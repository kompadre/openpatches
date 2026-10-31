// voiceKey — the name-independent identity of a voice. One key means one
// VoiceBank slot; it must see through the three encodings voice data travels
// in (base64 string, Uint8Array, plain array) and through the name bytes
// embedded in the patch itself.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { voiceKey } from '../html/components/patch-model.js';

function packedVoice(name) {
    const bytes = new Array(128).fill(7);
    for (let i = 0; i < 10; i++) bytes[118 + i] = (name.charCodeAt(i) || 32);
    return bytes;
}

function toBase64(bytes) {
    return Buffer.from(bytes).toString('base64');
}

describe('voiceKey', () => {
    test('the same bytes hash equal across all three encodings', () => {
        const bytes = packedVoice('BRASS   1 ');
        const asArray = voiceKey(bytes);
        const asTyped = voiceKey(Uint8Array.from(bytes));
        const asB64 = voiceKey(toBase64(bytes));
        assert.equal(asArray, asTyped);
        assert.equal(asArray, asB64);
    });

    test('a renamed copy of a 128-byte packed voice keys the same', () => {
        assert.equal(voiceKey(packedVoice('BRASS   1 ')), voiceKey(packedVoice('MY BRASS  ')));
    });

    test('different parameters key differently', () => {
        const a = packedVoice('BRASS   1 ');
        const b = packedVoice('BRASS   1 ');
        b[0] = 99;
        assert.notEqual(voiceKey(a), voiceKey(b));
    });

    test('155-byte unpacked VCED ignores its name bytes too', () => {
        const a = new Array(155).fill(3);
        const b = a.slice();
        for (let i = 145; i < 155; i++) b[i] = 65;
        assert.equal(voiceKey(a), voiceKey(b));
    });

    test('garbage returns null rather than a key', () => {
        assert.equal(voiceKey(null), null);
        assert.equal(voiceKey(undefined), null);
        assert.equal(voiceKey(''), null);
        assert.equal(voiceKey({}), null);
    });
});
