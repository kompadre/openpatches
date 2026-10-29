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

import {
    BULK_DUMP_SIZE,
    buildBulkDumpRequest,
    buildVoiceDump,
    isBulkDump,
    toPacked128,
    validateBulkDump,
} from '../components/syx-builder.js';
import { DEVICE_TYPE_AUTO, detectDeviceType, getProfile, isDeviceType } from './midi-devices.js';

const STORAGE_KEY = 'openpatches_midi';

const ALL_SOUND_OFF = 120;
const ALL_NOTES_OFF = 123;
const MIDI_CHANNELS = 16;
const VOICE_BANK_SLOTS = 8;

// A scheduled note-off lands this many ms early. Without the gap, a note
// repeating at the same pitch on the next tick is cut by the previous note's
// note-off arriving at exactly the same instant.
const NOTE_OFF_GAP_MS = 2;

// Every note-path message is sent with a timestamp this far in the future.
// The internal synth has latency of its own (AudioContext output buffering +
// the worklet's ring lookahead), so an unstamped MIDI message reaches the
// hardware well before the same note is heard locally and "both" mode
// flams. The default was measured against a Korg Volca FM; the right value
// depends on the machine and audio device, so the user tunes it in the MIDI
// settings modal (see playLatencyProbe). It is applied in exactly one place,
// sendAt(), so note-on, note-off, stop and release can never drift apart: a
// note-off that beats its own note-on to the wire is a stuck note.
// SysEx transfers are deliberately *not* delayed — they are not aligned with
// audio, and the edit-buffer dump in front of an audition note gains a head
// start on its ~50 ms wire time by going out immediately.
export const DEFAULT_OUTPUT_LATENCY_MS = 317;
export const MAX_OUTPUT_LATENCY_MS = 1000;

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
let auditionEnabled = false;            // send previews to the device's edit buffer
let outputLatencyMs = DEFAULT_OUTPUT_LATENCY_MS;
let deviceType = DEVICE_TYPE_AUTO;       // profile id, or 'auto' = detect from the output port name
let lastAuditionVoice = null;           // dedupe key for the loaded edit buffer
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

// --- Device profile ---

export function getDeviceType() { return deviceType; }

/** 'auto' or a profile id from midi-devices.js; anything else is ignored. */
export function setDeviceType(id) {
    if (!isDeviceType(id)) return;
    deviceType = id;
    saveState();
}

// The output's name, live if MIDI is up, otherwise what we remembered for
// the selected id — so the profile is right even before the user has
// enabled MIDI this session (the send-bank confirm dialog runs first).
function outputName() {
    const port = getOutputPort();
    if (port) return port.name;
    if (!selectedOutputId) return null;
    const names = loadState().names || {};
    return names[selectedOutputId] || null;
}

/** The profile id actually in force: the explicit choice, or the detection result. */
export function getResolvedDeviceType() {
    return deviceType === DEVICE_TYPE_AUTO ? detectDeviceType(outputName()) : deviceType;
}

/** @returns {import('./midi-devices.js').DeviceProfile} */
export function getDeviceProfile() {
    return getProfile(getResolvedDeviceType());
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
        port.onmidimessage = (e) => {
            // A pending SysEx receive gets first look and swallows what it
            // consumes; the note handler never wants SysEx anyway.
            if (consumeSysex(e.data)) return;
            if (onMidiMessage) onMidiMessage(e);
        };
    }
}

// --- Output ---

export function getOutputLatency() { return outputLatencyMs; }

/**
 * Set the output latency in ms. Clamped to 0..MAX_OUTPUT_LATENCY_MS and
 * rounded — the value comes from a slider, so out-of-range input is a
 * nudge past the end, not a mistake to reject. Non-numbers are ignored.
 */
export function setOutputLatency(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return;
    outputLatencyMs = Math.round(Math.min(MAX_OUTPUT_LATENCY_MS, Math.max(0, n)));
    saveState();
}

// The one place the output latency is applied. `when` is on the
// performance.now() clock and means "when the internal synth would sound
// this"; the message is stamped outputLatencyMs later so the hardware
// lines up with it. Throws like port.send() does — callers decide how to
// recover.
function sendAt(port, data, when = performance.now()) {
    port.send(data, when + outputLatencyMs);
}

/**
 * Send raw bytes to the selected output. `timestamp` is on the
 * performance.now() clock and defaults to now; like every other note-path
 * message it is shifted by the output latency so it lines up with the
 * internal synth.
 * @returns {boolean} whether anything was sent
 */
export function send(data, timestamp) {
    const port = getOutputPort();
    if (!port) return false;
    try {
        sendAt(port, data, timestamp);
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
export function playNoteOut(slot, midi, velocity = 100, durMs = 0, opts = {}) {
    return sendNoteOnChannel(getSlotChannel(slot), midi, velocity, durMs, opts);
}

/**
 * Same contract as playNoteOut, but on an explicit MIDI channel.
 *
 * `time` is when the note sounds on the performance.now() clock (default:
 * now). Everything — note-on, scheduled note-off, the bookkeeping timer —
 * is relative to it, and every message goes through sendAt() so the output
 * latency is applied uniformly.
 */
function sendNoteOnChannel(ch, midi, velocity = 100, durMs = 0, { schedule = true, time = performance.now() } = {}) {
    const port = getOutputPort();
    if (!port) return null;

    const key = ch + ':' + midi;

    const prev = outNotes.get(key);
    if (prev) prev();

    try {
        sendAt(port, [0x90 | ch, midi, velocity], time);
    } catch (err) {
        console.warn('[midi] note-on failed:', err);
        return null;
    }

    if (schedule && durMs > 0) {
        try {
            // Same clock as the note-on, so the note keeps its full length
            // and the off can never land ahead of the on.
            sendAt(port, [0x80 | ch, midi, 0], time + Math.max(1, durMs - NOTE_OFF_GAP_MS));
        } catch { /* the explicit stop below is the fallback */ }
    }

    let done = false;
    const stop = () => {
        if (done) return;
        done = true;
        if (outNotes.get(key) === stop) outNotes.delete(key);
        // Sent even when a note-off was already scheduled: a duplicate
        // note-off is harmless, a missed one is not. Goes through sendAt()
        // too — an unstamped off would overtake the still-queued on.
        try { sendAt(port, [0x80 | ch, midi, 0]); } catch { /* port went away */ }
    };
    outNotes.set(key, stop);

    if (schedule && durMs > 0) {
        // Drop the bookkeeping entry roughly when the note ends. The
        // latency cancels out here: the note-on and the scheduled note-off
        // are both shifted by it, so "ends" is simply time + durMs.
        setTimeout(() => {
            if (outNotes.get(key) === stop) outNotes.delete(key);
            done = true;
        }, Math.max(0, time - performance.now() + durMs));
    }
    return stop;
}

/**
 * One tick of the output-latency calibration in the settings modal: a short
 * note on the device's basic channel, sent exactly as a piano-roll note is,
 * so what the user tunes against is what playback will do. `onWire` fires
 * on the main thread when the note-on is due to leave — the modal flashes
 * on it. With audition on, the device is handed the same INIT-style test
 * tone the internal synth plays, so the two notes can be heard fusing.
 * Works with no device selected: the flash alone is still useful.
 * @returns {function|null} stop function
 */
export function playLatencyProbe(midi = 60, { velocity = 100, durMs = 150, voiceData = null, onWire = null } = {}) {
    if (onWire) setTimeout(onWire, outputLatencyMs);
    if (!getOutputPort()) return null;
    if (voiceData && isAuditionEnabled()) {
        return auditionNote(voiceData, midi, velocity, durMs);
    }
    return sendNoteOnChannel(deviceChannel, midi, velocity, durMs);
}

/** Blind note-off for a slot, used by the keyboard's fallback release path. */
export function stopNoteOut(slot, midi) {
    const key = getSlotChannel(slot) + ':' + midi;
    const stop = outNotes.get(key);
    if (stop) { stop(); return true; }
    const port = getOutputPort();
    if (!port) return false;
    try { sendAt(port, [0x80 | getSlotChannel(slot), midi, 0]); } catch { return false; }
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
 *
 * Sent twice: once unstamped, so it goes out right now (and still makes it
 * out on pagehide), and once the output latency later. Every note-on is
 * queued that far ahead, so during playback there are always some still in
 * flight; the immediate sweep alone would silence the device and then let
 * those land and stick. Web MIDI's clear() would drop them, but Chrome has
 * never implemented it.
 */
export function panic() {
    outNotes.clear();
    const port = getOutputPort();
    if (!port) return false;
    const now = performance.now();
    try {
        for (let ch = 0; ch < MIDI_CHANNELS; ch++) {
            port.send([0xB0 | ch, ALL_SOUND_OFF, 0]);
            port.send([0xB0 | ch, ALL_NOTES_OFF, 0]);
        }
        for (let ch = 0; ch < MIDI_CHANNELS; ch++) {
            sendAt(port, [0xB0 | ch, ALL_SOUND_OFF, 0], now);
            sendAt(port, [0xB0 | ch, ALL_NOTES_OFF, 0], now);
        }
    } catch {
        return false;
    }
    return true;
}

// --- Bulk dump transport ---

// Time for one byte over a 31250-baud MIDI DIN cable (10 bits per byte).
const MS_PER_MIDI_BYTE = 10 / 31.25;

// How long to wait for a device to answer a dump request before giving up.
// Generous on purpose: the original DX7 Mk I ignores dump requests entirely
// and the user has to start the transfer from its front panel.
const RECEIVE_TIMEOUT_MS = 45000;

// A SysEx receive in progress: { buf, expect, match, settle, onProgress }.
let sysexCollector = null;

/**
 * Feed an inbound MIDI message to a pending SysEx receive.
 * @returns {boolean} true if the message was consumed
 */
function consumeSysex(data) {
    const c = sysexCollector;
    if (!c || !data || data.length === 0) return false;

    if (data[0] === 0xF0) c.buf = [];
    // Mid-stream bytes with no start byte seen: not ours.
    if (!c.buf) return false;

    for (let i = 0; i < data.length; i++) c.buf.push(data[i]);

    if (data[data.length - 1] !== 0xF7) {
        // Web MIDI usually delivers a whole SysEx in one event, but the spec
        // permits splitting, so report partial progress and keep collecting.
        if (c.onProgress) c.onProgress(Math.min(99, (c.buf.length / c.expect) * 100));
        return true;
    }

    const bytes = Uint8Array.from(c.buf);
    c.buf = null;
    // Anything that is not what we asked for (an ID reply, a parameter
    // change) is ignored and we keep waiting.
    if (c.match(bytes)) c.settle(bytes);
    return true;
}

function awaitSysex({ match, expect, timeoutMs, signal, onProgress, timeoutMessage }) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const finish = (fn, arg) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            sysexCollector = null;
            fn(arg);
        };
        const timer = setTimeout(
            () => finish(reject, new Error(timeoutMessage || 'Timed out waiting for the device to send its bank')),
            timeoutMs);
        if (signal) {
            signal.addEventListener('abort', () => finish(reject, new Error('Cancelled')), { once: true });
        }
        sysexCollector = {
            buf: null,
            expect,
            match,
            onProgress,
            settle: (bytes) => finish(resolve, bytes),
        };
    });
}

/**
 * Request a 32-voice bulk dump and resolve with the raw 4104-byte message.
 *
 * The device profile decides the shape of the exchange: whether the device
 * can be dumped at all (Dexed and the volca fm cannot), whether a dump
 * request is worth sending (the DX7 Mk I ignores it — the user starts the
 * transfer from the front panel, which is why the timeout is long and the
 * message says what to press), and what to say when nothing arrives.
 *
 * @returns {Promise<Uint8Array>}
 */
export async function receiveBank({ onProgress, signal, timeoutMs = RECEIVE_TIMEOUT_MS } = {}) {
    if (!hasSysex()) throw new Error('SysEx permission has not been granted');
    const profile = getDeviceProfile();
    if (!profile.bankReceive.supported) {
        throw new Error(profile.bankReceive.reason || (profile.name + ' cannot transmit a bank'));
    }
    const inPort = getInputPort();
    if (!inPort) {
        throw new Error('No MIDI input device is selected. Receiving a bank needs one — ' +
            'open MIDI \u203a Devices and pick the input your synth sends on.');
    }

    const pending = awaitSysex({
        match: isBulkDump,
        expect: BULK_DUMP_SIZE,
        timeoutMs,
        signal,
        onProgress,
        timeoutMessage: 'Timed out waiting for ' + profile.name + ' to send its bank.' +
            (profile.bankReceive.manualHint ? ' ' + profile.bankReceive.manualHint : ''),
    });

    const out = getOutputPort();
    if (out && profile.bankReceive.dumpRequest) {
        try { out.send(buildBulkDumpRequest({ channel: deviceChannel })); } catch { /* front panel it is */ }
    }

    const bytes = await pending;
    const check = validateBulkDump(bytes);
    if (!check.ok) throw new Error(check.error);
    if (onProgress) onProgress(100);
    return bytes;
}

/**
 * Send a 4104-byte bulk dump to the device.
 *
 * Sent as a single message: MIDI has no flow control, and splitting a dump
 * across sends risks a gap mid-transfer that some synths treat as a truncated
 * message. Progress is therefore an estimate from the cable's byte rate —
 * there is no completion signal to wait on.
 */
export async function sendBank(bytes, { onProgress, signal } = {}) {
    if (!hasSysex()) throw new Error('SysEx permission has not been granted');
    const profile = getDeviceProfile();
    if (!profile.bankSend.supported) throw new Error(profile.name + ' does not accept bank dumps');
    const port = getOutputPort();
    if (!port) throw new Error('No MIDI output device is selected');

    const check = validateBulkDump(bytes);
    if (!check.ok) throw new Error('Refusing to send a malformed bank: ' + check.error);

    port.send(bytes);
    await estimateTransfer(bytes.length, onProgress, signal);
}

// Walk a progress bar across the time the bytes physically take on the wire.
function estimateTransfer(byteCount, onProgress, signal) {
    const total = Math.max(200, byteCount * MS_PER_MIDI_BYTE);
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
            if (signal && signal.aborted) {
                clearInterval(timer);
                reject(new Error('Cancelled'));
                return;
            }
            const pct = Math.min(100, ((Date.now() - t0) / total) * 100);
            if (onProgress) onProgress(pct);
            if (pct >= 100) {
                clearInterval(timer);
                resolve();
            }
        }, 50);
    });
}

// --- Live audition ------------------------------------------------------

export function isAuditionEnabled() {
    return auditionEnabled && hasSysex() && !!getOutputPort();
}

export function getAuditionEnabled() { return auditionEnabled; }

/**
 * Audition is switched on, but the grant we are holding is the plain tier
 * and cannot carry SysEx — so auditioning silently does nothing.
 *
 * This is the normal state on a fresh page load: `auditionEnabled` is
 * restored from localStorage, the permission tier is not, and MIDI is
 * enabled with the weakest tier that the *default* settings need. Callers
 * that can prompt (i.e. are inside a user gesture) should upgrade; the
 * settings modal both pre-requests the right tier and offers a one-click
 * fix when this is true.
 */
export function auditionNeedsSysex() {
    return auditionEnabled && !!access && !sysexEnabled;
}

export function setAuditionEnabled(on) {
    auditionEnabled = !!on;
    lastAuditionVoice = null;
    saveState();
}

/**
 * Load a voice into the device's edit buffer. Repeated calls with identical
 * bytes are skipped: a 163-byte VCED costs ~50 ms on the wire, which is
 * audible latency in front of a preview note.
 *
 * Sent unstamped on purpose: the audition note-on that follows is delayed
 * by the output latency, so the dump gets that much of a head start.
 * @returns {boolean} whether the device was (or already was) loaded
 */
export function sendVoiceToEditBuffer(voiceData) {
    const port = getOutputPort();
    if (!port || !hasSysex()) return false;

    const packed = toPacked128(voiceData);
    if (!packed) return false;

    const key = packed.join(',');
    if (key === lastAuditionVoice) return true;

    const msg = buildVoiceDump(packed, { channel: deviceChannel });
    if (!msg) return false;
    try {
        port.send(msg);
    } catch (err) {
        console.warn('[midi] edit-buffer send failed:', err);
        return false;
    }
    lastAuditionVoice = key;
    return true;
}

/**
 * Audition a patch on the device: load it into the edit buffer, then play a
 * note on the device's basic channel.
 * @returns {function|null} stop function
 */
export function auditionNote(voiceData, midi, velocity = 100, durMs = 0) {
    if (!isAuditionEnabled()) return null;
    if (!sendVoiceToEditBuffer(voiceData)) return null;
    return sendNoteOnChannel(deviceChannel, midi, velocity, durMs, { schedule: durMs > 0 });
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
            auditionEnabled,
            outputLatencyMs,
            deviceType,
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
    auditionEnabled = !!saved.auditionEnabled;
    deviceType = isDeviceType(saved.deviceType) ? saved.deviceType : DEVICE_TYPE_AUTO;
    outputLatencyMs = DEFAULT_OUTPUT_LATENCY_MS;
    if (Number.isFinite(saved.outputLatencyMs)) {
        outputLatencyMs = Math.round(Math.min(MAX_OUTPUT_LATENCY_MS, Math.max(0, saved.outputLatencyMs)));
    }
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
    auditionEnabled = false;
    outputLatencyMs = DEFAULT_OUTPUT_LATENCY_MS;
    deviceType = DEVICE_TYPE_AUTO;
    lastAuditionVoice = null;
    sysexCollector = null;
    outNotes.clear();
    initFromStorage();
}
