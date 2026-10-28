// Phase 3: piano roll / keyboard notes fan out to an external MIDI device.
// The risky parts are the ones covered here: that a note-off always reaches
// the hardware (a stuck note is unrecoverable from the browser), that
// scheduled note-offs do not cut a repeat of the same pitch, and that
// "MIDI only" cannot silence the app when no device is actually connected.
//
// The 'output latency' block pins performance.now() so the timestamps can be
// asserted exactly. It guards the one invariant the latency shift must
// never break: no note-off may reach the wire ahead of its own note-on.

import { test, before, beforeEach, after, describe } from 'node:test';
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
        // The implementation reads its own clock inside the call, so bracket
        // it: the stamp must sit between t0+L+498 and t1+L+498 (2 ms gap,
        // L = output latency).
        const L = midi.getOutputLatency();
        const t0 = performance.now();
        midi.playNoteOut(0, 60, 100, 500);
        const t1 = performance.now();
        assert.deepEqual(msgs()[0], [0x90, 60, 100]);
        assert.deepEqual(msgs()[1], [0x80, 60, 0]);
        const when = stamps()[1];
        assert.ok(when >= t0 + L + 490 && when <= t1 + L + 498,
            `note-off scheduled ${when - t0 - L}ms past the latency, expected just under 500`);
    });

    test('the scheduled note-off lands early enough not to cut a repeat', () => {
        midi.playNoteOut(0, 60, 100, 500);
        const t1 = performance.now();
        // The next note at this pitch starts no earlier than 500 ms after the
        // call returned, and carries the same latency; the off must precede it.
        assert.ok(stamps()[1] < t1 + midi.getOutputLatency() + 500);
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

describe('output latency', () => {
    // Pin the clock so every stamp is exact. L is the only number that
    // matters here; the tests read it from the module rather than repeating
    // it, so retuning the constant does not mean retuning the suite.
    const NOW = 10_000;
    let L;
    let realNow;

    before(() => {
        L = midi.getOutputLatency();
        realNow = performance.now;
        performance.now = () => NOW;
    });

    after(() => {
        performance.now = realNow;
    });

    test('the default is a sane positive number of milliseconds', () => {
        assert.equal(L, midi.DEFAULT_OUTPUT_LATENCY_MS);
        assert.ok(Number.isFinite(L) && L > 0 && L <= midi.MAX_OUTPUT_LATENCY_MS, `default = ${L}`);
    });

    test('the setting is applied to the very next send', () => {
        midi.setOutputLatency(100);
        midi.playNoteOut(0, 60, 100, 500);
        assert.deepEqual(stamps(), [NOW + 100, NOW + 100 + 498]);
    });

    test('a note started under one latency is released under the new one', () => {
        // The off is stamped later than the on, so changing the setting
        // mid-note cannot invert their order on the wire.
        midi.setOutputLatency(500);
        const stop = midi.playNoteOut(0, 60, 100, 0, { schedule: false });
        midi.setOutputLatency(0);
        out().sent.length = 0;
        stop();
        assert.equal(stamps()[0], NOW, 'released on the new clock');
    });

    test('the setting is clamped, rounded and non-numbers are ignored', () => {
        midi.setOutputLatency(-5);
        assert.equal(midi.getOutputLatency(), 0);
        midi.setOutputLatency(midi.MAX_OUTPUT_LATENCY_MS + 1000);
        assert.equal(midi.getOutputLatency(), midi.MAX_OUTPUT_LATENCY_MS);
        midi.setOutputLatency(12.6);
        assert.equal(midi.getOutputLatency(), 13);
        midi.setOutputLatency('nope');
        midi.setOutputLatency(NaN);
        midi.setOutputLatency(undefined);
        assert.equal(midi.getOutputLatency(), 13);
        midi.setOutputLatency('250');
        assert.equal(midi.getOutputLatency(), 250, 'numeric strings from an <input> are fine');
    });

    test('the setting is persisted, restored, and falls back to the default when corrupt', () => {
        midi.setOutputLatency(42);
        assert.equal(JSON.parse(localStorage.getItem('openpatches_midi')).outputLatencyMs, 42);
        midi._reset();
        assert.equal(midi.getOutputLatency(), 42);

        localStorage.setItem('openpatches_midi', JSON.stringify({ outputLatencyMs: 'lots' }));
        midi._reset();
        assert.equal(midi.getOutputLatency(), L);

        localStorage.setItem('openpatches_midi', JSON.stringify({ outputLatencyMs: 99999 }));
        midi._reset();
        assert.equal(midi.getOutputLatency(), midi.MAX_OUTPUT_LATENCY_MS, 'a stored value is clamped too');
    });

    test('a fresh _reset() with empty storage goes back to the default', () => {
        midi.setOutputLatency(42);
        localStorage.clear();
        midi._reset();
        assert.equal(midi.getOutputLatency(), L);
    });

    test('a note-on is stamped exactly OUTPUT_LATENCY_MS ahead of now', () => {
        midi.playNoteOut(0, 60, 100, 0, { schedule: false });
        assert.deepEqual(out().sent, [[[0x90, 60, 100], NOW + L]]);
    });

    test('the scheduled note-off keeps the full duration (same clock as the note-on)', () => {
        // Regression: shifting only the note-on shortened every piano-roll
        // note by the latency.
        midi.playNoteOut(0, 60, 100, 500);
        assert.deepEqual(stamps(), [NOW + L, NOW + L + 498]);
    });

    test('a note shorter than the latency still ends after it starts', () => {
        // Regression: with an unshifted note-off, any note under L ms had
        // its off arrive first and the on stuck forever.
        midi.playNoteOut(0, 60, 100, 100);
        const [on, off] = stamps();
        assert.deepEqual(msgs(), [[0x90, 60, 100], [0x80, 60, 0]]);
        assert.ok(off > on, `note-off at ${off} must follow note-on at ${on}`);
        assert.equal(off, NOW + L + 98);
    });

    test('a 1 ms note still orders off after on', () => {
        midi.playNoteOut(0, 60, 100, 1);
        const [on, off] = stamps();
        assert.ok(off > on);
    });

    test('an explicit stop() is delayed too, so it cannot overtake the note-on', () => {
        const stop = midi.playNoteOut(0, 60, 100, 5000);
        const onAt = stamps()[0];
        out().sent.length = 0;
        stop();
        assert.deepEqual(out().sent, [[[0x80, 60, 0], NOW + L]]);
        assert.ok(stamps()[0] >= onAt);
    });

    test('a held note released by stopNoteOut is delayed', () => {
        midi.playNoteOut(3, 60, 100, 30000, { schedule: false });
        out().sent.length = 0;
        midi.stopNoteOut(3, 60);
        assert.deepEqual(out().sent, [[[0x83, 60, 0], NOW + L]]);
    });

    test('a blind stopNoteOut for an untracked note is delayed', () => {
        midi.stopNoteOut(3, 72);
        assert.deepEqual(out().sent, [[[0x83, 72, 0], NOW + L]]);
    });

    test('releaseAllOut puts every note-off on the same clock', () => {
        for (const n of [60, 64, 67]) midi.playNoteOut(0, n, 100, 0, { schedule: false });
        out().sent.length = 0;
        midi.releaseAllOut();
        assert.equal(out().sent.length, 3);
        for (const [, at] of out().sent) assert.equal(at, NOW + L);
    });

    test('a retrigger sends the old note-off before the new note-on at the same stamp', () => {
        midi.playNoteOut(0, 60, 100, 0, { schedule: false });
        out().sent.length = 0;
        midi.playNoteOut(0, 60, 100, 0, { schedule: false });
        assert.deepEqual(out().sent, [
            [[0x80, 60, 0], NOW + L],
            [[0x90, 60, 100], NOW + L],
        ]);
    });

    test('an explicit time option places the whole note on that clock', () => {
        midi.playNoteOut(0, 60, 100, 500, { time: NOW + 250 });
        assert.deepEqual(stamps(), [NOW + 250 + L, NOW + 250 + L + 498]);
    });

    test('raw send() is shifted like everything else, with or without a timestamp', () => {
        midi.send([0xB0, 7, 100]);
        midi.send([0xB0, 7, 50], NOW + 1000);
        assert.deepEqual(out().sent, [
            [[0xB0, 7, 100], NOW + L],
            [[0xB0, 7, 50], NOW + 1000 + L],
        ]);
    });

    test('panic catches a note-on that is still in flight', () => {
        // Regression: an immediate-only panic silenced the device, then the
        // queued note-on landed and stuck.
        midi.playNoteOut(5, 60, 100, 0, { schedule: false });
        const onAt = stamps()[0];
        out().sent.length = 0;
        midi.panic();
        const immediate = out().sent.filter(s => s[1] === undefined);
        const delayed = out().sent.filter(s => s[1] !== undefined);
        assert.equal(immediate.length, 32, 'an unstamped sweep goes out right now');
        assert.equal(delayed.length, 32, 'and a second one once the queue has drained');
        const late = delayed.filter(([d, at]) => d[0] === (0xB0 | 5) && d[1] === 123 && at >= onAt);
        assert.equal(late.length, 1, 'All Notes Off on ch5 lands after the queued note-on');
    });

    test('the calibration probe plays on the device channel like a piano-roll note', () => {
        midi.setDeviceChannel(4);
        const stop = midi.playLatencyProbe(60, { durMs: 150 });
        assert.ok(stop);
        assert.deepEqual(out().sent, [
            [[0x94, 60, 100], NOW + L],
            [[0x84, 60, 0], NOW + L + 148],
        ]);
    });

    test('the probe fires onWire when the note-on is due to leave', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        midi.setOutputLatency(200);
        let fired = 0;
        midi.playLatencyProbe(60, { onWire: () => fired++ });
        t.mock.timers.tick(199);
        assert.equal(fired, 0);
        t.mock.timers.tick(1);
        assert.equal(fired, 1);
    });

    test('the probe still flashes with no device selected', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        midi.setSelectedOutput(null);
        let fired = 0;
        assert.equal(midi.playLatencyProbe(60, { onWire: () => fired++ }), null);
        t.mock.timers.tick(L);
        assert.equal(fired, 1);
    });

    test('the bookkeeping timer tracks the note end, so a late stop sends nothing', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const stop = midi.playNoteOut(0, 60, 100, 500);
        t.mock.timers.tick(499);
        assert.ok(midi.stopNoteOut(0, 60), 'still tracked just before the end');
        out().sent.length = 0;
        t.mock.timers.tick(1);
        stop();
        assert.deepEqual(out().sent, [], 'the scheduled note-off already covers it');
    });

    test('the bookkeeping timer is relative to the time option', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        // A note that started 400 ms ago with 500 ms to run ends in 100 ms.
        midi.playNoteOut(0, 60, 100, 500, { time: NOW - 400 });
        t.mock.timers.tick(100);
        out().sent.length = 0;
        assert.equal(midi.stopNoteOut(0, 60), true);
        assert.deepEqual(msgs(), [[0x80, 60, 0]], 'untracked by now: a blind off, not a tracked stop');
    });
});
