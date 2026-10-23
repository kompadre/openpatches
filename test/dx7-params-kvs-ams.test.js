// Regression: operator byte 13 packs AMS in bits 0-1 and KVS in bits 2-4.
//
// readOp/writeOp used to have the two fields swapped and KVS masked to 2 bits,
// so the Params editor edited the wrong parameter and silently clamped key
// velocity sensitivity 4–7 down to 0–3 on every save.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readOp, writeOp, OP_BLOCK_SIZE } from '../html/components/dx7-params.js';

function opBytes(b13) {
    const bytes = new Uint8Array(128);
    bytes[13] = b13;
    return bytes;
}

describe('dx7-params operator byte 13 (KVS / AMS)', () => {
    test('reads KVS from bits 2-4 and AMS from bits 0-1', () => {
        const op = readOp(opBytes((7 << 2) | 2), 0);
        assert.equal(op.velSens, 7);
        assert.equal(op.amSens, 2);
    });

    test('writes KVS to bits 2-4 and AMS to bits 0-1', () => {
        const bytes = new Uint8Array(128);
        writeOp(bytes, 0, { ...readOp(bytes, 0), velSens: 5, amSens: 3 });
        assert.equal(bytes[13], (5 << 2) | 3);
    });

    test('round-trips every KVS/AMS combination unchanged', () => {
        for (let kvs = 0; kvs <= 7; kvs++) {
            for (let ams = 0; ams <= 3; ams++) {
                const b13 = (kvs << 2) | ams;
                for (let opIndex = 0; opIndex < 6; opIndex++) {
                    const bytes = new Uint8Array(128);
                    bytes[opIndex * OP_BLOCK_SIZE + 13] = b13;
                    const op = readOp(bytes, opIndex);
                    assert.equal(op.velSens, kvs);
                    assert.equal(op.amSens, ams);
                    const out = new Uint8Array(128);
                    writeOp(out, opIndex, op);
                    assert.equal(out[opIndex * OP_BLOCK_SIZE + 13], b13, `kvs=${kvs} ams=${ams} op=${opIndex}`);
                }
            }
        }
    });
});
