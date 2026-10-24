// Regression: the long-lived engine needs a silence path that doesn't destroy
// state, and per-channel capture must be reachable from JS.
//
//   * `all_notes_off()` releases every active voice with the 64-sample fade.
//     Patches, channel volumes and LUTs survive — unlike `reset_engine()`.
//     Also reachable via MIDI CC 120 / CC 123.
//   * `get_channel_samples(ch, n)` exposes SynthUnit::GetChannelSamples —
//     the pre-filter int32 capture of the last render_audio() call. One
//     static buffer, so read before the next call overwrites it.
//
// Runs the real msfa.wasm under Node against a patch from html/DEMO.syx.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WASM_URL = new URL('../html/synth/wasm/msfa.wasm', import.meta.url);
const SYX_URL = new URL('../html/DEMO.syx', import.meta.url);
const SR = 44100;

let exp;

const imports = () => ({
    wasi_snapshot_preview1: {
        fd_close: () => 0, fd_fdstat_get: () => 0, fd_seek: () => 0,
        fd_write: () => 0, poll_oneoff: () => 0, proc_exit: () => {},
        clock_time_get: () => 0,
    },
    env: { emscripten_notify_memory_growth: () => {} },
});

function loadFirstVoice() {
    const syx = readFileSync(SYX_URL);
    const view = new Uint8Array(exp.memory.buffer, exp.get_patch_buffer(), 128);
    view.set(syx.subarray(6, 6 + 128)); // skip 6-byte sysex header
    exp.load_voice_from_buffer();
}

function renderPeak(nSamples) {
    const ptr = exp.render_audio(nSamples);
    const heap = new Int16Array(exp.memory.buffer);
    let peak = 0;
    for (let i = 0; i < nSamples; i++) {
        peak = Math.max(peak, Math.abs(heap[(ptr >> 1) + i]));
    }
    return peak;
}

function channelPeak(channel, nSamples) {
    const ptr = exp.get_channel_samples(channel, nSamples);
    assert.ok(ptr, 'get_channel_samples returned a pointer');
    const heap = new Int32Array(exp.memory.buffer);
    let peak = 0;
    for (let i = 0; i < nSamples; i++) {
        peak = Math.max(peak, Math.abs(heap[(ptr >> 2) + i]));
    }
    return peak;
}

before(async () => {
    const mod = await WebAssembly.compile(readFileSync(WASM_URL));
    const inst = await WebAssembly.instantiate(mod, imports());
    exp = inst.exports;
    exp.init_engine(SR);
});

describe('all_notes_off', () => {
    test('export exists', () => {
        assert.equal(typeof exp.all_notes_off, 'function');
    });

    test('silences a ringing note without resetting the engine', () => {
        exp.reset_engine();
        loadFirstVoice();
        exp.note_on(60, 100);
        assert.ok(renderPeak(4410) > 0, 'note should be audible before the stop');

        exp.all_notes_off();
        renderPeak(128); // one block to complete the 64-sample fade
        assert.equal(renderPeak(8820), 0, 'engine silent after all_notes_off');

        // State survived: the same patch plays again without a reload
        exp.note_on(60, 100);
        assert.ok(renderPeak(4410) > 0, 'patch still loaded after all_notes_off');
    });

    test('CC 123 (all notes off) does the same via MIDI', () => {
        exp.reset_engine();
        loadFirstVoice();
        exp.note_on(60, 100);
        assert.ok(renderPeak(4410) > 0);

        exp.send_midi(0xb0, 123, 0);
        renderPeak(256); // consume the CC, finish the fade
        assert.equal(renderPeak(8820), 0, 'engine silent after CC 123');
    });
});

describe('get_channel_samples', () => {
    test('export exists', () => {
        assert.equal(typeof exp.get_channel_samples, 'function');
    });

    test('captures the playing channel, silence elsewhere', () => {
        exp.reset_engine();
        loadFirstVoice(); // slot 0 → channel 0
        exp.note_on(60, 100); // bridge note_on is channel 0
        exp.render_audio(4410);

        assert.ok(channelPeak(0, 4410) > 0, 'channel 0 captured the note');
        assert.equal(channelPeak(3, 4410), 0, 'channel 3 stayed silent');
    });
});
