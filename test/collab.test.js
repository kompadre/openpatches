// collab.js: a host and guests, real sessions wired through an
// in-memory room hub. Delivery is queued and pumped, as a real channel is
// asynchronous; timers are a hand-cranked fake.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createCollab, makeProjectSession, seedPattern, profileStore, createTrack, addClip;

before(async () => {
    installBrowserEnv();
    ({ createCollab } = await import('../html/components/collab.js'));
    ({ makeProjectSession, seedPattern } = await import('./project-fixture.js'));
    ({ profileStore } = await import('../html/components/profile-store.js'));
    ({ createTrack, addClip } = await import('../html/components/project-model.js'));
});

beforeEach(() => localStorage.clear());

/** Rooms of peers; what one sends the others get, on pump(). */
function createHub() {
    const rooms = new Map();
    const queue = [];
    let dropNext = 0;
    const hub = {
        sent: [],
        open(room, onMessage) {
            if (!rooms.has(room)) rooms.set(room, new Set());
            const me = { onMessage };
            rooms.get(room).add(me);
            return {
                send(msg) {
                    hub.sent.push(msg);
                    if (dropNext > 0) { dropNext--; return; }
                    const copy = JSON.parse(JSON.stringify(msg));   // structured clone, near enough
                    for (const other of rooms.get(room)) if (other !== me) queue.push(() => other.onMessage(copy));
                },
                close() { rooms.get(room).delete(me); },
            };
        },
        pump() { while (queue.length) queue.shift()(); },
        drop(n = 1) { dropNext = n; },
    };
    return hub;
}

function fakeTimers() {
    let now = 0;
    let timers = [];
    return {
        setTimeout(fn, ms) { const t = { fn, at: now + (ms || 0) }; timers.push(t); return t; },
        clearTimeout(t) { timers = timers.filter(x => x !== t); },
        now() { return now; },
        advance(ms) {
            now += ms;
            for (;;) {
                const due = timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at)[0];
                if (!due) break;
                timers = timers.filter(t => t !== due);
                due.fn();
            }
        },
    };
}

function setup() {
    const hub = createHub();
    const clock = fakeTimers();
    let seed = 1;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const make = (name) => {
        const session = makeProjectSession({ name });
        let bench = 0;
        const collab = createCollab({
            session, openChannel: hub.open, random, sendMs: 100, now: clock.now,
            setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
            onBench: () => { bench++; },
        });
        const notices = [];
        collab.subscribe((s) => { if (s.notice) notices.push(s.notice); });
        return { session, collab, notices, bench: () => bench };
    };
    const guest = make('Mine');
    const host = make('Theirs');
    const { pattern } = seedPattern(host.session, { notes: [{ midi: 60, start: 0, dur: 4 }] });
    return { hub, clock, host, guest, pattern, make };
}

/** A second guest in the room. */
async function joinedToo(s, code, name = 'Other') {
    const g = s.make(name);
    const p = g.collab.join(code);
    s.hub.pump();
    await p;
    return g;
}

/** Both ways round the hub, timers run: what a quiet moment settles. */
function settle(s) {
    s.clock.advance(100);
    s.hub.pump();
    s.hub.pump();
}

async function joined(s) {
    const code = s.host.collab.host();
    const p = s.guest.collab.join(code);
    s.hub.pump();
    await p;
    return code;
}

const notesOf = (session, id) => session.getPattern(id).notes.map(n => [n.midi, n.start, n.dur]);

describe('collab: joining', () => {
    test('the guest gets the host’s project, playable, ephemeral, and is counted', async () => {
        const s = setup();
        const listed = profileStore.list().length;
        const current = profileStore.current;
        await joined(s);
        assert.equal(s.guest.session.getId(), s.host.session.getId());
        assert.equal(s.guest.session.isGuest(), true);
        assert.deepEqual(notesOf(s.guest.session, s.pattern.id), [[60, 0, 4]]);
        assert.equal(s.guest.session.get().tracks.length, 1);
        assert.equal(s.guest.collab.status().state, 'watching');
        assert.equal(s.guest.collab.status().hostName, 'Theirs');
        assert.equal(s.host.collab.status().peers, 1);
        assert.ok(s.guest.bench() >= 1, 'the canvas is told');
        // Never ours: not written to this profile's storage, not listed.
        s.guest.session.update((p) => { p.bpm = 77; }, 'test');
        await s.guest.session.flush();
        assert.equal(s.guest.session.backend._raw.has(s.host.session.getId()), false, 'not on disk');
        assert.equal(profileStore.current, current, 'still ours to come back to');
        assert.equal(profileStore.list().length, listed);
    });

    test('no one sharing that code: the join fails after the timeout, and we are out', async () => {
        const s = setup();
        const p = s.guest.collab.join('NOBODY');
        s.hub.pump();
        s.clock.advance(3000);
        await assert.rejects(p, /No one is sharing with code NOBODY/);
        assert.equal(s.guest.collab.status().role, null);
        assert.equal(s.guest.session.isGuest(), false);
        assert.deepEqual(s.guest.notices, ['No one is sharing with code NOBODY']);
    });

    test('the guest arrives on the section the host is on', async () => {
        const s = setup();
        const sec = s.host.session.addSection({ name: 'Chorus' }, 'test');
        s.host.session.setSection(sec.id, 'test');
        await joined(s);
        assert.equal(s.guest.session.getSectionId(), sec.id);
    });
});

describe('collab: following the host', () => {
    test('a pattern edit arrives after the gathering time, into the same objects', async () => {
        const s = setup();
        await joined(s);
        const obj = s.guest.session.getPattern(s.pattern.id);
        const heard = [];
        s.guest.session.subscribe((ev) => heard.push([ev.kind, ev.source]));
        s.host.session.getPattern(s.pattern.id).notes.push({ midi: 67, start: 8, dur: 4 });
        s.host.session.touchPattern(s.pattern.id, 'tracker');
        s.hub.pump();
        assert.deepEqual(notesOf(s.guest.session, s.pattern.id), [[60, 0, 4]], 'not yet');
        s.clock.advance(100);
        s.hub.pump();
        assert.deepEqual(notesOf(s.guest.session, s.pattern.id), [[60, 0, 4], [67, 8, 4]]);
        assert.equal(s.guest.session.getPattern(s.pattern.id), obj, 'the editors’ object');
        assert.deepEqual(heard, [['pattern', 'collab']]);
        const parts = s.hub.sent.filter(m => m.t === 'parts');
        assert.deepEqual(Object.keys(parts.at(-1).changes), [`patterns/${s.pattern.id}`], 'only the pattern travelled');
    });

    test('a burst of edits travels as one message', async () => {
        const s = setup();
        await joined(s);
        for (let i = 0; i < 5; i++) s.host.session.update((p) => { p.bpm = 100 + i; }, 'test');
        s.clock.advance(100);
        s.hub.pump();
        assert.equal(s.hub.sent.filter(m => m.t === 'parts').length, 1);
        assert.equal(s.guest.session.get().bpm, 104);
    });

    test('the band, sections and patches follow; the canvas is told about patches', async () => {
        const s = setup();
        await joined(s);
        const bench = s.guest.bench();
        s.host.session.update((p) => { p.tracks.push(createTrack({ name: 'Bass', slot: 1 })); }, 'voicebank', 'tracks');
        s.host.session.addSection({ name: 'Bridge' }, 'test');
        s.host.session.update((p) => { p.patches.x = { id: 'x', name: 'Bell', voice_data: 'AAAA' }; }, 'patches', 'patches');
        s.clock.advance(100);
        s.hub.pump();
        const g = s.guest.session.get();
        assert.deepEqual(g.tracks.map(t => t.name), ['Seed', 'Bass']);
        assert.deepEqual(g.sections.map(x => x.name).slice(-1), ['Bridge']);
        assert.equal(g.patches.x.name, 'Bell');
        assert.equal(s.guest.bench(), bench + 1);
    });

    test('a missed message: the guest asks for it all and catches up', async () => {
        const s = setup();
        await joined(s);
        s.hub.drop(1);
        s.host.session.update((p) => { p.bpm = 90; }, 'test');
        s.clock.advance(100);
        s.host.session.update((p) => { p.name = 'Renamed'; }, 'test');
        s.clock.advance(100);
        s.hub.pump();                                  // v2 arrives, v1 never did → resync
        s.hub.pump();                                  // the snapshot
        assert.ok(s.hub.sent.some(m => m.t === 'resync'));
        assert.equal(s.guest.session.get().bpm, 90);
        assert.equal(s.guest.session.get().name, 'Renamed');
        s.host.session.update((p) => { p.bpm = 91; }, 'test');
        s.clock.advance(100);
        s.hub.pump();
        assert.equal(s.guest.session.get().bpm, 91, 'and follows on from there');
    });

    test('the host opens another project: the guests get that one', async () => {
        const s = setup();
        await joined(s);
        s.host.session.createNew('Second', 'menu');
        s.hub.pump();
        assert.equal(s.guest.session.getId(), s.host.session.getId());
        assert.equal(s.guest.session.get().name, 'Second');
        assert.equal(s.guest.session.isGuest(), true);
    });
});

describe('collab: guest edits', () => {
    test('a guest edit shows at once, reaches the host, is acked, and nothing is reverted', async () => {
        const s = setup();
        await joined(s);
        const other = await joinedToo(s, s.host.collab.status().room);
        const obj = s.guest.session.getPattern(s.pattern.id);
        obj.notes.push({ midi: 64, start: 4, dur: 4 });
        s.guest.session.touchPattern(s.pattern.id, 'roll');
        assert.deepEqual(notesOf(s.guest.session, s.pattern.id), [[60, 0, 4], [64, 4, 4]], 'at once');
        assert.equal(s.guest.collab.status().pending, 0, 'not sent yet');
        s.clock.advance(100);
        assert.equal(s.guest.collab.status().pending, 1);
        s.hub.pump();                                  // the edit reaches the host
        assert.deepEqual(notesOf(s.host.session, s.pattern.id), [[60, 0, 4], [64, 4, 4]]);
        s.hub.pump();                                  // parts + ack come back
        assert.equal(s.guest.collab.status().pending, 0);
        assert.deepEqual(s.guest.collab.status().conflicts, []);
        assert.equal(s.guest.session.getPattern(s.pattern.id), obj, 'the editors’ object');
        assert.deepEqual(notesOf(s.guest.session, s.pattern.id), [[60, 0, 4], [64, 4, 4]]);
        assert.deepEqual(notesOf(other.session, s.pattern.id), [[60, 0, 4], [64, 4, 4]], 'the other guest has it');
        assert.deepEqual(s.guest.notices, []);
        const edit = s.hub.sent.find(m => m.t === 'edit');
        assert.equal(edit.edit.module, 'roll');
        assert.equal(edit.edit.base, 0);
        assert.deepEqual(edit.edit.groups.flat().map(op => op.atom), [`pattern/${s.pattern.id}/note/4:64`]);
    });

    test('nothing travels from under an open edit until it is committed', async () => {
        const s = setup();
        await joined(s);
        const obj = s.guest.session.getPattern(s.pattern.id);
        s.guest.session.beginEdit({ patternId: s.pattern.id }, 'tracker');   // first keystroke
        obj.notes.push({ midi: 64, start: 4, dur: 4 });
        obj.notes.push({ midi: 64, start: 4, dur: 2 });                     // a double, to be merged
        s.guest.session.update((p) => { p.bpm = 99; }, 'transport');         // something else meanwhile
        settle(s);
        assert.equal(s.host.session.get().bpm, 99, 'the tempo went');
        assert.deepEqual(notesOf(s.host.session, s.pattern.id), [[60, 0, 4]], 'the pattern waited');
        obj.notes.splice(2, 1);                                              // the commit merges the doubles…
        s.guest.session.touchPattern(s.pattern.id, 'tracker');              // …and announces
        settle(s);
        assert.deepEqual(notesOf(s.host.session, s.pattern.id), [[60, 0, 4], [64, 4, 4]]);
        assert.equal(s.guest.collab.status().pending, 0);
        assert.deepEqual(s.guest.collab.status().conflicts, []);
    });

    test('host parts arriving mid-edit merge per atom: the pending note stays, the host’s arrives', async () => {
        const s = setup();
        await joined(s);
        const obj = s.guest.session.getPattern(s.pattern.id);
        obj.notes.push({ midi: 64, start: 4, dur: 4 });
        s.guest.session.touchPattern(s.pattern.id, 'roll');
        s.host.session.getPattern(s.pattern.id).notes.push({ midi: 67, start: 8, dur: 4 });
        s.host.session.touchPattern(s.pattern.id, 'roll');
        s.clock.advance(100);                          // both send; nothing delivered yet
        // The host's parts land first: M1 would have refilled the notes array and lost E-4.
        const toGuest = s.hub.sent.filter(m => m.t === 'parts');
        assert.equal(toGuest.length, 1);
        s.hub.pump();
        assert.deepEqual(notesOf(s.guest.session, s.pattern.id).sort(), [[60, 0, 4], [64, 4, 4], [67, 8, 4]]);
        assert.deepEqual(notesOf(s.host.session, s.pattern.id).sort(), [[60, 0, 4], [64, 4, 4], [67, 8, 4]]);
        s.hub.pump();
        assert.equal(s.guest.collab.status().pending, 0);
        assert.deepEqual(s.guest.collab.status().conflicts, []);
        assert.equal(s.guest.session.getPattern(s.pattern.id), obj);
    });

    test('a conflict the guest started first: the host’s edit loses, and the host is told', async () => {
        const s = setup();
        await joined(s);
        s.guest.session.beginEdit({}, 'transport');
        s.guest.session.update((p) => { p.bpm = 50; }, 'transport');
        s.clock.advance(50);
        s.host.session.update((p) => { p.bpm = 60; }, 'transport');
        settle(s);
        assert.equal(s.host.session.get().bpm, 50);
        assert.equal(s.guest.session.get().bpm, 50);
        assert.deepEqual(s.guest.collab.status().conflicts, []);
        const rows = s.host.collab.status().conflicts;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, 'overridden');
        assert.deepEqual(rows[0].atoms, ['bpm']);
        assert.equal(rows[0].mine[0].value, '60');
        assert.equal(rows[0].theirs[0].value, '50');
        assert.equal(rows[0].kept, 'theirs');
    });

    test('a conflict the host started first: the guest’s group is rejected, takes the host’s value, gets a row', async () => {
        const s = setup();
        await joined(s);
        s.host.session.update((p) => { p.bpm = 60; }, 'transport');
        s.clock.advance(50);
        s.guest.session.update((p) => { p.bpm = 50; p.name = 'Guest named'; }, 'transport');
        assert.equal(s.guest.session.get().bpm, 50, 'shows at once');
        settle(s);
        settle(s);
        assert.equal(s.host.session.get().bpm, 60);
        assert.equal(s.guest.session.get().bpm, 60, 'back to the host’s');
        assert.equal(s.host.session.get().name, 'Guest named', 'the other group stood');
        const rows = s.guest.collab.status().conflicts;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, 'conflict');
        assert.match(rows[0].reason, /started first/);
        assert.deepEqual(rows[0].atoms, ['bpm']);
        assert.equal(rows[0].mine[0].value, '50');
        assert.equal(rows[0].theirs[0].value, '60');
        assert.equal(rows[0].module, 'transport');
        assert.ok(s.guest.notices.some(n => /lost a conflict/.test(n)));
        assert.deepEqual(s.host.collab.status().conflicts, []);
    });

    test('a later edit that beats one of ours: the overridden row travels to us', async () => {
        const s = setup();
        const code = await joined(s);
        const other = await joinedToo(s, code);
        // The other guest began first; both change the tempo they saw (120),
        // and ours reaches the host first.
        other.session.beginEdit({}, 'transport');
        s.clock.advance(50);
        s.guest.session.update((p) => { p.bpm = 50; }, 'transport');
        other.session.update((p) => { p.bpm = 70; }, 'transport');
        settle(s);
        settle(s);
        assert.equal(s.host.session.get().bpm, 70);
        assert.equal(s.guest.session.get().bpm, 70);
        assert.equal(other.session.get().bpm, 70);
        const rows = s.guest.collab.status().conflicts;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, 'overridden');
        assert.equal(rows[0].mine[0].value, '50');
        assert.equal(rows[0].theirs[0].value, '70');
        assert.deepEqual(other.collab.status().conflicts, []);
    });

    test('an edit that would break an invariant is rejected with the reason', async () => {
        const s = setup();
        await joined(s);
        // The host puts a second clip at bar 3; the guest, not knowing, moves the first to bar 3 too.
        s.host.session.update((p, sec) => { addClip(p, sec, { trackId: s.host.session.get().tracks[0].id, patternId: s.pattern.id, startCol: 32 }); }, 'section-editor');
        s.guest.session.update((p, sec) => { sec.clips[0].startCol = 32; }, 'section-editor');
        settle(s);
        settle(s);
        assert.deepEqual(s.host.session.getSection().clips.map(c => c.startCol), [0, 32]);
        assert.deepEqual(s.guest.session.getSection().clips.map(c => c.startCol), [0, 32], 'the move came back');
        const rows = s.guest.collab.status().conflicts;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, 'invariant');
        assert.match(rows[0].reason, /overlap/);
    });

    test('a begin says who is editing what, until their edit lands', async () => {
        const s = setup();
        profileStore.setIdentity({ alias: 'Bob' });
        await joined(s);
        s.guest.session.beginEdit({ patternId: s.pattern.id }, 'tracker');
        s.hub.pump();
        const e = s.host.collab.status().editing;
        assert.equal(e.length, 1);
        assert.equal(e[0].alias, 'Bob');
        assert.equal(e[0].scope.patternId, s.pattern.id);
        s.guest.session.getPattern(s.pattern.id).notes.push({ midi: 64, start: 4, dur: 4 });
        s.guest.session.touchPattern(s.pattern.id, 'tracker');
        settle(s);
        assert.deepEqual(s.host.collab.status().editing, []);
        assert.equal(s.hub.sent.find(m => m.t === 'edit').edit.alias, 'Bob');
    });

    test('a missed message with an edit in flight: resync keeps and resends it', async () => {
        const s = setup();
        await joined(s);
        s.hub.drop(1);                                 // the next message (the host’s parts) is lost
        s.host.session.update((p) => { p.name = 'Renamed'; }, 'test');
        s.clock.advance(100);
        s.guest.session.update((p) => { p.bpm = 77; }, 'transport');
        s.hub.drop(1);                                 // …and so is the guest’s edit
        s.clock.advance(100);
        s.host.session.update((p) => { p.tags = ['x']; }, 'test');
        s.clock.advance(100);
        s.hub.pump();                                  // v2 arrives, v1 never did → resync
        s.hub.pump();                                  // the snapshot
        settle(s);
        settle(s);
        assert.equal(s.guest.session.get().name, 'Renamed');
        assert.equal(s.guest.session.get().bpm, 77, 'ours kept');
        assert.equal(s.host.session.get().bpm, 77, 'and sent again');
        assert.equal(s.guest.collab.status().pending, 0);
    });

    test('the host opens another project: the guest follows and forgets what it had in flight', async () => {
        const s = setup();
        await joined(s);
        s.guest.session.update((p) => { p.bpm = 77; }, 'transport');
        s.clock.advance(100);
        s.host.session.createNew('Second', 'menu');
        s.hub.pump();
        assert.equal(s.guest.session.get().name, 'Second');
        assert.equal(s.guest.collab.status().pending, 0);
        s.hub.pump();
        assert.notEqual(s.host.session.get().bpm, 77);
    });

    test('switching section is the guest’s own business', async () => {
        const s = setup();
        const sec = s.host.session.addSection({ name: 'B' }, 'test');
        await joined(s);
        s.guest.session.setSection(sec.id, 'section');
        settle(s);
        assert.equal(s.guest.session.getSectionId(), sec.id);
        assert.deepEqual(s.guest.notices, []);
        assert.equal(s.hub.sent.filter(m => m.t === 'edit').length, 0);
    });
});

describe('collab: ending', () => {
    test('the host stops: the guest keeps watching what was there, and can keep a copy', async () => {
        const s = setup();
        await joined(s);
        s.host.collab.stopHosting();
        s.hub.pump();
        assert.equal(s.guest.collab.status().state, 'ended');
        assert.deepEqual(s.guest.notices, ['The host stopped sharing']);
        assert.equal(s.guest.session.isGuest(), true, 'still on screen');
        const hostId = s.host.session.getId();
        await s.guest.collab.leave({ keepCopy: true });
        assert.equal(s.guest.session.isGuest(), false);
        assert.notEqual(s.guest.session.getId(), hostId, 'a project of our own');
        assert.deepEqual(notesOf(s.guest.session, s.pattern.id), [[60, 0, 4]]);
        assert.ok(profileStore.has(s.guest.session.getId()));
        assert.equal(s.guest.collab.status().role, null);
    });

    test('leaving goes back to our own project; the host counts us out', async () => {
        const s = setup();
        const mine = s.guest.session.getId();
        await joined(s);
        await s.guest.collab.leave();
        s.hub.pump();
        assert.equal(s.guest.session.getId(), mine);
        assert.equal(s.guest.session.get().name, 'Mine');
        assert.equal(s.guest.session.isGuest(), false);
        assert.equal(s.host.collab.status().peers, 0);
    });

    test('opening another project while watching ends it', async () => {
        const s = setup();
        const mine = s.guest.session.getId();
        await joined(s);
        await s.guest.session.open(mine, 'menu');
        s.hub.pump();
        assert.equal(s.guest.collab.status().role, null);
        assert.equal(s.host.collab.status().peers, 0);
    });

    test('close() on the way out says goodbye either way', async () => {
        const s = setup();
        await joined(s);
        s.guest.collab.close();
        s.hub.pump();
        assert.equal(s.host.collab.status().peers, 0);
        const g2 = setup();
        await joined(g2);
        g2.host.collab.close();
        g2.hub.pump();
        assert.equal(g2.guest.collab.status().state, 'ended');
    });
});
