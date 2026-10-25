// Phase 3: piano roll / keyboard notes fan out to an external MIDI device.
// The risky parts are the ones covered here: that a note-off always reaches
// the hardware (a stuck note is unrecoverable from the browser), that
// scheduled note-offs do not cut a repeat of the same pitch, and that
// "MIDI only" cannot silence the app when no device is actually connected.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let midi;
let stub;

before(async () => {
    installBrowserEnv();
    globalThis.performance = globalThis.performance || { now: () => Date.now() };
    installMidiStub();
    midi = await import('../html/synth/midi-manager.js');
});

beforeEach(async () => {
    localStorage.clear();
    midi._reset();
    stub = installMidiStub();
    await midi.requestMidi();
    midi.setSelectedOutput('out0');
    out().sent.length = 0;
});

const out = () => stub.outputs[0];
const msgs = () => out().sent.map(s => s[0]);
const stamps = () => out().sent.map(s => s[1]);

describe('output mode', () => {
    test('internal is the default and sends nothing', () => {
        assert.equal(midi.getOutputMode(), 'internal');
        assert.equal(midi.isMidiOutEnabled(), false);
        assert.equal(midi.isInternalEnabled(), true);
    });

    test('midi mode silences the internal synth', () => {
        midi.setOutputMode('midi');
        assert.equal(midi.isMidiOutEnabled(), true);
        assert.equal(midi.isInternalEnabled(), false);
    });

    test('both drives each engine', () => {
        midi.setOutputMode('both');
        assert.equal(midi.isMidiOutEnabled(), true);
        assert.equal(midi.isInternalEnabled(), true);
    });

    test('midi mode with no device falls back to the internal synth', () => {
        midi.setOutputMode('midi');
        midi.setSelectedOutput(null);
        assert.equal(midi.isMidiOutEnabled(), false);
        assert.equal(midi.isInternalEnabled(), true, 'must not go silent');
    });

    test('an unknown mode is rejected', () => {
        midi.setOutputMode('both');
        midi.setOutputMode('nonsense');
        assert.equal(midi.getOutputMode(), 'both');
    });

    test('mode is persisted', () => {
        midi.setOutputMode('both');
        assert.equal(JSON.parse(localStorage.getItem('openpatches_midi')).outputMode, 'both');
    });

    test('changing mode releases anything still sounding', () => {
        midi.setOutputMode('both');
        midi.playNoteOut(0, 60, 100, 0, { schedule: false });
        out().sent.length = 0;
        midi.setOutputMode('internal');
        assert.deepEqual(msgs(), [[0x80, 60, 0]]);
    });
});

describe('slot → channel mapping', () => {
    test('defaults to identity', () => {
        for (let s = 0; s < 8; s++) assert.equal(midi.getSlotChannel(s), s);
    });

    test('a remapped slot sends on its channel', () => {
        midi.setSlotChannel(0, 9);
        midi.playNoteOut(0, 60, 100, 0, { schedule: false });
        assert.deepEqual(msgs(), [[0x90 | 9, 60, 100]]);
    });

    test('out-of-range slots and channels are rejected', () => {
        midi.setSlotChannel(0, 16);
        midi.setSlotChannel(0, -1);
        midi.setSlotChannel(99, 3);
        assert.equal(midi.getSlotChannel(0), 0);
    });

    test('the map is persisted and restored', () => {
        midi.setSlotChannel(3, 11);
        assert.deepEqual(JSON.parse(localStorage.getItem('openpatches_midi')).slotChannels[3], 11);
        midi._reset();
        assert.equal(midi.getSlotChannel(3), 11);
    });

    test('a corrupt stored map falls back to identity per entry', () => {
        localStorage.setItem('openpatches_midi', JSON.stringify({
            slotChannels: [5, 'nope', 99, 2],
        }));
        midi._reset();
        assert.equal(midi.getSlotChannel(0), 5);
        assert.equal(midi.getSlotChannel(1), 1, 'non-integer ignored');
        assert.equal(midi.getSlotChannel(2), 2, 'out-of-range ignored');
        assert.equal(midi.getSlotChannel(3), 2);
    });
});

describe('note output', () => {
    test('a scheduled note-off is timestamped, not left to a timer', () => {
        const t0 = performance.now();
        midi.playNoteOut(0, 60, 100, 500);
        assert.deepEqual(msgs()[0], [0x90, 60, 100]);
        assert.deepEqual(msgs()[1], [0x80, 60, 0]);
        const when = stamps()[1];
        assert.ok(when >= t0 + 490 && when <= t0 + 500,
            `note-off scheduled ${when - t0}ms out, expected just under 500`);
    });

    test('the scheduled note-off lands early enough not to cut a repeat', () => {
        const t0 = performance.now();
        midi.playNoteOut(0, 60, 100, 500);
        // The next note at this pitch starts at t0+500; the off must precede it.
        assert.ok(stamps()[1] < t0 + 500);
    });

    test('a held note is not scheduled — only an explicit note-off ends it', () => {
        const stop = midi.playNoteOut(0, 60, 100, 30000, { schedule: false });
        assert.deepEqual(msgs(), [[0x90, 60, 100]], 'no note-off queued up front');
        stop();
        assert.deepEqual(msgs().at(-1), [0x80, 60, 0]);
    });

    test('stopping early still sends an immediate note-off', () => {
        const stop = midi.playNoteOut(0, 60, 100, 5000);
        out().sent.length = 0;
        stop();
        assert.deepEqual(msgs(), [[0x80, 60, 0]], 'duplicate note-off is safer than none');
    });

    test('stop is idempotent', () => {
        const stop = midi.playNoteOut(0, 60, 100, 0, { schedule: false });
        out().sent.length = 0;
        stop(); stop(); stop();
        assert.equal(msgs().length, 1);
    });

    test('retriggering the same pitch releases the previous note first', () => {
        midi.playNoteOut(0, 60, 100, 0, { schedule: false });
        out().sent.length = 0;
        midi.playNoteOut(0, 60, 100, 0, { schedule: false });
        assert.deepEqual(msgs(), [[0x80, 60, 0], [0x90, 60, 100]]);
    });

    test('the same pitch on two slots is independent', () => {
        midi.playNoteOut(0, 60, 100, 0, { schedule: false });
        midi.playNoteOut(1, 60, 100, 0, { schedule: false });
        out().sent.length = 0;
        midi.releaseAllOut();
        assert.deepEqual(msgs().sort(), [[0x80, 60, 0], [0x81, 60, 0]]);
    });

    test('playNoteOut with no device selected is a safe no-op', () => {
        midi.setSelectedOutput(null);
        assert.equal(midi.playNoteOut(0, 60, 100, 500), null);
    });

    test('releaseAllOut silences everything it started', () => {
        for (const n of [60, 64, 67]) midi.playNoteOut(0, n, 100, 0, { schedule: false });
        out().sent.length = 0;
        midi.releaseAllOut();
        assert.deepEqual(msgs().map(m => m[1]).sort(), [60, 64, 67]);
    });

    test('stopNoteOut releases a tracked note', () => {
        midi.playNoteOut(2, 60, 100, 0, { schedule: false });
        out().sent.length = 0;
        assert.equal(midi.stopNoteOut(2, 60), true);
        assert.deepEqual(msgs(), [[0x82, 60, 0]]);
    });

    test('stopNoteOut sends a blind note-off for an untracked note', () => {
        assert.equal(midi.stopNoteOut(2, 72), true);
        assert.deepEqual(msgs(), [[0x82, 72, 0]]);
    });

    test('panic clears the tracking map so a later release is not doubled', () => {
        midi.playNoteOut(0, 60, 100, 0, { schedule: false });
        midi.panic();
        out().sent.length = 0;
        midi.releaseAllOut();
        assert.deepEqual(msgs(), [], 'panic already silenced the device');
    });
});
