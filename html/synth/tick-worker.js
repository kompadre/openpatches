// Tick Worker — precise heartbeat for pianoroll playback/recording.
// Uses absolute targeting (no drift accumulation) with spin for sub-ms precision.
//
// Messages IN:
//   { type: 'start', bpm, startCol? }
//   { type: 'stop' }
//
// Messages OUT:
//   { type: 'tick', col }

let running = false;

self.onmessage = function (e) {
    const msg = e.data;

    if (msg.type === 'start') {
        running = true;
        const bpm = msg.bpm || 120;
        const msPerSixteenth = 60000 / bpm / 4;
        const startCol = msg.startCol || 0;
        const t0 = performance.now();
        let col = startCol;

        function tick() {
            if (!running) return;

            const target = t0 + (col - startCol) * msPerSixteenth;
            const now = performance.now();
            const remaining = target - now;

            if (remaining > 4) {
                // Sleep via setTimeout, wake up 2ms early for spin
                setTimeout(function () {
                    // Spin for sub-ms precision
                    while (performance.now() < target) { /* spin */ }
                    emit(col);
                    col++;
                    tick();
                }, remaining - 2);
            } else if (remaining > 0) {
                // Too short to sleep — spin
                while (performance.now() < target) { /* spin */ }
                emit(col);
                col++;
                tick();
            } else {
                // Already past target (overslept) — emit immediately, no spin
                emit(col);
                col++;
                tick();
            }
        }

        // First tick fires immediately at startCol
        emit(col);
        col++;
        tick();
    }

    if (msg.type === 'stop') {
        running = false;
    }
};

function emit(col) {
    self.postMessage({ type: 'tick', col: col });
}
