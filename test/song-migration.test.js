// Migration from the piano-roll era to Patterns and Songs.
//
// The roll stored one flat note list whose per-note `slot` was the voice.
// That is a song of clips at measure 0: group by slot, one pattern and one
// track per group. The legacy name-keyed snapshot songs convert the same way.
//
// The two properties that matter: nothing a user made is lost, and running
// the migration twice does not duplicate the library.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

const ROLL_KEY = 'openpatches_pianoroll';
const LEGACY_SONGS_KEY = 'openpatches_songs';
const MIGRATION_KEY = 'openpatches_seq_migrated';

let M;

before(async () => {
    installBrowserEnv();
    M = await import('../html/components/song-model.js');
});

// The old name-keyed store is gone from the code; the migration is the only
// thing that still reads its key, so the fixtures write it directly.
const legacySongStore = {
    create(name, data) {
        const map = JSON.parse(localStorage.getItem(LEGACY_SONGS_KEY) || '{}');
        map[name] = { name, data, savedAt: Date.now() };
        localStorage.setItem(LEGACY_SONGS_KEY, JSON.stringify(map));
    },
};

beforeEach(() => localStorage.clear());

const note = (midi, start, dur, slot) => ({ midi, start, dur, slot });

function seedRoll(data) {
    localStorage.setItem(ROLL_KEY, JSON.stringify(data));
}

const slots = [{ name: 'Bass', patchId: 'p1', volume: 90, voiceData: [1, 2, 3] }];

describe('splitNotesBySlot', () => {
    test('groups by slot in ascending slot order and drops the slot field', () => {
        const bySlot = M.splitNotesBySlot([
            note(60, 0, 2, 2), note(64, 4, 1, 0), note(67, 8, 1, 2),
        ]);
        assert.deepEqual([...bySlot.keys()], [0, 2]);
        assert.deepEqual(bySlot.get(2), [{ midi: 60, start: 0, dur: 2 }, { midi: 67, start: 8, dur: 1 }]);
        assert.equal('slot' in bySlot.get(0)[0], false);
    });

    test('a missing slot counts as slot 0 (the piano roll default)', () => {
        const bySlot = M.splitNotesBySlot([{ midi: 60, start: 0, dur: 1 }]);
        assert.deepEqual([...bySlot.keys()], [0]);
    });

    test('garbage in, empty out', () => {
        assert.equal(M.splitNotesBySlot(null).size, 0);
        assert.equal(M.splitNotesBySlot('x').size, 0);
        assert.equal(M.splitNotesBySlot([null, 'x']).size, 0);
    });
});

describe('songFromLegacyRoll', () => {
    test('one pattern, track and clip per used slot', () => {
        const { song, patterns } = M.songFromLegacyRoll({
            measures: 2, bpm: 140, notes: [note(60, 0, 4, 0), note(48, 16, 2, 3)],
        }, 'My tune');

        assert.equal(patterns.length, 2);
        assert.equal(song.tracks.length, 2);
        assert.equal(song.clips.length, 2);
        assert.equal(song.name, 'My tune');
        assert.equal(song.bpm, 140);

        // slot order, and the slot rides on the track, not the notes
        assert.deepEqual(song.tracks.map(t => t.slot), [0, 3]);
        assert.deepEqual(patterns.map(p => p.measures), [2, 2]);
        assert.deepEqual(patterns[1].notes, [{ midi: 48, start: 16, dur: 2 }]);
        for (const p of patterns) for (const n of p.notes) assert.equal('slot' in n, false);
    });

    test('every clip starts at measure 0 — the roll played all slots at once', () => {
        const { song } = M.songFromLegacyRoll({
            measures: 1, notes: [note(60, 0, 1, 0), note(62, 0, 1, 1)],
        }, 'T');
        assert.deepEqual(song.clips.map(c => [c.startCol, c.repeats]), [[0, 1], [0, 1]]);
    });

    test('clips point at the patterns and tracks that were just made', () => {
        const { song, patterns } = M.songFromLegacyRoll({
            measures: 1, notes: [note(60, 0, 1, 0), note(62, 0, 1, 1)],
        }, 'T');
        const patternIds = new Set(patterns.map(p => p.id));
        const trackIds = new Set(song.tracks.map(t => t.id));
        for (const c of song.clips) {
            assert.ok(patternIds.has(c.patternId), 'clip resolves to a pattern');
            assert.ok(trackIds.has(c.trackId), 'clip resolves to a track');
        }
    });

    test('patterns are named after the song and the slot', () => {
        const { patterns } = M.songFromLegacyRoll({ measures: 1, notes: [note(60, 0, 1, 2)] }, 'Tune');
        assert.equal(patterns[0].name, 'Tune — Slot 3');
    });

    test('the voice bank snapshot is carried over', () => {
        const { song } = M.songFromLegacyRoll({ measures: 1, notes: [note(60, 0, 1, 0)], slots }, 'T');
        assert.deepEqual(song.voiceBank, slots);
    });

    test('an empty roll yields a song with no clips and no patterns', () => {
        const { song, patterns } = M.songFromLegacyRoll({ measures: 1, notes: [] }, 'T');
        assert.deepEqual(patterns, []);
        assert.deepEqual(song.clips, []);
        assert.deepEqual(song.tracks, []);
        assert.equal(song.name, 'T');
    });

    test('a slot whose notes are all invalid produces no empty pattern', () => {
        const { song, patterns } = M.songFromLegacyRoll({
            measures: 1, notes: [{ midi: 'x', start: 0, dur: 1, slot: 1 }, note(60, 0, 1, 0)],
        }, 'T');
        assert.equal(patterns.length, 1);
        assert.deepEqual(song.tracks.map(t => t.slot), [0]);
    });

    test('notes past the end of the roll are cut or dropped, as in a pattern', () => {
        const { patterns } = M.songFromLegacyRoll({
            measures: 1, notes: [note(60, 14, 99, 0), note(62, 40, 1, 0)],
        }, 'T');
        assert.deepEqual(patterns[0].notes, [{ midi: 60, start: 14, dur: 2 }]);
    });
});

describe('buildMigration', () => {
    test('converts the working roll into a song, flagged as current', () => {
        seedRoll({ measures: 1, bpm: 100, notes: [note(60, 0, 1, 0)] });
        const { patterns, songs, currentSongId } = M.buildMigration();
        assert.equal(songs.length, 1);
        assert.equal(patterns.length, 1);
        assert.equal(songs[0].name, 'Untitled song');
        assert.equal(songs[0].id, currentSongId);
    });

    test('converts every legacy saved song too', () => {
        seedRoll({ measures: 1, notes: [note(60, 0, 1, 0)] });
        legacySongStore.create('Alpha', { measures: 2, bpm: 90, notes: [note(48, 0, 4, 1)], slots });
        legacySongStore.create('Beta', { measures: 1, bpm: 120, notes: [note(72, 0, 1, 0)] });

        const { songs, patterns, currentSongId } = M.buildMigration();
        assert.deepEqual(songs.map(s => s.name).sort(), ['Alpha', 'Beta', 'Untitled song']);
        assert.equal(patterns.length, 3);

        const alpha = songs.find(s => s.name === 'Alpha');
        assert.equal(alpha.bpm, 90);
        assert.equal(alpha.tracks[0].slot, 1);
        assert.deepEqual(alpha.voiceBank, slots);
        assert.notEqual(alpha.id, currentSongId);
    });

    test('an empty working roll contributes nothing', () => {
        seedRoll({ measures: 1, notes: [] });
        legacySongStore.create('Alpha', { measures: 1, notes: [note(60, 0, 1, 0)] });
        const { songs, currentSongId } = M.buildMigration();
        assert.deepEqual(songs.map(s => s.name), ['Alpha']);
        assert.equal(currentSongId, null);
    });

    test('nothing stored at all is not an error', () => {
        const { patterns, songs, currentSongId } = M.buildMigration();
        assert.deepEqual(patterns, []);
        assert.deepEqual(songs, []);
        assert.equal(currentSongId, null);
    });

    test('a corrupt roll blob is ignored', () => {
        localStorage.setItem(ROLL_KEY, '{not json');
        assert.deepEqual(M.buildMigration().songs, []);
        localStorage.setItem(ROLL_KEY, '"a string"');
        assert.deepEqual(M.buildMigration().songs, []);
    });

    test('it reads only — the legacy keys are untouched', () => {
        seedRoll({ measures: 1, notes: [note(60, 0, 1, 0)] });
        legacySongStore.create('Alpha', { measures: 1, notes: [note(60, 0, 1, 0)] });
        const rollBefore = localStorage.getItem(ROLL_KEY);
        const songsBefore = localStorage.getItem(LEGACY_SONGS_KEY);
        M.buildMigration();
        assert.equal(localStorage.getItem(ROLL_KEY), rollBefore);
        assert.equal(localStorage.getItem(LEGACY_SONGS_KEY), songsBefore);
        assert.equal(localStorage.getItem('openpatches_patterns'), null, 'and stores nothing');
    });
});

describe('migrateIfNeeded', () => {
    test('stores the patterns and songs it built', () => {
        seedRoll({ measures: 2, bpm: 128, notes: [note(60, 0, 4, 0), note(48, 0, 8, 1)] });
        const result = M.migrateIfNeeded();

        assert.equal(result.migrated, true);
        assert.equal(result.patterns, 2);
        assert.equal(result.songs, 1);
        assert.equal(M.patternStore.list().length, 2);
        assert.equal(M.songStore.list().length, 1);

        const song = M.songStore.get(result.currentSongId);
        assert.equal(song.bpm, 128);
        // the stored song still resolves to stored patterns
        for (const clip of song.clips) assert.ok(M.patternStore.get(clip.patternId), 'clip resolves');
        assert.equal(M.songLength(song, M.getStoredPattern), 2);
    });

    test('is idempotent — a second run changes nothing', () => {
        seedRoll({ measures: 1, notes: [note(60, 0, 1, 0)] });
        const first = M.migrateIfNeeded();
        const snapshot = localStorage.getItem('openpatches_patterns');

        const second = M.migrateIfNeeded();
        assert.equal(second.migrated, false);
        assert.equal(second.patterns, 0);
        assert.equal(second.currentSongId, null);
        assert.equal(M.patternStore.list().length, 1, 'no duplicate patterns');
        assert.equal(M.songStore.list().length, 1);
        assert.equal(localStorage.getItem('openpatches_patterns'), snapshot);
        assert.notEqual(first.currentSongId, null);
    });

    test('a fresh install migrates nothing but still marks itself done', () => {
        const result = M.migrateIfNeeded();
        assert.equal(result.migrated, true);
        assert.equal(result.songs, 0);
        assert.equal(M.hasMigrated(), true);
        assert.equal(M.migrateIfNeeded().migrated, false);
    });

    test('hasMigrated reflects the marker', () => {
        assert.equal(M.hasMigrated(), false);
        M.migrateIfNeeded();
        assert.equal(M.hasMigrated(), true);
    });

    test('the marker is written last, so a failed write retries next load', () => {
        seedRoll({ measures: 1, notes: [note(60, 0, 1, 0)] });
        const realSet = localStorage.setItem.bind(localStorage);
        localStorage.setItem = (k, v) => {
            if (k === MIGRATION_KEY) throw new Error('QuotaExceeded');
            realSet(k, v);
        };
        try {
            M.migrateIfNeeded();
        } finally {
            localStorage.setItem = realSet;
        }
        assert.equal(M.hasMigrated(), false, 'not marked done');
        assert.equal(M.migrateIfNeeded().migrated, true, 'so it runs again');
    });

    test('user data survives the round trip intact', () => {
        const original = [note(60, 0, 4, 0), note(64, 4, 4, 0), note(36, 0, 16, 5)];
        seedRoll({ measures: 2, bpm: 96, notes: original, slots });
        const { currentSongId } = M.migrateIfNeeded();
        const song = M.songStore.get(currentSongId);

        // Reassemble the flat note list the roll used to hold.
        const rebuilt = [];
        for (const clip of song.clips) {
            const track = song.tracks.find(t => t.id === clip.trackId);
            for (const n of M.patternStore.get(clip.patternId).notes) {
                rebuilt.push({ midi: n.midi, start: n.start, dur: n.dur, slot: track.slot });
            }
        }
        const key = (n) => `${n.slot}:${n.start}:${n.midi}:${n.dur}`;
        assert.deepEqual(rebuilt.map(key).sort(), original.map(key).sort());
        assert.equal(song.bpm, 96);
        assert.deepEqual(song.voiceBank, slots);
    });
});

describe('v1 → v2 catch-up', () => {
    // The song bar went on writing to the legacy store after the first
    // migration ran. Removing it without this pass would strand every song
    // saved in between.
    const v1Marker = () => localStorage.setItem(MIGRATION_KEY, JSON.stringify({ at: 1, version: 1 }));

    test('a song saved after the first migration is picked up', () => {
        seedRoll({ measures: 1, bpm: 120, notes: [note(60, 0, 1, 0)] });
        M.migrateIfNeeded();                       // v2 in one go
        assert.equal(M.songStore.list().length, 1);

        // Pretend that run was the old v1, then save another legacy song.
        v1Marker();
        legacySongStore.create('Saved later', { measures: 2, bpm: 90, notes: [note(48, 0, 4, 1)] });

        const result = M.migrateIfNeeded();
        assert.equal(result.migrated, true);
        assert.equal(result.songs, 1);
        const names = M.songStore.list().map(s => s.name);
        assert.ok(names.includes('Saved later'));
        const brought = M.songStore.list().find(s => s.name === 'Saved later');
        assert.equal(brought.bpm, 90);
        assert.deepEqual(brought.tracks.map(t => t.slot), [1]);
    });

    test('songs the first pass already converted are not duplicated', () => {
        legacySongStore.create('Alpha', { measures: 1, bpm: 120, notes: [note(60, 0, 1, 0)] });
        M.migrateIfNeeded();
        assert.equal(M.songStore.list().length, 1);

        v1Marker();
        const second = M.migrateIfNeeded();
        assert.equal(second.songs, 0, 'matched by name');
        assert.equal(M.songStore.list().length, 1);
    });

    test('the catch-up does not move the current song', () => {
        seedRoll({ measures: 1, bpm: 120, notes: [note(60, 0, 1, 0)] });
        const first = M.migrateIfNeeded();
        v1Marker();
        legacySongStore.create('Later', { measures: 1, notes: [note(48, 0, 1, 0)] });
        const result = M.migrateIfNeeded();
        assert.equal(result.currentSongId, null, 'an upgrade never re-points the session');
        assert.notEqual(first.currentSongId, null);
    });

    test('after v2 nothing runs again', () => {
        legacySongStore.create('A', { measures: 1, notes: [note(60, 0, 1, 0)] });
        M.migrateIfNeeded();
        assert.equal(M.migratedVersion(), 2);
        assert.equal(M.hasMigrated(), true);
        assert.equal(M.migrateIfNeeded().migrated, false);
    });

    test('a v1 install with nothing left over is upgraded quietly', () => {
        v1Marker();
        const r = M.migrateIfNeeded();
        assert.equal(r.migrated, true);
        assert.equal(r.songs, 0);
        assert.equal(M.migratedVersion(), 2);
    });

    test('the legacy keys survive the whole thing — they are the only copy', () => {
        seedRoll({ measures: 1, notes: [note(60, 0, 1, 0)] });
        legacySongStore.create('A', { measures: 1, notes: [note(48, 0, 1, 0)] });
        const rollBefore = localStorage.getItem(ROLL_KEY);
        const songsBefore = localStorage.getItem(LEGACY_SONGS_KEY);
        M.migrateIfNeeded();
        v1Marker();
        M.migrateIfNeeded();
        assert.equal(localStorage.getItem(ROLL_KEY), rollBefore);
        assert.equal(localStorage.getItem(LEGACY_SONGS_KEY), songsBefore);
    });
});
