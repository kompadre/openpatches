// The note output (html/synth/note-output.js) — Player phase 2's one
// interface: ons held open through the playNote chain, offs via the stop
// function it hands back (possibly later — the synth may still be
// starting), and an all-off that finds everything.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createNoteOutput } from '../html/synth/note-output.js';

const on = (slot, midi, vel) => ({ type: 'on', slot, midi, vel });

describe('note output', () => {
    test('noteOn plays sustained with the velocity; noteOff runs the stop once', () => {
        const calls = [];
        const stops = [];
        const out = createNoteOutput((midi, durMs, voiceData, slot, opts) => {
            calls.push({ midi, durMs, slot, opts });
            const stop = () => stops.push(midi);
            return stop;
        });
        out.noteOn(on(0, 60, 42), 500, null);
        assert.deepEqual(calls[0], { midi: 60, durMs: 500, slot: 0, opts: { sustained: true, velocity: 42 } });
        out.noteOff(0, 60);
        out.noteOff(0, 60);
        assert.deepEqual(stops, [60], 'a second off is a no-op');
    });

    test('no velocity: the chain falls back to its own default', () => {
        const calls = [];
        const out = createNoteOutput((midi, durMs, voiceData, slot, opts) => { calls.push(opts); });
        out.noteOn(on(0, 60), 500, null);
        assert.deepEqual(calls[0], { sustained: true });
    });

    test('an off that arrives before the stop resolves still lands', async () => {
        const stops = [];
        let resolve;
        const out = createNoteOutput(() => new Promise(r => { resolve = r; }));
        out.noteOn(on(1, 64, 100), 500, null);
        out.noteOff(1, 64);                            // synth still starting
        assert.deepEqual(stops, []);
        resolve(() => stops.push(64));
        await Promise.resolve();
        await Promise.resolve();
        assert.deepEqual(stops, [64], 'stopped the moment the stop landed');
    });

    test('allOff stops everything sounding, and an off for a note never on is a no-op', () => {
        const stops = [];
        const out = createNoteOutput((midi) => () => stops.push(midi));
        out.noteOn(on(0, 60, 100), 500, null);
        out.noteOn(on(1, 64, 100), 500, null);
        out.noteOff(2, 72);                            // never on
        out.allOff();
        assert.deepEqual(stops.sort(), [60, 64]);
        out.allOff();
        assert.deepEqual(stops.sort(), [60, 64], 'idempotent');
    });

    test('a retrigger replaces the entry: the first stop is dropped, the second answers the off', () => {
        const stops = [];
        const out = createNoteOutput((midi, d, v, s, o) => () => stops.push(o.velocity));
        out.noteOn(on(0, 60, 1), 500, null);
        out.noteOn(on(0, 60, 2), 500, null);
        out.noteOff(0, 60);
        assert.deepEqual(stops, [2]);
    });
});
