// The voice bank follows the project.
//
// Loading a song used to restore the voices it was written for — that was
// the song bar's job, and the bar is gone. The toolbar now does it when the
// session switches project, and keeps the open project's copy of the bank
// up to date so a new project remembers its sounds too.
//
// Still the flat `voiceBank` array inherited from the Song era. Phase 3c
// moves it onto the project's tracks, where the patch and the mixer strip
// already live, and this file goes with it.

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

describe('the current song keeps its voices current', () => {
    test('adding a voice is recorded on the song', () => {
        const h = build();
        const bank = h.dock._voiceBank;
        bank._addEntry('Piano', 'piano-data', 'p1');
        const saved = h.session.get().voiceBank;
        assert.ok(Array.isArray(saved));
        assert.deepEqual(saved.map(e => e.name), ['Piano']);
        assert.equal(saved[0].voiceData, 'piano-data');
    });

    test('typed voice data is stored as a plain array — JSON cannot carry it', () => {
        const h = build();
        h.dock._voiceBank._addEntry('Bass', Uint8Array.from([1, 2, 3]), 'p2');
        assert.deepEqual(h.session.get().voiceBank[0].voiceData, [1, 2, 3]);
    });

    test('an ordinary song edit does not reapply the stored voices', () => {
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
        assert.equal(after[0].id, idBefore, 'the very same entries, not a rebuilt copy');
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

describe('switching project restores its voices', () => {
    test('the bank is replaced by the project it was written for', async () => {
        const h = build();
        const bank = h.dock._voiceBank;
        bank._addEntry('Piano', 'piano-data', 'p1');
        const first = h.session.getId();

        // A second project with its own voices.
        h.session.createFrom({
            name: 'Other',
            voiceBank: [{ name: 'Strings', patchId: 'p9', volume: 80, voiceData: 'str-data' }],
        }, 'song-editor');

        assert.deepEqual(bank._getEntries().filter(Boolean).map(e => e.name), ['Strings']);
        // Reading a body back is the one switch that has to be async.
        await h.session.open(first, 'song-editor');
        assert.deepEqual(bank._getEntries().filter(Boolean).map(e => e.name), ['Piano']);
    });

    test('a new project has no voices of its own, so the bank carries on', () => {
        const h = build();
        const bank = h.dock._voiceBank;
        bank._addEntry('Piano', 'piano-data', 'p1');

        const fresh = h.session.createNew('Fresh', 'song-editor');
        assert.equal(fresh.voiceBank, null, 'nothing of its own yet');
        assert.deepEqual(bank._getEntries().filter(Boolean).map(e => e.name), ['Piano'],
            'so the voices on screen are left alone rather than wiped');

        // Touching the bank from here on records it against the new song.
        bank._addEntry('Bass', 'bass-data', 'p2');
        assert.deepEqual(h.session.get().voiceBank.map(e => e.name), ['Piano', 'Bass']);
    });
});
