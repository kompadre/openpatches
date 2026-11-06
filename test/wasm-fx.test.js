// Per-track effects in the WASM engine (P1).
//
// The guarantees this file exists to hold:
//
//   * **Bypass is exact.** With every channel mask at 0 and ducking off,
//     the renderer takes the path it took before effects existed and the
//     output is identical sample for sample — even after parameters have
//     been set. This is the whole answer to "effects must not cost
//     anything when unused".
//   * Each effect moves the signal in its own direction when switched on.
//   * Channels 8..15 never see the stage — the preview (channel 15) must
//     not inherit a track's delay.
//   * The ducker leaves its own source alone and ducks the others.
//
// Runs the real msfa.wasm under Node against a patch from html/DEMO.syx.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FxEnable, FxParam, FxGlobalParam, FX_CHANNELS }
    from '../html/synth/fx-params.js';

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

before(async () => {
    const mod = await WebAssembly.compile(readFileSync(WASM_URL));
    const inst = await WebAssembly.instantiate(mod, imports());
    exp = inst.exports;
    exp.init_engine(SR);
});

/** Load the demo patch into a bank slot (slot index IS the MIDI channel). */
function loadVoice(slot) {
    const syx = readFileSync(SYX_URL);
    const view = new Uint8Array(exp.memory.buffer, exp.get_patch_buffer(), 128);
    view.set(syx.subarray(6, 6 + 128)); // skip the 6-byte sysex header
    exp.load_voice_channel_from_buffer(slot);
}

/** Every effect off, ducking off — the bypass state. */
function fxOff() {
    for (let ch = 0; ch < FX_CHANNELS; ch++) exp.set_fx_enabled(ch, 0);
    exp.set_global_fx_param(FxGlobalParam.FX_G_DUCK_SOURCE, -1);
}

function noteOn(channel, note, vel) {
    exp.send_midi(0x90 | channel, note, vel);
}

/** Render into a detached copy — the static buffer is reused next call. */
function render(nSamples) {
    const ptr = exp.render_audio(nSamples);
    assert.ok(ptr, 'render_audio returned a pointer');
    const heap = new Int16Array(exp.memory.buffer);
    return heap.slice(ptr >> 1, (ptr >> 1) + nSamples);
}

/**
 * A render from a known-clean engine: reset, load the given channels,
 * strike a note on each, render. Used to compare two configurations that
 * must come out the same.
 */
function freshRender(channels, nSamples) {
    exp.reset_engine();
    for (const ch of channels) loadVoice(ch);
    for (const ch of channels) noteOn(ch, 60, 100);
    return render(nSamples);
}

function peak(buf, from = 0, to = buf.length) {
    let p = 0;
    for (let i = from; i < to; i++) p = Math.max(p, Math.abs(buf[i]));
    return p;
}

function rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
}

describe('fx exports', () => {
    test('all three exist', () => {
        assert.equal(typeof exp.set_fx_enabled, 'function');
        assert.equal(typeof exp.set_fx_param, 'function');
        assert.equal(typeof exp.set_global_fx_param, 'function');
    });

    test('out-of-range channels are ignored, not a trap', () => {
        exp.set_fx_enabled(-1, FxEnable.FX_EN_DELAY);
        exp.set_fx_enabled(FX_CHANNELS, FxEnable.FX_EN_DELAY);
        exp.set_fx_enabled(99, FxEnable.FX_EN_DELAY);
        exp.set_fx_param(99, FxParam.FX_DELAY_TIME, 100);
        exp.set_fx_param(0, 9999, 1);
        exp.set_global_fx_param(9999, 1);
        fxOff();
        assert.ok(peak(freshRender([0], 2048)) > 0, 'engine still renders');
    });
});

describe('bypass is exact', () => {
    test('masks at zero render identically to before any fx call', () => {
        fxOff();
        const reference = freshRender([0], 4410);
        assert.ok(peak(reference) > 0, 'reference render is not silent');

        // Set every parameter to something extreme, but switch nothing on.
        for (let ch = 0; ch < FX_CHANNELS; ch++) {
            exp.set_fx_param(ch, FxParam.FX_DELAY_TIME, 120);
            exp.set_fx_param(ch, FxParam.FX_DELAY_FEEDBACK, 0.9);
            exp.set_fx_param(ch, FxParam.FX_DELAY_MIX, 1);
            exp.set_fx_param(ch, FxParam.FX_DRIVE_AMOUNT, 48);
            exp.set_fx_param(ch, FxParam.FX_COMP_THRESHOLD, -48);
            exp.set_fx_param(ch, FxParam.FX_COMP_RATIO, 20);
            exp.set_fx_param(ch, FxParam.FX_SEND_LEVEL, 1);
        }
        exp.set_global_fx_param(FxGlobalParam.FX_G_REVERB_LEVEL, 1);
        exp.set_global_fx_param(FxGlobalParam.FX_G_REVERB_DECAY, 0.95);

        const after = freshRender([0], 4410);
        assert.deepEqual(after, reference,
            'setting parameters without enabling anything changed the output');
    });

    test('switching an effect on and off again returns to the reference', () => {
        fxOff();
        const reference = freshRender([0], 4410);

        exp.set_fx_enabled(0, FxEnable.FX_EN_DRIVE);
        freshRender([0], 4410);

        fxOff();
        assert.deepEqual(freshRender([0], 4410), reference);
    });
});

describe('delay', () => {
    test('fully wet with no feedback delays the attack by its time', () => {
        fxOff();
        exp.set_fx_param(0, FxParam.FX_DELAY_TIME, 50); // 2205 samples at 44.1k
        exp.set_fx_param(0, FxParam.FX_DELAY_FEEDBACK, 0);
        exp.set_fx_param(0, FxParam.FX_DELAY_MIX, 1);
        exp.set_fx_enabled(0, FxEnable.FX_EN_DELAY);

        const out = freshRender([0], 4410);
        assert.equal(peak(out, 0, 2000), 0,
            'nothing should sound before the delay time has elapsed');
        assert.ok(peak(out, 2400, 4410) > 0,
            'the delayed signal should arrive after it');
        fxOff();
    });

    test('a dry/wet mix of zero is inaudible even when enabled', () => {
        fxOff();
        const reference = freshRender([0], 4410);

        exp.set_fx_param(0, FxParam.FX_DELAY_MIX, 0);
        exp.set_fx_param(0, FxParam.FX_DELAY_FEEDBACK, 0);
        exp.set_fx_enabled(0, FxEnable.FX_EN_DELAY);
        const out = freshRender([0], 4410);

        // Not bit-identical — the signal makes a round trip through float —
        // but it must be the same sound.
        assert.ok(Math.abs(rms(out) - rms(reference)) / rms(reference) < 0.01,
            'mix=0 should pass the dry signal through');
        fxOff();
    });
});

describe('drive', () => {
    test('saturation raises the RMS of the same note', () => {
        fxOff();
        const reference = freshRender([0], 4410);

        exp.set_fx_param(0, FxParam.FX_DRIVE_AMOUNT, 32);
        exp.set_fx_param(0, FxParam.FX_DRIVE_LEVEL, 1);
        exp.set_fx_enabled(0, FxEnable.FX_EN_DRIVE);
        const driven = freshRender([0], 4410);

        assert.ok(rms(driven) > rms(reference) * 1.5,
            `drive should make it louder and denser ` +
            `(${rms(reference).toFixed(0)} -> ${rms(driven).toFixed(0)})`);
        fxOff();
    });
});

describe('compressor', () => {
    test('a low threshold and a high ratio pull the peak down', () => {
        fxOff();
        const reference = freshRender([0], 4410);

        exp.set_fx_param(0, FxParam.FX_COMP_THRESHOLD, -40);
        exp.set_fx_param(0, FxParam.FX_COMP_RATIO, 20);
        exp.set_fx_param(0, FxParam.FX_COMP_ATTACK, 1);
        exp.set_fx_param(0, FxParam.FX_COMP_MAKEUP, 0);
        exp.set_fx_enabled(0, FxEnable.FX_EN_COMP);
        const squashed = freshRender([0], 4410);

        assert.ok(peak(squashed) < peak(reference),
            `compression should reduce the peak ` +
            `(${peak(reference)} -> ${peak(squashed)})`);
        fxOff();
    });
});

describe('channels without effects', () => {
    test('the preview channel 15 is untouched by a track effect', () => {
        fxOff();
        const reference = freshRender([15], 4410);
        assert.ok(peak(reference) > 0, 'channel 15 renders');

        // Drive hard on every channel that can carry it.
        for (let ch = 0; ch < FX_CHANNELS; ch++) {
            exp.set_fx_param(ch, FxParam.FX_DRIVE_AMOUNT, 64);
            exp.set_fx_enabled(ch, FxEnable.FX_EN_DRIVE);
        }
        assert.deepEqual(freshRender([15], 4410), reference,
            'the preview channel went through the effects stage');
        fxOff();
    });
});

describe('ducking', () => {
    test('a silent source ducks nobody', () => {
        fxOff();
        const reference = freshRender([1], 4410);

        exp.set_global_fx_param(FxGlobalParam.FX_G_DUCK_SOURCE, 7); // no voice
        exp.set_global_fx_param(FxGlobalParam.FX_G_DUCK_AMOUNT, 40);
        exp.set_global_fx_param(FxGlobalParam.FX_G_DUCK_THRESHOLD, -60);
        const out = freshRender([1], 4410);

        assert.ok(Math.abs(rms(out) - rms(reference)) / rms(reference) < 0.01,
            'nothing was playing on the source, so nothing should have ducked');
        fxOff();
    });

    test('the source itself is never ducked', () => {
        fxOff();
        const reference = freshRender([0], 4410);

        exp.set_global_fx_param(FxGlobalParam.FX_G_DUCK_SOURCE, 0);
        exp.set_global_fx_param(FxGlobalParam.FX_G_DUCK_AMOUNT, 40);
        exp.set_global_fx_param(FxGlobalParam.FX_G_DUCK_THRESHOLD, -60);
        const out = freshRender([0], 4410);

        assert.ok(Math.abs(rms(out) - rms(reference)) / rms(reference) < 0.01,
            'the one boosted track must pass through untouched');
        fxOff();
    });

    test('everyone else ducks under it', () => {
        fxOff();
        exp.set_global_fx_param(FxGlobalParam.FX_G_DUCK_SOURCE, 0);
        exp.set_global_fx_param(FxGlobalParam.FX_G_DUCK_THRESHOLD, -60);
        exp.set_global_fx_param(FxGlobalParam.FX_G_DUCK_ATTACK, 0.1);

        exp.set_global_fx_param(FxGlobalParam.FX_G_DUCK_AMOUNT, 0);
        const open = freshRender([0, 1], 4410);

        exp.set_global_fx_param(FxGlobalParam.FX_G_DUCK_AMOUNT, 40);
        const ducked = freshRender([0, 1], 4410);

        assert.ok(rms(ducked) < rms(open),
            `channel 1 should have been pulled down under channel 0 ` +
            `(${rms(open).toFixed(0)} -> ${rms(ducked).toFixed(0)})`);
        fxOff();
    });
});

describe('reset_engine and fx state', () => {
    test('drops the delay tail but keeps the parameters', () => {
        fxOff();
        exp.set_fx_param(0, FxParam.FX_DELAY_TIME, 50);
        exp.set_fx_param(0, FxParam.FX_DELAY_FEEDBACK, 0);
        exp.set_fx_param(0, FxParam.FX_DELAY_MIX, 1);
        exp.set_fx_enabled(0, FxEnable.FX_EN_DELAY);

        // Fill the line, then pull the emergency stop mid-tail.
        freshRender([0], 2048);
        exp.reset_engine();
        loadVoice(0);
        const after = render(2048);
        assert.equal(peak(after), 0,
            'the delay tail survived reset_engine — the stop was not silent');

        // ...and the settings are still there: the same note is still
        // delayed by the same 50 ms rather than coming through dry.
        noteOn(0, 60, 100);
        const out = render(4410);
        assert.equal(peak(out, 0, 1500), 0,
            'reset_engine forgot the delay settings');
        fxOff();
    });
});
