// collab.js: a host and guests, real sessions wired through an
// in-memory room hub. Delivery is queued and pumped, as a real channel is
// asynchronous; timers are a hand-cranked fake.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createCollab, relayChannel, relayUrl, makeProjectSession, seedPattern, profileStore, createTrack, addClip;

before(async () => {
    installBrowserEnv();
    ({ createCollab, relayChannel, relayUrl } = await import('../html/components/collab.js'));
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
        byPeer: new Map(),
        muted: new Set(),
        open(room, onMessage, o = {}) {
            if (!rooms.has(room)) rooms.set(room, new Set());
            const me = { onMessage, peer: o.peer };
            if (o.peer) hub.byPeer.set(o.peer, me);
            rooms.get(room).add(me);
            return {
                send(msg) {
                    hub.sent.push(msg);
                    if (hub.muted.has(me.peer)) return;
                    if (dropNext > 0) { dropNext--; return; }
                    const copy = JSON.parse(JSON.stringify(msg));   // structured clone, near enough
                    for (const other of rooms.get(room)) if (other !== me) queue.push(() => other.onMessage(copy));
                },
                close() { rooms.get(room).delete(me); },
            };
        },
        pump() { while (queue.length) queue.shift()(); },
        /** What the relay (or the channel) says, straight to one peer. */
        notify(peer, notice) { queue.push(() => hub.byPeer.get(peer).onMessage(notice)); },
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
            session, openChannel: hub.open, random, sendMs: 100, now: clock.now, clock: clock.now,
            beatMs: 5000, silentMs: 20000, graceMs: 15000,
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

    test('Reapply mine sends the lost value again as a fresh edit; it wins on the current base', async () => {
        const s = setup();
        await joined(s);
        s.host.session.update((p) => { p.bpm = 60; }, 'transport');
        s.clock.advance(50);
        s.guest.session.update((p) => { p.bpm = 50; }, 'transport');
        settle(s); settle(s);
        assert.equal(s.guest.session.get().bpm, 60);
        const row = s.guest.collab.status().conflicts[0];
        assert.ok(s.guest.collab.reapply(row));
        assert.equal(s.guest.session.get().bpm, 50, 'mine again, at once');
        assert.deepEqual(s.guest.collab.status().conflicts, []);
        settle(s); settle(s);
        assert.equal(s.host.session.get().bpm, 50, 'and the host took it');
        assert.deepEqual(s.guest.collab.status().conflicts, []);
        assert.deepEqual(s.host.collab.status().conflicts, [], 'the host had no edit in flight to lose');
        assert.equal(s.guest.collab.reapply(row), false, 'a row is reapplied once');
    });

    test('the host can reapply too, and presence is relayed to guests', async () => {
        const s = setup();
        const code = await joined(s);
        const other = await joinedToo(s, code);
        profileStore.setIdentity({ alias: 'Ann' });
        // The other guest begins; everyone hears who is editing.
        other.session.beginEdit({ patternId: s.pattern.id }, 'tracker');
        s.hub.pump(); s.hub.pump();
        assert.equal(s.guest.collab.status().editing.length, 1);
        assert.equal(s.guest.collab.status().editing[0].scope.patternId, s.pattern.id);
        assert.deepEqual(other.collab.status().editing, [], 'not told about itself');
        // The host loses a tempo conflict to the other guest (who began first) and reapplies.
        s.clock.advance(50);
        s.host.session.update((p) => { p.bpm = 60; }, 'transport');
        other.session.getPattern(s.pattern.id).notes.push({ midi: 64, start: 4, dur: 4 });
        other.session.update((p) => { p.bpm = 70; }, 'transport');
        other.session.touchPattern(s.pattern.id, 'tracker');
        settle(s); settle(s);
        assert.equal(s.host.session.get().bpm, 70);
        assert.deepEqual(s.guest.collab.status().editing, [], 'the edit landed');
        const rows = s.host.collab.status().conflicts;
        assert.equal(rows.length, 1);
        assert.ok(s.host.collab.reapply(rows[0]));
        settle(s); settle(s);
        assert.equal(s.host.session.get().bpm, 60);
        assert.equal(other.session.get().bpm, 60);
        assert.equal(s.guest.session.get().bpm, 60);
    });

    test('presence carries colour, the editor’s own entry never comes back to it', async () => {
        const s = setup();
        const code = await joined(s);
        profileStore.setIdentity({ alias: 'Bob', color: '#d84a6b' });
        const other = await joinedToo(s, code);
        other.session.beginEdit({ patternId: s.pattern.id }, 'tracker');
        s.hub.pump(); s.hub.pump();
        assert.deepEqual(s.host.collab.status().editing.map(e => [e.alias, e.color]), [['Bob', '#d84a6b']]);
        assert.deepEqual(s.guest.collab.status().editing.map(e => [e.alias, e.color, e.scope.patternId]), [['Bob', '#d84a6b', s.pattern.id]]);
        assert.deepEqual(other.collab.status().editing, []);
        other.session.getPattern(s.pattern.id).notes.push({ midi: 64, start: 4, dur: 4 });
        other.session.touchPattern(s.pattern.id, 'tracker');
        settle(s);
        assert.deepEqual(s.guest.collab.status().editing, []);
    });

    test('cursors travel at most every 100 ms, reach the others as ghosts, never move anyone, and go with the peer', async () => {
        const C = await import('../html/components/cursors.js');
        const s = setup();
        const code = await joined(s);
        const other = await joinedToo(s, code);
        profileStore.setIdentity({ alias: 'Bob', color: '#d84a6b' });
        // The guest's tracker reports twice inside the gathering time: one message, the latest.
        C.reportCursor('tracker', { sectionId: 'sX', slot: 0, lane: 0, col: 3 });
        C.reportCursor('tracker', { sectionId: 'sX', slot: 0, lane: 0, col: 5 });
        assert.equal(s.hub.sent.filter(m => m.t === 'cursor').length, 0, 'not yet');
        s.clock.advance(100);
        const sentAll = s.hub.sent.filter(m => m.t === 'cursor');
        // Every collab in this process shares the registry, so each of the three sent one; look at the content.
        assert.ok(sentAll.length >= 1);
        assert.equal(sentAll[0].where.tracker.col, 5);
        s.hub.pump();
        const seen = C.cursorsIn('tracker', { sectionId: 'sX' });
        assert.ok(seen.length >= 1, 'arrived as a remote cursor');
        assert.ok(seen.every(r => r.where.col === 5));
        assert.equal(s.guest.session.getSectionId(), s.host.session.getSectionId(), 'nobody’s view moved');
        // A section id nobody has on screen: drawn by nobody.
        assert.deepEqual(C.cursorsIn('tracker', { sectionId: s.host.session.getSectionId() }), []);
        // The other guest leaves: its cursor goes everywhere.
        await other.collab.leave();
        s.hub.pump();
        assert.ok(C.cursorsIn('tracker', { sectionId: 'sX' }).every(r => r.peer !== s.hub.sent.filter(m => m.t === 'join')[1].peer));
        C.reportCursor('tracker', null);
        s.clock.advance(100);
        s.hub.pump();
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

    test('a guest’s section edits travel: add, rename, tempo', async () => {
        const s = setup();
        await joined(s);
        s.guest.session.addSection({ name: 'Bridge' }, 'section');
        s.guest.session.renameSection('Bridge 2', 'section');
        s.guest.session.setSectionTempo({ bpm: 90 }, 'section');
        settle(s); settle(s);
        const h = s.host.session.get().sections;
        assert.deepEqual(h.map(x => [x.name, x.bpm]), [['Section 1', null], ['Bridge 2', 90]]);
        assert.equal(s.guest.collab.status().pending, 0);
        assert.deepEqual(s.guest.collab.status().conflicts, []);
        assert.equal(s.host.session.getSectionId(), h[0].id, 'the host stays on its own section');
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

describe('collab: the relay channel', () => {
    /** A WebSocket stand-in that the test opens, fails or feeds by hand. */
    function fakeWs() {
        const made = [];
        class WS {
            constructor(url) { this.url = url; this.sent = []; this.readyState = 0; made.push(this); }
            send(text) { this.sent.push(text); }
            close() { this.readyState = 3; this.closed = true; }
            open() { this.readyState = 1; this.onopen && this.onopen(); }
            fail() { this.onerror && this.onerror(); this.onclose && this.onclose(); }
            feed(text) { this.onmessage && this.onmessage({ data: text }); }
        }
        return { WS, made };
    }
    const fakeFallback = () => {
        const sent = [];
        const fn = (room, onMessage) => { fn.room = room; fn.onMessage = onMessage; return { send: (m) => sent.push(m), close() { fn.closed = true; } }; };
        fn.sent = sent;
        return fn;
    };

    test('the url is this server’s, ws or wss, with the peer', () => {
        assert.equal(relayUrl('ABC234', 'host', { protocol: 'http:', host: 'localhost:8000' }), 'ws://localhost:8000/api/room/ABC234?peer=host');
        assert.equal(relayUrl('ABC234', '', { protocol: 'https:', host: 'op.example' }), 'wss://op.example/api/room/ABC234');
    });

    test('sends before open are queued, then go as JSON; what arrives is parsed; junk is dropped', () => {
        const { WS, made } = fakeWs();
        const got = [];
        const ch = relayChannel('ABC234', (m) => got.push(m), { peer: 'p1', WebSocketImpl: WS, url: 'ws://x/api/room/ABC234' });
        assert.equal(ch.kind, 'connecting');
        ch.send({ t: 'join', peer: 'p1' });
        assert.deepEqual(made[0].sent, []);
        made[0].open();
        assert.equal(ch.kind, 'relay');
        assert.deepEqual(made[0].sent.map(JSON.parse), [{ t: 'join', peer: 'p1' }]);
        ch.send({ t: 'leave', peer: 'p1' });
        assert.equal(made[0].sent.length, 2);
        made[0].feed('{"t":"bye"}');
        made[0].feed('not json');
        assert.deepEqual(got, [{ t: 'bye' }]);
        ch.close();
        assert.ok(made[0].closed);
    });

    test('no relay: falls back to the local channel, queue and all', () => {
        const { WS, made } = fakeWs();
        const fallback = fakeFallback();
        const got = [];
        const ch = relayChannel('ABC234', (m) => got.push(m), { WebSocketImpl: WS, fallback, url: 'ws://x' });
        ch.send({ t: 'join', peer: 'p1' });
        made[0].fail();
        assert.equal(ch.kind, 'local');
        assert.equal(fallback.room, 'ABC234');
        assert.deepEqual(fallback.sent, [{ t: 'join', peer: 'p1' }]);
        ch.send({ t: 'leave', peer: 'p1' });
        assert.equal(fallback.sent.length, 2);
        fallback.onMessage({ t: 'bye' });
        assert.deepEqual(got, [{ t: 'bye' }]);
        ch.close();
        assert.ok(fallback.closed);
    });

    test('no WebSocket at all: local from the start', () => {
        const fallback = fakeFallback();
        const ch = relayChannel('ABC234', () => {}, { WebSocketImpl: null, fallback });
        if (typeof WebSocket === 'undefined') assert.equal(ch.kind, 'local');
        ch.close();
    });
});

describe('collab: dropped links, heartbeats, a host gone', () => {
    const guestPeer = (s) => s.hub.sent.find(m => m.t === 'join').peer;

    test('the relay says the host left: the guest waits the grace period, then the session ends', async () => {
        const s = setup();
        await joined(s);
        s.hub.notify(guestPeer(s), { relay: 'left', peer: 'host' });
        s.hub.pump();
        assert.equal(s.guest.collab.status().hostAway, true);
        assert.ok(s.guest.notices.some(n => /not answering/.test(n)));
        assert.equal(s.guest.collab.status().state, 'watching', 'still in, for now');
        s.host.collab.close();                    // really gone (its bye is lost too)
        s.clock.advance(15000);
        assert.equal(s.guest.collab.status().state, 'ended');
        assert.ok(s.guest.notices.includes('The host has gone'));
        assert.equal(s.guest.session.isGuest(), true, 'what is on screen stays');
    });

    test('the host back within the grace period: the session goes on', async () => {
        const s = setup();
        await joined(s);
        s.hub.notify(guestPeer(s), { relay: 'left', peer: 'host' });
        s.hub.pump();
        s.clock.advance(5000);                    // the host's beat arrives
        s.hub.pump();
        assert.equal(s.guest.collab.status().hostAway, false);
        assert.ok(s.guest.notices.includes('The host is back'));
        s.clock.advance(15000);
        s.hub.pump();
        assert.equal(s.guest.collab.status().state, 'watching');
    });

    test('a silent host (no beats) is taken for gone after silence + grace', async () => {
        const s = setup();
        await joined(s);
        s.hub.muted.add('host');
        for (let t = 0; t < 25000; t += 5000) { s.clock.advance(5000); s.hub.pump(); }
        assert.equal(s.guest.collab.status().hostAway, true);
        for (let t = 0; t < 15000; t += 5000) { s.clock.advance(5000); s.hub.pump(); }
        assert.equal(s.guest.collab.status().state, 'ended');
    });

    test('a guest whose link came back resyncs, and an edit lost on the way is sent again', async () => {
        const s = setup();
        await joined(s);
        s.hub.muted.add(guestPeer(s));            // the guest's socket is down…
        s.guest.session.update((p) => { p.bpm = 77; }, 'transport');
        s.clock.advance(100);
        s.hub.muted.delete(guestPeer(s));         // …and back
        s.hub.notify(guestPeer(s), { relay: 'reconnected' });
        s.hub.pump(); s.hub.pump();                // resync → snapshot
        settle(s); settle(s);
        assert.equal(s.host.session.get().bpm, 77);
        assert.equal(s.guest.collab.status().pending, 0);
        assert.ok(s.hub.sent.some(m => m.t === 'resync'));
    });

    test('a host whose link came back sends everyone the whole project', async () => {
        const s = setup();
        await joined(s);
        s.hub.muted.add('host');
        s.host.session.update((p) => { p.name = 'Renamed while away'; }, 'test');
        s.clock.advance(100);
        s.hub.muted.delete('host');
        s.hub.notify('host', { relay: 'reconnected' });
        s.hub.pump(); s.hub.pump();
        assert.equal(s.guest.session.get().name, 'Renamed while away');
    });

    test('the host counts out a guest the relay says left, or one gone silent; a beat brings it back', async () => {
        const s = setup();
        await joined(s);
        s.hub.notify('host', { relay: 'left', peer: guestPeer(s) });
        s.hub.pump();
        assert.equal(s.host.collab.status().peers, 0);
        s.clock.advance(5000);                    // the guest was only blipped: its beat
        s.hub.pump(); s.hub.pump();
        assert.equal(s.host.collab.status().peers, 1, 'back in, and caught up');
        s.hub.muted.add(guestPeer(s));
        for (let t = 0; t < 30000; t += 5000) { s.clock.advance(5000); s.hub.pump(); }
        assert.equal(s.host.collab.status().peers, 0, 'silent too long');
    });
});

describe('collab: the relay channel reconnects', () => {
    test('a drop after open: queued, retried with backoff, flushed on reopen, told', () => {
        const made = [];
        class WS {
            constructor(url) { this.url = url; this.sent = []; made.push(this); }
            send(t) { this.sent.push(t); }
            close() {}
        }
        const timers = [];
        const links = [];
        const got = [];
        const ch = relayChannel('ABC234', (m) => got.push(m), {
            WebSocketImpl: WS, url: 'ws://x', onLink: (k) => links.push(k),
            setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
        });
        made[0].onopen();
        made[0].onclose();                         // dropped
        assert.equal(ch.kind, 'reconnecting');
        ch.send({ t: 'beat', peer: 'p' });
        assert.equal(timers[0].ms, 500);
        timers.shift().fn();                       // retry 1…
        made[1].onclose();                         // …fails
        assert.equal(timers[0].ms, 1000, 'backs off');
        timers.shift().fn();
        made[2].onopen();
        assert.equal(ch.kind, 'relay');
        assert.deepEqual(made[2].sent.map(JSON.parse), [{ t: 'beat', peer: 'p' }]);
        assert.deepEqual(got, [{ relay: 'reconnected' }]);
        assert.deepEqual(links, ['relay', 'reconnecting', 'relay']);
        made[2].onclose();
        assert.equal(timers[0].ms, 500, 'backoff starts over after a good open');
        ch.close();
    });
});
