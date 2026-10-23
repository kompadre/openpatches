// Tick Worker — precise heartbeat for pianoroll playback/recording.
//
// Atomics path (preferred): zero-CPU sleeping via Atomics.wait on SharedArrayBuffer.
// Fallback path: setTimeout-based with spin for sub-ms precision.
//
// Messages IN:
//   { type: 'init', sab: SharedArrayBuffer }        — enable Atomics path
//   { type: 'start', bpm, startCol?, gen? }          — start ticking (gen: Atomics path only)
//   { type: 'stop' }                                  — stop (fallback path only)
//
// Messages OUT:
//   { type: 'tick', col }
//   { type: 'stopped' }
//
// Both paths are driven by a *generation counter*: every start or stop on the
// main thread bumps it, and a loop only runs while the counter still equals the
// generation it was started with. This makes a stale `start` (one that was
// queued while the worker was busy looping) a no-op, and means a `stop` issued
// at any moment reliably ends whatever loop is running — with no flag to reset.

// SharedArrayBuffer layout: Int32Array[2]
//   [0] = generation counter (main thread bumps on every start/stop)
//   [1] = reserved

let i32 = null;       // Int32Array view of SharedArrayBuffer
let useAtomics = false;
let gen = 0;          // generation for setTimeout fallback (worker-local)

self.onmessage = function (e) {
    var msg = e.data;

    if (msg.type === 'init') {
        i32 = new Int32Array(msg.sab);
        useAtomics = true;
        return;
    }

    if (msg.type === 'start') {
        var bpm = msg.bpm || 120;
        var startCol = msg.startCol || 0;
        if (useAtomics) {
            startAtomics(bpm, startCol, msg.gen);
        } else {
            startTimeout(bpm, startCol);
        }
    }

    if (msg.type === 'stop') {
        // Only used by setTimeout fallback (Atomics path stops via the counter)
        gen++;
    }
};

// --- Atomics path ---

function startAtomics(bpm, startCol, myGen) {
    var current = Atomics.load(i32, 0);
    if (myGen == null) myGen = current;
    // Stale start: a newer start/stop was issued while we were still looping.
    if (myGen !== current) return;

    var msPerSixteenth = 60000 / bpm / 4;
    var t0 = performance.now();
    var col = startCol;

    // Emit first tick immediately
    self.postMessage({ type: 'tick', col: col });
    col++;

    while (true) {
        // Any bump of the generation counter means "this loop is over"
        if (Atomics.load(i32, 0) !== myGen) break;

        // Calculate absolute target time
        var target = t0 + (col - startCol) * msPerSixteenth;
        var now = performance.now();
        var remaining = target - now;

        // Sleep until ~1ms before target. Returns at once if the counter already moved.
        if (remaining > 2) {
            Atomics.wait(i32, 0, myGen, remaining - 1);
        }

        // Check after wake (notify or timeout)
        if (Atomics.load(i32, 0) !== myGen) break;

        // Spin for sub-ms precision
        while (performance.now() < target) { /* spin */ }

        // Final check before emitting
        if (Atomics.load(i32, 0) !== myGen) break;

        self.postMessage({ type: 'tick', col: col });
        col++;
    }

    self.postMessage({ type: 'stopped' });
}

// --- setTimeout fallback ---

function startTimeout(bpm, startCol) {
    var myGen = ++gen;  // invalidates any chain still running
    var msPerSixteenth = 60000 / bpm / 4;
    var t0 = performance.now();
    var col = startCol;

    // Emit first tick immediately
    self.postMessage({ type: 'tick', col: col });
    col++;

    // Post one tick and schedule the next — or finish if a newer start/stop arrived.
    function step() {
        if (gen !== myGen) {
            self.postMessage({ type: 'stopped' });
            return;
        }
        self.postMessage({ type: 'tick', col: col });
        col++;
        tick();
    }

    function tick() {
        if (gen !== myGen) {
            self.postMessage({ type: 'stopped' });
            return;
        }

        var target = t0 + (col - startCol) * msPerSixteenth;
        var now = performance.now();
        var remaining = target - now;

        if (remaining > 4) {
            setTimeout(function () {
                if (gen !== myGen) { self.postMessage({ type: 'stopped' }); return; }
                // Spin for sub-ms precision
                while (performance.now() < target) { }
                step();
            }, remaining - 2);
        } else if (remaining > 0) {
            // Too short to sleep — spin
            while (performance.now() < target) { }
            step();
        } else {
            // Overslept — emit immediately
            step();
        }
    }

    tick();
}
