// The Mixer strips ARE the project's tracks.
//
// There is no separate bank any more — no `voiceBank` array, no
// `openpatches_voicebank` key, and crucially no second mute flag. A strip
// is a track: the slot is the channel, and the name, patch, volume, mute
// and solo all describe one voice. Assigning a voice writes the track;
// switching project brings its own band with it because the strips are
// only ever a view of `project.tracks`.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let createToolbar, makeProjectSession, M, midi;

before(async () => {
    installBrowserEnv();
    installMidiStub();
    midi = await import('../html/synth/midi-manager.js');
    M = await import('../html/components/project-model.js');
    ({ createToolbar } = await import('../html/components/toolbar.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
});

beforeEach(() => {
    localStorage.clear();
    midi._reset();
});

function build() {
    const dock = createToolbar({
        session: makeProjectSession(),
        playNoteFn: () => Promise.resolve(() => {}),
        stopNoteFn: () => {},
        tickWorker: { postMessage() {}, addEventListener() {} },
        startWorker: () => {},
        stopWorker: () => {},
    });
    return {
        dock,
        session: dock._session,
        bank: dock._voiceBank,
        roll: dock._pianoroll,
    };
}

describe('a strip is a track', () => {
    test('assigning a voice writes the project track', () => {
        const h = build();
        h.dock._voiceBank._addEntry('Piano', 'piano-data', 'p1');
        const tracks = h.session.get().tracks;
        assert.deepEqual(tracks.map(t => [t.slot, t.name, t.patchId]), [[0, 'Piano', 'p1']]);
        assert.equal(tracks[0].voiceData, 'piano-data');
    });

    test('typed voice data becomes a plain array — JSON cannot carry it', () => {
        const h = build();
        h.dock._voiceBank._addEntry('Bass', Uint8Array.from([1, 2, 3]), 'p2');
        assert.deepEqual(h.session.get().tracks[0].voiceData, [1, 2, 3]);
    });

    test('there is one mute, and the scheduler reads it', () => {
        // The bug this merge exists to make unrepeatable: the song's track
        // and the bank entry each kept their own mute, neither showed the
        // other, and they could disagree.
        const h = build();
        const bank = h.dock._voiceBank;
        bank._addEntry('Piano', 'piano-data', 'p1');
        bank._toggleMute(0);
        assert.equal(h.session.get().tracks[0].mute, true);
        bank._toggleMute(0);
        assert.equal(h.session.get().tracks[0].mute, false);
    });

    test('a track the roll made keeps its clips when a voice lands on its slot', () => {
        // The roll creates a bare track the moment a note is drawn, before
        // any patch exists. Assigning one must fill that track in, not
        // replace it and orphan its clips.
        const h = build();
        h.roll.addNote({ midi: 60, start: 0, dur: 1, slot: 0 });
        const trackId = h.session.get().tracks[0].id;
        const clips = h.session.getSection().clips.length;

        h.dock._voiceBank._addEntry('Piano', 'piano-data', 'p1');
        assert.equal(h.session.get().tracks.length, 1, 'filled in, not duplicated');
        assert.equal(h.session.get().tracks[0].id, trackId);
        assert.equal(h.session.get().tracks[0].name, 'Piano');
        assert.equal(h.session.getSection().clips.length, clips, 'its clips survived');
    });

    test('an ordinary edit does not rebuild the strips', () => {
        const h = build();
        const bank = h.dock._voiceBank;
        bank._addEntry('Piano', 'piano-data', 'p1');
        const idBefore = bank._getEntries().filter(Boolean)[0].id;

        // Something structural, on the same song: placing a clip, adding a
        // track. The bank must be left exactly as it is — reapplying the
        // song's snapshot here would throw away whatever the user just did
        // to the voices (and _setEntries mints fresh entry ids).
        h.session.update((project) => { project.tracks.push(M.createTrack({ slot: 4 })); }, 'song-editor');

        const after = bank._getEntries().filter(Boolean);
        assert.deepEqual(after.map(e => e.name), ['Piano']);
        assert.equal(after[0].id, idBefore, 'the very same strip, not a rebuilt copy');
    });

    test('the roll keeps its working copies when the bank is written', () => {
        const h = build();
        h.roll.addNote({ midi: 60, start: 0, dur: 1, slot: 0 });
        const patternBefore = h.roll.getPattern();
        h.dock._voiceBank._addEntry('Piano', 'piano-data', 'p1');
        // Re-adopting on a voice-bank write would drop liveCache and hand
        // back a fresh object — and with it any gesture still in progress.
        assert.equal(h.roll.getPattern(), patternBefore, 'same pattern object, not re-read');
    });

    test('a bank change does not disturb the roll mid-edit', () => {
        const h = build();
        h.roll.addNote({ midi: 60, start: 0, dur: 1, slot: 0 });
        const patternId = h.roll.getTracks()[0].patternId;
        h.dock._voiceBank._addEntry('Piano', 'piano-data', 'p1');
        // Re-adopting the song on a voice-bank write would drop the roll's
        // working copies; the notes must still be there and still be its own.
        assert.deepEqual(h.roll.getNotes(), [{ midi: 60, start: 0, dur: 1 }]);
        assert.equal(h.roll.getTracks()[0].patternId, patternId);
    });
});

describe('switching project brings its own band', () => {
    test('the strips are replaced by the new project\'s tracks, and come back', async () => {
        const h = build();
        const bank = h.dock._voiceBank;
        bank._addEntry('Piano', 'piano-data', 'p1');
        const first = h.session.getId();

        h.session.createFrom({
            name: 'Other',
            tracks: [{ name: 'Strings', slot: 0, patchId: 'p9', volume: 80, voiceData: 'str-data' }],
        }, 'song-editor');
        assert.deepEqual(bank._getEntries().filter(Boolean).map(e => e.name), ['Strings']);

        // Reading a body back is the one switch that has to be async.
        await h.session.open(first, 'song-editor');
        assert.deepEqual(bank._getEntries().filter(Boolean).map(e => e.name), ['Piano']);
    });

    test('a new project starts with no band at all', () => {
        // The old behaviour — carrying the previous song's voices over
        // because the new one had none — went with the separate bank. A
        // project owns its tracks, and an empty project has none.
        const h = build();
        h.dock._voiceBank._addEntry('Piano', 'piano-data', 'p1');

        h.session.createNew('Fresh', 'song-editor');
        assert.deepEqual(h.dock._voiceBank._getEntries().filter(Boolean), []);
        assert.deepEqual(h.session.get().tracks, []);

        h.dock._voiceBank._addEntry('Bass', 'bass-data', 'p2');
        assert.deepEqual(h.session.get().tracks.map(t => t.name), ['Bass']);
    });
});
