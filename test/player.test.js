// The Player (html/synth/player.js) — Player phase 1. One head per track,
// the per-track loop, the looped-status transition, seek, seam, the piece.
//
// First the contract with phase 0: driven tick by tick over every golden
// fixture, the Player reproduces today's output where tracks are equal
// (`today`) and the agreed delta where they are not (`player`). Then the
// behaviours the goldens cannot see: seeking into a looped state, the
// piece's passes and parts, a scope with nothing in it, and locate().

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createPlayer } from '../html/synth/player.js';
import { createSectionSequence, createPieceSequence } from '../html/synth/section-sequencer.js';
import { createProject, addTrack, addPattern, addClip, addSection } from '../html/components/project-model.js';
import { fixtures, sequenceOf } from './golden-capture.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = (name) => JSON.parse(readFileSync(join(here, 'golden', name + '.json'), 'utf8'));
const ev = (e) => [e.midi, e.slot, e.dur, e.vel == null ? 0 : e.vel];
const ons = (events) => events.filter(e => e.type === 'on');
const sortEvs = (a, b) => a[1] - b[1] || a[0] - b[0];

/** Drive a Player the way the transport does: seek on the first tick, then tick. */
function run(seq, cols) {
    const player = createPlayer(seq);
    const out = { events: {}, cols: {}, seams: [], wraps: {} };
    let prev = null;
    for (let raw = 0; raw < cols; raw++) {
        if (raw === 0) player.start(seq.columnForTick(0));
        // A head standing on row 0 with its looped flag just set wrapped here.
        const now = player.positions();
        if (prev) {
            const wrapped = now.filter(h => h.looped && h.row === seq.range.startCol
                && prev.some(o => o.trackId === h.trackId && !(o.looped && o.row === seq.range.startCol)));
            if (wrapped.length) out.wraps[raw] = wrapped.map(h => h.trackId);
        }
        prev = now;
        const step = player.tick();
        const evs = ons(step.events).map(ev).sort(sortEvs);
        if (evs.length) out.events[raw] = evs;
        if (step.col !== raw) out.cols[raw] = step.col;
        if (step.seam) out.seams.push(raw);
    }
    return out;
}

describe('the Player keeps the phase-0 contract', () => {
    for (const fx of fixtures()) {
        test(fx.name + (fx.delta ? ' (the agreed delta)' : ' (as today)'), () => {
            const g = golden(fx.name);
            const seq = sequenceOf(fx.make());
            if (!fx.delta) {
                const got = run(seq, fx.cols);
                assert.deepEqual(got.events, g.today.events, 'events, tick by tick');
                assert.deepEqual(got.cols, g.today.cols, 'the outer column reported');
                return;
            }
            // Delta: the reference walk ends at the transition; the Player
            // then starts the Section again — so compare up to it, and
            // expect the seam on the tick after.
            const T = g.player.transitionAt;
            const got = run(seq, T + 2);
            const upTo = Object.fromEntries(Object.entries(got.events).filter(([c]) => Number(c) <= T));
            assert.deepEqual(upTo, g.player.events, 'events, tick by tick, under the per-track loop');
            assert.deepEqual(got.wraps, g.player.wraps, 'short tracks wrap where the reference says');
            assert.deepEqual(got.seams, [T + 1], 'the Section restarts right after the transition');
        });
    }
});

// --- Fixtures for the rest ---

const N = (midi, start, dur) => ({ midi, start, dur });

function mixed() {
    const p = createProject({ name: 'P' });
    const s = p.sections[0];
    const a = addTrack(p, { id: 'tA', slot: 0 });
    const b = addTrack(p, { id: 'tB', slot: 1 });
    const pa = addPattern(p, { id: 'pA', notes: [N(60, 0, 4)] });
    const pb = addPattern(p, { id: 'pB', measures: 2, notes: [N(36, 0, 4), N(38, 16, 4)] });
    addClip(p, s, { id: 'cA', trackId: a.id, patternId: pa.id, startCol: 0 });
    addClip(p, s, { id: 'cB', trackId: b.id, patternId: pb.id, startCol: 0 });
    return { p, s, seq: createSectionSequence(p, s) };
}

describe('heads, loop and transition', () => {
    test('equal tracks leave together: the transition is the last row, the next tick is row 0 with a seam', () => {
        const p = createProject({ name: 'P' });
        const s = p.sections[0];
        const t = addTrack(p, { id: 'tA', slot: 0 });
        const pat = addPattern(p, { id: 'pA', notes: [N(60, 0, 4)] });
        addClip(p, s, { id: 'cA', trackId: t.id, patternId: pat.id, startCol: 0 });
        const player = createPlayer(createSectionSequence(p, s));
        player.start(0);
        const cols = [];
        for (let i = 0; i < 18; i++) { const st = player.tick(); cols.push([st.col, st.seam]); }
        assert.deepEqual(cols.slice(14), [[14, false], [15, false], [0, true], [1, false]]);
    });

    test('a short track wraps to row 0 and is looped; the long one, unlooped at its last row, ends the Section', () => {
        const { seq } = mixed();
        const player = createPlayer(seq);
        player.start(0);
        for (let i = 0; i < 16; i++) player.tick();
        assert.deepEqual(player.positions(), [
            { trackId: 'tA', slot: 0, row: 0, looped: true, stopped: false },
            { trackId: 'tB', slot: 1, row: 16, looped: false, stopped: false },
        ]);
        assert.deepEqual(ons(player.tick().events).map(e => e.midi).sort(), [38, 60], 'both sound at column 16');
        for (let i = 17; i < 32; i++) player.tick();
        const st = player.tick();
        assert.equal(st.seam, true, 'column 32 is the Section again');
        assert.deepEqual(player.positions().map(h => h.looped), [false, false], 'looped status cleared');
    });

    test('a track with no clip in the scope has no head and does not block the transition', () => {
        const { p, s } = mixed();
        addTrack(p, { id: 'tC', slot: 2 });                  // nothing placed
        const player = createPlayer(createSectionSequence(p, s));
        player.start(0);
        assert.deepEqual(player.positions().map(h => h.trackId), ['tA', 'tB']);
        for (let i = 0; i < 32; i++) player.tick();
        assert.equal(player.tick().seam, true);
    });

    test('seek lands the heads where a run from the top would: the short track already looped', () => {
        const { seq } = mixed();
        const player = createPlayer(seq);
        player.start(20);
        assert.deepEqual(player.positions(), [
            { trackId: 'tA', slot: 0, row: 4, looped: true, stopped: false },
            { trackId: 'tB', slot: 1, row: 20, looped: false, stopped: false },
        ]);
        assert.equal(player.col(), 20);
        // The same events a run from 0 would give at 20.
        const ref = createPlayer(seq);
        ref.start(0);
        let at20 = null;
        for (let i = 0; i <= 20; i++) at20 = ref.tick();
        assert.deepEqual(ons(player.tick().events).map(ev), ons(at20.events).map(ev));
    });

    test('a range (the section loop) scopes the heads: row 0 is its first column and every end is clipped to it', () => {
        const { p, s } = mixed();
        s.loop = { start: 1, end: 2 };                        // columns 16–31
        const player = createPlayer(createSectionSequence(p, s));
        player.start(16);
        // tA's clip ends at 16: nothing of it lies in the range, so it has no head.
        assert.deepEqual(player.positions(), [{ trackId: 'tB', slot: 1, row: 16, looped: false, stopped: false }]);
        const first = player.tick();
        assert.deepEqual(ons(first.events).map(e => e.midi), [38]);
        for (let i = 17; i < 32; i++) player.tick();
        const st = player.tick();
        assert.equal(st.col, 16, 'wrapped to the loop start');
        assert.equal(st.seam, true);
    });

    test('a scope with nothing placed keeps a silent clock wrapping on the range', () => {
        const p = createProject({ name: 'P' });
        const s = p.sections[0];
        const t = addTrack(p, { id: 'tA', slot: 0 });
        const pat = addPattern(p, { id: 'pA', notes: [] });
        addClip(p, s, { id: 'cA', trackId: t.id, patternId: pat.id, startCol: 0 });
        // A pattern-mode window past every clip: a range with nothing in it.
        const player = createPlayer(createSectionSequence(p, s, { range: { startCol: 32, endCol: 48 } }));
        player.start(32);
        assert.deepEqual(player.positions(), []);
        for (let i = 0; i < 16; i++) player.tick();
        assert.equal(player.tick().col, 32);
    });

    test('locate() reports each track where its own head is', () => {
        const { seq } = mixed();
        const player = createPlayer(seq);
        player.start(20);
        const here = player.locate();
        assert.equal(here.col, 20);
        assert.equal(here.tracks.tA.patternCol, 4, 'the looped track reads its real pattern column');
        assert.equal(here.tracks.tB.patternCol, 20);
    });
});

describe('explicit note-offs (phase 2)', () => {
    function oneTrack(notes, measures = 1) {
        const p = createProject({ name: 'P' });
        const s = p.sections[0];
        const t = addTrack(p, { id: 'tA', slot: 0 });
        const pat = addPattern(p, { id: 'pA', measures, notes });
        addClip(p, s, { id: 'cA', trackId: t.id, patternId: pat.id, startCol: 0 });
        return createPlayer(createSectionSequence(p, s));
    }

    test('a note goes off exactly dur ticks after its on', () => {
        const player = oneTrack([N(60, 0, 4), N(62, 8, 1)]);
        player.start(0);
        const log = [];
        for (let i = 0; i < 12; i++) {
            const st = player.tick();
            for (const e of st.events) log.push([i, e.type, e.midi]);
        }
        assert.deepEqual(log, [[0, 'on', 60], [4, 'off', 60], [8, 'on', 62], [9, 'off', 62]]);
    });

    test('the transition flushes everything sounding, the offs ahead of the new row 0', () => {
        // The note's tail (dur 8 from row 12) would ring past the wrap.
        const player = oneTrack([N(60, 12, 8)]);
        player.start(0);
        let seamEvents = null;
        for (let i = 0; i < 17; i++) {
            const st = player.tick();
            if (st.seam) seamEvents = st.events;
        }
        assert.ok(seamEvents, 'wrapped');
        assert.deepEqual(seamEvents.map(e => [e.type, e.midi]), [['off', 60]],
            'cut at the Section transition — the one synthetic off');
        assert.deepEqual(player.sounding(), [], 'nothing left sounding');
    });

    test('a retriggered pitch keeps one sounding entry, its off at the later time', () => {
        const player = oneTrack([{ midi: 60, start: 0, dur: 8 }, { midi: 60, start: 2, dur: 4, lane: 1 }]);
        player.start(0);
        const log = [];
        for (let i = 0; i < 8; i++) {
            const st = player.tick();
            for (const e of st.events) log.push([i, e.type]);
        }
        // On at 0, the retrigger at 2 supersedes (the output cuts, no off
        // event between), one off when the second note ends.
        assert.deepEqual(log, [[0, 'on'], [2, 'on'], [6, 'off']]);
    });

    test('a seek does not cut what sounds; adopt() hands the notes to a rebuilt Player', () => {
        // The off counts real ticks, not columns: a seek moves the head,
        // never the note's remaining time.
        const player = oneTrack([N(60, 0, 12)], 2);
        player.start(0);
        player.tick();                                  // on at 0 (12 ticks left)
        player.start(4);                                // a jump — no off
        assert.deepEqual(player.tick().events.map(e => e.type), [], 'still sounding');
        const heir = oneTrack([N(60, 0, 12)], 2);
        heir.adopt(player.sounding());                  // 10 ticks left
        heir.start(10);
        const offAt = [];
        for (let i = 0; i < 14; i++) {
            const st = heir.tick();                     // columns 10, 11, …
            for (const e of st.events) if (e.type === 'off') offAt.push(st.col);
        }
        assert.deepEqual(offAt, [20], 'the adopted note runs out its 10 remaining ticks');
    });
});

describe('commands from the effects column (phase 4)', () => {
    /** Two tracks: A one bar (slot 0), B two bars (slot 1); commands on A unless said. */
    function withFx(fx, { onB = false } = {}) {
        const p = createProject({ name: 'P' });
        const s = p.sections[0];
        const a = addTrack(p, { id: 'tA', slot: 0 });
        const b = addTrack(p, { id: 'tB', slot: 1 });
        const pa = addPattern(p, { id: 'pA', notes: [N(60, 0, 1), N(62, 4, 1), N(64, 8, 1), N(65, 12, 1)] });
        const pb = addPattern(p, { id: 'pB', measures: 2, notes: [N(36, 0, 1)] });
        addClip(p, s, { id: 'cA', trackId: a.id, patternId: pa.id, startCol: 0 });
        addClip(p, s, { id: 'cB', trackId: b.id, patternId: pb.id, startCol: 0 });
        s.fx = { [onB ? 'tB' : 'tA']: fx };
        return createPlayer(createSectionSequence(p, s));
    }
    const rowOf = (player, id) => player.positions().find(h => h.trackId === id);
    const onsOf = (st, slot) => st.events.filter(e => e.type === 'on' && e.slot === slot).map(e => e.midi);

    test('jump (B): the row fires, then the head goes to row N; backwards is a loop', () => {
        const player = withFx([{ row: 8, cmd: 'B', arg: 4 }]);
        player.start(0);
        const log = [];
        for (let i = 0; i < 14; i++) { const st = player.tick(); log.push([rowOf(player, 'tA').row, onsOf(st, 0)]); }
        // Fired rows: 0 … 8 (64), then 4 (62), 5, 6, 7, 8 (64) — the head read after each tick is the next row.
        assert.deepEqual(log.map(l => l[1]).flat(), [60, 62, 64, 62, 64]);
        assert.equal(rowOf(player, 'tA').looped, true, 'a backward jump counts as a loop');
        assert.equal(rowOf(player, 'tB').looped, false);
    });

    test('a looping jump on the short track does not hold the Section: B still ends it at its last row', () => {
        const player = withFx([{ row: 8, cmd: 'B', arg: 4 }]);
        player.start(0);
        let seamAt = null;
        for (let i = 0; i < 40 && seamAt == null; i++) { const st = player.tick(); if (st.seam) seamAt = i; }
        assert.equal(seamAt, 32, 'B (two bars, unlooped) arrives at its last row at 31');
    });

    test('a jump on the long track lengthens the Section: the others keep looping meanwhile', () => {
        const player = withFx([{ row: 24, cmd: 'B', arg: 16 }], { onB: true });  // B: 24 → 16, forever
        player.start(0);
        let seams = 0;
        let aWraps = 0;
        let prev = 0;
        for (let i = 0; i < 100; i++) {
            const st = player.tick();
            if (st.seam) seams++;
            const r = rowOf(player, 'tA').row;
            if (r < prev) aWraps++;
            prev = r;
        }
        assert.equal(seams, 0, 'B never reaches its last row unlooped');
        assert.ok(aWraps >= 5, 'A loops on its own meanwhile');
    });

    test('back (R) and skip (K) move by rows; skip past the end wraps', () => {
        const player = withFx([{ row: 4, cmd: 'R', arg: 3 }, { row: 13, cmd: 'K', arg: 10 }]);
        player.start(0);
        const rows = [];
        for (let i = 0; i < 8; i++) { player.tick(); rows.push(rowOf(player, 'tA').row); }
        // after rows 0,1,2,3 fire the head is at 1,2,3,4; row 4 fires → back 3 → row 2
        assert.deepEqual(rows, [1, 2, 3, 4, 2, 3, 4, 2]);
        assert.equal(rowOf(player, 'tA').looped, true);
        const p2 = withFx([{ row: 13, cmd: 'K', arg: 10 }]);
        p2.start(13);
        p2.tick();                                         // row 13 fires, skip 10 → past 16: wrap
        assert.equal(rowOf(p2, 'tA').row, 0);
        assert.equal(rowOf(p2, 'tA').looped, true);
    });

    test('stop (S): the head rests, arms nothing, and counts as satisfied for the transition', () => {
        const player = withFx([{ row: 4, cmd: 'S', arg: 0 }]);
        player.start(0);
        const fired = [];
        let seamAt = null;
        for (let i = 0; i < 34; i++) {
            const st = player.tick();
            fired.push(...onsOf(st, 0));
            if (st.seam && seamAt == null) seamAt = i;
        }
        assert.deepEqual(fired.slice(0, 2), [60, 62], 'rows 0–4 fired, nothing after');
        assert.equal(rowOf(player, 'tA').stopped, false, 'realigned: the next Section clears it');
        assert.equal(seamAt, 32, 'B alone decides, A is satisfied');
        // Every head stopped: the Section ends at once.
        const all = withFx([{ row: 2, cmd: 'S', arg: 0 }]);
        all.start(0);
        all.tick(); all.tick(); all.tick();                 // rows 0, 1, 2 fire; A stops
        assert.equal(rowOf(all, 'tA').stopped, true);
    });

    test('break (D): the Section ends after this row, whatever the heads say', () => {
        const player = withFx([{ row: 5, cmd: 'D', arg: 0 }]);
        player.start(0);
        const log = [];
        for (let i = 0; i < 8; i++) { const st = player.tick(); log.push([st.col, st.seam]); }
        assert.deepEqual(log, [[0, false], [1, false], [2, false], [3, false], [4, false], [5, false], [0, true], [1, false]]);
    });

    test('seek replays the walk with its commands: the same rows a run from the top reaches', () => {
        const fx = [{ row: 8, cmd: 'B', arg: 4 }];
        const run = withFx(fx);
        run.start(0);
        for (let i = 0; i < 20; i++) run.tick();
        const sought = withFx(fx);
        sought.start(20);
        assert.deepEqual(sought.positions(), run.positions());
    });

    test('snapshot/restore carries the heads into a rebuilt Player, commands and all', () => {
        const fx = [{ row: 8, cmd: 'B', arg: 4 }];
        const a = withFx(fx);
        a.start(0);
        for (let i = 0; i < 11; i++) a.tick();
        const b = withFx(fx);
        assert.equal(b.restore(a.snapshot()), true);
        assert.deepEqual(b.positions(), a.positions());
        const next = [a.tick(), b.tick()];
        assert.deepEqual(onsOf(next[1], 0), onsOf(next[0], 0), 'the same row fires next');
        assert.equal(b.restore(null), false);
    });
});

describe('the piece', () => {
    function piece() {
        const p = createProject({ name: 'P' });
        const verse = p.sections[0];
        verse.id = 'secV';
        const t = addTrack(p, { id: 'tA', slot: 0 });
        const pv = addPattern(p, { id: 'pV', notes: [N(60, 0, 4)] });
        addClip(p, verse, { id: 'cV', trackId: t.id, patternId: pv.id, startCol: 0 });
        const chorus = addSection(p, { id: 'secC', name: 'C' }, { place: false });
        const pc = addPattern(p, { id: 'pC', measures: 2, notes: [N(72, 0, 4)] });
        addClip(p, chorus, { id: 'cC', trackId: t.id, patternId: pc.id, startCol: 0 });
        p.arrangement = [{ id: 'e1', sectionId: 'secV', repeats: 2 }, { id: 'e2', sectionId: 'secC' }];
        return createPieceSequence(p);
    }

    test('passes and parts follow in order, each starting at row 0 with a seam, and the piece comes round', () => {
        const player = createPlayer(piece());
        player.start(0);
        const log = [];
        for (let i = 0; i < 66; i++) {
            const st = player.tick();
            if (st.seam || i === 0) log.push([i, st.col, player.where()]);
        }
        // where() is read after the tick, i.e. for the row now armed — so
        // it names the scope the *next* tick plays; the seam marks the
        // first tick of each pass.
        assert.deepEqual(log.map(([i, col]) => [i, col]), [[0, 0], [16, 16], [32, 32], [64, 0]]);
        assert.deepEqual(player.where(), { part: 0, pass: 0 }, 'round again');
    });

    test('seek into a later pass or part lands in it', () => {
        const player = createPlayer(piece());
        player.start(20);
        assert.deepEqual(player.where(), { part: 0, pass: 1 });
        assert.equal(player.col(), 20);
        player.start(40);
        assert.deepEqual(player.where(), { part: 1, pass: 0 });
        assert.deepEqual(ons(player.tick().events).map(e => e.midi), [], 'column 8 of the chorus: silent');
        player.start(32);
        assert.deepEqual(ons(player.tick().events).map(e => e.midi), [72]);
    });
});
