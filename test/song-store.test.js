// songStore: named snapshots of the sequencer. The one rule that matters is
// that a save never overwrites — a name collision is an error the UI shows
// verbatim as "Song exists".

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let songStore;

before(async () => {
    installBrowserEnv();
    ({ songStore } = await import('../html/components/patch-model.js'));
});

beforeEach(() => localStorage.clear());

const song = (extra = {}) => ({ notes: [{ midi: 60, start: 0, dur: 2, slot: 0 }], bpm: 120, measures: 1, ...extra });

describe('songStore', () => {
    test('starts empty', () => {
        assert.deepEqual(songStore.list(), []);
        assert.equal(songStore.has('x'), false);
        assert.equal(songStore.get('x'), null);
    });

    test('create → has / get / list', () => {
        songStore.create('Bassline', song());
        assert.equal(songStore.has('Bassline'), true);
        assert.deepEqual(songStore.get('Bassline').data, song());
        assert.deepEqual(songStore.list(), ['Bassline']);
    });

    test('a second save under the same name fails with "Song exists" and keeps the original', () => {
        songStore.create('A', song({ bpm: 100 }));
        assert.throws(() => songStore.create('A', song({ bpm: 180 })), /^Error: Song exists$/);
        assert.equal(songStore.get('A').data.bpm, 100);
    });

    test('names are trimmed, so " A " collides with "A"', () => {
        songStore.create('A', song());
        assert.throws(() => songStore.create(' A ', song()), /Song exists/);
        assert.equal(songStore.has('  A'), true);
    });

    test('an empty name is refused', () => {
        assert.throws(() => songStore.create('', song()), /empty/);
        assert.throws(() => songStore.create('   ', song()), /empty/);
        assert.throws(() => songStore.create(null, song()), /empty/);
        assert.deepEqual(songStore.list(), []);
    });

    test('list is sorted case-insensitively for the autocomplete', () => {
        for (const n of ['zeta', 'Alpha', 'beta']) songStore.create(n, song());
        assert.deepEqual(songStore.list(), ['Alpha', 'beta', 'zeta']);
    });

    test('the stored copy does not alias the live data', () => {
        const live = song();
        songStore.create('A', live);
        live.notes.push({ midi: 99, start: 1, dur: 1, slot: 0 });
        assert.equal(songStore.get('A').data.notes.length, 1);
        // and a typed array in the snapshot comes back as a plain array
        songStore.create('B', { slots: [{ voiceData: Uint8Array.from([1, 2, 3]) }] });
        assert.deepEqual(songStore.get('B').data.slots[0].voiceData, [1, 2, 3]);
    });

    test('remove', () => {
        songStore.create('A', song());
        assert.equal(songStore.remove('A'), true);
        assert.equal(songStore.remove('A'), false, 'already gone');
        assert.equal(songStore.has('A'), false);
    });

    test('corrupt storage reads as empty rather than throwing', () => {
        localStorage.setItem('openpatches_songs', '{not json');
        assert.deepEqual(songStore.list(), []);
        localStorage.setItem('openpatches_songs', '[1,2,3]');
        assert.deepEqual(songStore.list(), []);
        songStore.create('A', song());
        assert.deepEqual(songStore.list(), ['A']);
    });
});
