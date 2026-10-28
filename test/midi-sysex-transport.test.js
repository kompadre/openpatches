// Phase 4 transport: bulk send/receive and live audition.
//
// The receive path is the delicate one. It shares the input port with the
// note recorder, Web MIDI is allowed to split a 4104-byte SysEx across
// events, and a device can interleave unrelated SysEx of its own.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installBrowserEnv, installMidiStub } from './harness.js';

let midi;
let B;
let stub;
let demo;

before(async () => {
    installBrowserEnv();
    globalThis.performance = globalThis.performance || { now: () => Date.now() };
    installMidiStub();
    B = await import('../html/components/syx-builder.js');
    midi = await import('../html/synth/midi-manager.js');
    demo = new Uint8Array(readFileSync(new URL('../html/DEMO.syx', import.meta.url)));
});

beforeEach(async () => {
    localStorage.clear();
    midi._reset();
    stub = installMidiStub();
    await midi.requestMidi({ sysex: true });
    midi.setSelectedInput('in0');
    midi.setSelectedOutput('out0');
    out().sent.length = 0;
});

const out = () => stub.outputs[0];
const inp = () => stub.inputs[0];

describe('receiveBank', () => {
    test('sends a dump request, then resolves with the arriving bank', async () => {
        const p = midi.receiveBank({ timeoutMs: 2000 });
        assert.deepEqual(out().sent[0][0], [0xF0, 0x43, 0x20, 0x09, 0xF7],
            'a dump request goes out optimistically');
        inp().receive(demo);
        assert.deepEqual([...(await p)], [...demo]);
    });

    test('the request carries the configured device channel', async () => {
        midi.setDeviceChannel(4);
        const p = midi.receiveBank({ timeoutMs: 2000 });
        assert.equal(out().sent[0][0][2], 0x24);
        inp().receive(demo);
        await p;
    });

    test('reassembles a dump split across events', async () => {
        const p = midi.receiveBank({ timeoutMs: 2000 });
        for (let i = 0; i < demo.length; i += 256) {
            inp().receive(demo.slice(i, i + 256));
        }
        assert.deepEqual([...(await p)], [...demo]);
    });

    test('reports progress while a split dump arrives', async () => {
        const seen = [];
        const p = midi.receiveBank({ timeoutMs: 2000, onProgress: v => seen.push(v) });
        for (let i = 0; i < demo.length; i += 1024) inp().receive(demo.slice(i, i + 1024));
        await p;
        assert.ok(seen.length > 1, 'intermediate progress was reported');
        assert.equal(seen.at(-1), 100);
    });

    test('ignores unrelated SysEx and keeps waiting', async () => {
        const p = midi.receiveBank({ timeoutMs: 2000 });
        inp().receive([0xF0, 0x7E, 0x00, 0x06, 0x02, 0xF7]);   // identity reply
        inp().receive(B.buildVoiceDump(demo.slice(6, 134)));    // single voice
        inp().receive(demo);
        assert.deepEqual([...(await p)], [...demo]);
    });

    test('rejects a corrupted dump rather than saving a bad backup', async () => {
        const p = midi.receiveBank({ timeoutMs: 2000 });
        const bad = demo.slice();
        bad[500] = (bad[500] + 1) & 0x7F;
        inp().receive(bad);
        await assert.rejects(p, /Checksum mismatch/);
    });

    test('times out with guidance for synths that ignore dump requests', async () => {
        await assert.rejects(
            () => midi.receiveBank({ timeoutMs: 60 }),
            /Timed out waiting for the device/,
        );
    });

    test('can be cancelled', async () => {
        const ctrl = new AbortController();
        const p = midi.receiveBank({ timeoutMs: 5000, signal: ctrl.signal });
        ctrl.abort();
        await assert.rejects(p, /Cancelled/);
    });

    test('note messages still reach the recorder during a receive', async () => {
        const notes = [];
        midi.setOnMidiMessage(e => notes.push([...e.data]));
        const p = midi.receiveBank({ timeoutMs: 2000 });
        inp().receive([0x90, 60, 100]);
        inp().receive(demo);
        await p;
        assert.deepEqual(notes, [[0x90, 60, 100]], 'playing while backing up still works');
    });

    test('a completed receive stops swallowing SysEx', async () => {
        const seen = [];
        midi.setOnMidiMessage(e => seen.push([...e.data]));
        const p = midi.receiveBank({ timeoutMs: 2000 });
        inp().receive(demo);
        await p;
        inp().receive([0xF0, 0x7E, 0x00, 0xF7]);
        assert.equal(seen.length, 1, 'later SysEx is passed through, not collected');
    });
});

describe('a received bank feeds the existing .syx import', () => {
    test('parseSyxFile reads the 32 voices straight out of it', async () => {
        const { parseSyxFile } = await import('../html/components/syx-parser.js');
        const p = midi.receiveBank({ timeoutMs: 2000 });
        inp().receive(demo);
        const bytes = await p;

        // Exactly what app.js onBackupReceived does before importing.
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const patches = parseSyxFile(buf);
        assert.equal(patches.length, 32);
        assert.ok(patches[0].name.length > 0);
        assert.equal(patches[0].raw.length, 128);
    });
});

describe('sendBank', () => {
    test('sends the dump as one message', async () => {
        await midi.sendBank(demo);
        const sysex = out().sent.filter(s => s[0][0] === 0xF0);
        assert.equal(sysex.length, 1, 'chunking risks a gap mid-transfer');
        assert.deepEqual(sysex[0][0], [...demo]);
    });

    test('reports progress to completion', async () => {
        const seen = [];
        await midi.sendBank(demo, { onProgress: v => seen.push(v) });
        assert.ok(seen.length > 0);
        assert.equal(seen.at(-1), 100);
    });

    test('refuses a malformed bank instead of writing garbage to the synth', async () => {
        const bad = demo.slice();
        bad[500] = (bad[500] + 1) & 0x7F;
        await assert.rejects(() => midi.sendBank(bad), /Refusing to send a malformed bank/);
        assert.equal(out().sent.length, 0, 'nothing was transmitted');
    });

    test('refuses a wrong-length buffer', async () => {
        await assert.rejects(() => midi.sendBank(new Uint8Array(100)), /Refusing to send/);
        assert.equal(out().sent.length, 0);
    });
});

describe('live audition', () => {
    const voice = () => demo.slice(6, 134);

    test('is off until enabled', () => {
        assert.equal(midi.isAuditionEnabled(), false);
        assert.equal(midi.auditionNote(voice(), 60, 100, 500), null);
        assert.equal(out().sent.length, 0);
    });

    test('loads the edit buffer then plays a note on the device channel', () => {
        midi.setAuditionEnabled(true);
        midi.setDeviceChannel(2);
        const stop = midi.auditionNote(voice(), 60, 100, 500);
        assert.ok(stop);

        const sent = out().sent.map(s => s[0]);
        assert.equal(sent[0][0], 0xF0, 'edit-buffer dump first');
        assert.equal(sent[0].length, 163);
        assert.deepEqual(sent[1], [0x90 | 2, 60, 100]);
        assert.deepEqual(sent[2], [0x80 | 2, 60, 0], 'note-off is scheduled');
    });

    test('the edit-buffer dump goes out immediately, ahead of the delayed note-on', () => {
        // The note-on carries the output latency; the SysEx must not, or it
        // would lose its ~50 ms head start and the first note would sound
        // with the previous patch.
        midi.setAuditionEnabled(true);
        const t0 = performance.now();
        midi.auditionNote(voice(), 60, 100, 500);
        const [dump, on, off] = out().sent;
        assert.equal(dump[0][0], 0xF0);
        assert.equal(dump[1], undefined, 'SysEx is unstamped');
        assert.ok(on[1] >= t0 + midi.getOutputLatency(), 'note-on carries the output latency');
        assert.ok(off[1] > on[1], 'note-off follows the note-on');
    });

    test('does not resend an unchanged edit buffer', () => {
        midi.setAuditionEnabled(true);
        midi.auditionNote(voice(), 60, 100, 500);
        out().sent.length = 0;
        midi.auditionNote(voice(), 64, 100, 500);
        const sysex = out().sent.filter(s => s[0][0] === 0xF0);
        assert.equal(sysex.length, 0, 'a ~50 ms transfer per preview note would be audible');
    });

    test('resends when the patch changes', () => {
        midi.setAuditionEnabled(true);
        midi.auditionNote(voice(), 60, 100, 500);
        out().sent.length = 0;
        midi.auditionNote(demo.slice(134, 262), 60, 100, 500);
        assert.equal(out().sent.filter(s => s[0][0] === 0xF0).length, 1);
    });

    test('toggling off clears the dedupe cache', () => {
        midi.setAuditionEnabled(true);
        midi.auditionNote(voice(), 60, 100, 500);
        midi.setAuditionEnabled(false);
        midi.setAuditionEnabled(true);
        out().sent.length = 0;
        midi.auditionNote(voice(), 60, 100, 500);
        assert.equal(out().sent.filter(s => s[0][0] === 0xF0).length, 1,
            'the device may have been changed while it was off');
    });

    test('needs sysex permission', async () => {
        midi._reset();
        stub = installMidiStub();
        await midi.requestMidi({ sysex: false });
        midi.setSelectedOutput('out0');
        midi.setAuditionEnabled(true);
        assert.equal(midi.isAuditionEnabled(), false);
        assert.equal(midi.auditionNote(voice(), 60, 100, 500), null);
    });

    test('is persisted', () => {
        midi.setAuditionEnabled(true);
        assert.equal(JSON.parse(localStorage.getItem('openpatches_midi')).auditionEnabled, true);
    });
});
