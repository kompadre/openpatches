// collab-referee.js: the host's per-atom judge (M2-2). Every worked
// example from TODO.md › Collaborative editing › M2 is here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../html/components/project-model.js';
import { diffGroups, readAtom, checkInvariants } from '../html/components/collab-ops.js';
import { createReferee, rank, effectiveStart, PRIORITY_CAP } from '../html/components/collab-referee.js';

const project = () => createProject({
    name: 'Jam',
    tracks: [{ id: 't1', name: 'Keys', slot: 0 }, { id: 't2', name: 'Bass', slot: 1 }],
    patterns: {
        p1: { id: 'p1', name: 'Riff', measures: 1, notes: [{ midi: 60, start: 0, dur: 16 }] },
        p2: { id: 'p2', name: 'Low', measures: 1, notes: [] },
    },
    sections: [{
        id: 's1', name: 'Intro',
        clips: [
            { id: 'c1', trackId: 't1', patternId: 'p1', startCol: 0, repeats: 1 },
            { id: 'c2', trackId: 't1', patternId: 'p2', startCol: 32, repeats: 1 },
        ],
    }],
});
const clone = (p) => createProject(JSON.parse(JSON.stringify(p)));

let seq = 0;
/** An edit by `peer`: `mutate` a copy of `mirror`, diffed against it. */
function edit(mirror, mutate, { peer = 'A', start = 1000, end = 2000, base = 0, module = 'roll' } = {}) {
    const next = clone(mirror);
    mutate(next);
    return { id: 'e' + (++seq), peer, alias: peer, module, base, start, end, groups: diffGroups(mirror, next) };
}
const atomsOf = (groups) => groups.flatMap(g => g.map(op => op.atom)).sort();
const accepted = (out) => atomsOf(out.accepted.map(a => a.group));
const rejected = (out) => atomsOf(out.rejected.map(r => r.group));

/** Host at version 0 with the project; guests' mirrors are copies of it. */
function host() {
    const body = project();
    return { body, ref: createReferee(), mirror: () => clone(body) };
}

describe('ranking', () => {
    test('earliest start wins, then earliest end, then peer id', () => {
        assert.ok(rank({ start: 1, end: 9, peer: 'B', after: '1' }, { start: 2, end: 3, peer: 'A', after: '1' }) < 0);
        assert.ok(rank({ start: 1, end: 9, peer: 'B', after: '1' }, { start: 1, end: 3, peer: 'A', after: '1' }) > 0);
        assert.ok(rank({ start: 1, end: 3, peer: 'A', after: '1' }, { start: 1, end: 3, peer: 'B', after: '1' }) < 0);
    });
    test('a value beats a deletion regardless of time', () => {
        assert.ok(rank({ start: 1, end: 2, peer: 'A', after: null }, { start: 5, end: 6, peer: 'B', after: '1' }) > 0);
    });
    test('a start older than the cap counts as end − cap', () => {
        assert.equal(effectiveStart({ start: 0, end: PRIORITY_CAP + 5000 }), 5000);
        assert.equal(effectiveStart({ start: 4000, end: 5000 }), 4000);
        assert.equal(effectiveStart({ end: 5000 }), 5000, 'no start: start = end');
    });
});

describe('worked examples', () => {
    test('A adds C-4@0 / B adds E-4@4 in one pattern → both', () => {
        const h = host();
        const m = h.mirror();
        const a = h.ref.judge(edit(m, p => p.patterns.p2.notes.push({ midi: 60, start: 0, dur: 4 }), { peer: 'A' }), h.body);
        const b = h.ref.judge(edit(m, p => p.patterns.p2.notes.push({ midi: 64, start: 4, dur: 4 }), { peer: 'B' }), h.body);
        assert.equal(a.rejected.length + b.rejected.length, 0);
        assert.equal(h.body.patterns.p2.notes.length, 2);
        assert.equal(h.ref.version, 2);
    });

    test('same note, same dur → one (agreement, nothing applied, no conflict)', () => {
        const h = host();
        const m = h.mirror();
        h.ref.judge(edit(m, p => p.patterns.p2.notes.push({ midi: 60, start: 0, dur: 4 }), { peer: 'A' }), h.body);
        const b = h.ref.judge(edit(m, p => p.patterns.p2.notes.push({ midi: 60, start: 0, dur: 4 }), { peer: 'B' }), h.body);
        assert.equal(b.rejected.length, 0);
        assert.ok(b.accepted[0].agreed);
        assert.deepEqual(b.applied, []);
        assert.equal(h.body.patterns.p2.notes.length, 1);
        assert.equal(h.ref.version, 1);
    });

    test('same note, dur 4 vs 8 → conflict, earliest start wins (even arriving second)', () => {
        const h = host();
        const m = h.mirror();
        const a = h.ref.judge(edit(m, p => p.patterns.p2.notes.push({ midi: 60, start: 0, dur: 4 }), { peer: 'A', start: 1000, end: 2000 }), h.body);
        assert.equal(a.rejected.length, 0);
        const b = h.ref.judge(edit(m, p => p.patterns.p2.notes.push({ midi: 60, start: 0, dur: 8 }), { peer: 'B', start: 500, end: 2500 }), h.body);
        assert.equal(b.rejected.length, 0);
        assert.equal(b.overridden.length, 1, 'A is told');
        assert.equal(b.overridden[0].mine.peer, 'A');
        assert.equal(b.overridden[0].theirs.after, '8');
        assert.equal(h.body.patterns.p2.notes[0].dur, 8);
        // A later start loses.
        const c = h.ref.judge(edit(m, p => p.patterns.p2.notes.push({ midi: 60, start: 0, dur: 2 }), { peer: 'C', start: 1500, end: 2600 }), h.body);
        assert.equal(c.rejected.length, 1);
        assert.equal(c.rejected[0].kind, 'conflict');
        assert.match(c.rejected[0].reason, /B started first/);
        assert.equal(c.rejected[0].conflicts[0].theirs.peer, 'B');
        assert.equal(h.body.patterns.p2.notes[0].dur, 8);
    });

    test('notes vs rename → both', () => {
        const h = host();
        const m = h.mirror();
        h.ref.judge(edit(m, p => p.patterns.p1.notes.push({ midi: 64, start: 4, dur: 4 }), { peer: 'A' }), h.body);
        const b = h.ref.judge(edit(m, p => { p.patterns.p1.name = 'Hook'; }, { peer: 'B' }), h.body);
        assert.equal(b.rejected.length, 0);
        assert.equal(h.body.patterns.p1.name, 'Hook');
        assert.equal(h.body.patterns.p1.notes.length, 2);
    });

    test('volume vs delay → both', () => {
        const h = host();
        const m = h.mirror();
        h.ref.judge(edit(m, p => { p.tracks[0].volume = 50; }, { peer: 'A', module: 'mixer' }), h.body);
        const b = h.ref.judge(edit(m, p => { p.tracks[0].fx.delay = true; p.tracks[0].fx.delayMix = 0.4; }, { peer: 'B', module: 'mixer' }), h.body);
        assert.equal(b.rejected.length, 0);
        assert.equal(h.body.tracks[0].volume, 50);
        assert.equal(h.body.tracks[0].fx.delay, true);
    });

    test('clip move vs repeats → both unless it now overlaps', () => {
        const h = host();
        const m = h.mirror();
        // c1 at 0 (16 cols), c2 at 32. Move c1 to 8 and give c1 two repeats: 8..40 runs into c2.
        h.ref.judge(edit(m, p => { p.sections[0].clips[0].startCol = 8; }, { peer: 'A', module: 'section' }), h.body);
        const b = h.ref.judge(edit(m, p => { p.sections[0].clips[0].repeats = 2; }, { peer: 'B', module: 'section' }), h.body);
        assert.equal(b.rejected.length, 1);
        assert.equal(b.rejected[0].kind, 'invariant');
        assert.match(b.rejected[0].reason, /overlap/);
        assert.equal(h.body.sections[0].clips[0].repeats, 1);
        assert.deepEqual(checkInvariants(h.body), []);
        // Had A moved c2 away to 64 instead, both fit.
        const h2 = host();
        const m2 = h2.mirror();
        h2.ref.judge(edit(m2, p => { p.sections[0].clips[1].startCol = 64; }, { peer: 'A' }), h2.body);
        const b2 = h2.ref.judge(edit(m2, p => { p.sections[0].clips[0].repeats = 2; }, { peer: 'B' }), h2.body);
        assert.equal(b2.rejected.length, 0);
        assert.equal(h2.body.sections[0].clips[0].repeats, 2);
    });

    test('clip to bar 3 vs bar 5 → conflict', () => {
        const h = host();
        const m = h.mirror();
        h.ref.judge(edit(m, p => { p.sections[0].clips[1].startCol = 48; }, { peer: 'A', start: 1000, end: 2000 }), h.body);
        const b = h.ref.judge(edit(m, p => { p.sections[0].clips[1].startCol = 80; }, { peer: 'B', start: 1200, end: 1900 }), h.body);
        assert.equal(b.rejected.length, 1);
        assert.equal(h.body.sections[0].clips[1].startCol, 48);
    });

    test('delete pattern vs add a note → the edit wins, the pattern is back, the deleter is told', () => {
        const h = host();
        const m = h.mirror();
        const del = h.ref.judge(edit(m, p => {
            delete p.patterns.p2;
            p.sections[0].clips.splice(1, 1);
        }, { peer: 'A', start: 100, end: 200 }), h.body);
        assert.equal(del.rejected.length, 0);
        assert.equal(h.body.patterns.p2, undefined);
        const b = h.ref.judge(edit(m, p => p.patterns.p2.notes.push({ midi: 40, start: 0, dur: 4 }), { peer: 'B', start: 5000, end: 6000 }), h.body);
        assert.equal(b.rejected.length, 0);
        assert.ok(h.body.patterns.p2, 'revived');
        assert.equal(h.body.patterns.p2.name, 'Low');
        assert.equal(h.body.patterns.p2.notes.length, 1);
        assert.equal(h.body.sections[0].clips.length, 2, 'its clip came back with it');
        assert.equal(b.overridden.length, 1);
        assert.equal(b.overridden[0].mine.peer, 'A');
        assert.equal(b.overridden[0].atom, 'pattern/p2');
        assert.deepEqual(checkInvariants(h.body), []);
    });

    test('add a note, then someone deletes the pattern on an old base → the delete loses', () => {
        const h = host();
        const m = h.mirror();
        h.ref.judge(edit(m, p => p.patterns.p2.notes.push({ midi: 40, start: 0, dur: 4 }), { peer: 'B', start: 100, end: 200 }), h.body);
        const del = h.ref.judge(edit(m, p => {
            delete p.patterns.p2;
            p.sections[0].clips.splice(1, 1);
        }, { peer: 'A', start: 50, end: 300 }), h.body);
        assert.equal(del.rejected.length, 1);
        assert.match(del.rejected[0].reason, /edit beats a delete/);
        assert.ok(h.body.patterns.p2);
    });

    test('tracker cuts a held note (16→4) vs roll lengthening it (→12) → conflict on that dur', () => {
        const h = host();
        const m = h.mirror();
        const a = h.ref.judge(edit(m, p => {
            p.patterns.p1.notes[0].dur = 4;
            p.patterns.p1.notes.push({ midi: 62, start: 4, dur: 4 });
        }, { peer: 'A', module: 'tracker', start: 1000, end: 2000 }), h.body);
        assert.equal(a.rejected.length, 0);
        const b = h.ref.judge(edit(m, p => { p.patterns.p1.notes[0].dur = 12; }, { peer: 'B', module: 'roll', start: 1100, end: 1500 }), h.body);
        assert.equal(b.rejected.length, 1);
        assert.deepEqual(b.rejected[0].conflicts.map(c => c.atom), ['pattern/p1/note/0:60']);
        assert.equal(b.rejected[0].conflicts[0].theirs.module, 'tracker');
        assert.equal(h.body.patterns.p1.notes.find(n => n.midi === 60).dur, 4);
        assert.equal(h.body.patterns.p1.notes.length, 2, 'the typed note stands');
    });

    test('overlapping notes in one lane → both, lanes repack', () => {
        const h = host();
        const m = h.mirror();
        h.ref.judge(edit(m, p => p.patterns.p2.notes.push({ midi: 60, start: 0, dur: 8 }), { peer: 'A' }), h.body);
        const b = h.ref.judge(edit(m, p => p.patterns.p2.notes.push({ midi: 64, start: 4, dur: 8 }), { peer: 'B' }), h.body);
        assert.equal(b.rejected.length, 0);
        const notes = h.body.patterns.p2.notes;
        assert.equal(notes.length, 2);
        assert.equal(notes.filter(n => n.lane === 1).length, 1);
    });
});

describe('mechanics', () => {
    test('per-group acceptance: one group rejected, the other applied, in one edit', () => {
        const h = host();
        const m = h.mirror();
        h.ref.judge(edit(m, p => { p.tracks[0].name = 'Piano'; }, { peer: 'A', start: 100, end: 200 }), h.body);
        const b = h.ref.judge(edit(m, p => { p.tracks[0].name = 'Organ'; p.tracks[1].name = 'Sub'; }, { peer: 'B', start: 300, end: 400 }), h.body);
        assert.deepEqual(rejected(b), ['track/t1/name']);
        assert.deepEqual(accepted(b), ['track/t2/name']);
        assert.equal(h.body.tracks[0].name, 'Piano');
        assert.equal(h.body.tracks[1].name, 'Sub');
    });

    test('a group with a move: losing one atom loses the move whole', () => {
        const h = host();
        const m = h.mirror();
        h.ref.judge(edit(m, p => { p.patterns.p1.notes[0].dur = 2; }, { peer: 'A', start: 100, end: 200 }), h.body);
        const b = h.ref.judge(edit(m, p => { p.patterns.p1.notes[0].start = 8; }, { peer: 'B', start: 300, end: 400 }), h.body);
        assert.equal(b.rejected.length, 1);
        assert.deepEqual(rejected(b), ['pattern/p1/note/0:60', 'pattern/p1/note/8:60']);
        assert.equal(h.body.patterns.p1.notes.length, 1);
        assert.equal(h.body.patterns.p1.notes[0].start, 0);
    });

    test('versions decide whether a conflict exists: a writer at or before base never competes', () => {
        const h = host();
        const m = h.mirror();
        h.ref.judge(edit(m, p => { p.bpm = 100; }, { peer: 'A', start: 100, end: 200 }), h.body);
        // B saw version 1 (bpm 100) and sets 90 — before matches, plain apply.
        const m2 = h.mirror();
        const b = h.ref.judge(edit(m2, p => { p.bpm = 90; }, { peer: 'B', start: 50, end: 60, base: 1 }), h.body);
        assert.equal(b.rejected.length, 0);
        assert.equal(h.body.bpm, 90);
        // C's base is 2 (knows 90) yet its before says 100 — nobody wrote after base, so apply.
        const c = h.ref.judge({ id: 'x', peer: 'C', base: 2, start: 1, end: 2, groups: [[{ atom: 'bpm', before: '100', after: '80' }]] }, h.body);
        assert.equal(c.rejected.length, 0);
        assert.equal(h.body.bpm, 80);
    });

    test('a start older than 2 minutes loses its priority', () => {
        const h = host();
        const m = h.mirror();
        const T = 10 * 60 * 1000;
        h.ref.judge(edit(m, p => { p.bpm = 100; }, { peer: 'A', start: T - 1000, end: T }), h.body);
        // B began long before A but sat on it for 13 min; its start counts
        // as end − 2 min, which is after A's start.
        const b = h.ref.judge(edit(m, p => { p.bpm = 90; }, { peer: 'B', start: 0, end: T + 3 * 60 * 1000 }), h.body);
        assert.equal(b.rejected.length, 1);
        assert.match(b.rejected[0].reason, /over 2 min/);
        assert.equal(h.body.bpm, 100);
    });

    test('edit beats delete on one atom: removing a note vs lengthening it', () => {
        const h = host();
        const m = h.mirror();
        h.ref.judge(edit(m, p => { p.patterns.p1.notes = []; }, { peer: 'A', start: 100, end: 200 }), h.body);
        const b = h.ref.judge(edit(m, p => { p.patterns.p1.notes[0].dur = 8; }, { peer: 'B', start: 900, end: 1000 }), h.body);
        assert.equal(b.rejected.length, 0);
        assert.equal(h.body.patterns.p1.notes[0].dur, 8);
        assert.equal(b.overridden[0].mine.peer, 'A');
    });

    test('invariants: a slot clash rejects the later group with the reason; the rest stands', () => {
        const h = host();
        const m = h.mirror();
        h.ref.judge(edit(m, p => { p.tracks[1].slot = 3; }, { peer: 'A' }), h.body);
        const b = h.ref.judge(edit(m, p => { p.tracks[0].slot = 3; p.name = 'Renamed'; }, { peer: 'B' }), h.body);
        assert.equal(b.rejected.length, 1);
        assert.match(b.rejected[0].reason, /slot 4/);
        assert.equal(h.body.name, 'Renamed');
        assert.equal(h.body.tracks[0].slot, 0);
    });

    test('the host\'s own edits go through too: records are kept, version counts', () => {
        const h = host();
        const m = h.mirror();
        const a = h.ref.judge(edit(m, p => { p.name = 'Host named'; }, { peer: 'host', start: 1, end: 2 }), h.body);
        assert.equal(a.version, 1);
        assert.equal(h.ref.writerOf('name').peer, 'host');
        const b = h.ref.judge(edit(m, p => { p.name = 'Guest named'; }, { peer: 'G', start: 3, end: 4 }), h.body);
        assert.equal(b.rejected.length, 1);
        assert.equal(h.ref.version, 1, 'nothing changed');
    });

    test('a diff that applies cleanly to the host leaves no difference', () => {
        const h = host();
        const m = h.mirror();
        const draft = clone(m);
        draft.patterns.p3 = { id: 'p3', name: 'New', measures: 2, notes: [{ midi: 40, start: 0, dur: 2 }] };
        draft.sections[0].clips.push({ id: 'c9', trackId: 't2', patternId: 'p3', startCol: 0, repeats: 1 });
        draft.sections.push({ id: 's2', name: 'Outro' });
        const next = clone(draft);     // normalised, as any committed body is
        const out = h.ref.judge({ id: 'e', peer: 'A', base: 0, start: 1, end: 2, groups: diffGroups(m, next) }, h.body);
        assert.equal(out.rejected.length, 0);
        assert.deepEqual(diffGroups(h.body, next), []);
        assert.equal(readAtom(h.body, 'sections/order'), '["s1","s2"]');
    });

    test('prune forgets old writers', () => {
        const h = host();
        const m = h.mirror();
        h.ref.judge(edit(m, p => { p.bpm = 100; }, { peer: 'A' }), h.body);
        h.ref.version = 5000;
        h.ref.prune(1000);
        assert.equal(h.ref.writerOf('bpm'), null);
    });
});
