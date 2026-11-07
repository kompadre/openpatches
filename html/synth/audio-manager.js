// Audio Manager — singleton audio engine.
// AudioContext + AudioWorklet initialized once, live for page lifetime.
// No repeated addModule(), no blob URLs, no re-initialization.
// Offline (non-realtime) rendering lives in dx7-synth.js; re-exported here
// so callers keep a single synth entry point.

export { renderOffline } from './dx7-synth.js';

import {
    FxParam, FxGlobalParam, FX_FIELDS, FX_GLOBAL_FIELDS, fxEnableMask,
} from './fx-params.js';

const VOICE_BANK_SLOTS = 8;   // Voice bank uses channels 0-7
const MIDI_CHANNELS = 16;     // DX7 has 16 MIDI channels (0-15)
const PREVIEW_SLOT = 15;      // Dedicated WASM patch slot for preview
const PREVIEW_CHANNEL = 15;   // Dedicated MIDI channel for preview
const DEFAULT_VOLUME = 100;   // Must match voicebank.js DEFAULT_VOLUME

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

    // A failed load must not poison the singleton — drop the half-built state
    // so the next acquire() can retry instead of returning the rejected promise
    // forever. The caller still sees the original rejection.
    initPromise.catch(() => {
        initPromise = null;
        initialized = false;
        if (ctx) { try { ctx.close(); } catch {} }
        ctx = null;
        dx7Node = null;
        lastSentPatch.fill(null);
        lastSentVolume.fill(null);
        clearFxCache();
        setState('closed');
    });

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

// Last patch bytes sent per slot. SetVoice resets the slot's LFO phase, so
// re-sending an unchanged patch mid-playback audibly re-phases that channel —
// only slots whose bytes actually changed are sent. Cleared on emergencyStop
// (the fresh engine has forgotten everything).
const lastSentPatch = new Array(VOICE_BANK_SLOTS).fill(null);

// Last channel volume sent per slot. Volumes live only in the engine, so a
// fresh page load starts every channel at the WASM default — the persisted
// VoiceBank volumes have to be pushed with the first snapshot.
const lastSentVolume = new Array(VOICE_BANK_SLOTS).fill(null);

function patchBytesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * Send the VoiceBank snapshot to the synth.
 * Each entry loads into its slot (array index) and maps channel = slot.
 * Idempotent — only slots whose patch bytes or volume changed are sent.
 */
export function sendVoiceSnapshot(entries) {
    if (!isReady() || !dx7Node) return;
    const voices = [];
    for (let i = 0; i < Math.min(entries.length, VOICE_BANK_SLOTS); i++) {
        const entry = entries[i];
        if (!entry || !entry.voiceData) continue;

        // effectiveVolume folds in Mute/Solo; falling back to the fader
        // volume keeps old snapshots (and tests) meaningful.
        const volume = entry.effectiveVolume ?? entry.volume ?? DEFAULT_VOLUME;
        if (lastSentVolume[i] !== volume) {
            lastSentVolume[i] = volume;
            setChannelVolume(i, volume);
        }

        const patch = normalizeVoiceData(entry.voiceData);
        if (!patch) continue;
        if (patchBytesEqual(lastSentPatch[i], patch)) continue;
        lastSentPatch[i] = patch.slice();
        voices.push({ slot: i, data: patch.buffer });
    }
    if (voices.length > 0) {
        dx7Node.port.postMessage({ type: 'voice-snapshot', voices });
    }
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
    if (channel >= 0 && channel < VOICE_BANK_SLOTS) lastSentVolume[channel] = volume;
    dx7Node.port.postMessage({ type: 'channel-volume', channel, volume });
}

// --- Effects ---
//
// Effect state lives in the engine, exactly like channel volumes: nothing
// reads it back, so a fresh worklet starts at the WASM defaults and the
// project's settings have to be pushed to it. These caches are what keep
// the push idempotent — `sendFxSnapshot` runs on every `tracks` update and
// most of them change nothing about the effects.
//
// `reset_engine` KEEPS fx parameters (they are static, like volumes), so a
// reinit does not strictly need a re-push; the cache is cleared anyway so
// that the next snapshot is a full one rather than a diff against a state
// nobody verified.
const lastSentFxMask = new Array(VOICE_BANK_SLOTS).fill(null);
const lastSentFxParams = new Array(VOICE_BANK_SLOTS).fill(null);
const lastSentGlobalFx = new Map();

function clearFxCache() {
    lastSentFxMask.fill(null);
    lastSentFxParams.fill(null);
    lastSentGlobalFx.clear();
}

/** Switch a channel's effects on or off. `mask` is an FxEnable bitmask. */
export function setFxEnabled(channel, mask) {
    if (!dx7Node || channel < 0 || channel >= VOICE_BANK_SLOTS) return;
    lastSentFxMask[channel] = mask;
    dx7Node.port.postMessage({ type: 'fx-enabled', channel, mask });
}

/** One per-channel parameter. `param` is an `FxParam` id. */
export function setFxParam(channel, param, value) {
    if (!dx7Node || channel < 0 || channel >= VOICE_BANK_SLOTS) return;
    if (!lastSentFxParams[channel]) lastSentFxParams[channel] = {};
    lastSentFxParams[channel][param] = value;
    dx7Node.port.postMessage({ type: 'fx-param', channel, param, value });
}

/** One global parameter — the shared reverb or the ducker. */
export function setGlobalFxParam(param, value) {
    if (!dx7Node) return;
    lastSentGlobalFx.set(param, value);
    dx7Node.port.postMessage({ type: 'fx-global', param, value });
}

/**
 * Push the whole rack: the project's tracks (each carrying `slot` and the
 * `fx` record project-model builds) and the project's global `fx`.
 *
 * Idempotent — only what actually changed is sent. A slot with no track on
 * it is explicitly switched OFF rather than skipped: a deleted track whose
 * delay keeps ringing is a tail with no strip to stop it.
 */
export function sendFxSnapshot(tracks, globalFx) {
    if (!isReady() || !dx7Node) return;

    const fxBySlot = new Array(VOICE_BANK_SLOTS).fill(null);
    for (const t of tracks || []) {
        if (t && t.slot >= 0 && t.slot < VOICE_BANK_SLOTS) fxBySlot[t.slot] = t.fx || null;
    }

    const channels = [];
    for (let ch = 0; ch < VOICE_BANK_SLOTS; ch++) {
        const fx = fxBySlot[ch];
        const mask = fxEnableMask(fx);
        const params = [];
        if (fx) {
            for (const [field, name] of Object.entries(FX_FIELDS)) {
                const param = FxParam[name];
                const value = fx[field];
                if (typeof value !== 'number' || !Number.isFinite(value)) continue;
                const sent = lastSentFxParams[ch];
                if (sent && sent[param] === value) continue;
                params.push([param, value]);
            }
        }
        if (params.length === 0 && lastSentFxMask[ch] === mask) continue;

        channels.push({ channel: ch, mask, params });
        if (!lastSentFxParams[ch]) lastSentFxParams[ch] = {};
        for (const [param, value] of params) lastSentFxParams[ch][param] = value;
        lastSentFxMask[ch] = mask;
    }

    const global = [];
    for (const [field, name] of Object.entries(FX_GLOBAL_FIELDS)) {
        const param = FxGlobalParam[name];
        const value = globalFx ? globalFx[field] : undefined;
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        if (lastSentGlobalFx.get(param) === value) continue;
        global.push([param, value]);
        lastSentGlobalFx.set(param, value);
    }

    if (channels.length > 0 || global.length > 0) {
        dx7Node.port.postMessage({ type: 'fx-snapshot', channels, global });
    }
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
 * Release every voice in the engine (64-sample fade), including notes the
 * main thread lost track of. Patches and volumes stay loaded.
 */
export function allNotesOff() {
    releaseAllNotes();
    if (dx7Node) {
        dx7Node.port.postMessage({ type: 'all-notes-off' });
    }
}

/**
 * Emergency stop: silence everything and reset the MSFA engine to a fresh
 * SynthUnit. Channel volumes survive (static in WASM); loaded patches do
 * not — the caller must re-send the voice snapshot.
 */
export function emergencyStop() {
    releaseAllNotes();
    lastSentPatch.fill(null);
    clearFxCache();
    if (dx7Node) {
        dx7Node.port.postMessage({ type: 'reinit' });
    }
}

// Stop function of the currently ringing preview note. A note-off matches
// every active note with the same channel+midi, so overlapping previews on
// the shared channel 15 would kill each other — release the old one first.
let previewStop = null;

/**
 * Preview a patch with its own voiceData, on the dedicated preview slot/channel.
 * Never touches slots 0-7 — the VoiceBank's patches stay loaded.
 * Starting a new preview releases the previous one.
 */
export function playNoteRealtime(voiceData, midi, velocity = 100) {
    if (!isReady() || !dx7Node) return null;
    const patch = normalizeVoiceData(voiceData);
    if (!patch) return null;
    if (previewStop) previewStop();
    dx7Node.port.postMessage({ type: 'patch', slot: PREVIEW_SLOT, data: patch.buffer });
    dx7Node.port.postMessage({ type: 'midi', data: [0x90 | PREVIEW_CHANNEL, midi, velocity] });
    const stop = () => {
        if (previewStop === stop) previewStop = null;
        if (dx7Node) dx7Node.port.postMessage({ type: 'midi', data: [0x80 | PREVIEW_CHANNEL, midi, 0] });
    };
    previewStop = stop;
    return stop;
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
