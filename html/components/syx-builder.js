// DX7 SysEx encoder — the write side of syx-parser.js.
//
// Two message formats matter here:
//
//   Bulk dump (32 voices, "format 9")
//     F0 43 0n 09 20 00 <4096 packed bytes> <checksum> F7      = 4104 bytes
//
//   Single voice to the edit buffer ("format 0", VCED)
//     F0 43 0n 00 01 1B <155 unpacked bytes> <checksum> F7     =  163 bytes
//
// `n` is the device's basic channel (0-15). The bulk payload is exactly the
// 128-byte packed voice this app already stores in `patch.voice_data`, so a
// bank is a straight concatenation. The edit-buffer message is not: it wants
// the *unpacked* 155-byte form, which is what unpackVoice() produces.
//
// Bit layouts are taken from dx7-params.js readOp/readGlobal rather than
// restated here, so there is one authority for them.

import { readOp, readGlobal, writeOp, writeGlobal, decodeVoiceData } from './dx7-params.js';

export const PACKED_VOICE_SIZE = 128;
export const UNPACKED_VOICE_SIZE = 155;
export const VOICE_COUNT = 32;
export const BULK_PAYLOAD_SIZE = PACKED_VOICE_SIZE * VOICE_COUNT; // 4096
export const BULK_DUMP_SIZE = BULK_PAYLOAD_SIZE + 8;              // 4104
export const VOICE_DUMP_SIZE = UNPACKED_VOICE_SIZE + 8;           // 163

const YAMAHA_ID = 0x43;

/** Yamaha SysEx checksum: two's complement of the 7-bit sum of the payload. */
export function sysexChecksum(bytes) {
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) sum += bytes[i];
    return (128 - (sum & 0x7F)) & 0x7F;
}

/** Coerce base64 / array / Uint8Array voice data to 128 packed bytes. */
export function toPacked128(voiceData) {
    if (!voiceData) return null;
    let bytes;
    if (typeof voiceData === 'string') bytes = decodeVoiceData(voiceData);
    else if (voiceData instanceof Uint8Array) bytes = voiceData;
    else if (Array.isArray(voiceData)) bytes = Uint8Array.from(voiceData);
    else return null;
    if (bytes.length < PACKED_VOICE_SIZE) return null;
    return bytes.length === PACKED_VOICE_SIZE ? bytes : bytes.slice(0, PACKED_VOICE_SIZE);
}

// --- INIT VOICE ---------------------------------------------------------

// Built rather than pasted as a blob so the values stay readable. Operator
// index 0 is OP6 and index 5 is OP1 (DX7 stores them in reverse), so OP1 is
// the one carrying output level 99 — the others are silent.
export function makeInitVoice() {
    const bytes = new Uint8Array(PACKED_VOICE_SIZE);
    for (let i = 0; i < 6; i++) {
        writeOp(bytes, i, {
            r1: 99, r2: 99, r3: 99, r4: 99,
            l1: 99, l2: 99, l3: 99, l4: 0,
            breakPoint: 39, lDepth: 0, rDepth: 0,
            lCurve: 0, rCurve: 0,
            rateScaling: 0, detune: 7,
            amSens: 0, velSens: 0,
            outputLevel: i === 5 ? 99 : 0,
            oscMode: 0, freqCoarse: 1, freqFine: 0,
        });
    }
    writeGlobal(bytes, {
        pitchR1: 99, pitchR2: 99, pitchR3: 99, pitchR4: 99,
        pitchL1: 50, pitchL2: 50, pitchL3: 50, pitchL4: 50,
        algorithm: 0, feedback: 0, keySync: 1,
        lfoSpeed: 35, lfoDelay: 0, lfoPmDepth: 0, lfoAmd: 0,
        lfoSync: 1, lfoWaveform: 0, lfoPmSens: 3,
        transpose: 24,
        name: 'INIT VOICE',
    });
    return bytes;
}

// --- Packed 128 → unpacked 155 -----------------------------------------

/**
 * Expand a packed voice into the 155-byte edit-buffer layout: each operator
 * grows from 17 to 21 bytes (the bit-packed curve/detune/sensitivity fields
 * get a byte each), and the 26 global bytes grow to 29.
 */
export function unpackVoice(packed) {
    const src = toPacked128(packed);
    if (!src) return null;
    const out = new Uint8Array(UNPACKED_VOICE_SIZE);

    for (let i = 0; i < 6; i++) {
        const op = readOp(src, i);
        const b = i * 21;
        out[b + 0] = op.r1; out[b + 1] = op.r2; out[b + 2] = op.r3; out[b + 3] = op.r4;
        out[b + 4] = op.l1; out[b + 5] = op.l2; out[b + 6] = op.l3; out[b + 7] = op.l4;
        out[b + 8] = op.breakPoint;
        out[b + 9] = op.lDepth;
        out[b + 10] = op.rDepth;
        out[b + 11] = op.lCurve;
        out[b + 12] = op.rCurve;
        out[b + 13] = op.rateScaling;
        out[b + 14] = op.amSens;
        out[b + 15] = op.velSens;
        out[b + 16] = op.outputLevel;
        out[b + 17] = op.oscMode;
        out[b + 18] = op.freqCoarse;
        out[b + 19] = op.freqFine;
        out[b + 20] = op.detune;
    }

    const g = readGlobal(src);
    out[126] = g.pitchR1; out[127] = g.pitchR2; out[128] = g.pitchR3; out[129] = g.pitchR4;
    out[130] = g.pitchL1; out[131] = g.pitchL2; out[132] = g.pitchL3; out[133] = g.pitchL4;
    out[134] = g.algorithm;
    out[135] = g.feedback;
    out[136] = g.keySync;
    out[137] = g.lfoSpeed;
    out[138] = g.lfoDelay;
    out[139] = g.lfoPmDepth;
    out[140] = g.lfoAmd;
    out[141] = g.lfoSync;
    out[142] = g.lfoWaveform;
    // readGlobal reads 4 bits here for display tolerance; the VCED field is 3.
    out[143] = g.lfoPmSens & 0x07;
    out[144] = g.transpose;
    const name = (g.name || '').padEnd(10, ' ').slice(0, 10);
    for (let i = 0; i < 10; i++) out[145 + i] = name.charCodeAt(i) & 0x7F;

    return out;
}

// --- Message builders ---------------------------------------------------

/**
 * Build a 4104-byte 32-voice bulk dump.
 * Fewer than 32 patches are padded with INIT VOICE; extras are dropped.
 *
 * @param {Array<{voice_data?: string}>|Array<Uint8Array>} patches
 * @param {{channel?: number}} opts  device basic channel, 0-15
 */
export function buildBulkDump(patches, { channel = 0 } = {}) {
    const payload = new Uint8Array(BULK_PAYLOAD_SIZE);
    const init = makeInitVoice();

    for (let slot = 0; slot < VOICE_COUNT; slot++) {
        const entry = patches ? patches[slot] : null;
        const raw = entry ? toPacked128(entry.voice_data !== undefined ? entry.voice_data : entry) : null;
        payload.set(raw || init, slot * PACKED_VOICE_SIZE);
    }

    const msg = new Uint8Array(BULK_DUMP_SIZE);
    msg[0] = 0xF0;
    msg[1] = YAMAHA_ID;
    msg[2] = 0x00 | (channel & 0x0F);  // sub-status 0 (voice data) + channel
    msg[3] = 0x09;                     // format 9: 32 voices
    msg[4] = 0x20;                     // byte count MSB (4096 >> 7)
    msg[5] = 0x00;                     // byte count LSB
    msg.set(payload, 6);
    msg[6 + BULK_PAYLOAD_SIZE] = sysexChecksum(payload);
    msg[BULK_DUMP_SIZE - 1] = 0xF7;
    return msg;
}

/** Build a 163-byte single-voice dump targeting the device's edit buffer. */
export function buildVoiceDump(voiceData, { channel = 0 } = {}) {
    const body = unpackVoice(voiceData);
    if (!body) return null;

    const msg = new Uint8Array(VOICE_DUMP_SIZE);
    msg[0] = 0xF0;
    msg[1] = YAMAHA_ID;
    msg[2] = 0x00 | (channel & 0x0F);
    msg[3] = 0x00;   // format 0: 1 voice
    msg[4] = 0x01;   // byte count MSB (155 >> 7)
    msg[5] = 0x1B;   // byte count LSB (155 & 0x7F)
    msg.set(body, 6);
    msg[6 + UNPACKED_VOICE_SIZE] = sysexChecksum(body);
    msg[VOICE_DUMP_SIZE - 1] = 0xF7;
    return msg;
}

/** Build a bulk dump *request*. Ignored by the original DX7 Mk I. */
export function buildBulkDumpRequest({ channel = 0 } = {}) {
    return Uint8Array.from([0xF0, YAMAHA_ID, 0x20 | (channel & 0x0F), 0x09, 0xF7]);
}

// --- Validation ---------------------------------------------------------

/**
 * Check that `bytes` is a well-formed 32-voice bulk dump.
 * @returns {{ok: true, payload: Uint8Array} | {ok: false, error: string}}
 */
export function validateBulkDump(bytes) {
    if (!bytes || bytes.length !== BULK_DUMP_SIZE) {
        return { ok: false, error: `Expected ${BULK_DUMP_SIZE} bytes, got ${bytes ? bytes.length : 0}` };
    }
    if (bytes[0] !== 0xF0 || bytes[BULK_DUMP_SIZE - 1] !== 0xF7) {
        return { ok: false, error: 'Not a SysEx message (missing F0/F7 framing)' };
    }
    if (bytes[1] !== YAMAHA_ID) return { ok: false, error: 'Not a Yamaha SysEx message' };
    if (bytes[3] !== 0x09) return { ok: false, error: `Not a 32-voice bulk dump (format ${bytes[3]})` };

    const payload = bytes.subarray(6, 6 + BULK_PAYLOAD_SIZE);
    const expected = sysexChecksum(payload);
    const actual = bytes[6 + BULK_PAYLOAD_SIZE];
    if (expected !== actual) {
        return { ok: false, error: `Checksum mismatch (expected ${expected}, got ${actual}) — the transfer was corrupted` };
    }
    return { ok: true, payload };
}

/** True if `bytes` looks like a complete 32-voice bulk dump. */
export function isBulkDump(bytes) {
    return !!bytes && bytes.length === BULK_DUMP_SIZE
        && bytes[0] === 0xF0 && bytes[1] === YAMAHA_ID && bytes[3] === 0x09;
}
