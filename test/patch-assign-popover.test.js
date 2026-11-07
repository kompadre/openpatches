// The ♫ slot picker — the one way to put a patch into the voice bank.
// Eight buttons, occupants marked, the patch's own slot flagged; clicking a
// button commits (onAssignSlot) and closes. Without the new wiring the
// button falls back to the legacy onSelect.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createPatchRow, voiceKey;

before(async () => {
    installBrowserEnv();
    ({ createPatchRow } = await import('../html/components/patch-row.js'));
    ({ voiceKey } = await import('../html/components/patch-model.js'));
});

beforeEach(() => localStorage.clear());

const evt = () => ({ stopPropagation() {}, preventDefault() {} });

function bankWith(slots) {
    // Entries as the voicebank hands them out: voiceKey precomputed.
    return slots.map((s, i) => s ? { name: s, voiceKey: voiceKey(s + '-data'), color: '#123456', volume: 100 } : null);
}

function openPopover(patch, opts) {
    const row = createPatchRow(patch, { isMinified: true, ...opts });
    const btn = row.querySelector('.patch-assign');
    btn.dispatch('click', evt());
    return { row, btn, pop: row.querySelector('.patch-assign-pop') };
}

describe('assign popover', () => {
    test('renders one button per slot with occupants marked', () => {
        const { pop } = openPopover({ id: 'x', name: 'New', voice_data: 'new-data' }, {
            onAssignSlot: () => {},
            getBankEntries: () => bankWith(['A', null, 'C', null, null, null, null, null]),
        });
        assert.ok(pop, 'popover appears on ♫ click');
        const slots = pop.querySelectorAll('.patch-assign-slot');
        assert.equal(slots.length, 8);
        assert.ok(slots[0].className.includes('occupied'));
        assert.ok(!slots[1].className.includes('occupied'));
        assert.equal(String(slots[2].title), 'C', 'occupant name as tooltip');
    });

    test('the patch already in the bank wears .current on its own slot', () => {
        const { pop } = openPopover({ id: 'x', name: 'C', voice_data: 'C-data' }, {
            onAssignSlot: () => {},
            getBankEntries: () => bankWith(['A', null, 'C']),
        });
        const slots = pop.querySelectorAll('.patch-assign-slot');
        assert.ok(slots[2].className.includes('current'));
        assert.ok(!slots[0].className.includes('current'));
    });

    test('a voice in two slots wears .current on both', () => {
        const { pop } = openPopover({ id: 'x', name: 'C', voice_data: 'C-data' }, {
            onAssignSlot: () => {},
            getBankEntries: () => bankWith(['A', 'C', 'C', null, 'B']),
        });
        const slots = pop.querySelectorAll('.patch-assign-slot');
        assert.deepEqual(slots.map(b => b.className.includes('current')),
            [false, true, true, false, false, false, false, false]);
    });

    test('clicking a slot commits it and closes the popover', () => {
        const calls = [];
        const patch = { id: 'x', name: 'New', voice_data: 'new-data' };
        const { row, pop } = openPopover(patch, {
            onAssignSlot: (p, idx) => calls.push([p, idx]),
            getBankEntries: () => bankWith(['A']),
        });
        pop.querySelectorAll('.patch-assign-slot')[4].dispatch('click', evt());
        assert.deepEqual(calls, [[patch, 4]]);
        assert.equal(row.querySelector('.patch-assign-pop'), null, 'closed after commit');
    });

    test('a second ♫ click just closes it', () => {
        const { row, btn } = openPopover({ id: 'x', name: 'N', voice_data: 'n-data' }, {
            onAssignSlot: () => {},
            getBankEntries: () => bankWith([]),
        });
        btn.dispatch('click', evt());
        assert.equal(row.querySelector('.patch-assign-pop'), null);
    });

    test('without the wiring the button falls back to onSelect', () => {
        const picked = [];
        const patch = { id: 'x', name: 'N', voice_data: 'n-data' };
        const row = createPatchRow(patch, { isMinified: true, onSelect: (p) => picked.push(p) });
        row.querySelector('.patch-assign').dispatch('click', evt());
        assert.deepEqual(picked, [patch]);
        assert.equal(row.querySelector('.patch-assign-pop'), null);
    });
});
