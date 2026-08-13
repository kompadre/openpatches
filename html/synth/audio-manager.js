// Audio Manager — singleton audio engine.
// AudioContext + AudioWorklet initialized once, live for page lifetime.
// No repeated addModule(), no blob URLs, no re-initialization.

const VOICE_BANK_SLOTS = 8;   // Voice bank uses channels 0-7
const MIDI_CHANNELS = 16;     // DX7 has 16 MIDI channels (0-15)
const PREVIEW_SLOT = 15;      // Dedicated WASM patch slot for preview
const PREVIEW_CHANNEL = 15;   // Dedicated MIDI channel for preview

let ctx = null;
let dx7Node = null;
let initialized = false;
let initPromise = null;

// Cached WASM binary (fetched once, shared by main + offline contexts)
let cachedWasmBytes = null;

// Active note tracking: "channel:midi" → stopFn
const activeNotes = new Map();

let onStatusChange = null;

function setState(state) {
    if (onStatusChange) onStatusChange(state);
}

export function setOnStatusChange(fn) {
    onStatusChange = fn;
    fn(getState());
}

export function isReady() {
    return initialized && ctx && ctx.state === 'running';
}

export function getState() {
    if (!ctx) return 'closed';
    if (ctx.state === 'suspended') return 'suspended';
    if (initialized) return 'ready';
    if (initPromise) return 'loading';
    return 'closed';
}

// --- Singleton initialization ---

async function initAudio() {
    if (initialized) return ctx;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        setState('loading');

        // Load processor module ONCE — static file path, browser caches it
        const base = new URL('./wasm/', import.meta.url).pathname;
        await ctx.audioWorklet.addModule(new URL('./dx7-processor.js', import.meta.url));

        // Fetch raw WASM binary on main thread (AudioWorklet has no fetch)
        const wasmResp = await fetch(base + 'msfa.wasm');
        cachedWasmBytes = await wasmResp.arrayBuffer();

        // Create ONE persistent worklet node, pass WASM via processorOptions
        dx7Node = new AudioWorkletNode(ctx, 'dx7-synth', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: { wasmBytes: cachedWasmBytes },
        });
        dx7Node.connect(ctx.destination);

        // Wait for WASM ready (or error)
        await new Promise((resolve, reject) => {
            dx7Node.port.onmessage = (e) => {
                if (e.data.type === 'ready') resolve();
                if (e.data.type === 'error') reject(new Error(e.data.error));
            };
            setTimeout(resolve, 2000);
        });

        initialized = true;
        setState('ready');
        return ctx;
    })();

    return initPromise;
}

export async function acquire() {
    if (initialized && ctx && ctx.state === 'running') {
        return ctx;
    }
    if (ctx && ctx.state === 'suspended') {
        await ctx.resume();
        return ctx;
    }
    return initAudio();
}

// --- Voice loading ---

export function base64ToUint8Array(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
}

function normalizeVoiceData(voiceData) {
    if (typeof voiceData === 'string') return base64ToUint8Array(voiceData);
    if (voiceData instanceof Uint8Array) return voiceData;
    if (Array.isArray(voiceData)) return new Uint8Array(voiceData);
    return null;
}

/**
 * Send full VoiceBank snapshot to the synth.
 * Each entry loads into its slot (array index) and maps channel = slot.
 * Idempotent — overwrites whatever was loaded before.
 */
export function sendVoiceSnapshot(entries) {
    if (!isReady() || !dx7Node) return;
    const voices = [];
    for (let i = 0; i < Math.min(entries.length, VOICE_BANK_SLOTS); i++) {
        const entry = entries[i];
        if (!entry || !entry.voiceData) continue;
        const patch = normalizeVoiceData(entry.voiceData);
        if (!patch) continue;
        voices.push({ slot: i, data: patch.buffer });
    }
    if (voices.length > 0) {
        dx7Node.port.postMessage({ type: 'voice-snapshot', voices });
    }
}

/**
 * Load a patch into the preview slot (slot 15, channel 15).
 * Must be called before playNoteOnChannel(15, ...) for correct timbre.
 */
export function loadPreviewPatch(voiceData) {
    if (!isReady() || !dx7Node) return;
    const patch = normalizeVoiceData(voiceData);
    if (!patch) return;
    dx7Node.port.postMessage({
        type: 'voice-snapshot',
        voices: [{ slot: PREVIEW_SLOT, channel: PREVIEW_CHANNEL, data: patch.buffer }],
    });
}

/**
 * Send rendered samples to the live AudioWorklet for playback.
 * Samples are mixed with synth output (pianoroll notes keep playing).
 * Calling again overwrites any active preview (new preview replaces old).
 */
export function playSamplesInWorklet(samples) {
    if (!dx7Node) return;
    dx7Node.port.postMessage({ type: 'play-samples', samples });
}

/**
 * Set channel volume (0-127 MIDI range).
 */
export function setChannelVolume(channel, volume) {
    if (!dx7Node) return;
    dx7Node.port.postMessage({ type: 'channel-volume', channel, volume });
}

// --- Channel-based playback ---

/**
 * Play a note on a specific MIDI channel (no patch load).
 * Tracks active notes per channel:midi — re-triggering same pair sends note-off first.
 * @returns {function|null} stop function
 */
export function playNoteOnChannel(channel, midi, velocity = 100) {
    if (!isReady() || !dx7Node) return null;
    if (channel < 0 || channel >= MIDI_CHANNELS) return null;

    const key = channel + ':' + midi;
    const existing = activeNotes.get(key);
    if (existing) {
        existing();
        activeNotes.delete(key);
    }

    // Increment generation to guard against stale stop functions
    const generation = (activeNotes._gen || 0) + 1;
    activeNotes._gen = generation;

    dx7Node.port.postMessage({ type: 'midi', data: [0x90 | channel, midi, velocity] });
    const stop = () => {
        // Only send note-off if this is still the active note
        if (activeNotes.get(key) === stop) {
            if (dx7Node) dx7Node.port.postMessage({ type: 'midi', data: [0x80 | channel, midi, 0] });
            activeNotes.delete(key);
        }
    };
    activeNotes.set(key, stop);
    return stop;
}

/**
 * Release all tracked active notes (for pianoroll stop / shutdown).
 */
export function releaseAllNotes() {
    for (const stop of activeNotes.values()) stop();
    activeNotes.clear();
}

/**
 * Legacy: play note with voiceData (loads patch on channel 0).
 */
export function playNoteRealtime(voiceData, midi, velocity = 100) {
    if (!isReady() || !dx7Node) return null;
    const patch = typeof voiceData === 'string' ? base64ToUint8Array(voiceData) : voiceData;
    dx7Node.port.postMessage({ type: 'patch', slot: 0, data: patch.buffer });
    dx7Node.port.postMessage({ type: 'midi', data: [0x90, midi, velocity] });
    return () => {
        if (dx7Node) dx7Node.port.postMessage({ type: 'midi', data: [0x80, midi, 0] });
    };
}

// --- Offline rendering (main-thread WASM, no AudioWorklet) ---

// Cached offline WASM instance (separate from realtime AudioWorklet)
let offlineWasm = null;
let offlineHeapI16 = null;
let offlinePatchView = null;

async function ensureOfflineWasm() {
    if (offlineWasm) return true;
    if (!cachedWasmBytes) {
        const base = new URL('./wasm/', import.meta.url).pathname;
        const wasmResp = await fetch(base + 'msfa.wasm');
        cachedWasmBytes = await wasmResp.arrayBuffer();
    }
    const wasiStub = {
        fd_close: () => 0, fd_fdstat_get: () => 0, fd_seek: () => 0,
        fd_write: () => 0, poll_oneoff: () => 0, proc_exit: () => {},
    };
    const { instance } = await WebAssembly.instantiate(cachedWasmBytes, {
        wasi_snapshot_preview1: wasiStub,
    });
    offlineWasm = instance.exports;
    offlineWasm.init_engine(44100);
    offlineHeapI16 = new Int16Array(offlineWasm.memory.buffer);
    const patchPtr = offlineWasm.get_patch_buffer();
    offlinePatchView = new Uint8Array(offlineWasm.memory.buffer, patchPtr, 128);
    return true;
}

function offlineRefreshHeap() {
    if (offlineHeapI16.buffer !== offlineWasm.memory.buffer) {
        offlineHeapI16 = new Int16Array(offlineWasm.memory.buffer);
        const patchPtr = offlineWasm.get_patch_buffer();
        offlinePatchView = new Uint8Array(offlineWasm.memory.buffer, patchPtr, 128);
    }
}

export async function renderOffline(voiceData, midi, durationMs) {
    const sr = 44100;
    const renderDur = Math.max(durationMs, 500);
    const totalSamples = Math.ceil(((renderDur / 1000) + 0.5) * sr);

    if (!(await ensureOfflineWasm())) {
        throw new Error('Offline WASM init failed');
    }

    // Reset engine state for clean render
    offlineWasm.init_engine(sr);

    // Load patch into static buffer
    const patch = typeof voiceData === 'string' ? base64ToUint8Array(voiceData) : voiceData;
    offlineRefreshHeap();
    offlinePatchView.set(patch.subarray(0, 128));
    offlineWasm.load_voice_from_buffer();

    // Trigger note
    offlineWasm.note_on(midi, 100);

    // Render in chunks (WASM buffer max 88200 samples ~2s)
    const MAX_CHUNK = 88200;
    const result = new Float32Array(totalSamples);
    let offset = 0;

    while (offset < totalSamples) {
        const chunk = Math.min(MAX_CHUNK, totalSamples - offset);
        const ptr = offlineWasm.render_audio(chunk);
        if (!ptr) break;

        offlineRefreshHeap();
        const i16base = ptr >> 1;
        for (let i = 0; i < chunk; i++) {
            result[offset + i] = offlineHeapI16[i16base + i] * (1.0 / 32768.0);
        }
        offset += chunk;
    }

    // Fade-out over last 50ms
    const fadeLen = Math.min(Math.ceil(0.05 * sr), totalSamples);
    for (let i = 0; i < fadeLen; i++) {
        result[totalSamples - fadeLen + i] *= (1 - i / fadeLen);
    }

    return samplesToWavBlob(result, sr);
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

// --- Shutdown hooks (disabled for testing) ---

let _pianorollStopFn = null;

export function setPianorollStop(fn) {
    _pianorollStopFn = fn;
}

function stopPianorollAndRelease() {
    if (_pianorollStopFn) _pianorollStopFn();
    releaseAllNotes();
}

export async function shutdownAll() {
    // No-op
}

export function extendIdle() {
    // No-op
}
