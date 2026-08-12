// app.js — Orchestration only. All heavy logic lives in components/.
// Wires up file input, menu bar, canvas, toolbar, and import flows.

import { parseSyxFile, voiceRawToBase64 } from './components/syx-parser.js';
import { batchRenderWaveforms } from './synth/dx7-synth.js';
import { acquire, shutdownAll, extendIdle, playNoteRealtime, playNoteOnChannel, releaseAllNotes, sendVoiceSnapshot, playSamplesInWorklet, setChannelVolume, base64ToUint8Array, renderOffline, isReady, getState, setOnStatusChange, setPianorollStop } from './synth/audio-manager.js';
import { patchStore, canvasStore, jobStore, createPatch } from './components/patch-model.js';
import { initCanvas, addContainer, addPatchToContainer, refreshCanvas } from './components/canvas.js';
import { createToolbar } from './components/toolbar.js';
import { openEdit } from './components/edit-panel.js';
import { Job, jobManager } from './components/job.js';
import { initTutorial, startTutorial, restartTutorial, isTutorialActive } from './components/tutorial.js';

const fileInput = document.getElementById('wav-input');

const baseUrl = window.location.origin.indexOf("localhost") > -1 ? "http://localhost:8080" : window.location.origin;

let pianoDockWrapper = null;
let activeKeyboardNote = 60;
let activeSyxVoiceData = null;
let forkOsc = null;
let forkGain = null;

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
});

// --- Playback ---

function noteToFreq(note, octave) {
    return 440 * Math.pow(2, (note + (octave - 4) * 12 - 9) / 12);
}

async function playNote(midi, voiceData, durationMs, channel) {
    const dur = Math.round(durationMs || 0);
    const durMs = dur > 0 ? dur : 600;

    // Pianoroll path: channel provided → play on that channel in worklet
    if (channel != null) {
        try {
            await acquire();
            if (isReady()) {
                const stop = playNoteOnChannel(channel, midi);
                if (stop) setTimeout(stop, durMs);
                return;
            }
        } catch (err) {
            console.warn('DX7 synth unavailable:', err);
        }
    }

    // Preview path: offline render + sample injection (no channel needed)
    if (voiceData) {
        try {
            await acquire();
            if (isReady()) {
                const stop = playNoteRealtime(voiceData, midi);
                if (stop) setTimeout(stop, durMs * 0.6);
                return;
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
            const data = await resp.json();
            if (data.wav_url) {
                new Audio(baseUrl + data.wav_url).play();
                return;
            }
        } catch (err) {
            console.warn('API play failed:', err);
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
    } catch {}
}

async function playPatch(patch, midi) {
    const note = midi || activeKeyboardNote || 60;
    if (patch.voice_data) {
        try {
            await acquire();
            if (isReady()) {
                // Render offline on main thread (separate WASM instance)
                const blob = await renderOffline(patch.voice_data, note, 3000);
                // Decode WAV → float samples → feed into live worklet
                const audioCtx = await acquire();
                const audioBuffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
                playSamplesInWorklet(audioBuffer.getChannelData(0));
                return URL.createObjectURL(blob); // canvas draws waveform
            }
        } catch (err) {
            console.warn('DX7 synth unavailable:', err);
        }
        const resp = await fetch(baseUrl + '/api/play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voice_data: patch.voice_data, note })
        });
        const data = await resp.json();
        if (data.wav_url) {
            new Audio(baseUrl + data.wav_url).play();
            return baseUrl + data.wav_url;
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
    const wrapper = document.getElementById('progress-wrapper');
    if (wrapper) wrapper.style.display = 'block';
    const fill = document.getElementById('progress-fill');
    if (fill) fill.style.width = pct + '%';
}

function hideProgress() {
    const wrapper = document.getElementById('progress-wrapper');
    if (wrapper) wrapper.style.display = 'none';
}

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

    if (file.name.toLowerCase().endsWith('.syx')) {
        appendLog(`Routing .syx file: ${file.name} (${file.size} bytes)`);
        handleSyxUpload(file);
        fileInput.value = '';
        return;
    }

    // WAV import — Job drives the lifecycle
    const job = Job.create({ fileName: file.name });
    await job.probe(file, jobOpts);
    refreshCanvas();
});

// --- SYX upload (simple, no Job lifecycle needed) ---

async function handleSyxUpload(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const patches = parseSyxFile(arrayBuffer);
        if (!patches || patches.length === 0) {
            appendLog(`Failed to parse .syx file: ${file.name}`);
            return;
        }

        const name = file.name.replace(/\.[^.]+$/, '');
        appendLog(`Parsed .syx: ${name} (${patches.length} voices)`);

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
            fileName: file.name,
            containerId: null,
        });

        const ctr = addContainer(name, { jobId, patchIds: created.map(p => p.id) });
        const updatedCtr = canvasStore.getContainer(ctr.id);
        if (updatedCtr) {
            updatedCtr.patchIds = created.map(p => p.id);
            canvasStore.putContainer(updatedCtr);
        }

        initCanvas(getCanvasOpts());

    } catch (err) {
        appendLog(`Error reading .syx file: ${err.message}`);
    }
}

// --- Canvas opts ---

function getCanvasOpts() {
    return {
        onPlay: (patch) => {
            if (patch.voice_data) {
                activeSyxVoiceData = patch.voice_data;
                // Also add to voice bank so pianoroll has a channel
                if (pianoDockWrapper && pianoDockWrapper._voiceBank) {
                    pianoDockWrapper._voiceBank._addEntry(patch.name || 'Untitled', patch.voice_data, patch.name);
                }
            }
            return playPatch(patch, activeKeyboardNote);
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
                        new Audio(url).play();
                    }
                });
            }
        },
        renderJobBody: (jobData, bodyEl) => {
            const job = Job.restore(jobData);
            job.renderBody(bodyEl, jobOpts);
        },
        onLoadJobWav: (jobId, callback) => {
            dbGet(jobId).then(arrayBuffer => {
                if (arrayBuffer) callback(arrayBuffer);
            });
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
        onExportContainer: async (patches, name) => {
            let safeName = (name || 'patches').replace(/\.(?=[^.]*$)|syx$/i, '').trim();
            safeName = safeName.replace(/[^a-zA-Z0-9 _\-]/g, '').trim() || 'patches';

            if (patches.length === 0) {
                appendLog('No patches with voice data to export');
                return;
            }
            try {
                const resp = await fetch(baseUrl + '/api/export-syx', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: safeName, patches: patches.map(p => ({ name: p.name, voice_data: p.voice_data })) })
                });
                const data = await resp.json();
                if (data.error) {
                    appendLog('Export error: ' + data.error);
                    return;
                }
                const a = document.createElement('a');
                a.href = baseUrl + data.syx_url;
                a.download = safeName + '.syx';
                a.click();
                appendLog(`Exported ${data.count} patches as ${safeName}.syx`);
            } catch (e) {
                appendLog('Export failed: ' + e.message);
            }
        },
        baseUrl,
    };
}

// --- Toolbar ---

function initToolbar() {
    const pianoDock = document.getElementById('piano-dock');
    pianoDock.innerHTML = '';

    const isMobile = window.matchMedia('(max-width: 600px)').matches;
    const playFn = (midi, durationMs, voiceData, channel) => playNote(midi, voiceData || activeSyxVoiceData, durationMs, channel);

    const dock = createToolbar({
        matchedMidi: activeKeyboardNote,
        playNoteFn: playFn,
        initialTab: isMobile ? 'canvas' : 'pianoroll',
        onNoteClick: (midi) => { activeKeyboardNote = midi; },
        onSnapshot: (entries) => {
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
            onPatchCreated: (patch) => {
                addContainer(patch.name, { patchIds: [patch.id] });
                initCanvas(getCanvasOpts());
            },
        },
    });
    pianoDock.appendChild(dock);
    pianoDockWrapper = dock;

    if (isMobile) {
        const sky = document.getElementById('night-sky');
        const canvasPanel = dock.querySelector('.dock-panel-canvas');
        if (sky && canvasPanel) canvasPanel.appendChild(sky);
        if (dock._voiceBank) {
            dock._voiceBank.classList.add('compact');
            if (dock._voiceBank._render) dock._voiceBank._render();
        }
    }

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

document.getElementById('menu-import-wav').addEventListener('click', () => {
    fileInput.accept = '.wav';
    fileInput.click();
});
document.getElementById('menu-import-syx').addEventListener('click', () => {
    fileInput.accept = '.syx';
    fileInput.click();
});
document.getElementById('menu-load-demo').addEventListener('click', () => {
    loadDemoSyx(true);
});
document.getElementById('menu-show-log').addEventListener('click', () => {
    if (pianoDockWrapper && pianoDockWrapper._showLog) pianoDockWrapper._showLog();
});
document.getElementById('menu-clear-history').addEventListener('click', async () => {
    if (!confirm('Clear all session history?')) return;
    jobManager.stopAll();
    localStorage.removeItem('openpatches_patches');
    localStorage.removeItem('openpatches_canvas');
    localStorage.removeItem('openpatches_jobs');
    localStorage.removeItem('openpatches_voicebank');
    localStorage.removeItem('openpatches_tutorial');
    // Note: demoWasOffered (openpatches_demo_offered) is intentionally preserved
    canvasStore.clear();
    initCanvas(getCanvasOpts());
    appendLog('History cleared');
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

initToolbar();
restore();
