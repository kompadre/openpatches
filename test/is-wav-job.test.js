// Only a container born of WAV inference has a source WAV to show or to ask
// for again. A .syx load and the demo bank also leave a job record, so their
// containers carry a jobId — and used to offer "⤒ WAV" for audio that never
// existed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isWavJob } from '../html/components/patch-model.js';

describe('isWavJob', () => {
    test('a WAV inference job is one', () => {
        assert.equal(isWavJob({ id: 'j', type: 'wav_import' }), true);
    });

    test('a record predating the type field is one (the Job class defaults it)', () => {
        assert.equal(isWavJob({ id: 'j', status: 'completed' }), true);
    });

    test('.syx and demo loads are not', () => {
        assert.equal(isWavJob({ id: 'j', type: 'syx_import' }), false);
        assert.equal(isWavJob({ id: 'j', type: 'demo_import' }), false);
    });

    test('an unknown type is not — allow-list, not deny-list', () => {
        assert.equal(isWavJob({ id: 'j', type: 'midi_backup' }), false);
    });

    test('no job is not', () => {
        assert.equal(isWavJob(null), false);
        assert.equal(isWavJob(undefined), false);
    });
});
