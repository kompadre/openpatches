// DX7 Batch Waveform Rendering — main thread WASM for spectrogram thumbnails.
// Realtime synth is in audio-manager.js.
// Uses static pre-allocated buffers in WASM — no malloc/free from JS.

let wasmExports = null;
let wasmHeapI16 = null;
let wasmPatchView = null; // Uint8Array view into static patch buffer

function base64ToUint8Array(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
}

async function ensureWasmExports() {
    if (wasmExports) return true;
    try {
        const base = new URL('./wasm/', import.meta.url).pathname;
        const resp = await fetch(base + 'msfa.wasm');
        const binary = await resp.arrayBuffer();
        const wasiStub = {
            fd_close: () => 0, fd_fdstat_get: () => 0, fd_seek: () => 0,
            fd_write: () => 0, poll_oneoff: () => 0, proc_exit: () => {},
            clock_time_get: () => 0,
        };
        const envStub = {
            emscripten_notify_memory_growth: () => {},
        };
        const { instance } = await WebAssembly.instantiate(binary, {
            wasi_snapshot_preview1: wasiStub,
            env: envStub,
        });
        wasmExports = instance.exports;
        wasmHeapI16 = new Int16Array(wasmExports.memory.buffer);

        // Get static patch buffer address and create view
        const patchPtr = wasmExports.get_patch_buffer();
        wasmPatchView = new Uint8Array(wasmExports.memory.buffer, patchPtr, 128);

        return true;
    } catch (err) {
        console.warn('WASM batch init failed:', err);
        return false;
    }
}

function refreshHeapViews() {
    if (wasmHeapI16.buffer !== wasmExports.memory.buffer) {
        wasmHeapI16 = new Int16Array(wasmExports.memory.buffer);
        // Recreate patch view at same offset
        const patchPtr = wasmExports.get_patch_buffer();
        wasmPatchView = new Uint8Array(wasmExports.memory.buffer, patchPtr, 128);
    }
}

function samplesToWavBlob(samples, sr) {
    const numSamples = samples.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    function writeStr(offset, str) {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

export async function batchRenderWaveforms(patches, onResult, midiNote = 60) {
    if (!(await ensureWasmExports())) return;

    const sr = 44100;
    const nSamples = Math.ceil(sr * 0.8); // 800ms render
    wasmExports.init_engine(sr);

    for (const { voiceData, canvas } of patches) {
        try {
            const patch = typeof voiceData === 'string' ? base64ToUint8Array(voiceData) : voiceData;
            if (patch.length < 128) continue;

            // Copy directly into static patch buffer — no malloc/free
            refreshHeapViews();
            wasmPatchView.set(patch.subarray(0, 128));
            wasmExports.load_voice_from_buffer();

            wasmExports.note_on(midiNote, 100);
            const samplesPtr = wasmExports.render_audio(nSamples);

            refreshHeapViews();
            const i16base = samplesPtr >> 1;
            const samples = new Float32Array(nSamples);
            for (let i = 0; i < nSamples; i++) {
                samples[i] = wasmHeapI16[i16base + i] * (1.0 / 32768.0);
            }

            const blob = samplesToWavBlob(samples, sr);
            onResult(canvas, blob);
        } catch (_) {}
    }
}
