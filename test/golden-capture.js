// Player phase 0 — the golden capture (SESSION.md › Player and per-track
// Playheads). What today's sequencers emit, per column, over fixture
// projects: events, the tick → column mapping, and the playhead positions.
// The goldens live in test/golden/*.json; golden-playback.test.js holds the
// phases to them, and `npm run golden:update` rewrites them (do that
// only when a change in output is *intended* and say so in the commit).
//
// Every id is fixed by hand so the capture is stable run to run.
//
// For the mixed-length fixtures the golden also carries the **expected
// delta** under the per-track loop rule agreed 2026-11-17 — `player`,
// beside `today` — computed by a tiny reference simulation of the rule:
// a head that reaches the end of its track's last clip wraps to row 0 and
// is `looped`; the Section ends when a head arrives at its last row not
// yet looped while every other active head has looped, is stopped, or is
// itself at its last row on the same tick. The cut is exact, never
// bar-rounded. Phase 1 must match `player`; everything else must match
// `today`.

import {
    createProject, addTrack, addPattern, addClip, addSection,
    COLS_PER_MEASURE, clipCols, getPattern,
} from '../html/components/project-model.js';
import {
    createSectionSequence, createPieceSequence, createPatternSequence,
    patternPlacements, nearestPlacement,
} from '../html/synth/section-sequencer.js';

const N = (midi, start, dur, vel) => (vel == null ? { midi, start, dur } : { midi, start, dur, vel });

/** One event, compact and order-stable: [midi, slot, dur, vel (0 = none)]. */
const ev = (e) => [e.midi, e.slot, e.dur, e.vel == null ? 0 : e.vel];
const sortEvs = (a, b) => a[1] - b[1] || a[0] - b[0];

/**
 * Drive a sequence the way the transport does — rawCol 0..cols-1 through
 * columnForTick, then eventsAt — and note where the playhead says it is.
 * Only columns where something fires carry an `events` entry; `locate` is
 * sampled where the per-track positions change shape.
 */
export function capture(seq, cols) {
    const out = { kind: seq.kind, length: seq.length, range: seq.range, events: {}, cols: {}, locate: {} };
    let lastLoc = null;
    for (let raw = 0; raw < cols; raw++) {
        const col = seq.columnForTick(raw);
        if (col !== raw) out.cols[raw] = col;
        const evs = seq.eventsAt(col).map(ev).sort(sortEvs);
        if (evs.length) out.events[raw] = evs;
        if (seq.locate) {
            const here = seq.locate(col);
            const loc = JSON.stringify(here);
            if (loc !== lastLoc) { out.locate[raw] = here; lastLoc = loc; }
        }
    }
    return out;
}

// --- Fixtures ---

function project() {
    return createProject({ name: 'Golden' });
}

/** A track with a pattern placed; everything id-pinned. */
function put(p, section, { slot, track, pattern, measures = 1, notes, at = 0, clip, repeats, lengthCols, divider }) {
    const t = addTrack(p, { id: track, name: track, slot });
    if (divider) t.divider = divider;
    const pat = addPattern(p, { id: pattern, name: pattern, measures, notes });
    const c = { id: clip, trackId: t.id, patternId: pat.id, startCol: at };
    if (lengthCols != null) c.lengthCols = lengthCols; else c.repeats = repeats || 1;
    addClip(p, section, c);
    return { t, pat };
}

export function fixtures() {
    const all = [];

    // 1. Two equal one-bar tracks: a chord with velocities, legato, an OFF.
    all.push({
        name: 'section-basic', cols: 40,
        make() {
            const p = project();
            const s = p.sections[0];
            put(p, s, {
                slot: 0, track: 'tA', pattern: 'pA', clip: 'cA',
                notes: [N(60, 0, 4, 42), N(64, 0, 4), N(67, 4, 4, 127), N(60, 8, 8)],
            });
            put(p, s, {
                slot: 1, track: 'tB', pattern: 'pB', clip: 'cB',
                notes: [N(36, 0, 16, 90)],
            });
            return createSectionSequence(p, s);
        },
    });

    // 2. Track speeds (stored as `divider`): ½× over a one-bar clip, ¼× over
    // a two-bar clip. The sequence speaks rows (`today` ignores speed); the
    // reference walk holds each row for the track's ticks: the ½× track
    // takes two bars, loops, and the ¼× one ends the Section at tick 127.
    all.push({
        name: 'section-divider', cols: 48, delta: true,
        make() {
            const p = project();
            const s = p.sections[0];
            put(p, s, {
                slot: 0, track: 'tA', pattern: 'pA', clip: 'cA', divider: 2,
                notes: [N(60, 0, 2), N(62, 2, 2), N(64, 4, 4)],
            });
            put(p, s, {
                slot: 1, track: 'tB', pattern: 'pB', clip: 'cB', divider: 4, measures: 2,
                notes: [N(40, 0, 1), N(43, 1, 1)],
            });
            return { seq: createSectionSequence(p, s), project: p, section: s };
        },
    });

    // 3. A section loop range (bar 2 of a two-bar arrangement).
    all.push({
        name: 'section-loop-range', cols: 48,
        make() {
            const p = project();
            const s = p.sections[0];
            put(p, s, {
                slot: 0, track: 'tA', pattern: 'pA', clip: 'cA', measures: 2,
                notes: [N(60, 0, 4), N(62, 16, 4), N(64, 28, 4)],
            });
            s.loop = { start: 1, end: 2 };
            return createSectionSequence(p, s);
        },
    });

    // 4. A clip cut mid-pattern and one spelled in repeats: the cut takes
    // notes (and note tails) with it. Mixed lengths (12 against 32): delta.
    all.push({
        name: 'section-cut-and-repeats', cols: 48, delta: true,
        make() {
            const p = project();
            const s = p.sections[0];
            put(p, s, {
                slot: 0, track: 'tA', pattern: 'pA', clip: 'cA', lengthCols: 12,
                notes: [N(60, 0, 4), N(62, 8, 8), N(64, 14, 2)],
            });
            put(p, s, {
                slot: 1, track: 'tB', pattern: 'pB', clip: 'cB', repeats: 2,
                notes: [N(36, 0, 4), N(38, 12, 4)],
            });
            return { seq: createSectionSequence(p, s), project: p, section: s };
        },
    });

    // 5. Mute and solo are read live: the same project, three ways.
    for (const [variant, setup] of [
        ['mute', (p) => { p.tracks[0].mute = true; }],
        ['solo', (p) => { p.tracks[1].solo = true; }],
    ]) {
        all.push({
            name: 'section-' + variant, cols: 16,
            make() {
                const p = project();
                const s = p.sections[0];
                put(p, s, { slot: 0, track: 'tA', pattern: 'pA', clip: 'cA', notes: [N(60, 0, 4)] });
                put(p, s, { slot: 1, track: 'tB', pattern: 'pB', clip: 'cB', notes: [N(36, 0, 4)] });
                setup(p);
                return createSectionSequence(p, s);
            },
        });
    }

    // 6. The piece: verse ×2 then chorus, end to end, wrapping.
    all.push({
        name: 'piece-repeats', cols: 72,
        make() {
            const p = project();
            const verse = p.sections[0];
            verse.id = 'secV';
            put(p, verse, { slot: 0, track: 'tA', pattern: 'pA', clip: 'cA', notes: [N(60, 0, 4), N(62, 8, 4)] });
            const chorus = addSection(p, { id: 'secC', name: 'Chorus' }, { place: false });
            const pat = addPattern(p, { id: 'pC', name: 'pC', notes: [N(72, 0, 8, 110)] });
            addClip(p, chorus, { id: 'cC', trackId: p.tracks[0].id, patternId: pat.id, startCol: 0 });
            p.arrangement = [
                { id: 'e1', sectionId: 'secV', repeats: 2 },
                { id: 'e2', sectionId: 'secC' },
            ];
            return createPieceSequence(p);
        },
    });

    // 7. A lone pattern (placed nowhere): the roll's loop.
    all.push({
        name: 'pattern-lone', cols: 36,
        make() {
            const p = project();
            const pat = addPattern(p, { id: 'pA', name: 'pA', notes: [N(60, 0, 4, 64), N(64, 12, 4)] });
            return createPatternSequence(pat, 3);
        },
    });

    // 8. Pattern mode over a placement, with and without the accompaniment.
    for (const accompany of [true, false]) {
        all.push({
            name: 'pattern-placed-' + (accompany ? 'accompanied' : 'alone'), cols: 32,
            make() {
                const p = project();
                const s = p.sections[0];
                const a = put(p, s, {
                    slot: 0, track: 'tA', pattern: 'pA', clip: 'cA', at: 16,
                    notes: [N(60, 0, 4), N(62, 4, 4)],
                });
                put(p, s, { slot: 1, track: 'tB', pattern: 'pB', clip: 'cB', repeats: 2, notes: [N(36, 0, 16)] });
                const places = patternPlacements(p, s, a.pat.id);
                const placement = nearestPlacement(places, 0);
                return createSectionSequence(p, s, {
                    onlyTrackId: accompany ? null : 'tA',
                    range: { startCol: placement.startCol, endCol: placement.endCol },
                });
            },
        });
    }

    // 9–10. Mixed lengths — the fixtures whose behaviour phase 1 *changes*:
    // these carry a `player` golden beside `today` (see reference()).
    all.push({
        name: 'delta-mixed-length', cols: 32, delta: true,
        make() {
            const p = project();
            const s = p.sections[0];
            put(p, s, { slot: 0, track: 'tA', pattern: 'pA', clip: 'cA', notes: [N(60, 0, 4), N(64, 8, 4)] });
            put(p, s, {
                slot: 1, track: 'tB', pattern: 'pB', clip: 'cB', measures: 2,
                notes: [N(36, 0, 8), N(38, 16, 8, 72)],
            });
            return { seq: createSectionSequence(p, s), project: p, section: s };
        },
    });
    all.push({
        name: 'delta-polyrhythm', cols: 48, delta: true,
        make() {
            const p = project();
            const s = p.sections[0];
            // A 12-column cut against a full bar ×2: 3 against 4.
            put(p, s, { slot: 0, track: 'tA', pattern: 'pA', clip: 'cA', lengthCols: 12, notes: [N(60, 0, 4), N(62, 6, 4)] });
            put(p, s, { slot: 1, track: 'tB', pattern: 'pB', clip: 'cB', repeats: 2, notes: [N(36, 0, 4), N(40, 8, 4)] });
            return { seq: createSectionSequence(p, s), project: p, section: s };
        },
    });

    return all;
}

// --- The reference simulation of the per-track loop rule (delta fixtures) ---

/** The end (exclusive) of a track's last clip in the section — exact, never bar-rounded. */
function trackEnd(project, section, trackId) {
    let end = 0;
    for (const clip of section.clips) {
        if (clip.trackId !== trackId) continue;
        const span = clipCols(clip, getPattern(project, clip.patternId));
        if (span && span.endCol > end) end = span.endCol;
    }
    return end;
}

/**
 * Walk one pass of the Section under the agreed rule and record what each
 * column fires. Heads advance together, one row per tick — or one row per
 * n ticks for a track at 1/n speed (`ticksPerRow`), its notes gathered on
 * the row's first tick and lasting n times as many ticks; a head whose
 * track ends wraps to row 0 and is `looped`; the pass ends on the tick an
 * unlooped head sits on its last row while every other active head has
 * looped or sits on its own last row. Events come from the section
 * sequence at each head's own position, filtered to its track.
 */
export function reference(seq, project, section) {
    const tracks = project.tracks
        .map(t => ({ id: t.id, end: trackEnd(project, section, t.id) }))
        .filter(t => t.end > 0);                       // inactive tracks take no part
    const out = { events: {}, wraps: {}, transitionAt: null };
    const pos = new Map(tracks.map(t => [t.id, 0]));
    const phase = new Map(tracks.map(t => [t.id, 0]));
    const tpr = (t) => (seq.ticksPerRow ? seq.ticksPerRow(t.id) : 1);
    const looped = new Set();
    for (let col = 0; col < 4096; col++) {
        const evs = [];
        for (const t of tracks) {
            if (phase.get(t.id) !== 0) continue;
            for (const e of seq.eventsAt(pos.get(t.id))) {
                if (e.trackId === t.id) evs.push(ev({ ...e, dur: e.dur * tpr(t) }));
            }
        }
        evs.sort(sortEvs);
        if (evs.length) out.events[col] = evs;
        // The transition check, with this head on its last row (its last
        // tick there) counting its colleagues' same-tick arrival as satisfied.
        const atLast = (t) => pos.get(t.id) === t.end - 1 && phase.get(t.id) === tpr(t) - 1;
        const triggers = tracks.some(t => atLast(t) && !looped.has(t.id)
            && tracks.every(o => o === t || looped.has(o.id) || atLast(o)));
        if (triggers) { out.transitionAt = col; break; }
        for (const t of tracks) {
            if (phase.get(t.id) + 1 < tpr(t)) { phase.set(t.id, phase.get(t.id) + 1); continue; }
            phase.set(t.id, 0);
            const next = pos.get(t.id) + 1;
            if (next >= t.end) {
                pos.set(t.id, 0);
                looped.add(t.id);
                if (!out.wraps[col + 1]) out.wraps[col + 1] = [];
                out.wraps[col + 1].push(t.id);
            } else {
                pos.set(t.id, next);
            }
        }
    }
    return out;
}

/** The sequence a fixture plays, whatever shape make() returns. */
export function sequenceOf(made) {
    return made && made.seq ? made.seq : made;
}

/** The full golden for one fixture. */
export function captureFixture(fx) {
    const made = fx.make();
    if (!fx.delta) return { today: capture(made, fx.cols) };
    const { seq, project: p, section } = made;
    return { today: capture(seq, fx.cols), player: reference(seq, p, section) };
}
