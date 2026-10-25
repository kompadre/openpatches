// Regressions in voicebank.js:
//  - `entry.volume || DEFAULT_VOLUME` treated a muted slot (0) as unset, so a
//    silenced voice displayed 100 and its overlay was drawn full.
//  - Colors are a function of the slot index (AGENTS.md), but they were only
//    assigned at insert time — a remove or reorder left every shifted entry
//    wearing its old slot's color while the pianoroll used the new index.

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
        assert.deepEqual(bank._getEntries().map(e => e.color), PATCH_COLORS.slice(0, 2));
    });

    test('removing a slot recolors everything below it', () => {
        seed([entry('a', 100), entry('b', 100), entry('c', 100)]);
        const bank = createVoiceBank({});
        bank._removeEntry('a');
        const after = bank._getEntries();
        assert.deepEqual(after.map(e => e.id), ['b', 'c']);
        assert.deepEqual(after.map(e => e.color), PATCH_COLORS.slice(0, 2));
    });

    test('the recoloring is persisted, not just rendered', () => {
        seed([entry('a', 100), entry('b', 100)]);
        createVoiceBank({})._removeEntry('a');
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        assert.equal(saved.entries.length, 1);
        assert.equal(saved.entries[0].color, PATCH_COLORS[0]);
    });
});
