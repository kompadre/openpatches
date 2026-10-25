// MIDI Manager — singleton Web MIDI access.
// Mirrors audio-manager.js: one lazily-created access object, live for the
// page lifetime, never requested until a feature actually needs it.
//
// Permission tiers. Chrome treats {sysex:false} and {sysex:true} as two
// separate permissions and prompts for each, so we request the weakest tier a
// feature needs and *upgrade* in place when SysEx is first required. Upgrading
// swaps the MIDIAccess object, which means every port listener has to be
// re-attached — see attachInputListener().
//
// Support is narrower than the rest of the app: Safari has no Web MIDI at all,
// so every iOS browser is out. Callers must check isSupported() and hide their
// UI rather than surfacing controls that can never work.

const STORAGE_KEY = 'openpatches_midi';

const ALL_SOUND_OFF = 120;
const ALL_NOTES_OFF = 123;
const MIDI_CHANNELS = 16;
const VOICE_BANK_SLOTS = 8;

// A scheduled note-off lands this many ms early. Without the gap, a note
// repeating at the same pitch on the next tick is cut by the previous note's
// note-off arriving at exactly the same instant.
const NOTE_OFF_GAP_MS = 2;

let access = null;          // MIDIAccess, or null until requested
let sysexEnabled = false;   // whether `access` was granted with sysex
let requestPromise = null;  // in-flight requestMIDIAccess
let requestGeneration = 0;  // guards against an older request resolving last
let state = 'closed';       // closed | requesting | ready | denied | unsupported

let selectedInputId = null;
let selectedOutputId = null;
let deviceChannel = 0;      // SysEx sub-status / basic channel (0-15)
let inputChannel = -1;      // -1 = omni, else only accept this channel (0-15)
let outputMode = 'internal';            // internal | midi | both
let slotChannels = defaultSlotChannels();

// VoiceBank slot → MIDI out channel. Identity by default, matching the
// internal engine's slot==channel convention. The map is free-form on
// purpose: a monotimbral synth simply ignores the channels it is not set to,
// so there is nothing to special-case for it here.
function defaultSlotChannels() {
    return Array.from({ length: VOICE_BANK_SLOTS }, (_, i) => i);
}

let onStatusChange = null;
let onPortsChange = null;
let onMidiMessage = null;   // (MIDIMessageEvent) — set by the recorder in phase 2

let boundInput = null;      // the port attachInputListener() is currently on

// --- Support + state ---

export function isSupported() {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}

export function getState() {
    if (!isSupported()) return 'unsupported';
    return state;
}

export function hasSysex() {
    return !!access && sysexEnabled;
}

function setState(next) {
    state = next;
    if (onStatusChange) onStatusChange(getState());
}

export function setOnStatusChange(fn) {
    onStatusChange = fn;
    if (fn) fn(getState());
}

export function setOnPortsChange(fn) {
    onPortsChange = fn;
}

function notifyPorts() {
    if (onPortsChange) onPortsChange();
}

// --- Access ---

/**
 * Request MIDI access. Must be called from a user gesture — browsers show a
 * permission prompt. Safe to call repeatedly: an existing grant is reused, and
 * asking for sysex when we only hold a plain grant upgrades it.
 *
 * @param {{sysex?: boolean}} opts
 * @returns {Promise<MIDIAccess>}
 */
export async function requestMidi({ sysex = false } = {}) {
    if (!isSupported()) throw new Error('Web MIDI is not supported in this browser');

    // Already have what the caller needs.
    if (access && (sysexEnabled || !sysex)) return access;

    // An in-flight request of a sufficient tier can be shared.
    if (requestPromise && (!sysex || requestPromise._sysex)) return requestPromise;

    // A plain request already in flight cannot satisfy a sysex caller, so we
    // start a second one. Both will resolve, in either order — the generation
    // counter makes sure the loser cannot clobber the winner's access object
    // (which would leave hasSysex() lying about a non-sysex grant).
    const generation = ++requestGeneration;

    setState('requesting');
    const p = navigator.requestMIDIAccess({ sysex }).then((granted) => {
        if (generation !== requestGeneration) return access || granted;
        access = granted;
        sysexEnabled = sysex;
        requestPromise = null;
        granted.onstatechange = handleStateChange;
        // The new access exposes *different* port objects, so any existing
        // onmidimessage handler is sitting on a now-orphaned port. The
        // identity check inside attachInputListener() re-binds it.
        attachInputListener();
        setState('ready');
        notifyPorts();
        return granted;
    }).catch((err) => {
        if (generation === requestGeneration) {
            requestPromise = null;
            if (!access) setState('denied');
        }
        throw err;
    });
    p._sysex = sysex;
    requestPromise = p;
    return p;
}

function handleStateChange() {
    // A port we had selected may have vanished; selection is resolved lazily
    // by id, so just tell the UI to re-read the lists.
    attachInputListener();
    notifyPorts();
}

// --- Ports ---

function portList(map) {
    if (!map) return [];
    return [...map.values()].map(p => ({
        id: p.id,
        name: p.name || '(unnamed)',
        manufacturer: p.manufacturer || '',
        state: p.state,
    }));
}

export function listInputs() {
    return access ? portList(access.inputs) : [];
}

export function listOutputs() {
    return access ? portList(access.outputs) : [];
}

// Port ids are not stable across browsers or sessions, so fall back to
// matching on name before giving up.
function resolvePort(map, id) {
    if (!map || !id) return null;
    const byId = map.get(id);
    if (byId) return byId;
    const remembered = loadState().names || {};
    const wantName = remembered[id];
    if (!wantName) return null;
    for (const port of map.values()) {
        if (port.name === wantName) return port;
    }
    return null;
}

export function getInputPort() {
    return access ? resolvePort(access.inputs, selectedInputId) : null;
}

export function getOutputPort() {
    return access ? resolvePort(access.outputs, selectedOutputId) : null;
}

export function getSelectedInputId() { return selectedInputId; }
export function getSelectedOutputId() { return selectedOutputId; }

export function setSelectedInput(id) {
    selectedInputId = id || null;
    attachInputListener();
    saveState();
    notifyPorts();
}

export function setSelectedOutput(id) {
    // Leaving a device behind with notes held down is the one failure the user
    // cannot fix from the browser.
    panic();
    selectedOutputId = id || null;
    saveState();
    notifyPorts();
}

export function getDeviceChannel() { return deviceChannel; }

export function setDeviceChannel(ch) {
    const n = Number(ch);
    if (!Number.isInteger(n) || n < 0 || n >= MIDI_CHANNELS) return;
    deviceChannel = n;
    saveState();
}

export function getInputChannel() { return inputChannel; }

/** -1 accepts every channel (omni); 0-15 accepts only that one. */
export function setInputChannel(ch) {
    const n = Number(ch);
    if (!Number.isInteger(n) || n < -1 || n >= MIDI_CHANNELS) return;
    inputChannel = n;
    saveState();
}

// --- Input routing ---

/**
 * Register the handler for incoming MIDI messages. The handler follows the
 * selected input port across device changes and permission upgrades.
 */
export function setOnMidiMessage(fn) {
    onMidiMessage = fn;
    attachInputListener();
}

function attachInputListener() {
    const port = getInputPort();
    if (boundInput === port) return;
    if (boundInput) boundInput.onmidimessage = null;
    boundInput = port;
    if (port) {
        port.onmidimessage = (e) => { if (onMidiMessage) onMidiMessage(e); };
    }
}

// --- Output ---

/**
 * Send raw bytes to the selected output. `timestamp` is on the
 * performance.now() clock; omit it to send immediately.
 * @returns {boolean} whether anything was sent
 */
export function send(data, timestamp) {
    const port = getOutputPort();
    if (!port) return false;
    try {
        port.send(data, timestamp);
        return true;
    } catch (err) {
        console.warn('[midi] send failed:', err);
        return false;
    }
}

// --- Note output routing ---

export function getOutputMode() { return outputMode; }

/**
 * 'internal' — local synth only (default, unchanged behaviour)
 * 'midi'     — external device only, local synth silent
 * 'both'     — doubled
 *
 * Governs slot-addressed notes (piano roll + keyboard). Patch previews always
 * use the local synth: there is no patch loaded on the external device to
 * preview with until the Phase 4 SysEx path exists.
 */
export function setOutputMode(mode) {
    if (mode !== 'internal' && mode !== 'midi' && mode !== 'both') return;
    if (mode !== outputMode) releaseAllOut();
    outputMode = mode;
    saveState();
}

export function isMidiOutEnabled() {
    return outputMode !== 'internal' && !!getOutputPort();
}

export function isInternalEnabled() {
    // If MIDI-only is selected but no device is actually reachable, fall back
    // to the local synth rather than going silent for no visible reason.
    return outputMode !== 'midi' || !getOutputPort();
}

export function getSlotChannel(slot) {
    return slotChannels[slot] ?? slot;
}

export function setSlotChannel(slot, ch) {
    const s = Number(slot);
    const c = Number(ch);
    if (!Number.isInteger(s) || s < 0 || s >= VOICE_BANK_SLOTS) return;
    if (!Number.isInteger(c) || c < 0 || c >= MIDI_CHANNELS) return;
    slotChannels[s] = c;
    saveState();
}

export function getSlotChannels() { return slotChannels.slice(); }

// Notes we started on the device: "channel:midi" → stop function.
const outNotes = new Map();

/**
 * Play a note on the external device, mapping VoiceBank slot → channel.
 *
 * `schedule` sends the note-off with an explicit future timestamp, which the
 * MIDI subsystem honours even if the main thread stalls — right for piano
 * roll notes, whose duration is known up front. Held keys pass schedule:false
 * because their "duration" is only a 30 s safety value; scheduling that far
 * out would leave a note-off landmine for whatever reuses the pitch.
 *
 * @returns {function|null} stop function
 */
export function playNoteOut(slot, midi, velocity = 100, durMs = 0, { schedule = true } = {}) {
    const port = getOutputPort();
    if (!port) return null;

    const ch = getSlotChannel(slot);
    const key = ch + ':' + midi;

    const prev = outNotes.get(key);
    if (prev) prev();

    try {
        port.send([0x90 | ch, midi, velocity]);
    } catch (err) {
        console.warn('[midi] note-on failed:', err);
        return null;
    }

    if (schedule && durMs > 0) {
        try {
            port.send([0x80 | ch, midi, 0], performance.now() + Math.max(1, durMs - NOTE_OFF_GAP_MS));
        } catch { /* the explicit stop below is the fallback */ }
    }

    let done = false;
    const stop = () => {
        if (done) return;
        done = true;
        if (outNotes.get(key) === stop) outNotes.delete(key);
        // Sent even when a note-off was already scheduled: a duplicate
        // note-off is harmless, a missed one is not.
        try { port.send([0x80 | ch, midi, 0]); } catch { /* port went away */ }
    };
    outNotes.set(key, stop);
    if (schedule && durMs > 0) {
        // Drop the bookkeeping entry roughly when the note ends.
        setTimeout(() => {
            if (outNotes.get(key) === stop) outNotes.delete(key);
            done = true;
        }, durMs);
    }
    return stop;
}

/** Blind note-off for a slot, used by the keyboard's fallback release path. */
export function stopNoteOut(slot, midi) {
    const key = getSlotChannel(slot) + ':' + midi;
    const stop = outNotes.get(key);
    if (stop) { stop(); return true; }
    const port = getOutputPort();
    if (!port) return false;
    try { port.send([0x80 | getSlotChannel(slot), midi, 0]); } catch { return false; }
    return true;
}

/** Note-off everything we started. Lighter than panic(); use on Stop. */
export function releaseAllOut() {
    for (const stop of [...outNotes.values()]) stop();
    outNotes.clear();
}

/**
 * Silence the output device: All Sound Off + All Notes Off on every channel.
 * Cheap, idempotent, and the only recovery path for a stuck note on external
 * hardware — call it liberally.
 */
export function panic() {
    outNotes.clear();
    const port = getOutputPort();
    if (!port) return false;
    for (let ch = 0; ch < MIDI_CHANNELS; ch++) {
        try {
            port.send([0xB0 | ch, ALL_SOUND_OFF, 0]);
            port.send([0xB0 | ch, ALL_NOTES_OFF, 0]);
        } catch {
            return false;
        }
    }
    return true;
}

// --- Bulk dump transport (Phase 4 — stubs) ---

export class MidiNotImplementedError extends Error {
    constructor(what) {
        super(`${what} is not implemented yet (planned for Phase 4)`);
        this.name = 'MidiNotImplementedError';
    }
}

// Roughly how long 4104 SysEx bytes take over a 31250-baud DIN cable. The
// stubs burn this time so the progress UI can be exercised honestly.
const BULK_DUMP_MS = 1300;

function stubProgress(onProgress, signal) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
            if (signal && signal.aborted) {
                clearInterval(timer);
                reject(new Error('Cancelled'));
                return;
            }
            const pct = Math.min(100, ((Date.now() - t0) / BULK_DUMP_MS) * 100);
            if (onProgress) onProgress(pct);
            if (pct >= 100) {
                clearInterval(timer);
                resolve();
            }
        }, 60);
    });
}

/**
 * STUB. Will request a bulk dump from the device and resolve with the raw
 * 4104-byte SysEx bank. Always rejects for now — callers must treat a failed
 * backup as a hard stop, never as "proceed anyway".
 *
 * @returns {Promise<Uint8Array>}
 */
export async function receiveBank({ onProgress, signal } = {}) {
    if (!hasSysex()) throw new Error('SysEx permission has not been granted');
    await stubProgress(onProgress, signal);
    throw new MidiNotImplementedError('Receiving a bank from the device');
}

/**
 * STUB. Will send a 4104-byte bulk dump to the device.
 * @returns {Promise<void>}
 */
export async function sendBank(bytes, { onProgress, signal } = {}) {
    if (!hasSysex()) throw new Error('SysEx permission has not been granted');
    await stubProgress(onProgress, signal);
    throw new MidiNotImplementedError('Sending a bank to the device');
}

// --- Persistence ---

function saveState() {
    try {
        const names = {};
        const inPort = getInputPort();
        const outPort = getOutputPort();
        if (selectedInputId && inPort) names[selectedInputId] = inPort.name;
        if (selectedOutputId && outPort) names[selectedOutputId] = outPort.name;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            inputId: selectedInputId,
            outputId: selectedOutputId,
            deviceChannel,
            inputChannel,
            outputMode,
            slotChannels,
            names,
        }));
    } catch (e) {
        console.warn('MIDI settings save failed:', e);
    }
}

function loadState() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
        return {};
    }
}

// Restore the remembered selection. No MIDI access is requested here — the
// ids are just parked until the user enables MIDI.
function initFromStorage() {
    const saved = loadState();
    selectedInputId = saved.inputId || null;
    selectedOutputId = saved.outputId || null;
    if (Number.isInteger(saved.deviceChannel)) deviceChannel = saved.deviceChannel;
    if (Number.isInteger(saved.inputChannel)) inputChannel = saved.inputChannel;
    if (saved.outputMode === 'midi' || saved.outputMode === 'both') outputMode = saved.outputMode;
    slotChannels = defaultSlotChannels();
    if (Array.isArray(saved.slotChannels)) {
        saved.slotChannels.forEach((ch, i) => {
            if (i < VOICE_BANK_SLOTS && Number.isInteger(ch) && ch >= 0 && ch < MIDI_CHANNELS) {
                slotChannels[i] = ch;
            }
        });
    }
}

initFromStorage();

// Test seam: the live MIDIAccess, so a suite can check which grant won.
export function _getAccess() {
    return access;
}

// Test seam: drop all cached access and re-read settings from storage, so a
// suite starts from the same state a fresh page load would.
export function _reset() {
    access = null;
    sysexEnabled = false;
    requestPromise = null;
    requestGeneration++;
    boundInput = null;
    onMidiMessage = null;
    state = 'closed';
    selectedInputId = null;
    selectedOutputId = null;
    deviceChannel = 0;
    inputChannel = -1;
    outputMode = 'internal';
    outNotes.clear();
    initFromStorage();
}
