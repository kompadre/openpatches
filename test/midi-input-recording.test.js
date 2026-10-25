// Phase 2: external MIDI input feeds the same noteOn/noteOff path as the
// on-screen keyboard. Also covers the two keyboard bugs the refactor was
// folded into:
//   - mouseleave fired a note-off for keys that were never pressed, cutting
//     sequencer notes on the active channel whenever the mouse swept across
//     the keyboard;
//   - playNote() returned undefined, so activeSounds was never populated and
//     every release fell through to a blind note-off.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let createToolbar;
let midi;
let stub;

// What the toolbar asked the synth to do, in order.
let played;      // { midi, dur, slot }
let stopped;     // midi released via the returned stop function
let blindOffs;   // midi released via the stopNoteFn fallback

before(async () => {
    installBrowserEnv();
    globalThis.performance = globalThis.performance || { now: () => Date.now() };
    installMidiStub();
    midi = await import('../html/synth/midi-manager.js');
    ({ createToolbar } = await import('../html/components/toolbar.js'));
});

// Build a toolbar whose synth hands back a working stop function.
async function makeToolbar({ asyncStop = true, returnStop = true } = {}) {
    localStorage.clear();
    midi._reset();
    stub = installMidiStub();
    played = [];
    stopped = [];
    blindOffs = [];

    const dock = createToolbar({
        playNoteFn: (m, dur, voiceData, slot, noteOpts) => {
            played.push({ midi: m, dur, slot, noteOpts });
            if (!returnStop) return asyncStop ? Promise.resolve(undefined) : undefined;
            const stop = () => stopped.push(m);
            return asyncStop ? Promise.resolve(stop) : stop;
        },
        stopNoteFn: (m) => blindOffs.push(m),
    });

    await midi.requestMidi();
    midi.setSelectedInput('in0');
    // createToolbar registered its handler at construction; selecting the
    // input is what binds it to a port.
    return dock;
}

const NOTE_ON = (ch, note, vel) => [0x90 | ch, note, vel];
const NOTE_OFF = (ch, note) => [0x80 | ch, note, 0];

function flush() {
    return new Promise(r => setTimeout(r, 0));
}

beforeEach(() => { localStorage.clear(); });

describe('MIDI input drives the shared note path', () => {
    test('note-on plays on the active record slot', async () => {
        await makeToolbar();
        stub.inputs[0].receive(NOTE_ON(0, 60, 100));
        assert.equal(played.length, 1);
        assert.equal(played[0].midi, 60);
        assert.equal(played[0].slot, 0);
    });

    test('note-off releases via the returned stop function, not a blind note-off', async () => {
        await makeToolbar();
        stub.inputs[0].receive(NOTE_ON(0, 60, 100));
        await flush();
        stub.inputs[0].receive(NOTE_OFF(0, 60));
        assert.deepEqual(stopped, [60]);
        assert.deepEqual(blindOffs, []);
    });

    test('note-on with velocity 0 is treated as note-off', async () => {
        await makeToolbar();
        stub.inputs[0].receive(NOTE_ON(0, 64, 100));
        await flush();
        stub.inputs[0].receive(NOTE_ON(0, 64, 0));
        assert.deepEqual(stopped, [64]);
    });

    test('a repeated note-on without a note-off retriggers rather than leaking', async () => {
        await makeToolbar();
        stub.inputs[0].receive(NOTE_ON(0, 60, 100));
        await flush();
        stub.inputs[0].receive(NOTE_ON(0, 60, 100));
        await flush();
        assert.deepEqual(stopped, [60], 'the first note was released');
        assert.equal(played.length, 2);
    });

    test('CC 123 releases everything that is held', async () => {
        await makeToolbar();
        for (const n of [60, 64, 67]) stub.inputs[0].receive(NOTE_ON(0, n, 100));
        await flush();
        stub.inputs[0].receive([0xB0, 123, 0]);
        assert.deepEqual(stopped.sort(), [60, 64, 67]);
    });

    test('a note-off for a key that was never down does nothing', async () => {
        await makeToolbar();
        stub.inputs[0].receive(NOTE_OFF(0, 60));
        assert.deepEqual(stopped, []);
        assert.deepEqual(blindOffs, []);
    });

    test('system messages are ignored', async () => {
        await makeToolbar();
        stub.inputs[0].receive([0xF8]);          // timing clock
        stub.inputs[0].receive([0xFE]);          // active sensing
        assert.deepEqual(played, []);
    });
});

describe('input channel filter', () => {
    test('omni accepts every channel', async () => {
        await makeToolbar();
        midi.setInputChannel(-1);
        stub.inputs[0].receive(NOTE_ON(0, 60, 100));
        stub.inputs[0].receive(NOTE_ON(7, 62, 100));
        assert.equal(played.length, 2);
    });

    test('a specific channel rejects the others', async () => {
        await makeToolbar();
        midi.setInputChannel(3);
        stub.inputs[0].receive(NOTE_ON(0, 60, 100));
        stub.inputs[0].receive(NOTE_ON(3, 62, 100));
        assert.deepEqual(played.map(p => p.midi), [62]);
    });

    test('the filter is persisted', async () => {
        await makeToolbar();
        midi.setInputChannel(9);
        assert.equal(JSON.parse(localStorage.getItem('openpatches_midi')).inputChannel, 9);
        midi.setInputChannel(99);
        assert.equal(midi.getInputChannel(), 9, 'out-of-range is rejected');
    });
});

describe('notes outside the C2-C6 grid', () => {
    test('are folded into range by octaves rather than dropped', async () => {
        await makeToolbar();
        stub.inputs[0].receive(NOTE_ON(0, 24, 100));  // C1 → C2
        stub.inputs[0].receive(NOTE_ON(0, 96, 100));  // C7 → C6
        assert.deepEqual(played.map(p => p.midi), [36, 84]);
    });

    test('the matching note-off folds the same way, so nothing sticks', async () => {
        await makeToolbar();
        stub.inputs[0].receive(NOTE_ON(0, 24, 100));
        await flush();
        stub.inputs[0].receive(NOTE_OFF(0, 24));
        assert.deepEqual(stopped, [36]);
    });
});

describe('keyboard regressions fixed by the refactor', () => {
    // Reaching the on-screen keys through the rendered DOM keeps these honest:
    // they exercise the same listeners a real click would.

    test('mouseleave on a key that was never pressed sends no note-off', async () => {
        const dock = await makeToolbar();
        const keys = dock.querySelectorAll('.key');
        assert.ok(keys.length > 0);
        // Sweep the mouse across ten keys without ever pressing one.
        for (const k of keys.slice(0, 10)) k.dispatch('mouseleave', { preventDefault() {} });
        assert.deepEqual(blindOffs, [], 'a mouse sweep must not emit note-offs');
        assert.deepEqual(stopped, []);
    });

    test('mousedown then mouseleave does release the note', async () => {
        const dock = await makeToolbar();
        const key = dock.querySelectorAll('.key')[0];
        key.dispatch('mousedown', { button: 0, preventDefault() {} });
        await flush();
        key.dispatch('mouseleave', { preventDefault() {} });
        assert.equal(stopped.length, 1);
        assert.deepEqual(blindOffs, []);
    });

    test('a key released before the synth resolves still gets stopped', async () => {
        // The async stop function arrives after the key is already back up —
        // this used to leave the note ringing for the full 30 s safety timeout.
        const dock = await makeToolbar({ asyncStop: true });
        const key = dock.querySelectorAll('.key')[0];
        key.dispatch('mousedown', { button: 0, preventDefault() {} });
        key.dispatch('mouseup', { preventDefault() {} });   // before the promise settles
        await flush();
        assert.equal(stopped.length, 1, 'the late stop function is called immediately');
    });

    test('with no stop function available, the blind fallback still fires once', async () => {
        const dock = await makeToolbar({ returnStop: false });
        const key = dock.querySelectorAll('.key')[0];
        key.dispatch('mousedown', { button: 0, preventDefault() {} });
        await flush();
        key.dispatch('mouseup', { preventDefault() {} });
        assert.equal(blindOffs.length, 1);
        // ...and not again on the trailing mouseleave
        key.dispatch('mouseleave', { preventDefault() {} });
        assert.equal(blindOffs.length, 1);
    });

    test('a 30 s safety duration is still requested for held keys', async () => {
        const dock = await makeToolbar();
        dock.querySelectorAll('.key')[0].dispatch('mousedown', { button: 0, preventDefault() {} });
        assert.equal(played[0].dur, 30000);
    });
});

describe('held notes opt out of MIDI note-off scheduling', () => {
    test('a key press is marked sustained, so the 30 s is not scheduled out', async () => {
        const dock = await makeToolbar();
        dock.querySelectorAll('.key')[0].dispatch('mousedown', { button: 0, preventDefault() {} });
        assert.equal(played[0].noteOpts.sustained, true);
    });

    test('MIDI input carries its velocity through', async () => {
        await makeToolbar();
        stub.inputs[0].receive(NOTE_ON(0, 60, 42));
        assert.equal(played[0].noteOpts.velocity, 42);
        assert.equal(played[0].noteOpts.sustained, true);
    });
});
