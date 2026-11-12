// collab-panel.js: the chip's words, and notices that come and go.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let chipText, attachCollabChip, describeAtom, describeValue, describePresence;

before(async () => {
    installBrowserEnv();
    ({ chipText, attachCollabChip, describeAtom, describeValue, describePresence } = await import('../html/components/collab-panel.js'));
});

const body = {
    patterns: { p1: { id: 'p1', name: 'Riff' } },
    tracks: [{ id: 't1', name: 'Keys' }],
    sections: [{ id: 's1', name: 'Intro' }],
};

function fakeCollab(initial) {
    let s = { role: null, room: null, state: null, peers: 0, hostName: '', ...initial };
    const fns = new Set();
    return {
        status: () => ({ ...s }),
        subscribe(fn) { fns.add(fn); return () => fns.delete(fn); },
        set(next, notice) { s = { ...s, ...next }; for (const fn of fns) fn(notice ? { ...s, notice } : { ...s }); },
    };
}

describe('words for atoms, values and presence', () => {
    test('atoms name what the project calls them', () => {
        assert.equal(describeAtom('pattern/p1/note/20:60', body), 'Riff › C-4 at 2.5');
        assert.equal(describeAtom('pattern/p1/name', body), 'Riff › name');
        assert.equal(describeAtom('track/t1/volume', body), 'Keys › volume');
        assert.equal(describeAtom('track/t1/fx/delayMix', body), 'Keys › effects › delayMix');
        assert.equal(describeAtom('section/s1/clip/c1/startCol', body), 'Intro › clip › position');
        assert.equal(describeAtom('bpm', body), 'project › tempo');
        assert.equal(describeAtom('pattern/zz', body), 'a pattern');
        assert.equal(describeAtom('nonsense', body), 'nonsense');
    });
    test('values read as words', () => {
        assert.equal(describeValue('"Hook"'), 'Hook');
        assert.equal(describeValue('90'), '90');
        assert.equal(describeValue('null'), '—');
        assert.equal(describeValue(null), 'removed');
        assert.equal(describeValue('["a","b"]'), '2 items');
    });
    test('presence', () => {
        assert.equal(describePresence({ alias: 'Bob', scope: { patternId: 'p1' } }, body), 'Bob is editing Riff');
        assert.equal(describePresence({ peer: 'X', scope: {} }, body), 'X is editing');
    });
});

describe('collab chip', () => {
    test('words for each moment; none without a session', () => {
        assert.equal(chipText({ role: null }), '');
        assert.equal(chipText({ role: 'host', room: 'ABC234', peers: 2 }), '⇄ Sharing ABC234 · 2 in');
        assert.equal(chipText({ role: 'host', room: 'ABC234', peers: 2, conflicts: [1, 2, 3] }), '⇄ Sharing ABC234 · 2 in · ⚠ 3');
        assert.equal(chipText({ role: 'guest', state: 'watching', room: 'ABC234', hostName: 'Jam', conflicts: [1] }), '⇄ With Jam · ⚠ 1');
        assert.equal(chipText({ role: 'guest', state: 'joining', room: 'ABC234' }), '⇄ Joining ABC234…');
        assert.equal(chipText({ role: 'guest', state: 'watching', room: 'ABC234', hostName: 'Jam' }), '⇄ With Jam');
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
        collab.set({}, 'Your edit lost a conflict — see Collaborate');
        assert.equal(chip.textContent, 'Your edit lost a conflict — see Collaborate');
        assert.ok(chip.classList.contains('collab-notice'));
        assert.deepEqual(log, ['Collab: Your edit lost a conflict — see Collaborate']);
        timer();
        assert.equal(chip.textContent, '⇄ With Jam');
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
