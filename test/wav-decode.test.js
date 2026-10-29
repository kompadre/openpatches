// decodeWavSamples walks the RIFF chunk list. It used to require `data` to
// follow `fmt ` immediately, so a WAV with a LIST/fact chunk in between (any
// file that went through ffmpeg or a DAW) decoded to null and the waveform
// stayed blank.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWavSamples, releaseWavUrl } from '../html/components/patch.js';

function chunk(id, body) {
    const padded = body.length % 2 ? Buffer.concat([body, Buffer.alloc(1)]) : body;
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, padded]);
}

function fmtChunk({ format = 1, channels = 1, bits = 16, rate = 44100 } = {}) {
    const b = Buffer.alloc(16);
    b.writeUInt16LE(format, 0);
    b.writeUInt16LE(channels, 2);
    b.writeUInt32LE(rate, 4);
    b.writeUInt32LE(rate * channels * bits / 8, 8);
    b.writeUInt16LE(channels * bits / 8, 12);
    b.writeUInt16LE(bits, 14);
    return chunk('fmt ', b);
}

function pcm16(samples) {
    const b = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => b.writeInt16LE(Math.round(s * 32767), i * 2));
    return chunk('data', b);
}

function wav(...chunks) {
    const body = Buffer.concat(chunks);
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(body.length + 4, 4);
    riff.write('WAVE', 8, 'ascii');
    const all = Buffer.concat([riff, body]);
    return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-3, `${a} ≈ ${b}`);

describe('decodeWavSamples', () => {
    test('plain fmt + data', () => {
        const s = decodeWavSamples(wav(fmtChunk(), pcm16([0, 0.5, -0.5])));
        assert.equal(s.length, 3);
        close(s[1], 0.5);
        close(s[2], -0.5);
    });

    test('a LIST chunk between fmt and data is skipped', () => {
        const list = chunk('LIST', Buffer.from('INFOISFT\x05\x00\x00\x00Lavf\x00', 'binary'));
        const s = decodeWavSamples(wav(fmtChunk(), list, pcm16([0.25, 0.75])));
        assert.ok(s, 'decoded');
        assert.equal(s.length, 2);
        close(s[1], 0.75);
    });

    test('an odd-sized chunk is padded to a word boundary', () => {
        const odd = chunk('junk', Buffer.from([1, 2, 3]));
        const s = decodeWavSamples(wav(fmtChunk(), odd, pcm16([0.1])));
        assert.ok(s && s.length === 1);
    });

    test('stereo is mixed to mono', () => {
        const s = decodeWavSamples(wav(fmtChunk({ channels: 2 }), pcm16([1, 0, -1, -1])));
        assert.equal(s.length, 2);
        close(s[0], 0.5);
        close(s[1], -1);
    });

    test('32-bit float is accepted', () => {
        const b = Buffer.alloc(8);
        b.writeFloatLE(0.125, 0);
        b.writeFloatLE(-0.5, 4);
        const s = decodeWavSamples(wav(fmtChunk({ format: 3, bits: 32 }), chunk('data', b)));
        assert.equal(s.length, 2);
        close(s[0], 0.125);
        close(s[1], -0.5);
    });

    test('data before fmt is rejected, not misread', () => {
        assert.equal(decodeWavSamples(wav(pcm16([0.1]), fmtChunk())), null);
    });

    test('a truncated data chunk decodes what is there', () => {
        const full = Buffer.from(wav(fmtChunk(), pcm16([0.1, 0.2, 0.3, 0.4])));
        const cut = full.subarray(0, full.length - 4);
        const s = decodeWavSamples(cut.buffer.slice(cut.byteOffset, cut.byteOffset + cut.byteLength));
        assert.equal(s.length, 2);
    });

    test('garbage is null', () => {
        assert.equal(decodeWavSamples(new ArrayBuffer(4)), null);
        assert.equal(decodeWavSamples(Buffer.from('RIFFxxxxWAVE').buffer), null);
    });
});

describe('releaseWavUrl', () => {
    test('revokes blob: URLs only', () => {
        const revoked = [];
        const orig = globalThis.URL.revokeObjectURL;
        globalThis.URL.revokeObjectURL = (u) => revoked.push(u);
        try {
            releaseWavUrl('blob:http://x/abc');
            releaseWavUrl('http://x/preview.wav');
            releaseWavUrl(null);
        } finally {
            globalThis.URL.revokeObjectURL = orig;
        }
        assert.deepEqual(revoked, ['blob:http://x/abc']);
    });
});
