// The Record button and the collapsible keyboard.
//
// Record sits on the transport bar above the tabs, on every viewport. It
// used to live in the mobile-only kb-controls row (which is how it quietly
// disappeared for desktop users) and then also in the piano roll's control
// row; the bar is the one place now.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let createToolbar;
let makeProjectSession;
let midi;

before(async () => {
    installBrowserEnv();
    installMidiStub();
    midi = await import('../html/synth/midi-manager.js');
    ({ createToolbar } = await import('../html/components/toolbar.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
});

function makeTickWorker() {
    const handlers = [];
    return {
        postMessage() {},
        addEventListener(type, fn) { if (type === 'message') handlers.push(fn); },
        tick(col) { for (const fn of handlers) fn({ data: { type: 'tick', col } }); },
    };
}

let started;
let stopped;

function build() {
    started = [];
    stopped = 0;
    const tickWorker = makeTickWorker();
    const dock = createToolbar({
        session: makeProjectSession(),
        playNoteFn: () => Promise.resolve(() => {}),
        stopNoteFn: () => {},
        tickWorker,
        startWorker: (w, bpm, col) => started.push({ bpm, col }),
        stopWorker: () => { stopped++; },
    });
    const controls = dock.querySelector('.pianoroll-controls');
    return {
        dock,
        tickWorker,
        roll: dock._pianoroll,
        controls,
        bar: dock.querySelector('.transport-bar'),
        recDesktop: dock.querySelector('.transport-record'),
        playRoll: dock.querySelector('.transport-play'),
        kbToggle: dock.querySelector('.kb-toggle'),
        kbWrapper: dock.querySelector('.keyboard-wrapper'),
    };
}

const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => {
    localStorage.clear();
    midi._reset();
});

describe('desktop Record button', () => {
    test('sits in the transport bar, right after Stop', () => {
        const { bar, recDesktop } = build();
        assert.ok(recDesktop, 'a Record button in the bar desktop users actually see');
        const kids = bar.children;
        const stopIdx = kids.findIndex(k => k.classList.contains('transport-stop'));
        assert.ok(stopIdx >= 0);
        assert.equal(kids[stopIdx + 1], recDesktop);
    });

    test('starts a recording session and stops it again', () => {
        const { recDesktop, playRoll, roll } = build();
        // With the clock stopped, Rec is a step record (toolbar-step-record
        // test); a live take is Rec over a running clock.
        roll.addNote({ midi: 60, start: 0, dur: 1, slot: 0 });
        roll.startPlayback();
        started.length = 0;
        recDesktop.dispatch('click');
        assert.deepEqual(started, [{ bpm: 120, col: 0 }], 'the tick worker is restarted for the recorder');
        assert.ok(recDesktop.classList.contains('active'));
        assert.match(recDesktop.textContent, /Stop/);
        assert.equal(playRoll.disabled, true, 'Play would be a silent no-op meanwhile');

        recDesktop.dispatch('click');
        assert.ok(stopped >= 1);
        assert.equal(recDesktop.classList.contains('active'), false);
        assert.match(recDesktop.textContent, /Rec$/);
        assert.equal(playRoll.disabled, false);
        assert.equal(roll.isPlaying(), false);
    });

    test('a key pressed during the session is recorded into the roll', async () => {
        const { dock, recDesktop, roll } = build();
        // A live take (Rec over a running clock); a quick tap into a step
        // record would be a rest — see toolbar-step-record.test.js.
        roll.addNote({ midi: 60, start: 4, dur: 1, slot: 0 });
        roll.startPlayback();
        recDesktop.dispatch('click');
        const key = dock.querySelectorAll('.key')[0];   // C2
        const ev = { button: 0, preventDefault() {} };
        key.dispatch('mousedown', ev);
        await flush();
        key.dispatch('mouseup', ev);
        await flush();
        recDesktop.dispatch('click');

        const notes = roll.getNotes();
        assert.equal(notes.length, 2);
        assert.equal(notes[1].midi, 36);
    });

    test('recording replaces running playback instead of stacking on it', () => {
        const { roll, recDesktop } = build();
        roll.addNote({ midi: 60, start: 0, dur: 1, slot: 0 });
        roll.startPlayback();
        assert.equal(roll.isPlaying(), true);
        recDesktop.dispatch('click');
        assert.equal(roll.isPlaying(), false);
        assert.ok(recDesktop.classList.contains('active'));
    });
});

describe('collapsible keyboard', () => {
    test('starts expanded, with the keys inside the wrapper the toggle controls', () => {
        const { dock, kbToggle, kbWrapper } = build();
        assert.ok(kbToggle && kbWrapper);
        assert.equal(kbWrapper.classList.contains('collapsed'), false);
        assert.match(kbToggle.textContent, /Keyboard/);
        assert.equal(kbToggle.getAttribute('aria-expanded'), 'true');
        assert.ok(kbWrapper.querySelector('.key'), 'the keys live in the wrapper');
        assert.equal(dock.querySelector('.pianoroll-container').closest('.keyboard-wrapper'), null,
            'the piano roll is not folded away with it');
    });

    test('the toggle collapses it and the choice is persisted', () => {
        const { dock, kbToggle, kbWrapper } = build();
        kbToggle.dispatch('click');
        assert.equal(kbWrapper.classList.contains('collapsed'), true);
        assert.equal(kbToggle.getAttribute('aria-expanded'), 'false');
        assert.equal(dock._isKeyboardCollapsed(), true);
        assert.equal(localStorage.getItem('openpatches_kb_collapsed'), '1');

        kbToggle.dispatch('click');
        assert.equal(kbWrapper.classList.contains('collapsed'), false);
        assert.equal(localStorage.getItem('openpatches_kb_collapsed'), '0');
    });

    test('a collapsed keyboard stays collapsed across a rebuild', () => {
        localStorage.setItem('openpatches_kb_collapsed', '1');
        const { dock, kbToggle } = build();
        assert.equal(dock._isKeyboardCollapsed(), true);
        assert.match(kbToggle.textContent, /^▸/, 'the chevron points right when folded');
    });

    test('collapsing does not interfere with recording', () => {
        const { dock, kbToggle, recDesktop } = build();
        kbToggle.dispatch('click');
        recDesktop.dispatch('click');
        assert.ok(recDesktop.classList.contains('active'), 'a step record is armed');
        assert.equal(dock._isKeyboardCollapsed(), true);
    });
});
