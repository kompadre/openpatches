// Regressions in voicebank.js:
//  - `entry.volume || DEFAULT_VOLUME` treated a muted slot (0) as unset, so a
//    silenced voice displayed 100 and its overlay was drawn full.
//  - Colors are a function of the slot index (AGENTS.md), but stale saved
//    state can carry another slot's color; it is recomputed on render.
//  - The slot index IS the synth channel, but removal used to splice the
//    array: every entry below shifted channel (tracks played the wrong
//    voice) and was recolored. Removal now leaves a hole.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

const STORAGE_KEY = 'openpatches_voicebank';
const PATCH_COLORS = ['#e94560', '#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4', '#ff5722', '#607d8b'];

let createVoiceBank;

before(async () => {
    installBrowserEnv();
    ({ createVoiceBank } = await import('../html/components/voicebank.js'));
});

function seed(entries) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries, activeId: entries[0]?.id || null }));
}

function entry(id, volume, color) {
    return { id, name: id, voiceData: id + '-data', patchId: id, color, volume };
}

function occupied(bank) {
    return bank._getEntries().filter(Boolean);
}

function volumeLabels(bank) {
    // The stub element stores textContent verbatim; a real DOM stringifies it.
    return bank.querySelectorAll('.voicebank-vol').map(el => String(el.textContent));
}

beforeEach(() => localStorage.clear());

describe('voicebank volume', () => {
    test('volume 0 displays as 0, not the default', () => {
        seed([entry('a', 0), entry('b', 70)]);
        const bank = createVoiceBank({});
        assert.deepEqual(volumeLabels(bank), ['0', '70']);
    });

    test('a missing volume is still backfilled to the default', () => {
        seed([{ id: 'a', name: 'a', voiceData: 'a-data' }]);
        const bank = createVoiceBank({});
        assert.deepEqual(volumeLabels(bank), ['100']);
        assert.equal(bank._getEntries()[0].volume, 100);
    });

    test('a null volume is backfilled too', () => {
        seed([entry('a', null)]);
        const bank = createVoiceBank({});
        assert.deepEqual(volumeLabels(bank), ['100']);
    });
});

describe('voicebank slot colors', () => {
    test('colors follow the slot index on load, overriding stale saved ones', () => {
        seed([entry('a', 100, '#ffffff'), entry('b', 100, '#000000')]);
        const bank = createVoiceBank({});
        assert.deepEqual(occupied(bank).map(e => e.color), PATCH_COLORS.slice(0, 2));
    });
});

describe('the slot is the channel: entries never shift', () => {
    test('the bank is always a fixed array of 8 slots', () => {
        seed([entry('a', 100)]);
        const bank = createVoiceBank({});
        assert.equal(bank._getEntries().length, 8);
    });

    test('removing a slot leaves a hole; the others keep index, color and volume', () => {
        seed([entry('a', 100), entry('b', 70), entry('c', 50)]);
        const bank = createVoiceBank({});
        bank._removeEntry('b');
        const after = bank._getEntries();
        assert.equal(after[0].id, 'a');
        assert.equal(after[1], null);
        assert.equal(after[2].id, 'c');
        assert.equal(after[2].color, PATCH_COLORS[2]);
        assert.equal(after[2].volume, 50);
    });

    test('the hole survives a save/load round trip', () => {
        seed([entry('a', 100), entry('b', 70), entry('c', 50)]);
        createVoiceBank({})._removeEntry('b');
        const bank = createVoiceBank({});
        const after = bank._getEntries();
        assert.equal(after[1], null);
        assert.equal(after[2].id, 'c');
    });

    test('removing the active entry selects the first remaining one', () => {
        seed([entry('a', 100), entry('b', 100)]);
        const bank = createVoiceBank({});
        bank._removeEntry('a');
        assert.equal(bank._getActive().id, 'b');
    });
});

describe('one voice, one slot', () => {
    test('assignToSlot writes to the exact slot asked for', () => {
        localStorage.clear();
        const bank = createVoiceBank({});
        assert.ok(bank._assignToSlot(3, { name: 'Piano', voiceData: 'piano-data', patchId: 'p1' }));
        const e = bank._getEntries();
        assert.equal(e[0], null);
        assert.equal(e[3].name, 'Piano');
        assert.equal(e[3].color, PATCH_COLORS[3]);
    });

    test('assigning the same bytes to another slot is a move, not a copy', () => {
        localStorage.clear();
        const bank = createVoiceBank({});
        bank._assignToSlot(0, { name: 'Piano', voiceData: 'piano-data', patchId: 'p1' });
        bank._getEntries()[0].volume = 42;
        bank._assignToSlot(5, { name: 'Piano', voiceData: 'piano-data', patchId: 'p1' });
        const e = bank._getEntries();
        assert.equal(e[0], null, 'the old slot empties');
        assert.equal(e[5].name, 'Piano');
        assert.equal(e[5].volume, 42, 'the volume travels with the voice');
        assert.equal(occupied(bank).length, 1);
    });

    test('dedup sees through encodings: Array and Uint8Array of the same bytes match', () => {
        localStorage.clear();
        const bank = createVoiceBank({});
        bank._assignToSlot(0, { name: 'Bass', voiceData: [1, 2, 3], patchId: 'p1' });
        bank._assignToSlot(4, { name: 'Bass copy', voiceData: Uint8Array.from([1, 2, 3]), patchId: 'p2' });
        assert.equal(occupied(bank).length, 1, 'same bytes may not occupy two slots');
        assert.equal(bank._getEntries()[0], null);
        assert.equal(bank._getEntries()[4].name, 'Bass copy');
    });

    test('addEntry fills the first empty slot and re-selects an existing voice', () => {
        localStorage.clear();
        const bank = createVoiceBank({});
        bank._assignToSlot(0, { name: 'A', voiceData: 'a-data' });
        bank._assignToSlot(2, { name: 'C', voiceData: 'c-data' });
        bank._addEntry('B', 'b-data', 'pb');
        assert.equal(bank._getEntries()[1].name, 'B', 'first hole, not append');
        bank._addEntry('A again', 'a-data', 'pa');
        assert.equal(occupied(bank).length, 3, 'no duplicate added');
        assert.equal(bank._getActive().name, 'A', 'the existing entry just becomes active');
    });

    test('_setEntries keeps slot positions and drops duplicate voices', () => {
        localStorage.clear();
        const bank = createVoiceBank({});
        bank._setEntries([
            { name: 'A', voiceData: 'a-data', volume: 60 },
            null,
            { name: 'B', voiceData: 'b-data' },
            { name: 'A dup', voiceData: 'a-data' },
        ]);
        const e = bank._getEntries();
        assert.equal(e[0].name, 'A');
        assert.equal(e[0].volume, 60);
        assert.equal(e[1], null, 'the saved hole is kept');
        assert.equal(e[2].name, 'B');
        assert.equal(e[3], null, 'the duplicate is dropped');
    });
});
