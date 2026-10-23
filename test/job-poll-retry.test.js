// Regression: a transient network/server error must not kill a running job.
//
// checkStatus used to swallow its own fetch errors and call fail() directly, so
// jobManager's _maxFailures retry budget could never fire and a single dropped
// request permanently failed a long-running match.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let Job, jobManager, isTransientStatus;

before(async () => {
    installBrowserEnv();
    ({ Job, jobManager, isTransientStatus } = await import('../html/components/job.js'));
});

function makeOpts() {
    const logs = [];
    const opts = {
        baseUrl: 'http://test',
        appendLog: (m) => logs.push(m),
        showProgress: () => {},
        hideProgress: () => {},
        dbPut: async () => {},
        dbGet: async () => null,
        jobManager,
        logs,
    };
    jobManager.setOpts(opts);
    return opts;
}

function makeJob() {
    const job = new Job({
        id: 'job_test',
        type: 'wav_import',
        status: 'polling',
        fileName: 'test.wav',
        containerId: 'ctr_test',
        statusUrl: '/api/status/abc',
    });
    return job;
}

// Queue of responses/errors; each poll consumes one.
function stubFetch(steps) {
    let i = 0;
    globalThis.fetch = async () => {
        const step = steps[Math.min(i++, steps.length - 1)];
        if (step instanceof Error) throw step;
        return {
            ok: step.status >= 200 && step.status < 300,
            status: step.status,
            text: async () => JSON.stringify(step.body ?? {}),
        };
    };
    return () => i; // call count
}

beforeEach(() => {
    localStorage.clear();
    jobManager.stopAll();
});

describe('isTransientStatus', () => {
    test('retries gateway, timeout and rate-limit statuses', () => {
        for (const s of [408, 429, 500, 502, 503, 504]) {
            assert.equal(isTransientStatus(s), true, `${s} should be transient`);
        }
    });
    test('does not retry client errors', () => {
        for (const s of [400, 401, 403, 404, 410]) {
            assert.equal(isTransientStatus(s), false, `${s} should be fatal`);
        }
    });
});

describe('Job.checkStatus error propagation', () => {
    test('rethrows network errors instead of failing the job', async () => {
        const opts = makeOpts();
        const job = makeJob();
        stubFetch([new TypeError('Failed to fetch')]);

        await assert.rejects(() => job.checkStatus(opts), /Failed to fetch/);
        assert.equal(job.status, 'polling', 'job should stay alive after one blip');
    });

    test('rethrows 5xx instead of failing the job', async () => {
        const opts = makeOpts();
        const job = makeJob();
        stubFetch([{ status: 502 }]);

        await assert.rejects(() => job.checkStatus(opts), /502/);
        assert.equal(job.status, 'polling');
    });

    test('fails immediately on a 404 — the job is genuinely gone', async () => {
        const opts = makeOpts();
        const job = makeJob();
        stubFetch([{ status: 404 }]);

        await job.checkStatus(opts); // must not throw
        assert.equal(job.status, 'failed');
    });

    test('still completes normally on success', async () => {
        const opts = makeOpts();
        const job = makeJob();
        stubFetch([{ status: 200, body: { status: 'completed', matches: [] } }]);

        await job.checkStatus(opts);
        assert.equal(job.status, 'completed');
    });
});

describe('jobManager retry budget', () => {
    test('survives blips below the budget and recovers on success', async () => {
        const opts = makeOpts();
        const job = makeJob();
        // Two failures, then progress — under the 3-failure budget.
        stubFetch([
            new TypeError('Failed to fetch'),
            new TypeError('Failed to fetch'),
            { status: 200, body: { status: 'processing', progress_percent: 50 } },
        ]);

        // Drive polls directly rather than waiting on the 3s interval.
        jobManager.start(job, 1e9);
        const entry = jobManager._active.get(job.id);
        await entry.poll();
        await entry.poll();
        assert.equal(job.status, 'polling', 'two blips should not fail the job');

        await entry.poll();
        assert.equal(entry.failures, 0, 'failure count should reset on success');
        assert.equal(job.status, 'polling');
        jobManager.stop(job.id);
    });

    test('gives up after the budget is exhausted', async () => {
        const opts = makeOpts();
        const job = makeJob();
        stubFetch([new TypeError('Failed to fetch')]); // always fails

        jobManager.start(job, 1e9);
        const entry = jobManager._active.get(job.id);
        for (let i = 0; i < jobManager._maxFailures + 1; i++) await entry.poll();

        assert.equal(job.status, 'failed', 'job should fail once the budget is spent');
        assert.equal(jobManager._active.has(job.id), false, 'polling should be stopped');
        assert.ok(
            opts.logs.some(l => /Polling stopped/.test(l)),
            'should log why polling stopped',
        );
    });

    test('counts the immediate first check toward the budget', async () => {
        makeOpts();
        const job = makeJob();
        stubFetch([new TypeError('Failed to fetch')]);

        jobManager.start(job, 1e9);
        const entry = jobManager._active.get(job.id);
        // start() fires one poll synchronously; let its promise settle.
        await new Promise(r => setTimeout(r, 0));
        assert.equal(entry.failures, 1, 'the eager first poll should be counted, not swallowed');
        jobManager.stop(job.id);
    });
});
