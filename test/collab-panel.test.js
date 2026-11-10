// collab-panel.js: the chip's words, and notices that come and go.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let chipText, attachCollabChip;

before(async () => {
    installBrowserEnv();
    ({ chipText, attachCollabChip } = await import('../html/components/collab-panel.js'));
});

function fakeCollab(initial) {
    let s = { role: null, room: null, state: null, peers: 0, hostName: '', ...initial };
    const fns = new Set();
    return {
        status: () => ({ ...s }),
        subscribe(fn) { fns.add(fn); return () => fns.delete(fn); },
        set(next, notice) { s = { ...s, ...next }; for (const fn of fns) fn(notice ? { ...s, notice } : { ...s }); },
    };
}

describe('collab chip', () => {
    test('words for each moment; none without a session', () => {
        assert.equal(chipText({ role: null }), '');
        assert.equal(chipText({ role: 'host', room: 'ABC234', peers: 2 }), '⇄ Sharing ABC234 · 2 watching');
        assert.equal(chipText({ role: 'guest', state: 'joining', room: 'ABC234' }), '⇄ Joining ABC234…');
        assert.equal(chipText({ role: 'guest', state: 'watching', room: 'ABC234', hostName: 'Jam' }), '⇄ Watching Jam · view only');
        assert.equal(chipText({ role: 'guest', state: 'ended', room: 'ABC234' }), '⇄ Session ended');
    });

    test('hidden when idle, shown and styled by role; a notice shows for a while and is logged', () => {
        const collab = fakeCollab();
        const chip = document.createElement('button');
        const log = [];
        let timer = null;
        let opened = 0;
        attachCollabChip({
            collab, chip, appendLog: (m) => log.push(m), openDialog: () => opened++,
            setTimer: (fn) => { timer = fn; return 1; }, clearTimer: () => { timer = null; },
        });
        assert.equal(chip.style.display, 'none');
        collab.set({ role: 'guest', state: 'watching', room: 'ABC234', hostName: 'Jam' });
        assert.equal(chip.style.display, '');
        assert.ok(chip.classList.contains('collab-guest'));
        collab.set({}, 'View only — your edit was undone');
        assert.equal(chip.textContent, 'View only — your edit was undone');
        assert.ok(chip.classList.contains('collab-notice'));
        assert.deepEqual(log, ['Collab: View only — your edit was undone']);
        timer();
        assert.equal(chip.textContent, '⇄ Watching Jam · view only');
        chip.dispatch('click');
        assert.equal(opened, 1);
    });

    test('a notice after the session is gone is logged, not shown', () => {
        const collab = fakeCollab();
        const chip = document.createElement('button');
        const log = [];
        attachCollabChip({ collab, chip, appendLog: (m) => log.push(m), setTimer: () => 1, clearTimer: () => {} });
        collab.set({ role: null }, 'No one is sharing with code ZZZZ99');
        assert.equal(chip.style.display, 'none');
        assert.deepEqual(log, ['Collab: No one is sharing with code ZZZZ99']);
    });
});
