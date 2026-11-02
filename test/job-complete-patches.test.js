// Regression: Job.complete() lost every matched patch.
//
// It read the container once, then called addPatchToContainer() per patch —
// each call re-read and re-saved the container — and finally wrote its own
// stale copy back with patchIds still []. Assign/Export/Sort saw nothing,
// and because the job stayed 'completed', restore() re-ran complete() on
// every reload and wiped the list again.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let Job, canvasStore, patchStore;
let bindProjectSession, makeProjectSession;

before(async () => {
    installBrowserEnv();
    ({ Job } = await import('../html/components/job.js'));
    ({ canvasStore, patchStore } = await import('../html/components/patch-model.js'));
    // Patches and the canvas live in the open project now, so the store
    // needs one to read and write.
    ({ bindProjectSession } = await import('../html/components/patch-model.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
});

beforeEach(() => {
    localStorage.clear();
    bindProjectSession(makeProjectSession());
});

const voice = (n) => btoa(String.fromCharCode(n).repeat(128));

function makeCompletedJob(resultData) {
    canvasStore.putContainer({ id: 'ctr_1', name: 'kick', left: 0, top: 0, width: 260, patchIds: [], jobId: 'job_1' });
    return new Job({
        id: 'job_1', status: 'completed', fileName: 'kick.wav', containerId: 'ctr_1', resultData,
    });
}

describe('Job.complete()', () => {
    test('the container ends up holding every matched patch', () => {
        const job = makeCompletedJob({
            midi_note: 48,
            matches: [{ name: 'A', voice_data: voice(1) }, { name: 'B', voice_data: voice(2) }],
            timbral_matches: [{ name: 'C', voice_data: voice(3) }],
        });
        job.complete({ appendLog() {} });

        const ctr = canvasStore.getContainer('ctr_1');
        assert.equal(ctr.patchIds.length, 3);
        assert.deepEqual(ctr.groups.map(g => [g.label, g.patchIds.length]), [['NEAREST', 2], ['TIMBRAL', 1]]);
        for (const id of ctr.patchIds) {
            assert.ok(patchStore.get(id), `patch ${id} stored`);
            assert.equal(canvasStore.getCanvasPatch(id).containerId, 'ctr_1');
        }
        // every grouped id is also in the flat list
        for (const g of ctr.groups) for (const id of g.patchIds) assert.ok(ctr.patchIds.includes(id));
    });

    test('running complete() twice (restore on reload) is idempotent', () => {
        const job = makeCompletedJob({ matches: [{ name: 'A', voice_data: voice(1) }] });
        job.complete({ appendLog() {} });
        job.complete({ appendLog() {} });
        const ctr = canvasStore.getContainer('ctr_1');
        assert.equal(ctr.patchIds.length, 1, 'no duplicates');
        assert.equal(ctr.groups.length, 1);
    });

    test('the same voice in two match groups yields two patches, each with its own name', () => {
        const job = makeCompletedJob({
            matches: [{ name: 'X', voice_data: voice(9) }],
            full_matches: [{ name: 'X', voice_data: voice(9) }],
        });
        job.complete({ appendLog() {} });
        const ctr = canvasStore.getContainer('ctr_1');
        assert.equal(ctr.patchIds.length, 2);
        const names = ctr.patchIds.map(id => patchStore.get(id).name).sort();
        assert.deepEqual(names, ['FULL X', 'NEAREST X']);
    });

    test('a container that lost its patchIds field is repaired, not crashed on', () => {
        canvasStore.putContainer({ id: 'ctr_1', name: 'kick', left: 0, top: 0, width: 260, jobId: 'job_1' });
        const job = new Job({
            id: 'job_1', status: 'completed', fileName: 'kick.wav', containerId: 'ctr_1',
            resultData: { matches: [{ name: 'A', voice_data: voice(1) }] },
        });
        job.complete({ appendLog() {} });
        assert.equal(canvasStore.getContainer('ctr_1').patchIds.length, 1);
    });
});
