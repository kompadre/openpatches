// The mobile Play/Stop button flipped to "Stop ■" whenever it was pressed,
// but the piano roll's startPlayback() is a no-op on an empty roll, so the
// label said Stop while nothing played — and the next press "stopped" it.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let createToolbar;
let midi;

before(async () => {
    installBrowserEnv();
    installMidiStub();
    midi = await import('../html/synth/midi-manager.js');
    ({ createToolbar } = await import('../html/components/toolbar.js'));
});

function build() {
    const dock = createToolbar({
        playNoteFn: () => Promise.resolve(() => {}),
        stopNoteFn: () => {},
        tickWorker: { postMessage() {}, addEventListener() {} },
        startWorker: () => {},
        stopWorker: () => {},
    });
    return { dock, roll: dock._pianoroll, play: dock.querySelector('.kb-btn-play') };
}

beforeEach(() => {
    localStorage.clear();
    midi._reset();
});

describe('mobile Play button', () => {
    test('stays "Play" when the roll is empty', () => {
        const { roll, play } = build();
        assert.equal(roll.isPlaying(), false);
        play.dispatch('click');
        assert.equal(roll.isPlaying(), false);
        assert.equal(play.textContent, 'Play ▶');
    });

    test('flips to "Stop" once playback really starts, and back', () => {
        const { roll, play } = build();
        roll.addNote({ midi: 60, start: 0, dur: 1, slot: 0 });
        play.dispatch('click');
        assert.equal(roll.isPlaying(), true);
        assert.equal(play.textContent, 'Stop ■');
        play.dispatch('click');
        assert.equal(roll.isPlaying(), false);
        assert.equal(play.textContent, 'Play ▶');
    });
});
