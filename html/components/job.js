// Job — steering object for WAV import lifecycle.
// Owns: probe → match → poll → complete/fail, container, rendering.

import { jobStore, canvasStore, patchStore, createPatch, patchIdFromVoiceData } from './patch-model.js';
import { addContainer, addPatchToContainer, refreshCanvas } from './canvas.js';
import { decodeWavSamples, drawMiniWaveform } from './patch.js';

const PROBE_FIELDS = ['attack_ms', 'decay_ms', 'sustain_level', 'release_ms', 'gate_ms', 'brightness', 'harmonicity'];
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

export class Job {
    constructor(data) {
        this.id = data.id;
        this.type = data.type || 'wav_import';
        this.status = data.status || 'pending';
        this.fileName = data.fileName || '';
        this.containerId = data.containerId || null;
        this.probeData = data.probeData || null;
        this.resultData = data.resultData || null;
        this.statusUrl = data.statusUrl || null;
        this.pollCount = data.pollCount || 0;
    }

    // --- Persistence ---

    save() {
        jobStore.put(this.toJSON());
    }

    toJSON() {
        return {
            id: this.id,
            type: this.type,
            status: this.status,
            fileName: this.fileName,
            containerId: this.containerId,
            probeData: this.probeData,
            resultData: this.resultData,
            statusUrl: this.statusUrl,
            pollCount: this.pollCount,
        };
    }

    // --- State queries ---

    get isProbe() { return this.status === 'probe_ready'; }
    get isPolling() { return this.status === 'polling'; }
    get isCompleted() { return this.status === 'completed'; }
    get isFailed() { return this.status === 'failed'; }
    get isActive() { return this.isProbe || this.isPolling; }

    // --- Container ---

    getContainer() {
        return this.containerId ? canvasStore.getContainer(this.containerId) : null;
    }

    syncContainerState() {
        const ctr = this.getContainer();
        if (!ctr) return;
        // Container name styling derives from job status
        canvasStore.putContainer(ctr);
    }

    // --- Static factories ---

    static create(opts) {
        const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        const job = new Job({
            id: jobId,
            type: 'wav_import',
            status: 'pending',
            fileName: opts.fileName,
        });
        job.save();
        return job;
    }

    static restore(data) {
        return new Job(data);
    }

    // --- Lifecycle: Probe ---

    async probe(file, opts) {
        const { baseUrl, appendLog, showProgress, hideProgress, dbPut } = opts;

        // Store WAV in IndexedDB
        try {
            const arrayBuffer = await file.arrayBuffer();
            await dbPut(this.id, arrayBuffer);
        } catch (e) {
            console.warn('Failed to store WAV in IndexedDB:', e);
        }

        appendLog(`Probing: ${this.fileName}`);
        showProgress(10);

        try {
            const formData = new FormData();
            formData.append('file', file);
            const response = await fetch(baseUrl + '/api/probe', { method: 'POST', body: formData });
            const text = await response.text();

            if (!response.ok) {
                appendLog(`[${response.status}] ${text}`);
                hideProgress();
                return false;
            }

            let data;
            try { data = JSON.parse(text); } catch {
                appendLog(`[${response.status}] ${text}`);
                hideProgress();
                return false;
            }

            appendLog(`Probe complete: ${this.fileName}`);
            this.probeData = data;
            this.status = 'probe_ready';
            this.save();

            // Create container linked to this job
            const ctr = addContainer(this.fileName.replace(/\.[^.]+$/, ''), {
                jobId: this.id,
            });
            this.containerId = ctr.id;
            this.save();
            hideProgress();
            return true;
        } catch (err) {
            appendLog(`Error: ${err.message}`);
            hideProgress();
            return false;
        }
    }

    // --- Lifecycle: Match ---

    async startMatch(formEl, opts) {
        const { baseUrl, appendLog, dbGet, jobManager } = opts;

        appendLog(`Matching: ${this.fileName}`);

        const arrayBuffer = await dbGet(this.id);
        if (!arrayBuffer) {
            appendLog('Error: stored WAV not found');
            return;
        }
        const blob = new Blob([arrayBuffer]);
        const file = new File([blob], this.fileName, { type: 'audio/wav' });

        try {
            const formData = new FormData();
            formData.append('file', file);

            const noteInput = formEl.querySelector('[name="note"]');
            if (noteInput && noteInput.value !== '') formData.append('note', noteInput.value);

            PROBE_FIELDS.forEach(key => {
                const input = formEl.querySelector(`[name="${key}"]`);
                if (input && input.value !== '') formData.append(key, input.value);
            });

            const response = await fetch(baseUrl + '/api/match', { method: 'POST', body: formData });
            const text = await response.text();

            if (!response.ok) {
                appendLog(`[${response.status}] ${text}`);
                return;
            }

            let data;
            try { data = JSON.parse(text); } catch {
                appendLog(`[${response.status}] ${text}`);
                return;
            }

            if (data.status_url) {
                this.statusUrl = data.status_url;
                this.status = 'polling';
                this.save();
                appendLog(`Status URL: ${data.status_url}`);
                refreshCanvas();
                jobManager.start(this);
            }
        } catch (err) {
            appendLog(`Error: ${err.message}`);
        }
    }

    // --- Lifecycle: Poll ---

    async checkStatus(opts) {
        const { baseUrl, appendLog, showProgress, hideProgress, jobManager } = opts;

        if (!this.statusUrl) return;

        try {
            const response = await fetch(baseUrl + this.statusUrl);
            const text = await response.text();
            let data;
            try { data = JSON.parse(text); } catch {
                appendLog(`[status] ${text}`);
                this.fail(opts);
                return;
            }

            if (data.status === 'queued') {
                this.pollCount = (this.pollCount || 0) + 1;
                appendLog(`[${this.fileName}] Queued, waiting on ${data.queue_position}`);
                showProgress(0);
                this.save();
            } else if (data.status === 'processing') {
                this.pollCount = (this.pollCount || 0) + 1;
                appendLog(`[${this.fileName}] Processing: ${data.progress_percent}% — ${data.phase || ''}`);
                showProgress(data.progress_percent);
                this.save();
            } else if (data.status === 'completed') {
                appendLog(`[${this.fileName}] Completed`);
                hideProgress();
                this.resultData = data;
                this.status = 'completed';
                this.pollCount = 0;
                this.save();
                this.complete(opts);
                jobManager.stop(this.id);
            } else {
                appendLog(`[${this.fileName}] ${JSON.stringify(data, null, 2)}`);
                hideProgress();
                this.fail(opts);
            }
        } catch (err) {
            appendLog(`[status error] ${err.message}`);
            this.fail(opts);
        }
    }

    // --- Lifecycle: Complete ---

    complete(opts) {
        const { appendLog } = opts;
        const data = this.resultData;
        if (!data) return;

        const baseName = this.fileName.replace(/\.[^.]+$/, '');
        const rootMidi = data.midi_note;
        const groups = [
            { key: 'matches',          prefix: 'NEAREST' },
            { key: 'timbral_matches',  prefix: 'TIMBRAL' },
            { key: 'full_matches',     prefix: 'FULL' },
            { key: 'favorites',        prefix: 'FAVORITES' },
            { key: 'formant_matches',  prefix: 'FORMANT' },
        ];

        const ctrId = this.containerId;
        if (!ctrId) return;

        const ctr = canvasStore.getContainer(ctrId);
        if (!ctr) return;

        const containerGroups = [];

        for (const group of groups) {
            const matches = data[group.key];
            if (!matches || matches.length === 0) continue;

            const patches = matches.map(m => createPatch({
                name: `${group.prefix} ${m.name || (`#${m.rank}`)}`,
                algorithm: m.algorithm,
                feedback: m.feedback,
                voice_data: m.voice_data || null,
                source: 'wav',
                midi_note: rootMidi,
            }));
            patchStore.bulkPut(patches);

            const patchIds = [];
            for (const p of patches) {
                addPatchToContainer(p.id, ctrId);
                patchIds.push(p.id);
            }

            containerGroups.push({ label: group.prefix, patchIds });
        }

        ctr.groups = containerGroups;
        canvasStore.putContainer(ctr);

        refreshCanvas();
        appendLog(`Match complete: ${baseName}`);
    }

    // --- Lifecycle: Fail ---

    fail(opts) {
        const { appendLog, jobManager } = opts;
        this.status = 'failed';
        this.save();
        if (jobManager) jobManager.stop(this.id);
        refreshCanvas();
        if (appendLog) appendLog(`[${this.fileName}] Failed`);
    }

    // --- Rendering ---

    renderBody(bodyEl, opts) {
        const { baseUrl, appendLog, dbGet, jobManager, toggleFork, noteToFreq } = opts;

        if (!this.probeData) return;

        const disabled = !this.isProbe;
        const isFinalized = this.isCompleted || this.isFailed;

        bodyEl.classList.add('container-body-probe');

        let targetEl = bodyEl;
        if (isFinalized) {
            const details = document.createElement('details');
            details.className = 'probe-details-finalized';
            const summary = document.createElement('summary');
            summary.textContent = 'Probe Parameters';
            details.appendChild(summary);
            bodyEl.appendChild(details);
            targetEl = details;
        }

        const panel = document.createElement('div');
        panel.className = 'probe-panel';

        // Info badges
        const info = document.createElement('div');
        info.className = 'probe-info';
        const badges = [
            {label: 'Freq', value: this.probeData.f0_hz ? this.probeData.f0_hz.toFixed(1) + ' Hz' : null},
            {label: 'Conf', value: this.probeData.f0_confidence ? this.probeData.f0_confidence.toFixed(2) : null},
            {label: 'Centroid', value: this.probeData.spectral_centroid_hz ? this.probeData.spectral_centroid_hz.toFixed(0) + ' Hz' : null},
            this.probeData.seen_before ? {label: 'SEEN BEFORE', value: '', cls: 'seen'} : null,
            this.probeData.best_match ? {label: 'Best', value: `algo ${this.probeData.best_match.algorithm} fb ${this.probeData.best_match.feedback} (${this.probeData.best_match.distance.toFixed(3)})`, cls: 'match'} : null,
        ].filter(Boolean);
        badges.forEach(b => {
            const span = document.createElement('span');
            span.className = 'badge' + (b.cls ? ' ' + b.cls : '');
            if (b.value) {
                const strong = document.createElement('strong');
                strong.textContent = b.label + ':';
                span.appendChild(strong);
                span.appendChild(document.createTextNode(' ' + b.value));
            } else {
                const strong = document.createElement('strong');
                strong.textContent = b.label;
                span.appendChild(strong);
            }
            info.appendChild(span);
        });
        panel.appendChild(info);

        // Note row
        const parsed = parseRootNote(this.probeData.root_note);
        const noteRow = document.createElement('div');
        noteRow.className = 'note-row';

        const noteField = document.createElement('div');
        noteField.className = 'probe-field';
        const noteLabel = document.createElement('label');
        noteLabel.textContent = 'Note';
        noteField.appendChild(noteLabel);
        const noteSelect = document.createElement('select');
        noteSelect.disabled = disabled;
        NOTE_NAMES.forEach((n, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = n;
            if (i === parsed.note) opt.selected = true;
            noteSelect.appendChild(opt);
        });
        noteField.appendChild(noteSelect);
        noteRow.appendChild(noteField);

        const octField = document.createElement('div');
        octField.className = 'probe-field';
        const octLabel = document.createElement('label');
        octLabel.textContent = 'Octave';
        octField.appendChild(octLabel);
        const octSelect = document.createElement('select');
        octSelect.disabled = disabled;
        for (let o = 0; o <= 8; o++) {
            const opt = document.createElement('option');
            opt.value = o;
            opt.textContent = o;
            if (o === parsed.octave) opt.selected = true;
            octSelect.appendChild(opt);
        }
        octField.appendChild(octSelect);
        noteRow.appendChild(octField);

        const hiddenNote = document.createElement('input');
        hiddenNote.type = 'hidden';
        hiddenNote.name = 'note';
        hiddenNote.value = this.probeData.root_note || 'C4';
        noteRow.appendChild(hiddenNote);

        if (!isFinalized) {
            const forkBtn = document.createElement('button');
            forkBtn.type = 'button';
            forkBtn.className = 'tuning-fork-btn';
            forkBtn.title = 'Tuning fork — click to play/stop';
            const forkIcon = document.createElement('b');
            forkIcon.textContent = 'Y';
            forkBtn.appendChild(forkIcon);
            forkBtn.disabled = disabled;
            noteRow.appendChild(forkBtn);

            function syncHiddenNote() {
                hiddenNote.value = NOTE_NAMES[noteSelect.value] + octSelect.value;
            }
            noteSelect.addEventListener('change', () => {
                syncHiddenNote();
                if (toggleFork._osc) toggleFork._osc.frequency.value = noteToFreq(parseInt(noteSelect.value), parseInt(octSelect.value));
            });
            octSelect.addEventListener('change', () => {
                syncHiddenNote();
                if (toggleFork._osc) toggleFork._osc.frequency.value = noteToFreq(parseInt(noteSelect.value), parseInt(octSelect.value));
            });
            forkBtn.addEventListener('click', () => toggleFork(forkBtn, noteSelect, octSelect));
        }

        panel.appendChild(noteRow);

        // Probe fields
        const form = document.createElement('form');
        form.className = 'probe-form';
        form.onsubmit = () => false;

        PROBE_FIELDS.forEach(key => {
            const field = document.createElement('div');
            field.className = 'probe-field';
            const numVal = this.probeData[key];
            const input = document.createElement('input');
            input.type = 'number';
            input.name = key;
            input.disabled = disabled;
            input.step = key === 'sustain_level' || key === 'harmonicity' ? '0.001' : '0.01';
            input.min = '0';
            if (key === 'sustain_level' || key === 'brightness' || key === 'harmonicity') input.max = '1';
            input.value = numVal !== undefined ? (Number.isInteger(numVal) ? numVal : parseFloat(numVal.toFixed(6))) : '';
            const label = document.createElement('label');
            label.textContent = key.replace(/_/g, ' ');
            field.appendChild(label);
            field.appendChild(input);
            form.appendChild(field);
        });

        // Actions
        if (!isFinalized) {
            const actions = document.createElement('div');
            actions.className = 'probe-actions';

            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'btn-reset';
            resetBtn.textContent = 'Reset';
            resetBtn.disabled = disabled;
            resetBtn.addEventListener('click', () => {
                bodyEl.innerHTML = '';
                this.renderBody(bodyEl, opts);
            });

            const matchBtn = document.createElement('button');
            matchBtn.type = 'button';
            matchBtn.className = 'btn-match';
            matchBtn.textContent = disabled ? 'Matching...' : 'Start Matching';
            matchBtn.disabled = disabled;
            matchBtn.addEventListener('click', () => this.startMatch(form, opts));

            actions.appendChild(resetBtn);
            actions.appendChild(matchBtn);
            form.appendChild(actions);
        }

        panel.appendChild(form);
        targetEl.appendChild(panel);
    }
}

function parseRootNote(rootNote) {
    if (!rootNote) return { note: 0, octave: 4 };
    const s = String(rootNote).trim();
    if (/^\d+$/.test(s)) {
        const midi = parseInt(s, 10);
        return { note: midi % 12, octave: Math.floor(midi / 12) - 1 };
    }
    const m = s.match(/^([A-G]#?)(\d)$/);
    if (m) {
        const idx = NOTE_NAMES.indexOf(m[1]);
        if (idx >= 0) return { note: idx, octave: parseInt(m[2], 10) };
    }
    return { note: 0, octave: 4 };
}

// --- Job Manager (polling coordinator) ---

export const jobManager = {
    _active: new Map(), // jobId -> { intervalId, failures }
    _maxFailures: 3,

    start(job, interval = 3000) {
        if (this._active.has(job.id)) return;
        const entry = { failures: 0 };
        entry.intervalId = setInterval(async () => {
            try {
                await job.checkStatus(jobManager._opts);
                entry.failures = 0; // reset on success
            } catch (e) {
                entry.failures++;
                if (entry.failures >= this._maxFailures) {
                    console.warn(`[jobManager] ${job.id}: ${entry.failures} consecutive failures, stopping poll`);
                    if (jobManager._opts && jobManager._opts.appendLog) {
                        jobManager._opts.appendLog(`[${job.fileName}] Polling stopped: ${entry.failures} connection failures`);
                    }
                    job.fail(jobManager._opts);
                    this.stop(job.id);
                }
            }
        }, interval);
        this._active.set(job.id, entry);
        // Immediate first check
        job.checkStatus(jobManager._opts).catch(() => {});
    },

    stop(jobId) {
        const entry = this._active.get(jobId);
        if (entry) {
            clearInterval(entry.intervalId);
            this._active.delete(jobId);
        }
    },

    stopAll() {
        for (const [jobId] of this._active) {
            this.stop(jobId);
        }
    },

    // Set by app.js at init time — provides opts for checkStatus
    _opts: null,
    setOpts(opts) {
        this._opts = opts;
    },
};
