// Tick Worker — precise heartbeat for pianoroll playback/recording.
//
// Atomics path (preferred): zero-CPU sleeping via Atomics.wait on SharedArrayBuffer.
// Fallback path: setTimeout-based with spin for sub-ms precision.
//
// Messages IN:
//   { type: 'init', sab: SharedArrayBuffer }        — enable Atomics path
//   { type: 'start', bpm, startCol?, gen? }          — start ticking (gen: Atomics path only)
//   { type: 'tempo', bpm }                            — retempo a running loop (fallback path only)
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
//
// Tempo can change *while a loop runs* — the song's BPM is editable during
// playback. On the Atomics path that cannot be a message: the loop never
// returns to the event loop (it blocks in Atomics.wait), so a postMessage
// would not be read until the transport stopped. It goes through the shared
// buffer instead, which the loop can read on every pass. The fallback path
// does yield, so there a message is enough.
//
// Either way the change *re-anchors* rather than restarts: the grid is
// recomputed from the last tick already emitted, so ticks that have gone out
// keep their timing and only the ones still to come follow the new rate. A
// restart would drop the column count and re-emit the downbeat.

// SharedArrayBuffer layout: Int32Array[2]
//   [0] = generation counter (main thread bumps on every start/stop)
//   [1] = current tempo, in millis of a BPM (120 BPM → 120000), so the
//         slider's whole-number BPM survives the trip as an exact integer

/** Fixed-point scale for the tempo slot: BPM × this is what is stored. */
var BPM_SCALE = 1000;

let i32 = null;       // Int32Array view of SharedArrayBuffer
let useAtomics = false;
let gen = 0;          // generation for setTimeout fallback (worker-local)
let wantBpm = 120;    // latest tempo asked for, fallback path only

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
        wantBpm = bpm;
        if (useAtomics) {
            startAtomics(bpm, startCol, msg.gen);
        } else {
            startTimeout(bpm, startCol);
        }
    }

    if (msg.type === 'tempo') {
        // Atomics path writes the shared slot on the main thread and never
        // gets here; see the header.
        if (msg.bpm > 0) wantBpm = msg.bpm;
    }

    if (msg.type === 'stop') {
        // Only used by setTimeout fallback (Atomics path stops via the counter)
        gen++;
    }
};

var msPerSixteenth = function (bpm) { return 60000 / bpm / 4; };

// --- Atomics path ---

function startAtomics(bpm, startCol, myGen) {
    var current = Atomics.load(i32, 0);
    if (myGen == null) myGen = current;
    // Stale start: a newer start/stop was issued while we were still looping.
    if (myGen !== current) return;

    var tempo = Math.round(bpm * BPM_SCALE);
    Atomics.store(i32, 1, tempo);
    var ms = msPerSixteenth(bpm);

    // The grid: `anchorAt` is when `anchorCol` was emitted, and every target
    // after it is a whole number of steps from there. Multiplying from a
    // fixed anchor rather than adding per tick is what keeps it drift-free.
    var t0 = performance.now();
    var anchorCol = startCol;
    var col = startCol;
    var lastAt = t0;        // scheduled time of the most recent tick

    // Emit first tick immediately
    self.postMessage({ type: 'tick', col: col });
    col++;

    // Re-anchor on the tick we last emitted, so what has gone out keeps its
    // timing and the pending one is a fresh step away at the new rate.
    function retempo() {
        var t = Atomics.load(i32, 1);
        if (t <= 0 || t === tempo) return false;
        tempo = t;
        ms = msPerSixteenth(t / BPM_SCALE);
        t0 = lastAt;
        anchorCol = col - 1;
        return true;
    }

    while (true) {
        // Any bump of the generation counter means "this loop is over"
        if (Atomics.load(i32, 0) !== myGen) break;

        retempo();

        // Calculate absolute target time
        var target = t0 + (col - anchorCol) * ms;
        var now = performance.now();
        var remaining = target - now;

        // Sleep until ~1ms before target. Returns at once if the counter already moved.
        if (remaining > 2) {
            Atomics.wait(i32, 0, myGen, remaining - 1);

            // Check after wake (notify or timeout)
            if (Atomics.load(i32, 0) !== myGen) break;

            // The tempo may have moved while we slept, which moves the
            // target — recompute before committing to the spin below, or a
            // tempo drop would be spun through at the old, shorter interval.
            if (retempo()) target = t0 + (col - anchorCol) * ms;
        }

        if (Atomics.load(i32, 0) !== myGen) break;

        // Spin for sub-ms precision
        while (performance.now() < target) { /* spin */ }

        // Final check before emitting
        if (Atomics.load(i32, 0) !== myGen) break;

        self.postMessage({ type: 'tick', col: col });
        lastAt = target;
        col++;
    }

    self.postMessage({ type: 'stopped' });
}

// --- setTimeout fallback ---

function startTimeout(bpm, startCol) {
    var myGen = ++gen;  // invalidates any chain still running
    var tempo = bpm;
    var ms = msPerSixteenth(bpm);
    var t0 = performance.now();
    var anchorCol = startCol;
    var col = startCol;
    var lastAt = t0;        // scheduled time of the most recent tick

    // Emit first tick immediately
    self.postMessage({ type: 'tick', col: col });
    col++;

    /** As on the Atomics path: re-anchor on the last tick emitted. */
    function retempo() {
        if (wantBpm === tempo) return false;
        tempo = wantBpm;
        ms = msPerSixteenth(tempo);
        t0 = lastAt;
        anchorCol = col - 1;
        return true;
    }

    // Post one tick and schedule the next — or finish if a newer start/stop arrived.
    function step(at) {
        if (gen !== myGen) {
            self.postMessage({ type: 'stopped' });
            return;
        }
        self.postMessage({ type: 'tick', col: col });
        lastAt = at;
        col++;
        tick();
    }

    function tick() {
        if (gen !== myGen) {
            self.postMessage({ type: 'stopped' });
            return;
        }

        retempo();
        var target = t0 + (col - anchorCol) * ms;
        var now = performance.now();
        var remaining = target - now;

        if (remaining > 4) {
            setTimeout(function () {
                if (gen !== myGen) { self.postMessage({ type: 'stopped' }); return; }
                // A 'tempo' message may have landed while the timer ran; it
                // moves the target, so recompute before spinning onto it.
                if (retempo()) {
                    var moved = t0 + (col - anchorCol) * ms;
                    // A slower tempo pushes the target out past this timer —
                    // go round again rather than spin out the difference.
                    if (moved - performance.now() > 4) { tick(); return; }
                    target = moved;
                }
                // Spin for sub-ms precision
                while (performance.now() < target) { }
                step(target);
            }, remaining - 2);
        } else if (remaining > 0) {
            // Too short to sleep — spin
            while (performance.now() < target) { }
            step(target);
        } else {
            // Overslept — emit immediately
            step(target);
        }
    }

    tick();
}
