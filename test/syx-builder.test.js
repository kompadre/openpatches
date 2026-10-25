// Phase 4 encoder. html/DEMO.syx is the golden fixture: a real 4104-byte DX7
// bulk dump. Parsing it and rebuilding it has to reproduce the file byte for
// byte — that single assertion covers the header, the packing and the
// checksum at once, and it is checked against a file nobody in this repo
// wrote by hand.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installBrowserEnv } from './harness.js';

let B;        // syx-builder
let params;   // dx7-params
let demo;

before(async () => {
    installBrowserEnv();
    B = await import('../html/components/syx-builder.js');
    params = await import('../html/components/dx7-params.js');
    demo = new Uint8Array(readFileSync(new URL('../html/DEMO.syx', import.meta.url)));
});

const voicesOf = (dump) => Array.from({ length: 32 },
    (_, i) => dump.slice(6 + i * 128, 6 + (i + 1) * 128));

describe('DEMO.syx golden fixture', () => {
    test('is the shape we think it is', () => {
        assert.equal(demo.length, 4104);
        assert.deepEqual([...demo.slice(0, 6)], [0xF0, 0x43, 0x00, 0x09, 0x20, 0x00]);
        assert.equal(demo[4103], 0xF7);
    });

    test('validates, checksum included', () => {
        const r = B.validateBulkDump(demo);
        assert.equal(r.ok, true, r.error);
    });

    test('its stored checksum matches a freshly computed one', () => {
        assert.equal(B.sysexChecksum(demo.subarray(6, 6 + 4096)), demo[4102]);
    });

    test('round-trips byte for byte through buildBulkDump', () => {
        const rebuilt = B.buildBulkDump(voicesOf(demo), { channel: 0 });
        assert.equal(rebuilt.length, demo.length);
        assert.deepEqual([...rebuilt], [...demo]);
    });
});

describe('buildBulkDump', () => {
    test('pads short banks with INIT VOICE', () => {
        const dump = B.buildBulkDump(voicesOf(demo).slice(0, 3));
        assert.equal(dump.length, 4104);
        const init = B.makeInitVoice();
        for (let slot = 3; slot < 32; slot++) {
            const got = dump.slice(6 + slot * 128, 6 + (slot + 1) * 128);
            assert.deepEqual([...got], [...init], 'slot ' + slot);
        }
    });

    test('drops voices past 32', () => {
        const many = [...voicesOf(demo), ...voicesOf(demo)];
        assert.equal(B.buildBulkDump(many).length, 4104);
    });

    test('accepts patch objects carrying base64 voice_data', () => {
        const patches = voicesOf(demo).map(raw => ({
            voice_data: params.encodeVoiceData(raw),
        }));
        assert.deepEqual([...B.buildBulkDump(patches)], [...demo]);
    });

    test('an empty bank is all INIT and still valid', () => {
        const dump = B.buildBulkDump([]);
        assert.equal(B.validateBulkDump(dump).ok, true);
    });

    test('encodes the device channel into the sub-status byte', () => {
        assert.equal(B.buildBulkDump([], { channel: 0 })[2], 0x00);
        assert.equal(B.buildBulkDump([], { channel: 5 })[2], 0x05);
        assert.equal(B.buildBulkDump([], { channel: 15 })[2], 0x0F);
    });

    test('the checksum is recomputed for the payload actually sent', () => {
        const dump = B.buildBulkDump(voicesOf(demo).slice(0, 10));
        assert.equal(B.validateBulkDump(dump).ok, true);
        assert.notEqual(dump[4102], demo[4102], 'a different bank has a different checksum');
    });
});

describe('validateBulkDump', () => {
    test('rejects a wrong length', () => {
        assert.match(B.validateBulkDump(demo.slice(0, 100)).error, /Expected 4104/);
        assert.match(B.validateBulkDump(null).error, /Expected 4104/);
    });

    test('rejects missing framing', () => {
        const bad = demo.slice(); bad[0] = 0x00;
        assert.match(B.validateBulkDump(bad).error, /F0\/F7/);
    });

    test('rejects a non-Yamaha message', () => {
        const bad = demo.slice(); bad[1] = 0x41;
        assert.match(B.validateBulkDump(bad).error, /Yamaha/);
    });

    test('rejects a single-voice dump', () => {
        const bad = demo.slice(); bad[3] = 0x00;
        assert.match(B.validateBulkDump(bad).error, /32-voice/);
    });

    test('catches a single corrupted payload byte', () => {
        const bad = demo.slice();
        bad[2000] = (bad[2000] + 1) & 0x7F;
        const r = B.validateBulkDump(bad);
        assert.equal(r.ok, false);
        assert.match(r.error, /Checksum mismatch/);
    });
});

describe('unpackVoice (packed 128 → VCED 155)', () => {
    test('produces 155 bytes', () => {
        assert.equal(B.unpackVoice(voicesOf(demo)[0]).length, 155);
    });

    test('is lossless — every DEMO voice repacks to its original bytes', () => {
        // Re-packing with dx7-params' writers is the inverse operation, so a
        // mismatch means the unpacker put a field in the wrong slot.
        for (const packed of voicesOf(demo)) {
            const u = B.unpackVoice(packed);
            const re = new Uint8Array(128);
            for (let i = 0; i < 6; i++) {
                const b = i * 21;
                params.writeOp(re, i, {
                    r1: u[b], r2: u[b + 1], r3: u[b + 2], r4: u[b + 3],
                    l1: u[b + 4], l2: u[b + 5], l3: u[b + 6], l4: u[b + 7],
                    breakPoint: u[b + 8], lDepth: u[b + 9], rDepth: u[b + 10],
                    lCurve: u[b + 11], rCurve: u[b + 12], rateScaling: u[b + 13],
                    amSens: u[b + 14], velSens: u[b + 15], outputLevel: u[b + 16],
                    oscMode: u[b + 17], freqCoarse: u[b + 18], freqFine: u[b + 19],
                    detune: u[b + 20],
                });
            }
            params.writeGlobal(re, {
                pitchR1: u[126], pitchR2: u[127], pitchR3: u[128], pitchR4: u[129],
                pitchL1: u[130], pitchL2: u[131], pitchL3: u[132], pitchL4: u[133],
                algorithm: u[134], feedback: u[135], keySync: u[136],
                lfoSpeed: u[137], lfoDelay: u[138], lfoPmDepth: u[139], lfoAmd: u[140],
                lfoSync: u[141], lfoWaveform: u[142], lfoPmSens: u[143],
                transpose: u[144],
                name: String.fromCharCode(...u.slice(145, 155)),
            });
            assert.deepEqual([...re], [...packed]);
        }
    });

    test('the voice name lands in the last 10 bytes', () => {
        const u = B.unpackVoice(voicesOf(demo)[0]);
        const name = String.fromCharCode(...u.slice(145, 155));
        const expected = String.fromCharCode(...voicesOf(demo)[0].slice(118, 128));
        assert.equal(name.trimEnd(), expected.replace(/\0/g, '').trimEnd());
    });

    test('LFO pitch-mod sensitivity is clamped to the 3-bit VCED field', () => {
        const packed = B.makeInitVoice();
        packed[116] |= 0xF0;                      // force all 4 read bits high
        assert.ok(B.unpackVoice(packed)[143] <= 7);
    });

    test('rejects undersized input', () => {
        assert.equal(B.unpackVoice(new Uint8Array(64)), null);
        assert.equal(B.unpackVoice(null), null);
    });
});

describe('buildVoiceDump (edit buffer)', () => {
    test('has the format-0 header and correct length', () => {
        const msg = B.buildVoiceDump(voicesOf(demo)[0], { channel: 0 });
        assert.equal(msg.length, 163);
        assert.deepEqual([...msg.slice(0, 6)], [0xF0, 0x43, 0x00, 0x00, 0x01, 0x1B]);
        assert.equal(msg[162], 0xF7);
    });

    test('byte count in the header matches the 155-byte body', () => {
        const msg = B.buildVoiceDump(voicesOf(demo)[0]);
        assert.equal((msg[4] << 7) | msg[5], 155);
    });

    test('checksum covers the body', () => {
        const msg = B.buildVoiceDump(voicesOf(demo)[0]);
        assert.equal(msg[161], B.sysexChecksum(msg.subarray(6, 161)));
    });

    test('carries the device channel', () => {
        assert.equal(B.buildVoiceDump(voicesOf(demo)[0], { channel: 9 })[2], 0x09);
    });

    test('every byte is valid 7-bit MIDI data', () => {
        const msg = B.buildVoiceDump(voicesOf(demo)[0]);
        for (let i = 1; i < msg.length - 1; i++) {
            assert.ok(msg[i] < 0x80, `byte ${i} = ${msg[i]} has the status bit set`);
        }
    });
});

describe('makeInitVoice', () => {
    test('is named INIT VOICE', () => {
        assert.equal(params.readGlobal(B.makeInitVoice()).name.trimEnd(), 'INIT VOICE');
    });

    test('only OP1 is audible', () => {
        const init = B.makeInitVoice();
        const levels = [0, 1, 2, 3, 4, 5].map(i => params.readOp(init, i).outputLevel);
        // Operator index 5 is OP1 in DX7's reversed storage order.
        assert.deepEqual(levels, [0, 0, 0, 0, 0, 99]);
    });
});

describe('buildBulkDumpRequest', () => {
    test('is the 5-byte format-9 request', () => {
        assert.deepEqual([...B.buildBulkDumpRequest({ channel: 0 })],
            [0xF0, 0x43, 0x20, 0x09, 0xF7]);
        assert.deepEqual([...B.buildBulkDumpRequest({ channel: 3 })],
            [0xF0, 0x43, 0x23, 0x09, 0xF7]);
    });
});
