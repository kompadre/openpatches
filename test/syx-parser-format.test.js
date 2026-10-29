// parseSyxFile checks the format byte and the checksum now. The format
// check is fatal (a single-voice dump is not 32 voices); the checksum is
// advisory, because hex-edited banks with a stale checksum are common and
// their voices are fine.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSyxFile } from '../html/components/syx-parser.js';

let demo;
let warnings;
const origWarn = console.warn;

before(() => {
    const b = readFileSync(new URL('../html/DEMO.syx', import.meta.url));
    demo = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
});

function withWarnings(fn) {
    warnings = [];
    console.warn = (...a) => warnings.push(a.join(' '));
    try { return fn(); } finally { console.warn = origWarn; }
}

describe('parseSyxFile', () => {
    test('DEMO.syx parses with a good checksum', () => {
        const patches = withWarnings(() => parseSyxFile(demo));
        assert.equal(patches.length, 32);
        assert.equal(patches.checksumOk, true);
        assert.deepEqual(warnings, []);
    });

    test('a wrong format byte is rejected', () => {
        const buf = demo.slice(0);
        new Uint8Array(buf)[3] = 0x00; // single voice
        const r = withWarnings(() => parseSyxFile(buf));
        assert.equal(r, null);
        assert.match(warnings[0], /format byte 0x0/);
    });

    test('a bad checksum still parses but is flagged', () => {
        const buf = demo.slice(0);
        const u8 = new Uint8Array(buf);
        u8[6 + 4096] = (u8[6 + 4096] + 1) & 0x7F;
        const patches = withWarnings(() => parseSyxFile(buf));
        assert.equal(patches.length, 32);
        assert.equal(patches.checksumOk, false);
        assert.match(warnings[0], /checksum mismatch/);
    });

    test('a corrupted data byte is caught by the checksum', () => {
        const buf = demo.slice(0);
        new Uint8Array(buf)[6 + 200] ^= 0x01;
        const patches = withWarnings(() => parseSyxFile(buf));
        assert.equal(patches.checksumOk, false);
    });
});
