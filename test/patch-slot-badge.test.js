// The slot badge: every patch row showing a banked voice wears that voice's
// VoiceBank slot number. Identity is the voice bytes (voiceKey), not the
// patch id — so a renamed copy, or the same voice in three containers, all
// show the same slot, and all of them update together when the bank moves.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createPatchRow, updateBankSlots, voiceKey;

before(async () => {
    installBrowserEnv();
    ({ createPatchRow, updateBankSlots } = await import('../html/components/patch-row.js'));
    ({ voiceKey } = await import('../html/components/patch-model.js'));
});

beforeEach(() => {
    localStorage.clear();
    document.body.children.length = 0;
    updateBankSlots([]);
});

// Entries as the voice bank hands them out: slot = index, voiceKey precomputed.
function bank(slots) {
    return slots.map(s => s ? { name: s.name, voiceKey: voiceKey(s.data), color: s.color || '#4caf50' } : null);
}

function addRow(patch, opts = {}) {
    const row = createPatchRow(patch, { isMinified: true, ...opts });
    document.body.appendChild(row);
    return row;
}

function badgeOf(row) {
    return row.querySelector('.patch-slot-badge');
}

describe('slot badge', () => {
    test('a banked voice shows its slot number and color', () => {
        updateBankSlots(bank([null, { name: 'Piano', data: 'piano-data', color: '#2196f3' }]));
        const b = badgeOf(addRow({ id: 'p', name: 'Piano', voice_data: 'piano-data' }));
        assert.equal(String(b.textContent), '2', 'slot 1 displays as 2');
        assert.equal(b.style.background, '#2196f3');
        assert.notEqual(b.style.display, 'none');
    });

    test('an unbanked voice has a hidden, empty badge', () => {
        updateBankSlots(bank([{ name: 'Piano', data: 'piano-data' }]));
        const b = badgeOf(addRow({ id: 'q', name: 'Bass', voice_data: 'bass-data' }));
        assert.equal(String(b.textContent), '');
        assert.equal(b.style.display, 'none');
    });

    test('every instance of the same voice shows the same slot, renamed or not', () => {
        updateBankSlots(bank([{ name: 'Piano', data: 'piano-data' }]));
        const a = addRow({ id: 'p1', name: 'Piano', voice_data: 'piano-data' });
        const b = addRow({ id: 'p2', name: 'My Piano', voice_data: 'piano-data' });
        assert.equal(String(badgeOf(a).textContent), '1');
        assert.equal(String(badgeOf(b).textContent), '1');
    });

    test('rows already on screen follow the bank when it changes', () => {
        const row = addRow({ id: 'p', name: 'Piano', voice_data: 'piano-data' });
        assert.equal(String(badgeOf(row).textContent), '', 'not banked yet');

        updateBankSlots(bank([null, null, { name: 'Piano', data: 'piano-data' }]));
        assert.equal(String(badgeOf(row).textContent), '3', 'assigned');

        // A swap: the same voice moves to slot 1.
        updateBankSlots(bank([{ name: 'Piano', data: 'piano-data' }]));
        assert.equal(String(badgeOf(row).textContent), '1', 'follows the move');

        // Removed from the bank entirely.
        updateBankSlots([]);
        assert.equal(String(badgeOf(row).textContent), '');
        assert.equal(badgeOf(row).style.display, 'none');
    });

    test('a patch with no voice data never claims a slot', () => {
        updateBankSlots(bank([{ name: 'Piano', data: 'piano-data' }]));
        const b = badgeOf(addRow({ id: 'n', name: 'No data', voice_data: null }));
        assert.equal(String(b.textContent), '');
        assert.equal(b.style.display, 'none');
    });
});
