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
        const evs = step.events.map(ev).sort(sortEvs);
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
            { trackId: 'tA', slot: 0, row: 0, looped: true },
            { trackId: 'tB', slot: 1, row: 16, looped: false },
        ]);
        assert.deepEqual(player.tick().events.map(e => e.midi).sort(), [38, 60], 'both sound at column 16');
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
            { trackId: 'tA', slot: 0, row: 4, looped: true },
            { trackId: 'tB', slot: 1, row: 20, looped: false },
        ]);
        assert.equal(player.col(), 20);
        // The same events a run from 0 would give at 20.
        const ref = createPlayer(seq);
        ref.start(0);
        let at20 = null;
        for (let i = 0; i <= 20; i++) at20 = ref.tick();
        assert.deepEqual(player.tick().events.map(ev), at20.events.map(ev));
    });

    test('a range (the section loop) scopes the heads: row 0 is its first column and every end is clipped to it', () => {
        const { p, s } = mixed();
        s.loop = { start: 1, end: 2 };                        // columns 16–31
        const player = createPlayer(createSectionSequence(p, s));
        player.start(16);
        // tA's clip ends at 16: nothing of it lies in the range, so it has no head.
        assert.deepEqual(player.positions(), [{ trackId: 'tB', slot: 1, row: 16, looped: false }]);
        const first = player.tick();
        assert.deepEqual(first.events.map(e => e.midi), [38]);
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
        assert.deepEqual(player.tick().events.map(e => e.midi), [], 'column 8 of the chorus: silent');
        player.start(32);
        assert.deepEqual(player.tick().events.map(e => e.midi), [72]);
    });
});
