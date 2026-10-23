// Regression: a `start` posted while the tick worker is already looping must
// not leave a ghost loop behind.
//
// The worker used to clear a stop flag at the top of every start. Pressing
// Record during playback queued a second `start`; after Stop the worker drained
// that stale message, cleared the flag and spun forever (Atomics path), or ran
// two concurrent tick chains (setTimeout fallback). Both paths are now driven by
// a generation counter that every start/stop bumps.
//
// The Atomics path is exercised in a real worker_threads Worker so Atomics.wait
// can block; the fallback path runs in-process with a fake `self`.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import vm from 'node:vm';

const WORKER_SRC = readFileSync(new URL('../html/synth/tick-worker.js', import.meta.url), 'utf8');
const FAST_BPM = 1500;  // 10 ms per sixteenth — quick, but still above the worker's 4 ms spin threshold

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Poll until `pred()` holds (worker boot time varies), failing after `timeout` ms.
async function waitFor(pred, what, timeout = 1000) {
    const t0 = Date.now();
    while (!pred()) {
        if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${what}`);
        await sleep(5);
    }
}
const count = (arr, type) => arr.filter(m => m.type === type).length;

// --- Atomics path: real worker thread, shared generation counter ---

function spawnWorker() {
    // Bridge the browser worker surface (`self.onmessage` / `self.postMessage`) onto parentPort.
    const bootstrap = `
        const { parentPort } = require('node:worker_threads');
        globalThis.self = { postMessage: (m) => parentPort.postMessage(m) };
        globalThis.performance = globalThis.performance || require('node:perf_hooks').performance;
        new Function(${JSON.stringify(WORKER_SRC)})();
        parentPort.on('message', (data) => self.onmessage({ data }));
    `;
    const w = new Worker(bootstrap, { eval: true });
    const received = [];
    w.on('message', (m) => received.push(m));
    return { w, received };
}

function makeControls(w) {
    const sab = new SharedArrayBuffer(8);
    const ctl = new Int32Array(sab);
    w.postMessage({ type: 'init', sab });
    return {
        // Mirrors startTickWorker / stopTickWorker in app.js
        start(startCol = 0) {
            const gen = Atomics.add(ctl, 0, 1) + 1;
            Atomics.notify(ctl, 0);
            w.postMessage({ type: 'start', bpm: FAST_BPM, startCol, gen });
            return gen;
        },
        stop() {
            Atomics.add(ctl, 0, 1);
            Atomics.notify(ctl, 0);
        },
    };
}

const workers = [];
after(() => Promise.all(workers.map(w => w.terminate())));

describe('tick worker — Atomics path', () => {
    test('start while looping replaces the loop; stop ends it; stale start is ignored', async () => {
        const { w, received } = spawnWorker();
        workers.push(w);
        const ctl = makeControls(w);

        // Play
        const gen1 = ctl.start(0);
        await waitFor(() => count(received, 'tick') >= 3, 'first loop ticks');

        // Record while playing: bump + new start, like the toolbar now does
        received.length = 0;
        ctl.start(0);
        await waitFor(() => count(received, 'tick') >= 4, 'second loop ticks');
        assert.equal(count(received, 'stopped'), 1, 'exactly one loop ended');
        const ticks = received.filter(m => m.type === 'tick');
        assert.equal(ticks[0].col, 0, 'second loop restarted from its own startCol');
        // Columns are strictly increasing → only one loop is emitting
        for (let i = 1; i < ticks.length; i++) assert.equal(ticks[i].col, ticks[i - 1].col + 1);

        // Stop
        received.length = 0;
        ctl.stop();
        await waitFor(() => count(received, 'stopped') >= 1, 'loop reported stopped');
        assert.equal(count(received, 'stopped'), 1);
        received.length = 0;
        await sleep(60);
        assert.equal(received.length, 0, 'no ticks after stop (no ghost loop)');

        // A start carrying an outdated generation must be a no-op
        w.postMessage({ type: 'start', bpm: FAST_BPM, startCol: 0, gen: gen1 });
        await sleep(60);
        assert.equal(received.length, 0, 'stale start ignored');
    });
});

// --- setTimeout fallback: in-process with a fake self ---

function loadFallbackWorker() {
    const posted = [];
    const self = { postMessage: (m) => posted.push(m) };
    const ctx = vm.createContext({ self, performance, setTimeout });
    vm.runInContext(WORKER_SRC, ctx);
    return { posted, send: (data) => self.onmessage({ data }) };
}

describe('tick worker — setTimeout fallback', () => {
    test('second start does not create a second tick chain', async () => {
        const { posted, send } = loadFallbackWorker();
        send({ type: 'start', bpm: FAST_BPM });
        await sleep(35);
        send({ type: 'start', bpm: FAST_BPM });
        await sleep(35);
        posted.length = 0;
        await sleep(80);
        const ticks = posted.filter(m => m.type === 'tick');
        assert.ok(ticks.length > 0);
        for (let i = 1; i < ticks.length; i++) {
            assert.equal(ticks[i].col, ticks[i - 1].col + 1, 'ticks come from a single chain');
        }
        send({ type: 'stop' });  // let the timer chain drain so the process can exit
    });

    test('stop ends the chain and a later start runs cleanly', async () => {
        const { posted, send } = loadFallbackWorker();
        send({ type: 'start', bpm: FAST_BPM });
        await sleep(35);
        send({ type: 'stop' });
        await sleep(35);
        posted.length = 0;
        await sleep(60);
        assert.equal(posted.filter(m => m.type === 'tick').length, 0, 'no ticks after stop');

        send({ type: 'start', bpm: FAST_BPM, startCol: 0 });
        await sleep(60);
        const ticks = posted.filter(m => m.type === 'tick');
        assert.ok(ticks.length > 0);
        assert.equal(ticks[0].col, 0);
        for (let i = 1; i < ticks.length; i++) assert.equal(ticks[i].col, ticks[i - 1].col + 1);
        send({ type: 'stop' });
    });
});
