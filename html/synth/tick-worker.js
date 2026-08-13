// Tick Worker — precise heartbeat for pianoroll playback/recording.
//
// Atomics path (preferred): zero-CPU sleeping via Atomics.wait on SharedArrayBuffer.
// Fallback path: setTimeout-based with spin for sub-ms precision.
//
// Messages IN:
//   { type: 'init', sab: SharedArrayBuffer }   — enable Atomics path
//   { type: 'start', bpm, startCol? }           — start ticking
//   { type: 'stop' }                             — stop (fallback path only)
//
// Messages OUT:
//   { type: 'tick', col }
//   { type: 'stopped' }

// SharedArrayBuffer layout: Int32Array[2]
//   [0] = control flag (0 = running, 1 = stop)
//   [1] = reserved

let i32 = null;       // Int32Array view of SharedArrayBuffer
let useAtomics = false;
let running = false;  // for setTimeout fallback

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
            startAtomics(bpm, startCol);
        } else {
            startTimeout(bpm, startCol);
        }
    }

    if (msg.type === 'stop') {
        // Only used by setTimeout fallback
        running = false;
    }
};

// --- Atomics path ---

function startAtomics(bpm, startCol) {
    Atomics.store(i32, 0, 0); // clear stop flag
    var msPerSixteenth = 60000 / bpm / 4;
    var t0 = performance.now();
    var col = startCol;

    // Emit first tick immediately
    self.postMessage({ type: 'tick', col: col });
    col++;

    while (true) {
        // Check stop flag
        if (Atomics.load(i32, 0) === 1) break;

        // Calculate absolute target time
        var target = t0 + (col - startCol) * msPerSixteenth;
        var now = performance.now();
        var remaining = target - now;

        // Sleep until ~1ms before target
        if (remaining > 2) {
            Atomics.wait(i32, 0, 0, remaining - 1);
        }

        // Check flag after wake (notify or timeout)
        if (Atomics.load(i32, 0) === 1) break;

        // Spin for sub-ms precision
        while (performance.now() < target) { /* spin */ }

        // Final flag check before emitting
        if (Atomics.load(i32, 0) === 1) break;

        self.postMessage({ type: 'tick', col: col });
        col++;
    }

    self.postMessage({ type: 'stopped' });
}

// --- setTimeout fallback ---

function startTimeout(bpm, startCol) {
    running = true;
    var msPerSixteenth = 60000 / bpm / 4;
    var t0 = performance.now();
    var col = startCol;

    // Emit first tick immediately
    self.postMessage({ type: 'tick', col: col });
    col++;

    function tick() {
        if (!running) {
            self.postMessage({ type: 'stopped' });
            return;
        }

        var target = t0 + (col - startCol) * msPerSixteenth;
        var now = performance.now();
        var remaining = target - now;

        if (remaining > 4) {
            setTimeout(function () {
                // Spin for sub-ms precision
                while (performance.now() < target) { }
                self.postMessage({ type: 'tick', col: col });
                col++;
                tick();
            }, remaining - 2);
        } else if (remaining > 0) {
            // Too short to sleep — spin
            while (performance.now() < target) { }
            self.postMessage({ type: 'tick', col: col });
            col++;
            tick();
        } else {
            // Overslept — emit immediately
            self.postMessage({ type: 'tick', col: col });
            col++;
            tick();
        }
    }

    tick();
}
