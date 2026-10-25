// Regression: stopping playback only stopped the tick worker, which prevents
// new note-ons but leaves anything already sounding to ring out. With MIDI
// output that is worse than a glitch — a note left on external hardware
// cannot be silenced from the browser at all.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createPianoroll;

before(async () => {
    installBrowserEnv();
    ({ createPianoroll } = await import('../html/components/pianoroll.js'));
});

function makeTickWorker() {
    const handlers = [];
    return {
        posted: [],
        postMessage(m) { this.posted.push(m); },
        addEventListener(type, fn) { if (type === 'message') handlers.push(fn); },
        tick(col) { for (const fn of handlers) fn({ data: { type: 'tick', col } }); },
    };
}

function build() {
    localStorage.setItem('openpatches_pianoroll', JSON.stringify({
        measures: 1,
        notes: [{ midi: 60, start: 0, dur: 4, slot: 0 }],
        bpm: 120,
    }));
    const released = [];
    const roll = createPianoroll({
        playNoteFn: () => {},
        onNotesChange: () => {},
        activeSlot: 0,
        tickWorker: makeTickWorker(),
        stopWorker: () => {},
        getSlotData: () => null,
        onStopPlayback: () => released.push('released'),
    });
    return { roll, released };
}

beforeEach(() => localStorage.clear());

describe('stopPlayback releases sounding notes', () => {
    test('stopping after starting fires the release hook', () => {
        const { roll, released } = build();
        roll.startPlayback();
        roll.stopPlayback();
        assert.deepEqual(released, ['released']);
    });

    test('the hook is optional', () => {
        localStorage.setItem('openpatches_pianoroll', JSON.stringify({ measures: 1, notes: [], bpm: 120 }));
        const roll = createPianoroll({
            playNoteFn: () => {},
            onNotesChange: () => {},
            activeSlot: 0,
            tickWorker: makeTickWorker(),
            stopWorker: () => {},
            getSlotData: () => null,
        });
        roll.startPlayback();
        assert.doesNotThrow(() => roll.stopPlayback());
    });
});
