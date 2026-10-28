// The output-latency control in the MIDI settings modal. The value itself is
// covered in midi-output-routing; what matters here is the loop the user
// tunes with: the slider writes through live, the test tone drives the
// internal synth and the device from the same tick, and the indicator lights
// exactly when the MIDI note-on is due to leave — not when it was queued.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let midi;
let panel;
let stub;
let played;     // [midi, durMs] handed to the internal synth
let prepared;   // prepareTestNote() calls

before(async () => {
    installBrowserEnv();
    installMidiStub();
    midi = await import('../html/synth/midi-manager.js');
    panel = await import('../html/components/midi-panel.js');
});

beforeEach(async () => {
    localStorage.clear();
    midi._reset();
    stub = installMidiStub();
    document.body.children.length = 0;
    played = [];
    prepared = 0;
    await midi.requestMidi();
    midi.setSelectedOutput('out0');
    out().sent.length = 0;
});

const out = () => stub.outputs[0];
const flush = () => new Promise(r => setImmediate(r));

// Node 20's mock clock schedules a timer created *inside* a callback relative
// to the end of the current tick(), so a big jump skips the flash-off timer.
// Step a millisecond at a time instead; `each` is run after every step.
function advance(t, ms, each) {
    for (let i = 0; i < ms; i++) {
        t.mock.timers.tick(1);
        if (each) each();
    }
}

function openPanel(extra = {}) {
    panel.openMidiSettings({
        prepareTestNote: async () => { prepared++; },
        playTestNote: (m, d) => played.push([m, d]),
        ...extra,
    });
    const q = (sel) => document.body.querySelector(sel);
    return {
        slider: q('.midi-latency-slider'),
        num: q('.midi-latency-num'),
        reset: q('.midi-latency-reset'),
        start: q('.midi-latency-start'),
        flash: q('.midi-latency-flash'),
        closeBtn: q('.modal-close'),
    };
}

describe('latency slider', () => {
    test('shows the stored value and spans the allowed range', () => {
        midi.setOutputLatency(250);
        const ui = openPanel();
        assert.equal(ui.slider.value, '250');
        assert.equal(ui.num.value, '250');
        assert.equal(ui.slider.min, '0');
        assert.equal(ui.slider.max, String(midi.MAX_OUTPUT_LATENCY_MS));
    });

    test('dragging writes through live and persists', () => {
        const ui = openPanel();
        ui.slider.value = '180';
        ui.slider.dispatch('input');
        assert.equal(midi.getOutputLatency(), 180);
        assert.equal(ui.num.value, '180', 'number box follows the slider');
        assert.equal(JSON.parse(localStorage.getItem('openpatches_midi')).outputLatencyMs, 180);
    });

    test('the number box clamps to the range and reflects the clamped value', () => {
        const ui = openPanel();
        ui.num.value = '5000';
        ui.num.dispatch('change');
        assert.equal(midi.getOutputLatency(), midi.MAX_OUTPUT_LATENCY_MS);
        assert.equal(ui.num.value, String(midi.MAX_OUTPUT_LATENCY_MS));
        assert.equal(ui.slider.value, String(midi.MAX_OUTPUT_LATENCY_MS));
    });

    test('garbage in the number box leaves the setting alone', () => {
        midi.setOutputLatency(300);
        const ui = openPanel();
        ui.num.value = 'abc';
        ui.num.dispatch('change');
        assert.equal(midi.getOutputLatency(), 300);
        assert.equal(ui.num.value, '300', 'the box is put back to the real value');
    });

    test('Default restores the measured default', () => {
        midi.setOutputLatency(5);
        const ui = openPanel();
        ui.reset.dispatch('click');
        assert.equal(midi.getOutputLatency(), midi.DEFAULT_OUTPUT_LATENCY_MS);
        assert.equal(ui.slider.value, String(midi.DEFAULT_OUTPUT_LATENCY_MS));
    });
});

describe('test tone', () => {
    test('warms the synth up, then drives both engines from one tick and flashes on the wire', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        midi.setOutputLatency(200);
        midi.setDeviceChannel(2);
        const ui = openPanel();

        const t0 = performance.now();
        ui.start.dispatch('click');
        await flush();

        assert.equal(prepared, 1, 'the synth is acquired before the first tick');
        assert.deepEqual(played, [[60, 150]], 'internal synth got the tone');
        const [on, off] = out().sent;
        assert.deepEqual(on[0], [0x92, 60, 100], 'device got it on its basic channel');
        assert.ok(on[1] >= t0 + 200, 'stamped with the current latency');
        assert.deepEqual(off[0], [0x82, 60, 0], 'and a scheduled note-off');
        assert.equal(ui.start.textContent, 'Stop test tone');

        // The flash must track the *wire* time, not the moment of sending.
        assert.equal(ui.flash.classList.contains('on'), false, 'dark while the note-on is queued');
        advance(t, 199, () => assert.equal(ui.flash.classList.contains('on'), false));
        advance(t, 1);
        assert.equal(ui.flash.classList.contains('on'), true, 'lit when the note-on leaves');
        advance(t, 119, () => assert.equal(ui.flash.classList.contains('on'), true));
        advance(t, 1);
        assert.equal(ui.flash.classList.contains('on'), false, 'and out again');

        // Repeats once a second.
        advance(t, 1000 - 200 - 120);
        assert.equal(played.length, 2);
        assert.equal(out().sent.filter(s => s[0][0] === 0x92).length, 2);
    });

    test('the flash follows the slider while the tone is running', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        midi.setOutputLatency(400);
        const ui = openPanel();
        ui.start.dispatch('click');
        await flush();

        ui.slider.value = '50';
        ui.slider.dispatch('input');
        advance(t, 1000);                   // second tick fires under the new value
        out().sent.length = 0;
        advance(t, 49, () => assert.equal(ui.flash.classList.contains('on'), false));
        advance(t, 1);
        assert.equal(ui.flash.classList.contains('on'), true);
    });

    test('a second click stops the tone', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        const ui = openPanel();
        ui.start.dispatch('click');
        await flush();
        assert.equal(played.length, 1);

        ui.start.dispatch('click');
        await flush();
        assert.equal(ui.start.textContent, 'Start test tone');
        // The note-on queued by the last tick is still in flight; it must
        // not light the box after the user pressed Stop.
        advance(t, 5000, () => assert.equal(ui.flash.classList.contains('on'), false));
        assert.equal(played.length, 1, 'no more ticks');
    });

    test('closing the modal stops the tone', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        const ui = openPanel();
        ui.start.dispatch('click');
        await flush();
        ui.closeBtn.dispatch('click');
        advance(t, 5000, () => assert.equal(ui.flash.classList.contains('on'), false));
        assert.equal(played.length, 1, 'a detached modal must not keep beeping');
    });

    test('closing the modal while the synth is warming up never starts the tone', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        let release;
        const ui = openPanel({
            prepareTestNote: () => new Promise(r => { release = r; }),
        });
        ui.start.dispatch('click');
        await flush();
        ui.closeBtn.dispatch('click');
        release();
        await flush();
        advance(t, 3000);
        assert.equal(played.length, 0, 'a detached modal must not start beeping');
        assert.equal(out().sent.length, 0);
    });

    test('runs without an internal synth hook: the device and the flash still work', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        panel.openMidiSettings({});
        const start = document.body.querySelector('.midi-latency-start');
        const flash = document.body.querySelector('.midi-latency-flash');
        start.dispatch('click');
        await flush();
        assert.equal(out().sent[0][0][0], 0x90);
        advance(t, midi.getOutputLatency());
        assert.equal(flash.classList.contains('on'), true);
    });

    test('a failing warm-up is logged and the tone still runs', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        const log = [];
        const ui = openPanel({
            appendLog: (m) => log.push(m),
            prepareTestNote: async () => { throw new Error('no AudioContext'); },
        });
        ui.start.dispatch('click');
        await flush();
        assert.ok(log.some(m => /no AudioContext/.test(m)));
        assert.equal(out().sent[0][0][0], 0x90, 'MIDI side still fires');
        assert.equal(ui.start.disabled, false);
    });
});
