// Sequencer core: "what starts at column N, on which slot".
//
// The contract the transport (phase 5) and both editors (phases 3/4) build
// on, so the edges are the point: clip offsets and repeats, the loop seam,
// mute/solo read live, patterns snapshotted at compile time, dangling
// references ignored.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let S, M;

before(async () => {
    installBrowserEnv();
    M = await import('../html/components/song-model.js');
    S = await import('../html/synth/sequencer.js');
});

beforeEach(() => localStorage.clear());

const note = (midi, start, dur = 1) => ({ midi, start, dur });

// A tiny in-memory pattern library; getPattern never touches localStorage here.
function lib(...patterns) {
    const map = new Map(patterns.map(p => [p.id, p]));
    return (id) => map.get(id) || null;
}

const P1 = () => M.createPattern({ id: 'p1', measures: 1, notes: [note(60, 0, 2), note(64, 4), note(67, 15)] });
const P2 = () => M.createPattern({ id: 'p2', measures: 2, notes: [note(48, 0, 4), note(50, 20, 1)] });

function song(partial) {
    return M.createSong({
        tracks: [{ id: 't1', slot: 0 }, { id: 't2', slot: 3 }],
        ...partial,
    });
}

const firing = (seq, col) => seq.eventsAt(col).map(e => [e.midi, e.slot]).sort();

describe('audibleTrackIds', () => {
    const t = (id, flags = {}) => M.createTrack({ id, ...flags });

    test('nothing flagged: everyone plays', () => {
        assert.deepEqual([...S.audibleTrackIds([t('a'), t('b')])].sort(), ['a', 'b']);
    });

    test('mute removes a track', () => {
        assert.deepEqual([...S.audibleTrackIds([t('a', { mute: true }), t('b')])], ['b']);
    });

    test('any solo isolates the soloed tracks', () => {
        assert.deepEqual([...S.audibleTrackIds([t('a'), t('b', { solo: true }), t('c', { solo: true })])].sort(), ['b', 'c']);
    });

    test('solo beats mute on the same track', () => {
        assert.deepEqual([...S.audibleTrackIds([t('a', { mute: true, solo: true }), t('b')])], ['a']);
    });

    test('everything muted is silence, not everything', () => {
        assert.equal(S.audibleTrackIds([t('a', { mute: true }), t('b', { mute: true })]).size, 0);
    });
});

describe('playbackRange / wrapToRange', () => {
    test('no loop: the whole song', () => {
        assert.deepEqual(S.playbackRange(M.createSong(), 3), { startCol: 0, endCol: 48 });
    });

    test('a loop range wins, in columns', () => {
        assert.deepEqual(S.playbackRange(M.createSong({ loop: { start: 1, end: 3 } }), 8), { startCol: 16, endCol: 48 });
    });

    test('a loop past the end of the song is honoured (silence is a choice)', () => {
        assert.deepEqual(S.playbackRange(M.createSong({ loop: { start: 4, end: 6 } }), 2), { startCol: 64, endCol: 96 });
    });

    test('an empty song without a loop has nothing to play', () => {
        assert.equal(S.playbackRange(M.createSong(), 0), null);
    });

    test('the worker count wraps inside the range', () => {
        const r = { startCol: 16, endCol: 48 };
        assert.equal(S.wrapToRange(0, r), 16);
        assert.equal(S.wrapToRange(31, r), 47);
        assert.equal(S.wrapToRange(32, r), 16, 'seam');
        assert.equal(S.wrapToRange(32 * 5 + 3, r), 19);
        assert.equal(S.wrapToRange(-1, r), 47, 'a negative count still lands inside');
    });
});

describe('createSongSequence — placement', () => {
    test('a clip at measure 0 fires its notes on the track slot', () => {
        const s = song({ clips: [{ trackId: 't2', patternId: 'p1', startMeasure: 0 }] });
        const seq = S.createSongSequence(s, lib(P1()));
        assert.equal(seq.kind, 'song');
        assert.equal(seq.length, 16);
        assert.deepEqual(seq.range, { startCol: 0, endCol: 16 });
        assert.deepEqual(firing(seq, 0), [[60, 3]]);
        assert.deepEqual(firing(seq, 4), [[64, 3]]);
        assert.deepEqual(firing(seq, 15), [[67, 3]]);
        assert.deepEqual(firing(seq, 1), [], 'a sustained note does not re-fire');
    });

    test('events carry duration in columns and the ids the UI needs', () => {
        const s = song({ clips: [{ id: 'c1', trackId: 't1', patternId: 'p1', startMeasure: 0 }] });
        const [e] = S.createSongSequence(s, lib(P1())).eventsAt(0);
        assert.deepEqual(e, {
            midi: 60, dur: 2, slot: 0, trackId: 't1', clipId: 'c1', patternId: 'p1',
            note: { midi: 60, start: 0, dur: 2 },
        });
    });

    test('a clip at measure 2 is offset by 32 columns', () => {
        const s = song({ clips: [{ trackId: 't1', patternId: 'p1', startMeasure: 2 }] });
        const seq = S.createSongSequence(s, lib(P1()));
        assert.equal(seq.length, 48);
        assert.deepEqual(firing(seq, 0), []);
        assert.deepEqual(firing(seq, 32), [[60, 0]]);
        assert.deepEqual(firing(seq, 36), [[64, 0]]);
        assert.deepEqual(firing(seq, 47), [[67, 0]]);
    });

    test('repeats replay the pattern back to back, then stop', () => {
        const s = song({ clips: [{ trackId: 't1', patternId: 'p1', startMeasure: 1, repeats: 3 }] });
        const seq = S.createSongSequence(s, lib(P1()));
        assert.equal(seq.length, 64);
        for (const col of [16, 32, 48]) assert.deepEqual(firing(seq, col), [[60, 0]], `repeat at ${col}`);
        assert.deepEqual(firing(seq, 64 - 1), [[67, 0]], 'last note of the last repeat');
        assert.deepEqual(firing(seq, 0), []);
    });

    test('a multi-measure pattern repeats on its own length, not the bar', () => {
        const s = song({ clips: [{ trackId: 't1', patternId: 'p2', startMeasure: 0, repeats: 2 }] });
        const seq = S.createSongSequence(s, lib(P2()));
        assert.equal(seq.length, 64);
        assert.deepEqual(firing(seq, 20), [[50, 0]]);
        assert.deepEqual(firing(seq, 52), [[50, 0]], '20 + 32');
        assert.deepEqual(firing(seq, 36), [], 'not 20 + 16');
        assert.deepEqual(firing(seq, 32), [[48, 0]]);
    });

    test('the same pattern on two tracks sounds on both slots at once', () => {
        const s = song({ clips: [
            { trackId: 't1', patternId: 'p1', startMeasure: 0 },
            { trackId: 't2', patternId: 'p1', startMeasure: 0 },
        ] });
        assert.deepEqual(firing(S.createSongSequence(s, lib(P1())), 0), [[60, 0], [60, 3]]);
    });

    test('clips on different tracks at different measures interleave', () => {
        const s = song({ clips: [
            { trackId: 't1', patternId: 'p1', startMeasure: 0, repeats: 2 },
            { trackId: 't2', patternId: 'p2', startMeasure: 1 },
        ] });
        const seq = S.createSongSequence(s, lib(P1(), P2()));
        assert.equal(seq.length, 48, 'p2 on t2 ends at measure 3');
        assert.deepEqual(firing(seq, 16), [[48, 3], [60, 0]]);
        assert.deepEqual(firing(seq, 36), [[50, 3]]);
    });

    test('a hand-edited overlap on one track plays both (no crash, no silence)', () => {
        const s = song({ clips: [
            { trackId: 't1', patternId: 'p1', startMeasure: 0 },
            { trackId: 't1', patternId: 'p2', startMeasure: 0 },
        ] });
        assert.deepEqual(firing(S.createSongSequence(s, lib(P1(), P2())), 0), [[48, 0], [60, 0]]);
    });
});

describe('createSongSequence — mute / solo, read live', () => {
    function build() {
        const s = song({ clips: [
            { trackId: 't1', patternId: 'p1', startMeasure: 0 },
            { trackId: 't2', patternId: 'p1', startMeasure: 0 },
        ] });
        return { s, seq: S.createSongSequence(s, lib(P1())) };
    }

    test('mute silences a track on the next column without a rebuild', () => {
        const { s, seq } = build();
        assert.deepEqual(firing(seq, 0), [[60, 0], [60, 3]]);
        s.tracks[0].mute = true;
        assert.deepEqual(firing(seq, 0), [[60, 3]]);
        s.tracks[0].mute = false;
        assert.deepEqual(firing(seq, 0), [[60, 0], [60, 3]]);
    });

    test('solo isolates, and un-solo restores', () => {
        const { s, seq } = build();
        s.tracks[1].solo = true;
        assert.deepEqual(firing(seq, 0), [[60, 3]]);
        s.tracks[1].solo = false;
        assert.deepEqual(firing(seq, 0), [[60, 0], [60, 3]]);
    });

    test('locate still reports muted tracks — the playhead moves over them', () => {
        const { s, seq } = build();
        s.tracks[0].mute = true;
        assert.deepEqual(Object.keys(seq.locate(0).tracks).sort(), ['t1', 't2']);
    });
});

describe('createSongSequence — loop and ticks', () => {
    test('without a loop the worker count wraps over the whole song', () => {
        const s = song({ clips: [{ trackId: 't1', patternId: 'p1', startMeasure: 0, repeats: 2 }] });
        const seq = S.createSongSequence(s, lib(P1()));
        assert.equal(seq.columnForTick(0), 0);
        assert.equal(seq.columnForTick(31), 31);
        assert.equal(seq.columnForTick(32), 0, 'seam back to the start');
        assert.equal(seq.columnForTick(100), 100 % 32);
    });

    test('a loop range confines ticks to it and the events follow', () => {
        const s = song({
            loop: { start: 1, end: 2 },
            clips: [{ trackId: 't1', patternId: 'p1', startMeasure: 0, repeats: 3 }],
        });
        const seq = S.createSongSequence(s, lib(P1()));
        assert.equal(seq.length, 48, 'length is the song, not the loop');
        assert.deepEqual(seq.range, { startCol: 16, endCol: 32 });
        assert.equal(seq.columnForTick(0), 16);
        assert.equal(seq.columnForTick(15), 31);
        assert.equal(seq.columnForTick(16), 16);
        assert.deepEqual(firing(seq, seq.columnForTick(0)), [[60, 0]]);
        assert.deepEqual(firing(seq, seq.columnForTick(4)), [[64, 0]]);
    });

    test('a loop over empty measures plays silence rather than refusing', () => {
        const s = song({ loop: { start: 4, end: 5 }, clips: [{ trackId: 't1', patternId: 'p1', startMeasure: 0 }] });
        const seq = S.createSongSequence(s, lib(P1()));
        assert.deepEqual(seq.range, { startCol: 64, endCol: 80 });
        assert.deepEqual(seq.eventsAt(seq.columnForTick(0)), []);
    });

    test('walking every tick of a song fires every note exactly once per pass', () => {
        const s = song({ clips: [
            { trackId: 't1', patternId: 'p1', startMeasure: 0, repeats: 2 },
            { trackId: 't2', patternId: 'p2', startMeasure: 2 },
        ] });
        const seq = S.createSongSequence(s, lib(P1(), P2()));
        const len = seq.range.endCol - seq.range.startCol;
        const count = {};
        for (let raw = 0; raw < len * 2; raw++) {
            for (const e of seq.eventsAt(seq.columnForTick(raw))) {
                count[`${e.trackId}:${e.midi}`] = (count[`${e.trackId}:${e.midi}`] || 0) + 1;
            }
        }
        // p1 × 2 repeats × 2 passes = 4 each; p2 once × 2 passes = 2 each
        assert.deepEqual(count, { 't1:60': 4, 't1:64': 4, 't1:67': 4, 't2:48': 2, 't2:50': 2 });
    });
});

describe('createSongSequence — robustness', () => {
    test('an empty song is an empty sequence the transport can refuse', () => {
        const seq = S.createSongSequence(M.createSong(), lib());
        assert.equal(seq.length, 0);
        assert.equal(seq.range, null);
        assert.deepEqual(seq.eventsAt(0), []);
        assert.deepEqual(seq.locate(0).tracks, {});
    });

    test('a clip whose pattern is missing is silence and does not count toward length', () => {
        const s = song({ clips: [
            { trackId: 't1', patternId: 'gone', startMeasure: 8 },
            { trackId: 't1', patternId: 'p1', startMeasure: 0 },
        ] });
        const seq = S.createSongSequence(s, lib(P1()));
        assert.equal(seq.length, 16);
        assert.deepEqual(firing(seq, 128), []);
    });

    test('a clip whose track was removed from the object after creation is skipped', () => {
        const s = song({ clips: [{ trackId: 't1', patternId: 'p1', startMeasure: 0 }] });
        s.tracks = s.tracks.filter(t => t.id !== 't1');   // bypass removeTrack on purpose
        const seq = S.createSongSequence(s, lib(P1()));
        assert.equal(seq.length, 0);
        assert.equal(seq.range, null);
    });

    test('patterns are snapshotted: editing the store after compile changes nothing', () => {
        const p = P1();
        const s = song({ clips: [{ trackId: 't1', patternId: 'p1', startMeasure: 0 }] });
        const seq = S.createSongSequence(s, lib(p));
        p.notes.push(note(72, 8));
        p.notes.length = 0;
        assert.deepEqual(firing(seq, 0), [[60, 0]], 'the compile-time notes');
        assert.deepEqual(firing(seq, 8), []);
    });

    test('never reads the pattern store on a tick', () => {
        const s = song({ clips: [{ trackId: 't1', patternId: 'p1', startMeasure: 0, repeats: 4 }] });
        let reads = 0;
        const counting = (id) => { reads++; return lib(P1())(id); };
        const seq = S.createSongSequence(s, counting);
        const after = reads;
        for (let raw = 0; raw < 200; raw++) seq.eventsAt(seq.columnForTick(raw));
        seq.locate(5);
        assert.equal(reads, after, 'getPattern was only called while compiling');
        assert.equal(after, 1, 'and once per clip');
    });
});

describe('createSongSequence — locate', () => {
    test('reports the song measure and the pattern-local column per track', () => {
        const s = song({ clips: [
            { id: 'c1', trackId: 't1', patternId: 'p1', startMeasure: 1, repeats: 2 },
            { id: 'c2', trackId: 't2', patternId: 'p2', startMeasure: 0 },
        ] });
        const seq = S.createSongSequence(s, lib(P1(), P2()));
        const at = seq.locate(37);          // measure 2, col 5
        assert.equal(at.measure, 2);
        assert.equal(at.colInMeasure, 5);
        assert.deepEqual(at.tracks.t1, { clipId: 'c1', patternId: 'p1', patternCol: 5 }, 'second repeat of p1');
        assert.equal(at.tracks.t2, undefined, 'p2 ended at measure 2');
        assert.deepEqual(seq.locate(20).tracks.t2, { clipId: 'c2', patternId: 'p2', patternCol: 20 });
    });

    test('a column with no clips has no tracks', () => {
        const s = song({ clips: [{ trackId: 't1', patternId: 'p1', startMeasure: 2 }] });
        assert.deepEqual(S.createSongSequence(s, lib(P1())).locate(3).tracks, {});
    });
});

describe('createPatternSequence', () => {
    test('loops one pattern on one slot — the piano roll as today', () => {
        const seq = S.createPatternSequence(P1(), 5);
        assert.equal(seq.kind, 'pattern');
        assert.equal(seq.length, 16);
        assert.deepEqual(seq.range, { startCol: 0, endCol: 16 });
        assert.equal(seq.columnForTick(16), 0);
        assert.equal(seq.columnForTick(20), 4);
        assert.deepEqual(firing(seq, 0), [[60, 5]]);
        assert.deepEqual(seq.eventsAt(4)[0], {
            midi: 64, dur: 1, slot: 5, trackId: 'pattern', clipId: null, patternId: 'p1',
            note: { midi: 64, start: 4, dur: 1 },
        });
    });

    test('reads the pattern live — the editor mutates it while it loops', () => {
        const p = P1();
        const seq = S.createPatternSequence(p, 0);
        p.notes.push(note(72, 8));
        assert.deepEqual(firing(seq, 8), [[72, 0]]);
        p.measures = 2;
        assert.equal(seq.length, 32);
        assert.equal(seq.columnForTick(20), 20, 'the loop grew with the pattern');
    });

    test('locate gives the pattern-local column under a fixed key', () => {
        const at = S.createPatternSequence(P2(), 0).locate(20);
        assert.equal(at.measure, 1);
        assert.equal(at.colInMeasure, 4);
        assert.deepEqual(at.tracks.pattern, { clipId: null, patternId: 'p2', patternCol: 20 });
    });

    test('no pattern is an empty sequence', () => {
        const seq = S.createPatternSequence(null, 0);
        assert.equal(seq.length, 0);
        assert.equal(seq.range, null);
        assert.deepEqual(seq.eventsAt(0), []);
    });
});

describe('placements', () => {
    test('one per repeat, one pattern long, sorted by start, across clips and tracks', () => {
        const sg = song({ clips: [
            { id: 'c2', trackId: 't2', patternId: 'p1', startMeasure: 6, repeats: 1 },
            { id: 'c1', trackId: 't1', patternId: 'p1', startMeasure: 1, repeats: 2 },
            { id: 'c3', trackId: 't1', patternId: 'p2', startMeasure: 3, repeats: 1 },
        ] });
        assert.deepEqual(S.patternPlacements(sg, 'p1', lib(P1(), P2())), [
            { clipId: 'c1', trackId: 't1', startCol: 16, endCol: 32 },
            { clipId: 'c1', trackId: 't1', startCol: 32, endCol: 48 },
            { clipId: 'c2', trackId: 't2', startCol: 96, endCol: 112 },
        ]);
        assert.deepEqual(S.patternPlacements(sg, 'p2', lib(P1(), P2())), [
            { clipId: 'c3', trackId: 't1', startCol: 48, endCol: 80 },
        ]);
        assert.deepEqual(S.patternPlacements(sg, 'nope', lib(P1())), []);
    });

    test('nearest: inside wins, else the closer edge, ties to the earlier, no position → first', () => {
        const ps = [{ startCol: 0, endCol: 16 }, { startCol: 64, endCol: 80 }];
        assert.equal(S.nearestPlacement(ps, 5), ps[0]);
        assert.equal(S.nearestPlacement(ps, 70), ps[1]);
        assert.equal(S.nearestPlacement(ps, 50), ps[1]);
        assert.equal(S.nearestPlacement(ps, 39), ps[0], '24 past the first\'s last column vs 25 before the second');
        assert.equal(S.nearestPlacement(ps, 40), ps[1], '25 vs 24');
        const tie = [{ startCol: 0, endCol: 16 }, { startCol: 31, endCol: 47 }];
        assert.equal(S.nearestPlacement(tie, 23), tie[0], 'a tie (8 each) goes to the earlier');
        assert.equal(S.nearestPlacement(ps, -1), ps[0]);
        assert.equal(S.nearestPlacement([], 5), null);
    });

    test('onlyTrackId confines what sounds, not the window — the roll recording alone', () => {
        const sg = song({ clips: [
            { id: 'c1', trackId: 't1', patternId: 'p1', startMeasure: 0, repeats: 4 },
            { id: 'c2', trackId: 't2', patternId: 'p2', startMeasure: 0, repeats: 1 },
        ] });
        const opts = { range: { startCol: 0, endCol: 16 }, onlyTrackId: 't1' };
        const seq = S.createSongSequence(sg, lib(P1(), P2()), opts);
        assert.deepEqual(seq.range, { startCol: 0, endCol: 16 }, 'the window is the same either way');
        assert.deepEqual(firing(seq, 0), [[60, 0]], 't2 is silent');
        assert.deepEqual(seq.locate(0).tracks.t2, { clipId: 'c2', patternId: 'p2', patternCol: 0 },
            'still located: the Song tab draws a playhead over it');
    });

    test('a song sequence takes a range override — the song, looped on a window', () => {
        const sg = song({ clips: [
            { id: 'c1', trackId: 't1', patternId: 'p1', startMeasure: 0, repeats: 4 },
            { id: 'c2', trackId: 't2', patternId: 'p2', startMeasure: 1, repeats: 1 },
        ] });
        const seq = S.createSongSequence(sg, lib(P1(), P2()), { range: { startCol: 16, endCol: 32 } });
        assert.deepEqual(seq.range, { startCol: 16, endCol: 32 });
        assert.equal(seq.length, 64, 'length is still the song\'s');
        assert.equal(seq.columnForTick(0), 16);
        assert.equal(seq.columnForTick(16), 16);
        assert.equal(seq.columnForTick(5), 21);
        assert.deepEqual(firing(seq, 16), [[48, 3], [60, 0]], 'both tracks sound inside the window');
    });
});

describe('msPerColumn', () => {
    test('a sixteenth at 120 bpm is 125 ms', () => {
        assert.equal(S.msPerColumn(120), 125);
        assert.equal(S.msPerColumn(60), 250);
    });
});
