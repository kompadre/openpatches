// Patch ids are content hashes. They used to hash voice_data alone, so the
// same voice returned under two names (one match in several result groups,
// or a renamed copy) collapsed into one record and the last name written won.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPatch } from '../html/components/patch-model.js';

const vd = btoa('x'.repeat(128));

describe('createPatch ids', () => {
    test('same bytes, different names → different ids', () => {
        assert.notEqual(createPatch({ name: 'NEAREST A', voice_data: vd }).id,
                        createPatch({ name: 'FULL A', voice_data: vd }).id);
    });

    test('same bytes, same name → same id (re-importing a bank is idempotent)', () => {
        assert.equal(createPatch({ name: 'A', voice_data: vd }).id,
                     createPatch({ name: 'A', voice_data: vd }).id);
    });

    test('an explicit id is kept', () => {
        assert.equal(createPatch({ id: 'keep', name: 'A', voice_data: vd }).id, 'keep');
    });

    test('no voice_data falls back to the algorithm/feedback/name hash', () => {
        const a = createPatch({ name: 'A', algorithm: 1, feedback: 2 });
        const b = createPatch({ name: 'A', algorithm: 1, feedback: 2 });
        assert.equal(a.id, b.id);
        assert.notEqual(a.id, createPatch({ name: 'B', algorithm: 1, feedback: 2 }).id);
    });
});
