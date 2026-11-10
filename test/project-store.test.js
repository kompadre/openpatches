// project-store: the in-memory body, the debounced flush, the backend seam.
//
// The contract that matters is that **callers stay synchronous**. A mutator
// edits the open body and calls touch(); the write happens later, on its
// own. These tests pin that, the ordering guarantees around it, and the
// unload behaviour — which is autosave-on-hidden, because a page cannot
// confirm anything during unload and an IndexedDB write started there is
// not guaranteed to commit.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createProjectStore, createMemoryBackend, createProject;

before(async () => {
    installBrowserEnv();
    ({ createProjectStore, createMemoryBackend } = await import('../html/components/project-store.js'));
    ({ createProject } = await import('../html/components/project-model.js'));
});

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

let backend;

beforeEach(() => {
    localStorage.clear();
    backend = createMemoryBackend();
});

/** A store over the shared backend, with the page lifecycle left alone. */
function makeStore(opts = {}) {
    return createProjectStore({ backend, intervalMs: 10, bindLifecycle: false, ...opts });
}

async function opened(opts = {}) {
    const store = makeStore(opts);
    await store.adopt({ name: 'Piece', bpm: 120 });
    return store;
}

describe('adopt and open', () => {
    test('adopt writes through at once — an unsaved project would not survive the tab', async () => {
        const store = await opened();
        assert.equal(store.get().name, 'Piece');
        assert.equal(store.isDirty(), false, 'already flushed');
        assert.deepEqual(await backend.listIds(), [store.getId()]);
    });

    test('a body comes back from the backend normalised', async () => {
        const store = await opened();
        const id = store.getId();
        await store.close();
        assert.equal(store.get(), null);

        const again = await store.open(id);
        assert.equal(again.name, 'Piece');
        assert.equal(again.sections.length, 1, 'normalizeProject ran on the way in');
    });

    test('a missing id returns null and leaves the open project where it was', async () => {
        // A stale index row pointing at a body that is gone must not cost
        // the user the project they are working on.
        const store = await opened();
        const id = store.getId();
        store.get().bpm = 140;
        store.touch();

        assert.equal(await store.open('prj_nope'), null);
        assert.equal(store.getId(), id, 'still open');
        assert.equal(store.get().bpm, 140);
        assert.equal((await backend.load(id)).bpm, 140, 'and the pending edit was flushed on the way');
    });

    test('opening another project flushes the one in hand first', async () => {
        const store = await opened();
        const first = store.getId();
        store.get().bpm = 155;
        store.touch();                    // pending, not yet written

        await store.adopt({ name: 'Second' });
        const stored = await backend.load(first);
        assert.equal(stored.bpm, 155, 'the edit was not lost by the switch');
    });
});

describe('the autosave tick', () => {
    test('touch does not write immediately — that is what keeps callers sync', async () => {
        const store = await opened();
        store.get().bpm = 140;
        store.touch();
        assert.equal(store.isDirty(), true);
        assert.equal((await backend.load(store.getId())).bpm, 120, 'still the old body');

        await tick(30);
        assert.equal(store.isDirty(), false);
        assert.equal((await backend.load(store.getId())).bpm, 140);
    });

    test('a burst of edits produces one write', async () => {
        const store = await opened();
        let writes = 0;
        const save = backend.save;
        backend.save = (...a) => { writes++; return save(...a); };

        for (let i = 0; i < 20; i++) { store.get().bpm = 100 + i; store.touch(); }
        await tick(30);

        assert.equal(writes, 1, 'the debounce collapsed the burst');
        assert.equal((await backend.load(store.getId())).bpm, 119, 'and the last value won');
    });

    test('flush() writes now and resolves when it has landed', async () => {
        const store = await opened();
        store.get().bpm = 140;
        store.touch();
        await store.flush();
        assert.equal((await backend.load(store.getId())).bpm, 140);
        assert.equal(store.isDirty(), false);
    });

    test('flush with nothing pending is a no-op, not a write', async () => {
        const store = await opened();
        let writes = 0;
        const save = backend.save;
        backend.save = (...a) => { writes++; return save(...a); };
        await store.flush();
        await store.flush();
        assert.equal(writes, 0);
    });

    test('touch bumps modified, which is what the profile index sorts on', async () => {
        const store = await opened();
        const before = store.get().modified;
        await tick(2);
        store.touch();
        assert.ok(store.get().modified >= before);
    });

    test('a failed write is announced, not just logged', async () => {
        // The one state where the user can actually act — stay on the
        // page, retry — and the only one where leaving costs them work.
        const store = await opened({ onError: () => {} });
        const seen = [];
        store.subscribe((e) => { if (e.reason === 'save-failed') seen.push(e.failed); });
        backend.save = () => Promise.reject(new Error('QuotaExceeded'));

        store.touch();
        await tick(30);
        // One per retry — the ticker keeps trying, which is the point.
        assert.ok(seen.length >= 1);
        assert.ok(seen.every(Boolean));
        assert.equal(store.hasFailed(), true);
    });

    test('a later success clears the failed flag', async () => {
        const store = await opened({ onError: () => {} });
        const save = backend.save;
        let fail = true;
        backend.save = (...a) => (fail ? Promise.reject(new Error('nope')) : save(...a));
        store.touch();
        await tick(30);
        assert.equal(store.hasFailed(), true);

        fail = false;
        await store.flush({ force: true });
        assert.equal(store.hasFailed(), false);
    });

    test('a failed write stays dirty and the next flush retries it', async () => {
        const errors = [];
        const store = await opened({ onError: (e) => errors.push(e) });
        const save = backend.save;
        let fail = true;
        backend.save = (...a) => (fail ? Promise.reject(new Error('QuotaExceeded')) : save(...a));

        store.get().bpm = 140;
        store.touch();
        await tick(30);
        assert.ok(errors.length >= 1, 'the failure was reported');
        assert.equal(store.isDirty(), true, 'the body on disk is still stale, so say so');
        assert.equal((await backend.load(store.getId())).bpm, 120, 'nothing was written');

        // The backend recovers. Nothing re-touched the body — the retry has
        // to come from the still-dirty flag alone, or the edit is lost.
        fail = false;
        await store.flush();
        assert.equal(store.isDirty(), false);
        assert.equal((await backend.load(store.getId())).bpm, 140);
    });

    test('writes are serialised, so a slow save cannot be overtaken', async () => {
        const store = await opened();
        const order = [];
        let resolveFirst;
        let n = 0;
        backend.save = (id, body) => {
            n++;
            if (n === 1) {
                return new Promise((r) => { resolveFirst = () => { order.push('first'); r(); }; });
            }
            order.push('second:' + body.bpm);
            return Promise.resolve();
        };

        store.get().bpm = 1; store.touch();
        await tick(20);                      // first write is in flight, hanging
        store.get().bpm = 2; store.touch();
        await tick(20);                      // second queued behind it
        assert.deepEqual(order, [], 'nothing finished while the first hangs');

        resolveFirst();
        await store.flush();
        assert.deepEqual(order, ['first', 'second:2'], 'in order, newest last');
    });
});

describe('canSave — not while the transport is busy', () => {
    test('an autosave tick is skipped while the transport says no', async () => {
        let busy = true;
        const store = makeStore({ canSave: () => !busy });
        await store.adopt({ name: 'Piece' });

        store.get().bpm = 140;
        store.touch();
        await tick(40);
        assert.equal(store.isDirty(), true, 'still pending');
        assert.equal((await backend.load(store.getId())).bpm, 120);

        // The take ends; the next tick picks it up.
        busy = false;
        await tick(40);
        assert.equal(store.isDirty(), false);
        assert.equal((await backend.load(store.getId())).bpm, 140);
    });

    test('a forced flush ignores canSave — stopping a take saves at once', async () => {
        const store = makeStore({ canSave: () => false });
        await store.adopt({ name: 'Piece' });
        store.get().bpm = 140;
        store.touch();

        await store.flush({ force: true });
        assert.equal((await backend.load(store.getId())).bpm, 140);
        assert.equal(store.isDirty(), false);
    });

    test('the lifecycle flush is forced, so a tab killed mid-take still saves', async () => {
        // "Do not save while playing" is a latency preference. It loses to
        // not losing the session.
        const store = createProjectStore({
            backend, intervalMs: 10_000, bindLifecycle: true, canSave: () => false,
        });
        await store.adopt({ name: 'Piece' });
        store.get().bpm = 140;
        store.touch();

        document.visibilityState = 'hidden';
        for (const fn of document._listeners.visibilitychange || []) fn();
        await tick(5);

        assert.equal((await backend.load(store.getId())).bpm, 140);
    });

    test('a skipped tick does not count as a write', async () => {
        const store = makeStore({ canSave: () => false });
        await store.adopt({ name: 'Piece' });
        let writes = 0;
        const save = backend.save;
        backend.save = (...a) => { writes++; return save(...a); };

        store.touch();
        await tick(40);
        assert.equal(writes, 0);
        assert.equal(store.isSaving(), false, 'nothing is in flight either');
    });
});

describe('isSaving and whenIdle — the Play deferral', () => {
    test('whenIdle resolves immediately when nothing is being written', async () => {
        const store = await opened();
        assert.equal(store.isSaving(), false);
        let resolved = false;
        store.whenIdle().then(() => { resolved = true; });
        await tick(1);
        assert.equal(resolved, true);
    });

    test('pressing Play mid-write waits for the write, then starts', async () => {
        const store = await opened();
        let release;
        const save = backend.save;
        backend.save = (...a) => new Promise((r) => { release = () => r(save(...a)); });

        store.get().bpm = 140;
        store.touch();
        await tick(20);                       // the tick fired; the write hangs
        assert.equal(store.isSaving(), true);

        const order = [];
        store.whenIdle().then(() => order.push('play starts'));
        await tick(5);
        assert.deepEqual(order, [], 'the button is down but nothing has started');

        release();
        await store.flush();
        await tick(1);
        assert.deepEqual(order, ['play starts']);
        assert.equal(store.isSaving(), false);
    });

    test('several waiters all resolve on the one write', async () => {
        const store = await opened();
        let release;
        const save = backend.save;
        backend.save = (...a) => new Promise((r) => { release = () => r(save(...a)); });
        store.touch();
        await tick(20);

        let n = 0;
        store.whenIdle().then(() => n++);
        store.whenIdle().then(() => n++);
        release();
        await store.flush();
        await tick(1);
        assert.equal(n, 2);
    });

    test('a write that fails still releases the waiters, or Play would hang forever', async () => {
        const store = await opened({ onError: () => {} });
        backend.save = () => Promise.reject(new Error('nope'));
        store.touch();
        await tick(20);

        let resolved = false;
        store.whenIdle().then(() => { resolved = true; });
        await tick(40);
        assert.equal(resolved, true);
    });
});

describe('remove and clear', () => {
    test('removing the open project closes it', async () => {
        const store = await opened();
        const id = store.getId();
        await store.remove(id);
        assert.equal(store.get(), null);
        assert.deepEqual(await backend.listIds(), []);
    });

    test('removing another project leaves the open one alone', async () => {
        const store = await opened();
        const keep = store.getId();
        await store.adopt({ name: 'Other' });
        const other = store.getId();
        await store.remove(keep);
        assert.equal(store.getId(), other);
        assert.deepEqual(await backend.listIds(), [other]);
    });

    test('a pending flush cannot resurrect a project that was just removed', async () => {
        const store = await opened();
        const id = store.getId();
        store.get().bpm = 140;
        store.touch();                     // scheduled
        await store.remove(id);
        await tick(30);                    // the timer would have fired by now
        assert.deepEqual(await backend.listIds(), [], 'stayed removed');
    });

    test('clear drops every body — the project half of "delete everything"', async () => {
        const store = await opened();
        await store.adopt({ name: 'Second' });
        assert.equal((await backend.listIds()).length, 2);
        await store.clear();
        assert.deepEqual(await backend.listIds(), []);
        assert.equal(store.get(), null);
    });
});

describe('subscribers', () => {
    test('open, edit and close are announced', async () => {
        const seen = [];
        const store = makeStore();
        store.subscribe((e) => seen.push(e.reason));
        await store.adopt({ name: 'Piece' });
        store.touch();
        await store.close();
        // save-start/save-end bracket each write; they are what the "Now
        // saving" indicator renders from.
        assert.deepEqual(seen.filter(r => !r.startsWith('save-')), ['open', 'edit', 'close']);
        assert.ok(seen.includes('save-start') && seen.includes('save-end'));
    });

    test('a throwing subscriber does not stop the others', async () => {
        const store = await opened();
        const seen = [];
        store.subscribe(() => { throw new Error('boom'); });
        store.subscribe(() => seen.push('ok'));
        store.touch();
        assert.deepEqual(seen, ['ok']);
    });

    test('unsubscribing stops the calls', async () => {
        const store = await opened();
        let n = 0;
        const off = store.subscribe(() => n++);
        store.touch();
        off();
        store.touch();
        assert.equal(n, 1);
    });
});

describe('the crash journal', () => {
    // Measured, not assumed: on a real reload both `visibilitychange:
    // hidden` and `pagehide` fire, the IndexedDB transaction *is* opened
    // inside the handler, and it still does not commit — the page is torn
    // down first and the edits are gone. localStorage is synchronous, so
    // it is the only thing that survives there.

    const JOURNAL = 'openpatches_project_journal';
    const journal = () => JSON.parse(localStorage.getItem(JOURNAL) || 'null');

    function hide() {
        document.visibilityState = 'hidden';
        for (const fn of document._listeners.visibilitychange || []) fn();
    }

    test('unsaved edits are written to localStorage as the page goes', async () => {
        const store = createProjectStore({ backend, intervalMs: 10_000, bindLifecycle: true });
        await store.adopt({ name: 'Piece' });
        store.get().bpm = 140;
        store.touch();

        hide();
        assert.equal(journal().bpm, 140, 'the only copy that reliably survives');
    });

    test('nothing pending, nothing journalled', async () => {
        const store = createProjectStore({ backend, intervalMs: 10_000, bindLifecycle: true });
        await store.adopt({ name: 'Piece' });
        hide();
        assert.equal(journal(), null);
    });

    test('the journal is dropped once a real write carries it', async () => {
        const store = createProjectStore({ backend, intervalMs: 10_000, bindLifecycle: true });
        await store.adopt({ name: 'Piece' });
        store.get().bpm = 140;
        store.touch();
        hide();
        assert.ok(journal());

        await store.flush({ force: true });
        await tick(5);
        assert.equal(journal(), null, 'IndexedDB has it now');
    });

    test('a journal newer than the stored body wins on open, and is written out', async () => {
        const store = createProjectStore({ backend, intervalMs: 0, bindLifecycle: false });
        await store.adopt({ name: 'Piece', bpm: 120 });
        const id = store.getId();

        // What a page that died mid-edit leaves behind.
        localStorage.setItem(JOURNAL, JSON.stringify({
            ...await backend.load(id), bpm: 155, modified: Date.now() + 1000,
        }));

        const reopened = await store.open(id);
        assert.equal(reopened.bpm, 155, 'recovered');
        await store.flush({ force: true });
        await tick(5);
        assert.equal((await backend.load(id)).bpm, 155, 'and written out properly');
        assert.equal(journal(), null, 'so the journal is spent');
    });

    test('a journal older than the stored body is ignored', async () => {
        const store = createProjectStore({ backend, intervalMs: 0, bindLifecycle: false });
        await store.adopt({ name: 'Piece', bpm: 120 });
        const id = store.getId();
        localStorage.setItem(JOURNAL, JSON.stringify({
            ...await backend.load(id), bpm: 99, modified: 1,
        }));
        assert.equal((await store.open(id)).bpm, 120, 'the stored body is newer');
    });

    test("a journal for another project is left alone", async () => {
        const store = createProjectStore({ backend, intervalMs: 0, bindLifecycle: false });
        await store.adopt({ name: 'Piece' });
        const id = store.getId();
        localStorage.setItem(JOURNAL, JSON.stringify({
            id: 'prj_other', name: 'Other', bpm: 155, modified: Date.now() + 1000,
        }));
        assert.equal((await store.open(id)).name, 'Piece');
        assert.ok(journal(), 'still there for when that project is opened');
    });

    test('a body too big for localStorage leaves a marker, not a stale journal', async () => {
        // localStorage has a quota and the journal is the whole body, so a
        // big project can fail to fit. Nothing can be shown at unload, so
        // the fallback is a few bytes the next boot can report.
        const { takeLostSaveMarker } = await import('../html/components/project-store.js');
        const store = createProjectStore({
            backend, intervalMs: 10_000, bindLifecycle: true, onError: () => {},
        });
        await store.adopt({ name: 'Nocturne' });

        // An older journal, from a session that did fit.
        localStorage.setItem(JOURNAL, JSON.stringify({ id: store.getId(), bpm: 100, modified: 1 }));

        const realSet = localStorage.setItem.bind(localStorage);
        localStorage.setItem = (k, v) => {
            if (k === JOURNAL) throw new Error('QuotaExceededError');
            return realSet(k, v);
        };
        store.get().bpm = 140;
        store.touch();
        hide();
        localStorage.setItem = realSet;

        assert.equal(journal(), null,
            'the stale copy is dropped — restoring it would quietly resurrect the wrong state');
        const marker = takeLostSaveMarker();
        assert.equal(marker.name, 'Nocturne', 'but the loss is recorded');
        assert.equal(takeLostSaveMarker(), null, 'and reported only once');
    });

    test('clear takes the journal, or a deleted project would come back', async () => {
        const store = createProjectStore({ backend, intervalMs: 10_000, bindLifecycle: true });
        await store.adopt({ name: 'Piece' });
        store.touch();
        hide();
        assert.ok(journal());
        await store.clear();
        assert.equal(journal(), null);
    });
});

describe('the page going away', () => {
    // No confirm() on the way out: a page cannot show one during unload, and
    // an IndexedDB write started there is not guaranteed to commit. The
    // answer is to have already written — on `hidden`, which fires while the
    // page is still alive and is the only one a mobile tab-kill honours.

    test('visibilitychange -> hidden flushes immediately', async () => {
        const store = createProjectStore({ backend, intervalMs: 10_000, bindLifecycle: true });
        await store.adopt({ name: 'Piece' });
        store.get().bpm = 140;
        store.touch();
        assert.equal(store.isDirty(), true);

        document.visibilityState = 'hidden';
        for (const fn of document._listeners.visibilitychange || []) fn();
        await tick(5);

        assert.equal((await backend.load(store.getId())).bpm, 140,
            'the debounce would not have fired for another ten seconds');
    });

    test('becoming visible again does not write', async () => {
        const store = createProjectStore({ backend, intervalMs: 10_000, bindLifecycle: true });
        await store.adopt({ name: 'Piece' });
        let writes = 0;
        const save = backend.save;
        backend.save = (...a) => { writes++; return save(...a); };

        store.get().bpm = 140;
        store.touch();
        document.visibilityState = 'visible';
        for (const fn of document._listeners.visibilitychange || []) fn();
        await tick(5);
        assert.equal(writes, 0);
    });
});

describe('ephemeral bodies (watching a collab host)', () => {
    test('held in memory only: edits, ticks, flushes and the page going away write nothing', async () => {
        const store = createProjectStore({ backend, intervalMs: 10, bindLifecycle: true });
        await store.adopt({ name: 'Mine' });
        const mine = store.getId();
        let writes = 0;
        const save = backend.save;
        backend.save = (...a) => { writes++; return save(...a); };

        store.adoptEphemeral({ id: 'prj_theirs', name: 'Theirs' });
        assert.equal(store.isEphemeral(), true);
        assert.equal(store.get().name, 'Theirs');
        store.get().bpm = 99;
        store.touch();
        assert.equal(store.isDirty(), false);
        await tick(30);
        await store.flush({ force: true });
        document.visibilityState = 'hidden';
        for (const fn of document._listeners.visibilitychange || []) fn();
        for (const fn of window._listeners?.pagehide || []) fn();
        await tick(5);
        assert.equal(writes, 0);
        assert.equal(await backend.load('prj_theirs'), null);
        assert.equal(localStorage.getItem('openpatches_project_journal'), null, 'not journaled either');

        // Opening ours ends it.
        await store.open(mine);
        assert.equal(store.isEphemeral(), false);
        store.touch();
        assert.equal(store.isDirty(), true);
    });

    test('the outgoing body is flushed before an ephemeral one replaces it', async () => {
        const store = await opened();
        store.get().bpm = 133;
        store.touch();
        store.adoptEphemeral({ name: 'Theirs' });
        await store.whenIdle();
        const id = (await backend.listIds())[0];
        assert.equal((await backend.load(id)).bpm, 133);
    });

    test('adoptNow ends it', () => {
        const store = makeStore();
        store.adoptEphemeral({ name: 'Theirs' });
        store.adoptNow({ name: 'Imported' });
        assert.equal(store.isEphemeral(), false);
    });
});

describe('the body is plain JSON', () => {
    test('what comes out of the backend is a copy, not the live object', async () => {
        const store = await opened();
        const stored = await backend.load(store.getId());
        stored.name = 'Mutated';
        assert.equal(store.get().name, 'Piece', 'the open body is untouched');
    });

    test('editing the open body after a flush does not reach back into the backend', async () => {
        const store = await opened();
        store.get().name = 'Changed';
        assert.equal((await backend.load(store.getId())).name, 'Piece', 'not until touch + flush');
    });

    test('renormalize re-runs the cross-record invariants after direct rummaging', async () => {
        const store = await opened();
        const project = store.get();
        project.tracks.push(...createProject({
            tracks: [{ slot: 0, name: 'A' }, { slot: 0, name: 'B' }],
        }).tracks);
        project.tracks.push({ id: 'dup', name: 'C', slot: 0, volume: 1, mute: false, solo: false });
        store.renormalize();
        assert.equal(store.get().tracks.length, 1, 'one track per slot');
    });
});
