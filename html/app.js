// app.js — Orchestration only. All heavy logic lives in components/.
// Wires up file input, menu bar, canvas, toolbar, and import flows.

import { parseSyxFile, voiceRawToBase64 } from './components/syx-parser.js';
import { batchRenderWaveforms } from './synth/dx7-synth.js';
import { acquire, shutdownAll, extendIdle, playNoteRealtime, playNoteOnChannel, releaseAllNotes, sendVoiceSnapshot, setChannelVolume, base64ToUint8Array, renderOffline, isReady, getState, setOnStatusChange, setPianorollStop, emergencyStop, sendFxSnapshot } from './synth/audio-manager.js';
import { FX_FIELDS, FX_GLOBAL_FIELDS, FX_ENABLE_FIELDS, FX_RANGES, FX_GLOBAL_RANGES } from './synth/fx-params.js';
import { patchStore, canvasStore, jobStore, createPatch, bindProjectSession, loadPatchNames, savePatchNames } from './components/patch-model.js';
import { initCanvas, addContainer, addPatchToContainer, refreshCanvas } from './components/canvas.js';
import { createToolbar } from './components/toolbar.js';
import { updateBankSlots } from './components/patch-row.js';
import { openEdit } from './components/edit-panel.js';
import { Job, jobManager } from './components/job.js';
import { initTutorial, startTutorial, restartTutorial, isTutorialActive } from './components/tutorial.js';
import * as midiManager from './synth/midi-manager.js';
import { openMidiSettings, sendBankToDevice } from './components/midi-panel.js';
import { openProjectsDialog } from './components/project-menu.js';
import { makeInitVoice, buildBulkDump, VOICE_COUNT } from './components/syx-builder.js';
import { downloadBytes, downloadJson, safeFilename } from './components/download.js';
import { exportProject, parseProjectFile, ImportError, FILE_EXTENSION } from './components/project-io.js';
import { createProjectStore, takeLostSaveMarker } from './components/project-store.js';
import { profileStore } from './components/profile-store.js';
import { createProjectSession } from './components/project-session.js';
import { attachSaveIndicator, attachSaveWarning } from './components/save-indicator.js';
import { openModal, el } from './components/modal.js';
import { planStorage, formatBytes } from './components/storage-gc.js';
import { importCandidates, planImport } from './components/project-merge.js';

const fileInput = document.getElementById('wav-input');

const baseUrl = window.location.origin.indexOf("localhost") > -1 ? "http://localhost:8080" : window.location.origin;

let pianoDockWrapper = null;
let activeKeyboardNote = 60;
let activeSyxVoiceData = null;
let forkOsc = null;
let forkGain = null;

// Tick worker for precise pianoroll heartbeat
let tickWorker = null;
let tickWorkerSab = null;
try {
    tickWorker = new Worker(new URL('./synth/tick-worker.js', import.meta.url));
    if (typeof SharedArrayBuffer !== 'undefined') {
        tickWorkerSab = new SharedArrayBuffer(8); // 2 × Int32
        tickWorker.postMessage({ type: 'init', sab: tickWorkerSab });
    }
} catch (e) {
    console.warn('[tick-worker] Failed to create worker:', e);
}

// Both helpers bump the shared generation counter: the worker's loop exits as
// soon as the counter no longer matches the generation it started with, and a
// `start` carrying an outdated generation is ignored. See tick-worker.js.
function stopTickWorker(tw) {
    if (!tw) return;
    if (tickWorkerSab) {
        const ctl = new Int32Array(tickWorkerSab);
        Atomics.add(ctl, 0, 1);
        Atomics.notify(ctl, 0);
    } else {
        tw.postMessage({ type: 'stop' });
    }
}

function startTickWorker(tw, bpm, startCol = 0) {
    if (!tw) return;
    if (tickWorkerSab) {
        const ctl = new Int32Array(tickWorkerSab);
        Atomics.store(ctl, 1, Math.round(bpm * 1000));
        const gen = Atomics.add(ctl, 0, 1) + 1;  // ends any running loop
        Atomics.notify(ctl, 0);
        tw.postMessage({ type: 'start', bpm, startCol, gen });
    } else {
        tw.postMessage({ type: 'start', bpm, startCol });
    }
}

// Retempo a loop that is already running. The Atomics path cannot be told by
// message — it is blocked in Atomics.wait and will not read its inbox until
// it stops — so the tempo goes in the shared slot, and the notify is what
// cuts the current sleep short so the new rate is picked up now rather than
// at the next tick. Generation is deliberately untouched: this is not a
// restart, and the loop keeps its column count. See tick-worker.js.
function setTickWorkerTempo(tw, bpm) {
    if (!tw || !(bpm > 0)) return;
    if (tickWorkerSab) {
        const ctl = new Int32Array(tickWorkerSab);
        Atomics.store(ctl, 1, Math.round(bpm * 1000));
        Atomics.notify(ctl, 0);
    } else {
        tw.postMessage({ type: 'tempo', bpm });
    }
}

// --- IndexedDB for WAV binary data ---
const DB_NAME = 'openpatches';
const DB_VERSION = 1;
const STORE_NAME = 'uploads';

const dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
});

async function dbPut(key, value) {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
}

async function dbGet(key) {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readonly');
    return new Promise((resolve, reject) => {
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Empty the whole upload store. The per-container delete is not enough for
 * a wipe: `canvasStore.clear()` drops the records *without* iterating
 * them, so every blob they referenced would be left unreachable forever —
 * which is how "Clear History" used to be the thing that leaked.
 */
async function dbClearUploads() {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    return new Promise((resolve, reject) => {
        const req = tx.objectStore(STORE_NAME).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

/** Every upload's key and size, for the Storage report. */
async function dbListUploads() {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
        const out = [];
        const req = store.openCursor();
        req.onsuccess = () => {
            const cur = req.result;
            if (!cur) { resolve(out); return; }
            const v = cur.value;
            const bytes = v && (v.byteLength != null ? v.byteLength : v.size != null ? v.size : 0);
            out.push({ key: String(cur.key), bytes: bytes || 0 });
            cur.continue();
        };
        req.onerror = () => reject(req.error);
    });
}

async function dbDelete(key) {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    return new Promise((resolve, reject) => {
        const req = tx.objectStore(STORE_NAME).delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

window._dbDelete = dbDelete;

// --- Audio status indicator ---

let pendingSnapshot = null;

setOnStatusChange((state) => {
    const el = document.getElementById('audio-status');
    if (!el) return;
    el.className = 'audio-status audio-' + state;
    el.title = 'Audio: ' + state;

    // Send pending snapshot when synth becomes ready
    if (state === 'ready' && pendingSnapshot) {
        sendVoiceSnapshot(pendingSnapshot);
        pendingSnapshot = null;
    }
    // Effect state lives only in the engine, so a worklet that has just
    // come up knows nothing about the open project's rack.
    if (state === 'ready') pushFx();
});

/**
 * Push the open project's effects to the engine. Cheap to call often —
 * sendFxSnapshot only sends what changed — which is why it hangs off every
 * `tracks` update rather than off each individual edit.
 */
// Not `projectSession` directly: setOnStatusChange calls back synchronously,
// before the const below it has been initialised, and touching it there is a
// TDZ ReferenceError rather than an undefined.
let fxSession = null;

function pushFx() {
    const project = fxSession && fxSession.get();
    if (!project) return;
    sendFxSnapshot(project.tracks, project.fx);
}

// --- MIDI status indicator ---

// The menu and the footer dot only exist where Web MIDI does. Safari and every
// iOS browser have none, so hide the UI rather than offering dead controls.
function updateMidiStatus(state) {
    const el = document.getElementById('midi-status');
    if (!el) return;
    if (state === 'unsupported') {
        el.style.display = 'none';
        return;
    }
    el.style.display = '';
    el.className = 'audio-status midi-status midi-' + state;
    el.title = 'MIDI: ' + state;
}

function initMidiUi() {
    const menuItem = document.getElementById('menu-item-midi');
    if (!midiManager.isSupported()) {
        if (menuItem) menuItem.style.display = 'none';
        updateMidiStatus('unsupported');
        return;
    }
    midiManager.setOnStatusChange(updateMidiStatus);

    // Someone who enabled MIDI before gets it back without opening the
    // settings again — including the SysEx tier when auditioning is on.
    midiManager.resumeIfEnabled().then((ok) => {
        if (!ok) return;
        const out = midiManager.getOutputPort();
        appendLog('MIDI restored' + (midiManager.hasSysex() ? ' (with SysEx)' : '')
            + (out ? ' — ' + out.name : ''));
    });

    // A page teardown or a backgrounded tab must not leave notes ringing on
    // hardware — the user has no way to silence it from here afterwards.
    window.addEventListener('pagehide', () => midiManager.panic());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') midiManager.panic();
    });
}

// --- The project store ---
//
// Stood up here, at the top, because it owns the autosave timer and the
// save indicator: both have to be live from the first paint, not from
// whenever an editor happens to be built.
//
// `canSave` is the "not while the transport is busy" rule. The cost being
// dodged is the synchronous clone of the project body — measured at
// 1.6 ms small, 4.3 ms for a large one — which would not drop audio (that
// has its own thread) but would delay the main thread's handling of a tick
// message, i.e. jitter the note scheduling. The transport is reached
// lazily through the dock, because the dock is built after this.
const projectStore = createProjectStore({
    canSave: () => !transportIsBusy(),
});
const projectSession = createProjectSession(projectStore);
fxSession = projectSession;

function transportIsBusy() {
    const roll = pianoDockWrapper && pianoDockWrapper._pianoroll;
    const transport = roll && roll.getTransport && roll.getTransport();
    return !!(transport && transport.isRunning && transport.isRunning());
}

/**
 * A finished take is exactly when the user expects their work written, and
 * it is also the moment `canSave` stops refusing — so rather than wait up
 * to another thirty seconds for the next tick, force it.
 */
function flushProjectAfterTake() {
    return projectStore.flush({ force: true });
}

// --- Emergency stop ---

// Silences everything and resets the engine to a fresh SynthUnit. Channel
// volumes survive the reset (static in WASM); loaded patches don't, so the
// VoiceBank snapshot is re-sent once the fresh engine is up.
function doEmergencyStop() {
    emergencyStop();
    midiManager.panic();
    if (pianoDockWrapper && pianoDockWrapper._pianoroll && pianoDockWrapper._pianoroll.stopPlayback) {
        pianoDockWrapper._pianoroll.stopPlayback();
    }
    setTimeout(() => {
        if (pianoDockWrapper && pianoDockWrapper._voiceBank) {
            const entries = pianoDockWrapper._voiceBank._getEntries();
            if (entries.length > 0) sendVoiceSnapshot(entries);
        }
        // reset_engine keeps the fx parameters, but emergencyStop drops the
        // main thread's cache so this re-pushes the rack in full.
        pushFx();
        appendLog('Emergency stop: MSFA engine reset, voices reloaded');
    }, 100);
}

// --- Playback ---

function noteToFreq(note, octave) {
    return 440 * Math.pow(2, (note + (octave - 4) * 12 - 9) / 12);
}

// Wrap a stop function in its own safety timeout, so held notes still die if
// the caller never releases them, and so an explicit release cancels the
// timer instead of leaving it to fire against a reused note.
function withTimeout(stop, durMs) {
    if (!stop) return null;
    let done = false;
    const timer = setTimeout(() => { done = true; stop(); }, durMs);
    return () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stop();
    };
}

// Combine the internal and MIDI stop functions into one, skipping nulls.
function joinStops(...stops) {
    const live = stops.filter(Boolean);
    if (live.length === 0) return null;
    if (live.length === 1) return live[0];
    return () => { for (const s of live) s(); };
}

/**
 * Play a note. Resolves to a stop function (or null) — the keyboard relies on
 * this to release a held key; returning undefined used to leave every key
 * falling back to a blind note-off on the active channel.
 */
async function playNote(midi, voiceData, durationMs, channel, noteOpts = {}) {
    const dur = Math.round(durationMs || 0);
    const durMs = dur > 0 ? dur : 600;

    // --- External MIDI fan-out. Slot-addressed notes only: a patch preview
    // has nothing loaded on the device to sound with (that arrives with the
    // Phase 4 SysEx path), so previews stay internal whatever the mode.
    let midiStop = null;
    if (channel != null && midiManager.isMidiOutEnabled()) {
        midiStop = midiManager.playNoteOut(channel, midi, noteOpts.velocity || 100, durMs, {
            // Held keys carry a 30 s safety duration rather than a real one;
            // scheduling a note-off that far out would leave a landmine for
            // whatever reuses the pitch next.
            schedule: !noteOpts.sustained,
        });
    }

    // Pianoroll path: channel provided → play on that channel in worklet
    if (channel != null) {
        if (!midiManager.isInternalEnabled()) return midiStop;
        try {
            await acquire();
            if (isReady()) {
                return joinStops(midiStop, withTimeout(playNoteOnChannel(channel, midi), durMs));
            }
        } catch (err) {
            console.warn('DX7 synth unavailable:', err);
        }
    }

    // Preview path: offline render + sample injection (no channel needed)
    if (voiceData) {
        // Live audition: load the patch into the device's edit buffer and
        // sound it there too. Additive — the local synth still plays, so the
        // preview never goes silent if the device is slow or misconfigured.
        const auditionStop = midiManager.isAuditionEnabled()
            ? midiManager.auditionNote(voiceData, midi, 100, durMs)
            : null;
        try {
            await acquire();
            if (isReady()) {
                return joinStops(auditionStop,
                    withTimeout(playNoteRealtime(voiceData, midi), durMs * 0.6));
            }
        } catch (err) {
            console.warn('DX7 synth unavailable, falling back:', err);
        }

        try {
            const body = { voice_data: voiceData, note: midi };
            body.duration_ms = durMs;
            const resp = await fetch(baseUrl + '/api/play', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!resp.ok) throw new Error('Server returned ' + resp.status);
            const data = await resp.json();
            if (data.wav_url) {
                const audio = new Audio(baseUrl + data.wav_url);
                audio.play();
                return () => { audio.pause(); };
            }
        } catch (err) {
            showError('Playback failed: ' + err.message);
        }
    }

    // Fallback: sine oscillator (needs AudioContext)
    try {
        const ctx = await acquire();
        const freq = 440 * Math.pow(2, (midi - 69) / 12);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.6);
        return () => { try { osc.stop(); } catch {} };
    } catch {}
    return null;
}

async function playPatch(patch, midi) {
    const note = midi || patch.midi_note || activeKeyboardNote || 60;
    if (patch.voice_data) {
        // Live audition on external hardware, alongside the local preview.
        if (midiManager.isAuditionEnabled()) {
            midiManager.auditionNote(patch.voice_data, note, 100, 10000);
        }
        try {
            await acquire();
            if (isReady()) {
                // Audible preview: realtime note on the dedicated channel 15
                const stop = playNoteRealtime(patch.voice_data, note);
                if (stop) setTimeout(stop, 10000);
                // Offline render only feeds the waveform drawing
                const blob = await renderOffline(patch.voice_data, note, 10000);
                return URL.createObjectURL(blob); // canvas draws waveform
            }
        } catch (err) {
            showError('Synth preview failed: ' + err.message);
        }
        try {
            const resp = await fetch(baseUrl + '/api/play', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ voice_data: patch.voice_data, note })
            });
            if (!resp.ok) throw new Error('Server returned ' + resp.status);
            const data = await resp.json();
            if (data.wav_url) {
                new Audio(baseUrl + data.wav_url).play();
                return baseUrl + data.wav_url;
            }
        } catch (err) {
            showError('Playback failed: ' + err.message);
        }
    }
    return null;
}

// --- Log ---

function appendLog(message) {
    const log = document.getElementById('log');
    if (!log) return;
    const timestamp = new Date().toLocaleTimeString();
    log.value += `[${timestamp}] ${message}\n`;
    log.scrollTop = log.scrollHeight;
    const label = document.getElementById('progress-label');
    if (label) {
        const short = message.replace(/^\[.*?\]\s*/, '').substring(0, 80);
        label.textContent = short;
    }
}

// --- Progress bar ---

function showProgress(pct) {
    const wrapper = document.getElementById('progress-modal');
    if (wrapper) wrapper.style.display = '';
    const fill = document.getElementById('progress-fill');
    if (fill) fill.style.width = pct + '%';
    if (pct === 0) {
        const label = document.getElementById('progress-label');
        if (label) label.textContent = '';
    }
}

function hideProgress() {
    const wrapper = document.getElementById('progress-modal');
    if (wrapper) wrapper.style.display = 'none';
}

function setProgressLabel(text) {
    const label = document.getElementById('progress-label');
    if (label) label.textContent = text;
}

// --- Error modal ---

function showError(message) {
    let overlay = document.getElementById('error-modal');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'error-modal';
        overlay.className = 'modal-overlay';
        overlay.style.zIndex = '600';
        overlay.innerHTML =
            '<div class="modal-dialog">' +
            '<div class="modal-header"><h3>Error</h3><button class="modal-close" id="error-close">×</button></div>' +
            '<div class="modal-body"><p id="error-message"></p></div>' +
            '</div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) overlay.style.display = 'none';
        });
        overlay.querySelector('#error-close').addEventListener('click', () => {
            overlay.style.display = 'none';
        });
    }
    document.getElementById('error-message').textContent = message;
    overlay.style.display = '';
}

window._showError = showError;

// --- Tuning fork ---

async function toggleFork(btn, noteSel, octSel) {
    if (forkOsc) {
        forkOsc.stop();
        forkOsc = null;
        forkGain = null;
        toggleFork._osc = null;
        btn.classList.remove('active');
        return;
    }
    try {
        const ctx = await acquire();
        const freq = noteToFreq(parseInt(noteSel.value), parseInt(octSel.value));
        forkOsc = ctx.createOscillator();
        forkGain = ctx.createGain();
        forkOsc.type = 'sine';
        forkOsc.frequency.value = freq;
        forkGain.gain.setValueAtTime(0.25, ctx.currentTime);
        forkOsc.connect(forkGain);
        forkGain.connect(ctx.destination);
        forkOsc.start();
        toggleFork._osc = forkOsc;
        btn.classList.add('active');
    } catch {}
}

// --- Shared opts for Job methods ---

const jobOpts = {
    baseUrl,
    appendLog,
    showProgress,
    hideProgress,
    dbPut,
    dbGet,
    jobManager,
    toggleFork,
    noteToFreq,
};

// Initialize jobManager with opts
jobManager.setOpts(jobOpts);

// --- File input handler ---

fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    if (file.name.toLowerCase().endsWith('.' + FILE_EXTENSION)) {
        fileInput.value = '';
        await importProjectFile(file);
        return;
    }

    if (file.name.toLowerCase().endsWith('.syx')) {
        appendLog(`Routing .syx file: ${file.name} (${file.size} bytes)`);
        handleSyxUpload(file);
        fileInput.value = '';
        return;
    }

    // WAV import — Job drives the lifecycle.
    // Clear the input first: re-picking the same file otherwise fires no
    // change event, so the second import silently does nothing.
    fileInput.value = '';
    const job = Job.create({ fileName: file.name });
    await job.probe(file, jobOpts);
    refreshCanvas();
});

// --- SYX upload (simple, no Job lifecycle needed) ---

async function handleSyxUpload(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        importSyxBank(arrayBuffer, file.name.replace(/\.[^.]+$/, ''), file.name);
    } catch (err) {
        appendLog(`Error reading .syx file: ${err.message}`);
    }
}

/**
 * Turn a raw 4104-byte DX7 bank into patches + a canvas container.
 * Shared by the .syx file import and the MIDI bank backup, which both end up
 * holding exactly the same bytes.
 * @returns {object} the created container
 * @throws if the buffer is not a parseable DX7 bank
 */
function importSyxBank(arrayBuffer, name, sourceLabel) {
    const patches = parseSyxFile(arrayBuffer);
    if (!patches || patches.length === 0) {
        throw new Error(`Not a readable DX7 bank: ${sourceLabel}`);
    }

    appendLog(`Parsed .syx: ${name} (${patches.length} voices)`);
    if (patches.checksumOk === false) {
        appendLog(`Warning: ${name} has a bad checksum — imported anyway, voices may be corrupt`);
    }

    const created = [];
    for (let i = 0; i < patches.length; i++) {
        const p = patches[i];
        // Skip INIT VOICE (empty/blank patches)
        if (p.name === 'INIT VOICE' || p.name.trim() === '') continue;
        if (!p.voice_data && p.raw) {
            p.voice_data = voiceRawToBase64(p.raw);
        }
        const patch = createPatch({
            name: p.name,
            algorithm: p.algorithm,
            feedback: p.feedback,
            voice_data: p.voice_data || null,
            source: 'syx',
        });
        patchStore.put(patch);
        created.push(patch);
    }

    const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    jobStore.put({
        id: jobId,
        type: 'syx_import',
        status: 'completed',
        fileName: sourceLabel,
        containerId: null,
    });

    const ctr = addContainer(name, { jobId, patchIds: created.map(p => p.id) });
    const updatedCtr = canvasStore.getContainer(ctr.id);
    if (updatedCtr) {
        updatedCtr.patchIds = created.map(p => p.id);
        canvasStore.putContainer(updatedCtr);
    }

    initCanvas(getCanvasOpts());
    return ctr;
}

// --- Canvas opts ---

function getCanvasOpts() {
    return {
        onPlay: (patch) => {
            // Auditioning must not touch the voice bank — assignment goes
            // through onSelect (the ♫ button) and nothing else.
            if (patch.voice_data) activeSyxVoiceData = patch.voice_data;
            return playPatch(patch);
        },
        onSelect: (patch) => {
            if (patch.voice_data) {
                activeSyxVoiceData = patch.voice_data;
                if (pianoDockWrapper && pianoDockWrapper._voiceBank) {
                    pianoDockWrapper._voiceBank._addEntry(patch.name || 'Untitled', patch.voice_data, patch.name);
                }
                const isMobile = window.matchMedia('(max-width: 600px)').matches;
                if (isMobile && pianoDockWrapper && pianoDockWrapper._showPianoroll) {
                    pianoDockWrapper._showPianoroll();
                } else if (pianoDockWrapper) {
                    pianoDockWrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
        },
        // The ♫ popover's commit: load the voice into the chosen slot and
        // bring the roll into view, same as onSelect used to.
        onAssignSlot: (patch, slot) => {
            if (!patch.voice_data || !pianoDockWrapper || !pianoDockWrapper._voiceBank) return;
            activeSyxVoiceData = patch.voice_data;
            pianoDockWrapper._voiceBank._assignToSlot(slot, {
                name: patch.name || 'Untitled',
                voiceData: patch.voice_data,
                patchId: patch.name,
            });
            const isMobile = window.matchMedia('(max-width: 600px)').matches;
            if (isMobile && pianoDockWrapper._showPianoroll) {
                pianoDockWrapper._showPianoroll();
            } else {
                pianoDockWrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        },
        getBankEntries: () => {
            if (!pianoDockWrapper || !pianoDockWrapper._voiceBank) return [];
            return pianoDockWrapper._voiceBank._getEntries();
        },
        onAssignToPianoroll: (patches) => {
            if (!pianoDockWrapper || !pianoDockWrapper._voiceBank) return;
            for (const patch of patches) {
                if (patch.voice_data) {
                    pianoDockWrapper._voiceBank._addEntry(patch.name || 'Untitled', patch.voice_data, patch.name);
                }
            }
            const isMobile = window.matchMedia('(max-width: 600px)').matches;
            if (isMobile && pianoDockWrapper && pianoDockWrapper._showPianoroll) {
                pianoDockWrapper._showPianoroll();
            } else {
                pianoDockWrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        },
        onEdit: (patch) => {
            openEdit(patch);
            if (pianoDockWrapper && pianoDockWrapper._showEdit) pianoDockWrapper._showEdit();
        },
        onPlayOriginal: (jobId) => {
            const job = jobStore.get(jobId);
            if (job && job.id) {
                dbGet(job.id).then(arrayBuffer => {
                    if (arrayBuffer) {
                        const blob = new Blob([arrayBuffer]);
                        const url = URL.createObjectURL(blob);
                        const audio = new Audio(url);
                        const revoke = () => URL.revokeObjectURL(url);
                        audio.addEventListener('ended', revoke, { once: true });
                        audio.addEventListener('error', revoke, { once: true });
                        audio.play().catch(revoke);
                    }
                });
            }
        },
        renderJobBody: (jobData, bodyEl) => {
            const job = Job.restore(jobData);
            job.renderBody(bodyEl, jobOpts);
        },
        // Called back with null when the blob is absent, so the container
        // can offer to re-upload it.
        onLoadJobWav: (jobId, callback) => {
            dbGet(jobId).then(arrayBuffer => {
                callback(arrayBuffer || null);
            }).catch(() => callback(null));
        },
        // The source WAV supplied again (an imported project's did not
        // travel with it). A different file name is allowed, but said.
        onReuploadJobWav: async (jobId, file) => {
            const job = jobStore.get(jobId);
            if (!job) return;
            if (!/\.wav$/i.test(file.name)) { appendLog(`[wav] ${file.name} is not a WAV file`); return; }
            const bytes = await file.arrayBuffer();
            await dbPut(jobId, bytes);
            if (job.fileName && job.fileName !== file.name) {
                appendLog(`[wav] ${file.name} supplied for ${job.fileName}`);
            }
            jobStore.put({ ...job, sourceMissing: false, fileName: job.fileName || file.name });
            refreshCanvas();
        },
        onSortContainer: (ctr) => {
            const sorted = (ctr.patchIds || [])
                .map(id => patchStore.get(id))
                .filter(Boolean)
                .sort((a, b) => (a.algorithm - b.algorithm) || (a.feedback - b.feedback));
            ctr.patchIds = sorted.map(p => p.id);
            canvasStore.putContainer(ctr);
            refreshCanvas();
        },
        // Built here, not fetched. syx-builder.js already produces these
        // bytes — it is what sendBankToDevice writes to the hardware — so
        // posting the patches to /api/export-syx and downloading the URL
        // that came back was a round trip to make something we were
        // holding. It also meant the export silently needed the optional
        // inference server to be up.
        onExportContainer: (patches, name) => {
            const safeName = safeFilename(name, { fallback: 'patches', strip: 'syx' });
            if (patches.length === 0) {
                appendLog('No patches with voice data to export');
                return;
            }
            try {
                const bytes = buildBulkDump(patches, { channel: midiManager.getDeviceChannel() });
                if (!downloadBytes(safeName + '.syx', bytes)) {
                    appendLog('This browser cannot download files');
                    return;
                }
                // A bulk dump is always 32 voices; the rest are INIT.
                appendLog(`Exported ${patches.length} patches as ${safeName}.syx`
                    + (patches.length < VOICE_COUNT ? ` (${VOICE_COUNT - patches.length} INIT)` : ''));
            } catch (e) {
                appendLog('Export failed: ' + e.message);
            }
        },
        onSendContainerToDevice: async (patches, name) => {
            if (patches.length === 0) {
                appendLog('No patches with voice data to send');
                return;
            }
            await sendBankToDevice(patches, name || 'bank', {
                appendLog,
                showProgress,
                hideProgress,
                setProgressLabel,
                showError,
                onBackupReceived: (bytes, backupName) => {
                    // Same bytes a .syx file would carry, so the import path is
                    // reused. Copy rather than handing over .buffer: a view with
                    // a non-zero byteOffset would make every patch offset wrong.
                    const buf = bytes.buffer.slice(
                        bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                    importSyxBank(buf, backupName, backupName);
                },
            });
        },
        baseUrl,
    };
}

// --- Toolbar ---

function initToolbar() {
    const pianoDock = document.getElementById('piano-dock');
    pianoDock.innerHTML = '';

    const isMobile = window.matchMedia('(max-width: 600px)').matches;
    const playFn = (midi, durationMs, voiceData, channel, noteOpts) =>
        playNote(midi, voiceData || activeSyxVoiceData, durationMs, channel, noteOpts);
    const stopNoteFn = (midi, channel) => {
        if (midiManager.isMidiOutEnabled()) midiManager.stopNoteOut(channel, midi);
        if (isReady()) playNoteOnChannel(channel, midi, 0);
    };
    // Stop must silence both engines. The internal release was missing
    // entirely — the piano roll's Stop button left its notes ringing.
    const onPlaybackStop = () => {
        releaseAllNotes();
        midiManager.releaseAllOut();
        // The transport has just gone idle, which is both when the user
        // expects a finished take written and the moment `canSave` stops
        // refusing. Forcing it here beats waiting out the next tick.
        flushProjectAfterTake();
    };

    const dock = createToolbar({
        session: projectSession,
        matchedMidi: activeKeyboardNote,
        appendLog,
        playNoteFn: playFn,
        stopNoteFn: stopNoteFn,
        initialTab: isMobile ? 'canvas' : 'pianoroll',
        tickWorker: tickWorker,
        startWorker: startTickWorker,
        stopWorker: stopTickWorker,
        tempoWorker: setTickWorkerTempo,
        onNoteClick: (midi) => { activeKeyboardNote = midi; },
        onPlaybackStop,
        onEmergencyStop: doEmergencyStop,
        onSnapshot: (entries) => {
            // Every patch row showing one of these voices wears its slot.
            updateBankSlots(entries);
            if (isReady()) {
                sendVoiceSnapshot(entries);
            } else {
                pendingSnapshot = entries;
            }
        },
        onVolumeChange: (channel, volume) => {
            setChannelVolume(channel, volume);
        },
        editOpts: {
            baseUrl,
            showProgress,
            hideProgress,
            onPatchCreated: (patch) => {
                addContainer(patch.name, { patchIds: [patch.id], isNew: true });
                initCanvas(getCanvasOpts());
                // Show the new patch where it landed. This used to collapse
                // the dock to uncover the night sky; the sky is a tab now.
                if (pianoDockWrapper && pianoDockWrapper._showCanvas) pianoDockWrapper._showCanvas();
            },
        },
    });
    pianoDock.appendChild(dock);
    pianoDockWrapper = dock;

    // Read-only handle for the e2e suite (e2e/). The wrapper — and through it
    // the transport and the roll — is otherwise unreachable from outside the
    // module graph, and real clock timing is exactly what test/harness.js
    // cannot check: the stub has no worker. Nothing in the app reads this.
    window.__opDock = dock;

    // The night sky is the Patches tab's panel at every size now — it used
    // to be a permanent half of the desktop page, above the dock.
    const sky = document.getElementById('night-sky');
    const canvasPanel = dock.querySelector('.dock-panel-canvas');
    if (sky && canvasPanel) canvasPanel.appendChild(sky);

    // Register pianoroll stop for audio-manager shutdown
    if (dock._pianoroll && dock._pianoroll.stopPlayback) {
        setPianorollStop(dock._pianoroll.stopPlayback);
    }
}

// --- Restore on load ---

const DEMO_OFFERED_KEY = 'openpatches_demo_offered';

async function loadDemoSyx(forceConfirm = false) {
    if (!forceConfirm) {
        // Auto-offer mode: skip if already offered or if there's existing data
        if (localStorage.getItem(DEMO_OFFERED_KEY)) return;
        const hasPatches = localStorage.getItem('openpatches_patches');
        const hasCanvas = localStorage.getItem('openpatches_canvas');
        if (hasPatches || hasCanvas) return;

        if (!confirm('Load demo patches? This will add 32 DX7 voices to get started.')) {
            localStorage.setItem(DEMO_OFFERED_KEY, '1');
            return;
        }
    }

    try {
        const resp = await fetch('html/DEMO.syx');
        const arrayBuffer = await resp.arrayBuffer();
        const patches = parseSyxFile(arrayBuffer);
        if (!patches || patches.length === 0) {
            appendLog('Failed to parse DEMO.syx');
            return;
        }

        const created = [];
        for (const p of patches) {
            if (p.name === 'INIT VOICE' || p.name.trim() === '') continue;
            if (!p.voice_data && p.raw) p.voice_data = voiceRawToBase64(p.raw);
            const patch = createPatch({
                name: p.name,
                algorithm: p.algorithm,
                feedback: p.feedback,
                voice_data: p.voice_data || null,
                source: 'demo',
            });
            patchStore.put(patch);
            created.push(patch);
        }

        if (created.length > 0) {
            const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
            jobStore.put({ id: jobId, type: 'demo_import', status: 'completed', fileName: 'DEMO.syx', containerId: null });
            const ctr = addContainer('DEMO', { jobId, patchIds: created.map(p => p.id) });
            const updatedCtr = canvasStore.getContainer(ctr.id);
            if (updatedCtr) { updatedCtr.patchIds = created.map(p => p.id); canvasStore.putContainer(updatedCtr); }
            initCanvas(getCanvasOpts());
            appendLog(`Loaded DEMO.syx: ${created.length} voices`);
            localStorage.setItem(DEMO_OFFERED_KEY, '1');
        }
    } catch (err) {
        appendLog('Failed to load demo: ' + err.message);
    }
}

async function restore() {
    initCanvas(getCanvasOpts());

    // Offer demo data if no existing data
    await loadDemoSyx(false);

    // Restore jobs: resume polling, handle completed/failed
    const jobs = jobStore.getAll();
    const activeJobs = [];

    for (const jobData of jobs) {
        if (!jobData.containerId) continue;
        const job = Job.restore(jobData);

        if (job.isCompleted && job.resultData) {
            const ctr = canvasStore.getContainer(job.containerId);
            if (ctr && (!ctr.patchIds || ctr.patchIds.length === 0)) {
                job.complete(jobOpts);
            }
        } else if (job.isPolling && job.statusUrl) {
            activeJobs.push(job);
        }
    }

    if (activeJobs.length > 0) {
        appendLog(`[restore] Resuming ${activeJobs.length} in-progress job(s)`);
        for (const job of activeJobs) {
            jobManager.start(job);
        }
    }

    refreshCanvas();

    // Start tutorial after DOM settles
    initTutorial();
    setTimeout(() => startTutorial(), 600);
}

// --- Menu bar ---

const hamburger = document.getElementById('hamburger');
const menuBar = document.getElementById('menu-bar');

if (hamburger) {
    hamburger.addEventListener('click', (e) => {
        e.stopPropagation();
        menuBar.classList.toggle('menu-open');
    });
}

document.querySelectorAll('.menu-item').forEach(item => {
    item.querySelector('.menu-label').addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = item.classList.contains('open');
        document.querySelectorAll('.menu-item.open').forEach(i => i.classList.remove('open'));
        if (!wasOpen) item.classList.add('open');
    });
});
document.addEventListener('click', () => {
    // Don't close menus while tutorial is active (it opens them programmatically)
    if (isTutorialActive()) return;
    document.querySelectorAll('.menu-item.open').forEach(i => i.classList.remove('open'));
    if (menuBar) menuBar.classList.remove('menu-open');
});

document.querySelectorAll('.menu-dropdown button').forEach(btn => {
    btn.addEventListener('click', () => {
        if (menuBar) menuBar.classList.remove('menu-open');
    });
});

// --- Project menu ---
//
// A project is the whole workspace, so switching one rebuilds the canvas
// (its patches came with it) and lets the dock re-read the session.
function afterProjectChange() {
    renderProjectName();
    initCanvas(getCanvasOpts());
}

function renderProjectName() {
    const el = document.getElementById('menu-status');
    if (!el) return;
    const project = projectSession.get();
    el.textContent = project ? project.name : '';
    el.title = project ? `Project “${project.name}” — click to rename` : '';
}

function renameCurrentProject() {
    const project = projectSession.get();
    if (!project) return;
    const wanted = prompt('Project name', project.name);
    if (wanted == null) return;
    projectSession.rename(wanted, 'menu');
    renderProjectName();
    appendLog(`Renamed project to ${projectSession.get().name}`);
}

document.getElementById('menu-new-project').addEventListener('click', () => {
    const project = projectSession.createNew('Untitled project', 'menu');
    appendLog(`New project: ${project.name}`);
    afterProjectChange();
});
document.getElementById('menu-projects').addEventListener('click', () => {
    openProjectsDialog({ session: projectSession, appendLog, onChange: afterProjectChange });
});
document.getElementById('menu-rename-project').addEventListener('click', renameCurrentProject);

// --- Export / import a project ---
//
// One JSON file, built and parsed in the page. See project-io.js for what
// travels and what deliberately does not.

document.getElementById('menu-export-project').addEventListener('click', async () => {
    const project = projectSession.get();
    if (!project) return;
    // Flush first so the file and the stored body agree — exporting a
    // project whose last edits are still pending would be a quiet way to
    // hand someone a stale copy of their own work.
    await projectSession.flush();
    try {
        const doc = exportProject(project);
        const name = safeFilename(project.name, { fallback: 'project', strip: FILE_EXTENSION });
        if (!downloadJson(`${name}.${FILE_EXTENSION}`, doc)) {
            appendLog('This browser cannot download files');
            return;
        }
        appendLog(`Exported project ${project.name}`);
    } catch (e) {
        appendLog('Export failed: ' + e.message);
    }
});

document.getElementById('menu-import-project').addEventListener('click', () => {
    importInto = false;      // a cancelled Import into… must not turn this into a merge
    fileInput.accept = '.' + FILE_EXTENSION;
    fileInput.click();
});

// --- Import into This Project… : pick patches and patterns from a file ---
let importInto = false;     // the shared file input: is this pick an import-into?
document.getElementById('menu-import-into').addEventListener('click', () => {
    importInto = true;
    fileInput.accept = '.' + FILE_EXTENSION;
    fileInput.click();
});

async function importIntoCurrent(file) {
    let source;
    try {
        source = parseProjectFile(await file.text());
    } catch (e) {
        showError(e instanceof ImportError ? e.message : 'Could not read that project: ' + e.message);
        return;
    }
    const target = projectSession.get();
    if (!target) return;
    const c = importCandidates(source, target);
    if (c.patches.length === 0 && c.patterns.length === 0) {
        showError(`"${source.name}" has no patches or patterns to import.`);
        return;
    }
    openModal(`Import from "${source.name}"`, (body, close) => {
        body.classList.add('import-into-dialog');
        body.appendChild(el('p', 'import-into-note',
            'Choose what joins this project. Patches already here are skipped; patterns come in as new, '
            + 'unplaced patterns (find them in the pattern library). Tracks and sections stay in the file.'));
        const boxes = { patch: [], pattern: [] };
        const group = (title, items, kind, label) => {
            if (items.length === 0) return;
            const fs = el('fieldset', 'import-into-group');
            const legend = el('legend');
            const all = el('input'); all.type = 'checkbox'; all.checked = true; all.className = 'import-into-all';
            legend.appendChild(all);
            legend.appendChild(document.createTextNode(` ${title} (${items.length})`));
            fs.appendChild(legend);
            const list = el('div', 'import-into-list');
            for (const it of items) {
                const row = el('label', 'import-into-item' + (it.present ? ' present' : ''));
                const cb = el('input'); cb.type = 'checkbox'; cb.value = it.id;
                cb.checked = !it.present; cb.disabled = !!it.present;
                cb.dataset.kind = kind;
                row.appendChild(cb);
                row.appendChild(document.createTextNode(' ' + label(it)));
                list.appendChild(row);
                if (!it.present) boxes[kind].push(cb);
            }
            all.addEventListener('change', () => { for (const cb of boxes[kind]) cb.checked = all.checked; sync(); });
            fs.appendChild(list);
            body.appendChild(fs);
        };
        group('Patches', c.patches, 'patch', (p) => p.name + (p.present ? ' — already here' : ''));
        group('Patterns', c.patterns, 'pattern', (p) => `${p.name} — ${p.measures} bar${p.measures > 1 ? 's' : ''}, ${p.notes} note${p.notes === 1 ? '' : 's'}`);
        const go = el('button', 'import-into-go');
        const sync = () => {
            const n = boxes.patch.filter(b => b.checked).length + boxes.pattern.filter(b => b.checked).length;
            go.textContent = n ? `Import ${n}` : 'Nothing chosen';
            go.disabled = n === 0;
        };
        for (const cb of [...boxes.patch, ...boxes.pattern]) cb.addEventListener('change', sync);
        sync();
        go.addEventListener('click', () => {
            const plan = planImport(source, target, {
                patchIds: boxes.patch.filter(b => b.checked).map(b => b.value),
                patternIds: boxes.pattern.filter(b => b.checked).map(b => b.value),
            });
            if (plan.patches.length) {
                patchStore.bulkPut(plan.patches);
                if (Object.keys(plan.patchNames).length) {
                    savePatchNames({ ...loadPatchNames(), ...plan.patchNames });
                }
                // On the canvas, together, so they can be found.
                addContainer(`From ${source.name}`, { patchIds: plan.patches.map(p => p.id) });
                refreshCanvas();
            }
            for (const p of plan.patterns) projectSession.createPattern(p, 'import-into');
            appendLog(`Imported ${plan.patches.length} patch(es) and ${plan.patterns.length} pattern(s) from ${source.name}`);
            close();
        });
        body.appendChild(go);
    });
}

async function importProjectFile(file) {
    if (importInto) { importInto = false; return importIntoCurrent(file); }
    let body;
    try {
        body = parseProjectFile(await file.text());
    } catch (e) {
        // ImportError messages are written for the user; anything else is
        // a surprise and says so.
        showError(e instanceof ImportError ? e.message : 'Could not read that project: ' + e.message);
        return;
    }
    // Always a new project: a fresh id and a free name, so importing the
    // same file twice gives two and the one on disk is never overwritten.
    const project = projectSession.createFrom(body, 'import');
    afterProjectChange();
    appendLog(`Imported project ${project.name}`);
}
document.getElementById('menu-status').addEventListener('click', renameCurrentProject);

// --- Storage… : a report, and an on-demand sweep of unreferenced WAVs ---
// Nothing here runs on its own; see storage-gc.js for what counts as unused.
document.getElementById('menu-storage').addEventListener('click', openStorageDialog);

async function storageReport() {
    await projectSession.flush();
    const ids = await projectStore.listIds();
    const bodies = [];
    for (const id of ids) {
        try { bodies.push(await projectStore.read(id)); } catch { /* unreadable: leave it out */ }
    }
    const uploads = await dbListUploads().catch(() => []);
    return planStorage(bodies, uploads);
}

function openStorageDialog() {
    openModal('Storage', (body) => {
        body.classList.add('storage-dialog');
        const status = el('p', 'storage-status', 'Measuring…');
        body.appendChild(status);
        const fill = async () => {
            const r = await storageReport();
            body.innerHTML = '';
            const table = el('table', 'storage-table');
            const row = (a, b, cls) => {
                const tr = el('tr', cls);
                tr.appendChild(el('td', null, a));
                tr.appendChild(el('td', 'storage-bytes', b));
                table.appendChild(tr);
            };
            for (const p of r.projects) row(p.name, formatBytes(p.bytes));
            row(`Projects (${r.projects.length})`, formatBytes(r.projectBytes), 'storage-total');
            row(`WAV uploads (${r.uploads.count})`, formatBytes(r.uploads.bytes), 'storage-total');
            body.appendChild(table);
            const note = el('p', 'storage-note');
            if (r.orphans.length === 0) {
                note.textContent = 'Every stored WAV belongs to a job in some project. Nothing to clean up.';
                body.appendChild(note);
                return;
            }
            note.textContent = `${r.orphans.length} WAV upload${r.orphans.length > 1 ? 's' : ''} (${formatBytes(r.orphanBytes)}) `
                + 'belong to no job in any project — left behind by deleted containers or projects.';
            body.appendChild(note);
            const btn = el('button', 'storage-sweep', `Delete ${r.orphans.length} unused WAV${r.orphans.length > 1 ? 's' : ''}`);
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                for (const o of r.orphans) await dbDelete(o.key).catch(() => {});
                appendLog(`[storage] deleted ${r.orphans.length} unused WAV upload(s), ${formatBytes(r.orphanBytes)}`);
                fill();
            });
            body.appendChild(btn);
        };
        fill().catch((e) => { status.textContent = 'Could not measure storage: ' + e.message; });
    });
}

document.getElementById('menu-import-wav').addEventListener('click', () => {
    importInto = false;
    fileInput.accept = '.wav';
    fileInput.click();
});
document.getElementById('menu-import-syx').addEventListener('click', () => {
    importInto = false;
    fileInput.accept = '.syx';
    fileInput.click();
});
document.getElementById('menu-load-demo').addEventListener('click', () => {
    loadDemoSyx(true);
});
document.getElementById('menu-show-log').addEventListener('click', () => {
    if (pianoDockWrapper && pianoDockWrapper._showLog) pianoDockWrapper._showLog();
});
// Delete everything. The old "Clear History" removed five of twenty-odd
// localStorage keys — patterns, arrangements, patch renames and the tag
// vocabulary all survived a "clear all" — and it orphaned every imported
// WAV, because canvasStore.clear() dropped the container records without
// deleting the blobs they referenced, leaving them unreachable forever.
//
// Now the state is a profile plus project bodies plus the upload store, so
// this is three operations that cannot drift out of step with a growing
// list of keys. The WAVs go first: once the bodies are gone, nothing knows
// which blobs were ever referenced.
document.getElementById('menu-clear-delete-all').addEventListener('click', async () => {
    if (!confirm('Delete all projects, patches and uploads? This cannot be undone.')) return;
    jobManager.stopAll();
    try {
        await dbClearUploads();
    } catch (e) {
        console.warn('[wipe] could not clear the uploads:', e);
    }
    await projectStore.clear();
    profileStore.clear();
    await projectSession.init();
    afterProjectChange();
    appendLog('Everything deleted');
});
document.getElementById('menu-emergency-stop').addEventListener('click', doEmergencyStop);

// MIDI menu
// The latency-calibration tone: INIT VOICE on the preview channel, so it is
// a clean instant-attack sine whatever the voice bank holds. The same bytes
// go to the device when audition is on, so both sides play one sound.
const latencyTestVoice = makeInitVoice();
function playLatencyTestNote(midi, durMs) {
    if (!isReady()) return;
    const stop = playNoteRealtime(latencyTestVoice, midi);
    if (stop) setTimeout(stop, durMs);
}
document.getElementById('menu-midi-devices').addEventListener('click', () => {
    openMidiSettings({
        appendLog,
        onStatusChange: updateMidiStatus,
        prepareTestNote: acquire,
        playTestNote: playLatencyTestNote,
        testVoiceData: latencyTestVoice,
    });
});
document.getElementById('menu-midi-panic').addEventListener('click', () => {
    appendLog(midiManager.panic() ? 'MIDI panic sent' : 'MIDI panic: no output device selected');
});

// Help modals
document.getElementById('menu-help').addEventListener('click', () => {
    document.getElementById('help-modal').style.display = '';
});
document.getElementById('menu-about').addEventListener('click', () => {
    document.getElementById('about-modal').style.display = '';
});
document.getElementById('menu-credits').addEventListener('click', () => {
    document.getElementById('credits-modal').style.display = '';
});
document.getElementById('menu-legal').addEventListener('click', () => {
    document.getElementById('legal-modal').style.display = '';
});
document.getElementById('menu-donate').addEventListener('click', () => {
    document.getElementById('donate-modal').style.display = '';
});
document.getElementById('donate-btn-kofi').addEventListener('click', () => {
    window.open('https://ko-fi.com/kompadre', '_blank');
});
document.getElementById('menu-restart-tutorial').addEventListener('click', () => {
    document.querySelectorAll('.menu-item.open').forEach(i => i.classList.remove('open'));
    restartTutorial();
});

['credits', 'about', 'help', 'legal', 'donate'].forEach(id => {
    document.getElementById(id + '-close').addEventListener('click', () => {
        document.getElementById(id + '-modal').style.display = 'none';
    });
    document.getElementById(id + '-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
});

// --- Init ---

attachSaveIndicator({ session: projectSession });
// Read before init(): a marker says the *previous* page load could not
// even journal its unsaved work, and taking it reports it exactly once.
attachSaveWarning({ session: projectSession, lost: takeLostSaveMarker() });
// The e2e seam, as window.__opDock is for the dock.
window.__opProject = projectSession;

// The editors read the open project synchronously, so it has to be open
// before they are built — hence the top-level await. A store that cannot
// start (IndexedDB blocked in a locked-down profile) must not take the
// whole app with it: the session falls back to an in-memory project and
// everything works for the session, just without persistence.
// Patches, the canvas and the jobs live in the project body, so the store
// has to know which project before anything reads them.
bindProjectSession(projectSession);
try {
    await projectSession.init();
} catch (e) {
    console.warn('[project] could not open the project store:', e);
}

initToolbar();
initMidiUi();
restore();
renderProjectName();
// The name in the bar follows a rename made anywhere — the Projects
// dialog, or another editor.
projectSession.subscribe((ev) => { if (ev.kind === 'project') renderProjectName(); });
// The engine holds no effect state of its own that anyone reads back, so
// every change to the band — and every project opened — has to be pushed.
projectSession.subscribe((ev) => {
    if (ev.kind === 'tracks' || ev.kind === 'project') pushFx();
});
pushFx();

// --- Effects, until the Mixer grows controls (phase 3) ---
//
// A console handle, in the spirit of window.__opDock and window.__opProject.
// Phase 2 wires the model and the plumbing but draws nothing, and an effect
// you cannot switch on is an effect nobody can tell is broken.
//
//   __opFx.list()                    what is on, and every value
//   __opFx.on(0, 'delay')            switch delay on for slot 0
//   __opFx.off(0, 'delay')           ...and off again
//   __opFx.set(0, 'delayMix', 0.5)   one parameter
//   __opFx.global('reverbLevel', 0.8)
//   __opFx.duck(0)                   slot 0 is the boosted track
//
// Everything here goes through projectSession.update, so it persists and
// survives a reload exactly as the Mixer's controls will.
function fxTrack(slot) {
    const project = projectSession.get();
    const track = project && project.tracks.find(t => t.slot === slot);
    if (!track) throw new Error(`no track on slot ${slot}`);
    // Every load path runs normalizeProject, which gives each track a rack;
    // a track without one got here past createTrack, and that is a bug to
    // see rather than to paper over.
    if (!track.fx) throw new Error(`track on slot ${slot} has no fx record`);
    return track;
}

window.__opFx = {
    list() {
        const project = projectSession.get();
        if (!project) return null;
        return {
            global: { ...project.fx },
            tracks: project.tracks.map(t => ({ slot: t.slot, name: t.name, ...t.fx })),
        };
    },
    on(slot, effect) { return this._flag(slot, effect, true); },
    off(slot, effect) { return this._flag(slot, effect, false); },
    _flag(slot, effect, value) {
        if (!(effect in FX_ENABLE_FIELDS)) {
            throw new Error(`unknown effect "${effect}" — one of ${Object.keys(FX_ENABLE_FIELDS)}`);
        }
        projectSession.update(() => { fxTrack(slot).fx[effect] = value; }, 'fx', 'tracks');
        return this.list();
    },
    set(slot, field, value) {
        const param = FX_FIELDS[field];
        if (!param) throw new Error(`unknown parameter "${field}" — one of ${Object.keys(FX_FIELDS)}`);
        const r = FX_RANGES[param];
        projectSession.update(() => {
            fxTrack(slot).fx[field] = Math.max(r.min, Math.min(r.max, Number(value)));
        }, 'fx', 'tracks');
        return this.list();
    },
    global(field, value) {
        const param = FX_GLOBAL_FIELDS[field];
        if (!param) throw new Error(`unknown parameter "${field}" — one of ${Object.keys(FX_GLOBAL_FIELDS)}`);
        const r = FX_GLOBAL_RANGES[param];
        projectSession.update((p) => {
            p.fx[field] = Math.max(r.min, Math.min(r.max, Number(value)));
        }, 'fx', 'tracks');
        return this.list();
    },
    duck(slot) { return this.global('duckSource', slot == null ? -1 : slot); },
};
