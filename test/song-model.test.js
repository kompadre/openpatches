// Sequencer model: Pattern / Track / Clip / Song factories, clip geometry
// and the two id-keyed stores.
//
// The factories are total — they are fed localStorage and, later, imported
// project files, so anything malformed must come back as a well-formed
// record rather than throw or poison the editors.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let M;

before(async () => {
    installBrowserEnv();
    M = await import('../html/components/song-model.js');
});

beforeEach(() => localStorage.clear());

const notes = (...list) => list.map(([midi, start, dur]) => ({ midi, start, dur }));

describe('createPattern', () => {
    test('fills in defaults', () => {
        const p = M.createPattern();
        assert.match(p.id, /^pat_/);
        assert.equal(p.name, 'Pattern');
        assert.equal(p.kind, 'mono');
        assert.equal(p.measures, 1);
        assert.deepEqual(p.notes, []);
        assert.ok(p.created > 0);
    });

    test('keeps a given id, name and measure count', () => {
        const p = M.createPattern({ id: 'pat_x', name: '  Bassline  ', measures: 4 });
        assert.equal(p.id, 'pat_x');
        assert.equal(p.name, 'Bassline', 'name is trimmed');
        assert.equal(p.measures, 4);
    });

    test('an unknown kind falls back to mono', () => {
        assert.equal(M.createPattern({ kind: 'drums' }).kind, 'mono');
        assert.equal(M.createPattern({ kind: 'mono' }).kind, 'mono');
    });

    test('notes are sorted by start, then pitch', () => {
        const p = M.createPattern({ notes: notes([64, 4, 1], [60, 0, 2], [67, 0, 1]) });
        assert.deepEqual(p.notes.map(n => [n.start, n.midi]), [[0, 60], [0, 67], [4, 64]]);
    });

    test('a note running past the end is cut at the end', () => {
        const p = M.createPattern({ measures: 1, notes: notes([60, 14, 99]) });
        assert.deepEqual(p.notes, [{ midi: 60, start: 14, dur: 2 }]);
    });

    test('a note starting past the end is dropped, not clamped', () => {
        const p = M.createPattern({ measures: 1, notes: notes([60, 16, 1], [62, 99, 1], [64, 15, 1]) });
        assert.deepEqual(p.notes, [{ midi: 64, start: 15, dur: 1 }]);
    });

    test('garbage notes are dropped', () => {
        const p = M.createPattern({
            notes: [null, 'x', {}, { midi: 60 }, { midi: 'a', start: 0, dur: 1 },
                    { midi: -1, start: 0, dur: 1 }, { midi: 128, start: 0, dur: 1 },
                    { midi: 60, start: -1, dur: 1 }, { midi: 60, start: 0, dur: 0 }],
        });
        assert.deepEqual(p.notes, [{ midi: 60, start: 0, dur: 1 }], 'dur 0 is raised to 1; the rest go');
    });

    test('a non-array notes field is not fatal', () => {
        assert.deepEqual(M.createPattern({ notes: 'nope' }).notes, []);
        assert.deepEqual(M.createPattern({ notes: null }).notes, []);
    });

    test('measures is clamped to at least 1', () => {
        assert.equal(M.createPattern({ measures: 0 }).measures, 1);
        assert.equal(M.createPattern({ measures: -5 }).measures, 1);
        assert.equal(M.createPattern({ measures: 'x' }).measures, 1);
    });

    test('round-trips through JSON unchanged', () => {
        const p = M.createPattern({ name: 'A', measures: 2, notes: notes([60, 0, 4]) });
        assert.deepEqual(M.createPattern(JSON.parse(JSON.stringify(p))), p);
    });
});

describe('createTrack', () => {
    test('defaults', () => {
        const t = M.createTrack();
        assert.match(t.id, /^trk_/);
        assert.equal(t.name, 'Track');
        assert.equal(t.slot, 0);
        assert.equal(t.mute, false);
        assert.equal(t.solo, false);
    });

    test('slot is clamped into the voice bank', () => {
        assert.equal(M.createTrack({ slot: 7 }).slot, 7);
        assert.equal(M.createTrack({ slot: 8 }).slot, M.MAX_SLOTS - 1);
        assert.equal(M.createTrack({ slot: -1 }).slot, 0);
        assert.equal(M.createTrack({ slot: null }).slot, 0);
    });

    test('mute/solo are strictly booleans', () => {
        assert.equal(M.createTrack({ mute: 'yes' }).mute, false);
        assert.equal(M.createTrack({ mute: true }).mute, true);
    });
});

describe('createSong', () => {
    const track = { id: 'trk_1', name: 'T', slot: 0 };

    test('defaults', () => {
        const s = M.createSong();
        assert.match(s.id, /^song_/);
        assert.equal(s.name, 'Song');
        assert.equal(s.bpm, M.DEFAULT_BPM);
        assert.deepEqual(s.tracks, []);
        assert.deepEqual(s.clips, []);
        assert.equal(s.loop, null);
        assert.equal(s.voiceBank, null);
    });

    test('bpm is clamped to the tempo range', () => {
        assert.equal(M.createSong({ bpm: 1 }).bpm, M.MIN_BPM);
        assert.equal(M.createSong({ bpm: 9999 }).bpm, M.MAX_BPM);
        assert.equal(M.createSong({ bpm: 'x' }).bpm, M.DEFAULT_BPM);
        assert.equal(M.createSong({ bpm: 140 }).bpm, 140);
    });

    test('clips pointing at a missing track or pattern are dropped', () => {
        const s = M.createSong({
            tracks: [track],
            clips: [
                { trackId: 'trk_1', patternId: 'pat_1' },
                { trackId: 'trk_gone', patternId: 'pat_1' },
                { trackId: 'trk_1', patternId: null },
            ],
        });
        assert.equal(s.clips.length, 1);
        assert.equal(s.clips[0].trackId, 'trk_1');
    });

    test('a backwards or empty loop range is discarded', () => {
        assert.equal(M.createSong({ loop: { start: 4, end: 2 } }).loop, null);
        assert.equal(M.createSong({ loop: { start: 2, end: 2 } }).loop, null);
        assert.equal(M.createSong({ loop: 'x' }).loop, null);
        assert.deepEqual(M.createSong({ loop: { start: 0, end: 4 } }).loop, { start: 0, end: 4 });
    });

    test('round-trips through JSON unchanged', () => {
        const s = M.createSong({
            name: 'S', bpm: 100, tracks: [track],
            clips: [{ id: 'clip_1', trackId: 'trk_1', patternId: 'pat_1', startMeasure: 2, repeats: 3 }],
            loop: { start: 0, end: 8 },
            voiceBank: [{ name: 'v', voiceData: [1, 2] }],
        });
        assert.deepEqual(M.createSong(JSON.parse(JSON.stringify(s))), s);
    });
});

describe('clip geometry', () => {
    // Built lazily: describe bodies run before before(), where M is imported.
    const pattern = () => M.createPattern({ id: 'pat_1', measures: 2 });
    const get = (id) => (id === 'pat_1' ? pattern() : null);

    test('a clip spans pattern length × repeats', () => {
        const clip = M.createClip({ patternId: 'pat_1', startMeasure: 4, repeats: 3 });
        assert.deepEqual(M.clipSpan(clip, pattern()), { start: 4, end: 10 });
    });

    test('a dangling pattern reference has no span', () => {
        assert.equal(M.clipSpan(M.createClip({ patternId: 'gone' }), null), null);
    });

    test('song length is the furthest clip end', () => {
        const song = M.createSong({
            tracks: [{ id: 'trk_1' }, { id: 'trk_2' }],
            clips: [
                { trackId: 'trk_1', patternId: 'pat_1', startMeasure: 0, repeats: 1 },
                { trackId: 'trk_2', patternId: 'pat_1', startMeasure: 6, repeats: 2 },
            ],
        });
        assert.equal(M.songLength(song, get), 10);
        assert.equal(M.songLength(M.createSong(), get), 0, 'an empty song is 0 measures');
    });

    test('a dangling clip does not count toward the length', () => {
        const song = M.createSong({
            tracks: [{ id: 'trk_1' }],
            clips: [{ trackId: 'trk_1', patternId: 'pat_gone', startMeasure: 40, repeats: 1 }],
        });
        assert.equal(M.songLength(song, get), 0);
    });
});

describe('clip placement', () => {
    const get = (id) => (id === 'pat_1' ? M.createPattern({ id: 'pat_1', measures: 2 }) : null);

    function song() {
        return M.createSong({ tracks: [{ id: 'trk_1', slot: 0 }, { id: 'trk_2', slot: 1 }] });
    }

    test('adds a clip and returns it', () => {
        const s = song();
        const clip = M.addClip(s, { trackId: 'trk_1', patternId: 'pat_1', startMeasure: 0 }, get);
        assert.equal(s.clips.length, 1);
        assert.match(clip.id, /^clip_/);
        assert.equal(clip.repeats, 1);
    });

    test('an overlapping clip on the same track is refused', () => {
        const s = song();
        M.addClip(s, { trackId: 'trk_1', patternId: 'pat_1', startMeasure: 0, repeats: 2 }, get); // [0,4)
        for (const startMeasure of [0, 1, 3]) {
            assert.throws(() => M.addClip(s, { trackId: 'trk_1', patternId: 'pat_1', startMeasure }, get),
                /Clip overlaps/, `measure ${startMeasure} overlaps [0,4)`);
        }
        assert.equal(s.clips.length, 1, 'nothing was added');
    });

    test('abutting clips are not an overlap', () => {
        const s = song();
        M.addClip(s, { trackId: 'trk_1', patternId: 'pat_1', startMeasure: 0, repeats: 2 }, get); // [0,4)
        M.addClip(s, { trackId: 'trk_1', patternId: 'pat_1', startMeasure: 4 }, get);             // [4,6)
        assert.equal(s.clips.length, 2);
    });

    test('the same measures on another track are fine — that is the point', () => {
        const s = song();
        M.addClip(s, { trackId: 'trk_1', patternId: 'pat_1', startMeasure: 0 }, get);
        M.addClip(s, { trackId: 'trk_2', patternId: 'pat_1', startMeasure: 0 }, get);
        assert.equal(s.clips.length, 2);
    });

    test('a clip with no pattern, no track, or a missing pattern is refused', () => {
        const s = song();
        assert.throws(() => M.addClip(s, { trackId: 'trk_1' }, get), /no pattern/);
        assert.throws(() => M.addClip(s, { trackId: 'nope', patternId: 'pat_1' }, get), /no track/);
        assert.throws(() => M.addClip(s, { trackId: 'trk_1', patternId: 'gone' }, get), /pattern is missing/);
        assert.equal(s.clips.length, 0);
    });

    test('updateClip moves a clip and ignores its own old position', () => {
        const s = song();
        const clip = M.addClip(s, { trackId: 'trk_1', patternId: 'pat_1', startMeasure: 0, repeats: 2 }, get);
        M.updateClip(s, clip.id, { startMeasure: 1 }, get);
        assert.equal(s.clips[0].startMeasure, 1, 'overlapping only itself is allowed');
        M.updateClip(s, clip.id, { repeats: 4 }, get);
        assert.equal(s.clips[0].repeats, 4);
    });

    test('updateClip refuses a move onto a neighbour and leaves the clip put', () => {
        const s = song();
        const a = M.addClip(s, { trackId: 'trk_1', patternId: 'pat_1', startMeasure: 0 }, get); // [0,2)
        M.addClip(s, { trackId: 'trk_1', patternId: 'pat_1', startMeasure: 2 }, get);           // [2,4)
        assert.throws(() => M.updateClip(s, a.id, { startMeasure: 3 }, get), /Clip overlaps/);
        assert.equal(s.clips.find(c => c.id === a.id).startMeasure, 0);
    });

    test('updateClip on an unknown clip throws', () => {
        assert.throws(() => M.updateClip(song(), 'clip_nope', {}, get), /Clip not found/);
    });

    test('removeClip', () => {
        const s = song();
        const clip = M.addClip(s, { trackId: 'trk_1', patternId: 'pat_1', startMeasure: 0 }, get);
        assert.equal(M.removeClip(s, clip.id), true);
        assert.equal(M.removeClip(s, clip.id), false, 'already gone');
        assert.deepEqual(s.clips, []);
    });

    test('removing a track takes its clips with it', () => {
        const s = song();
        M.addClip(s, { trackId: 'trk_1', patternId: 'pat_1', startMeasure: 0 }, get);
        M.addClip(s, { trackId: 'trk_2', patternId: 'pat_1', startMeasure: 0 }, get);
        assert.equal(M.removeTrack(s, 'trk_1'), true);
        assert.equal(s.tracks.length, 1);
        assert.deepEqual(s.clips.map(c => c.trackId), ['trk_2']);
        assert.equal(M.removeTrack(s, 'trk_1'), false);
    });
});

describe('stores', () => {
    test('patternStore create / get / list / remove', () => {
        assert.deepEqual(M.patternStore.list(), []);
        const p = M.patternStore.create({ name: 'Bass', measures: 2 });
        assert.equal(M.patternStore.has(p.id), true);
        assert.equal(M.patternStore.get(p.id).name, 'Bass');
        assert.equal(M.patternStore.list().length, 1);
        assert.equal(M.patternStore.remove(p.id), true);
        assert.equal(M.patternStore.remove(p.id), false);
        assert.equal(M.patternStore.get(p.id), null);
    });

    test('create always mints a fresh id, so it cannot overwrite', () => {
        const a = M.patternStore.create({ id: 'pat_fixed', name: 'A' });
        const b = M.patternStore.create({ id: 'pat_fixed', name: 'B' });
        assert.notEqual(a.id, b.id);
        assert.equal(M.patternStore.list().length, 2);
    });

    test('put updates in place — that is how an editor saves', () => {
        const p = M.patternStore.create({ name: 'A' });
        M.patternStore.put({ ...p, name: 'A2' });
        assert.equal(M.patternStore.list().length, 1);
        assert.equal(M.patternStore.get(p.id).name, 'A2');
    });

    test('two patterns may share a name (ids key the store)', () => {
        M.patternStore.create({ name: 'Same' });
        M.patternStore.create({ name: 'Same' });
        assert.equal(M.patternStore.list().length, 2);
    });

    test('list is sorted case-insensitively by name', () => {
        for (const name of ['zeta', 'Alpha', 'beta']) M.patternStore.create({ name });
        assert.deepEqual(M.patternStore.list().map(p => p.name), ['Alpha', 'beta', 'zeta']);
    });

    test('the stored copy does not alias the live record', () => {
        const live = M.createPattern({ name: 'A', notes: notes([60, 0, 1]) });
        M.patternStore.put(live);
        live.notes.push({ midi: 72, start: 4, dur: 1 });
        assert.equal(M.patternStore.get(live.id).notes.length, 1);
    });

    test('stored records are normalized on the way out', () => {
        localStorage.setItem('openpatches_patterns', JSON.stringify({
            pat_bad: { id: 'pat_bad', name: '', measures: 0, notes: [{ midi: 60, start: 99, dur: 1 }] },
        }));
        const p = M.patternStore.get('pat_bad');
        assert.equal(p.name, 'Pattern');
        assert.equal(p.measures, 1);
        assert.deepEqual(p.notes, [], 'the unreachable note is gone');
    });

    test('corrupt storage reads as empty rather than throwing', () => {
        localStorage.setItem('openpatches_patterns', '{not json');
        assert.deepEqual(M.patternStore.list(), []);
        localStorage.setItem('openpatches_patterns', '[1,2,3]');
        assert.deepEqual(M.patternStore.list(), []);
        M.patternStore.create({ name: 'A' });
        assert.equal(M.patternStore.list().length, 1, 'and writing recovers');
    });

    test('songStore keeps tracks, clips and the voice bank', () => {
        const s = M.songStore.create({
            name: 'Tune', bpm: 90,
            tracks: [{ id: 'trk_1', slot: 3 }],
            clips: [{ trackId: 'trk_1', patternId: 'pat_1', startMeasure: 1, repeats: 2 }],
            voiceBank: [{ name: 'Bass', voiceData: [1, 2, 3] }],
        });
        const back = M.songStore.get(s.id);
        assert.equal(back.bpm, 90);
        assert.equal(back.tracks[0].slot, 3);
        assert.equal(back.clips[0].repeats, 2);
        assert.deepEqual(back.voiceBank, [{ name: 'Bass', voiceData: [1, 2, 3] }]);
    });

    test('the two stores do not share a key', () => {
        M.patternStore.create({ name: 'P' });
        M.songStore.create({ name: 'S' });
        assert.equal(M.patternStore.list().length, 1);
        assert.equal(M.songStore.list().length, 1);
    });

    test('patternUsage names the songs that reference a pattern', () => {
        const p = M.patternStore.create({ name: 'P' });
        const other = M.patternStore.create({ name: 'Q' });
        const s1 = M.songStore.create({
            name: 'S1', tracks: [{ id: 'trk_1' }],
            clips: [{ trackId: 'trk_1', patternId: p.id }],
        });
        M.songStore.create({
            name: 'S2', tracks: [{ id: 'trk_1' }],
            clips: [{ trackId: 'trk_1', patternId: other.id }],
        });
        assert.deepEqual(M.patternUsage(p.id), [s1.id]);
        assert.deepEqual(M.patternUsage('pat_unused'), []);
    });
});
