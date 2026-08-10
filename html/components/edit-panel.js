// Edit Panel — Morph / Params / Random editing modes.
// Extracted from app.js. Lives in the toolbar's Edit tab.

import { createPatch, patchStore, patchIdFromVoiceData } from './patch-model.js';
import { createTagEditor } from './tag-editor.js';

let editSlot = null;
let editSlotB = null;
let editMode = 'morph';
let currentMutation = null;
let baseUrlRef = '';
let onPatchCreated = null; // callback(patch) when a new patch is saved

export function createEditPanel(opts) {
    baseUrlRef = opts.baseUrl || '';
    onPatchCreated = opts.onPatchCreated || null;

    const panel = document.createElement('div');
    panel.className = 'edit-panel-inner';

    // Mode tabs
    const modes = document.createElement('div');
    modes.className = 'edit-modes';
    const modeNames = ['morph', 'params', 'random'];
    modeNames.forEach(mode => {
        const btn = document.createElement('button');
        btn.className = 'edit-mode-btn' + (mode === editMode ? ' active' : '');
        btn.dataset.mode = mode;
        btn.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
        btn.addEventListener('click', () => setEditMode(mode));
        modes.appendChild(btn);
    });
    panel.appendChild(modes);

    // Slot area
    const slotArea = document.createElement('div');
    slotArea.id = 'edit-slot-area';
    panel.appendChild(slotArea);

    // Slider row
    const sliderRow = document.createElement('div');
    sliderRow.className = 'edit-slider-row';
    sliderRow.id = 'edit-slider-row';
    const sliderLabel = document.createElement('label');
    sliderLabel.className = 'edit-slider-label';
    sliderLabel.id = 'edit-slider-label';
    sliderLabel.textContent = 'Distance: ';
    const valSpan = document.createElement('span');
    valSpan.id = 'edit-slider-val';
    valSpan.textContent = '0.50';
    sliderLabel.appendChild(valSpan);
    sliderRow.appendChild(sliderLabel);
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = 'edit-slider';
    slider.min = '-1';
    slider.max = '1';
    slider.step = '0.01';
    slider.value = '0.5';
    slider.className = 'edit-slider';
    sliderRow.appendChild(slider);
    const ticks = document.createElement('div');
    ticks.className = 'edit-slider-ticks';
    [
        { val: '−1' },
        { val: '0' },
        { val: '1' }
    ].forEach(t => {
        const span = document.createElement('span');
        span.textContent = t.val;
        ticks.appendChild(span);
    });
    sliderRow.appendChild(ticks);
    panel.appendChild(sliderRow);

    // Params area
    const paramsArea = document.createElement('div');
    paramsArea.id = 'edit-params-area';
    paramsArea.style.display = 'none';
    panel.appendChild(paramsArea);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'edit-actions';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn-edit-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
        editSlot = null;
        editSlotB = null;
        currentMutation = null;
        renderEditPanel();
    });
    actions.appendChild(clearBtn);
    const goBtn = document.createElement('button');
    goBtn.className = 'btn-edit-primary';
    goBtn.id = 'edit-go';
    goBtn.disabled = true;
    goBtn.textContent = 'Morph';
    goBtn.addEventListener('click', runEditAction);
    actions.appendChild(goBtn);
    panel.appendChild(actions);

    // Status
    const statusEl = document.createElement('div');
    statusEl.className = 'edit-status';
    statusEl.id = 'edit-status';
    statusEl.textContent = 'Open Edit on any patch to begin';
    panel.appendChild(statusEl);

    // Tags area (global for active patch)
    const tagsArea = document.createElement('div');
    tagsArea.id = 'edit-tags-area';
    tagsArea.className = 'edit-tags-area';
    panel.appendChild(tagsArea);

    // Slider input handler
    slider.addEventListener('input', () => {
        const valEl = document.getElementById('edit-slider-val');
        if (valEl) valEl.textContent = editMode === 'random' ? slider.value : parseFloat(slider.value).toFixed(2);
        if (editMode === 'morph' && editSlot && editSlotB) {
            statusEl.textContent = `Ready: ${editSlot.name} ${ratioLabel(parseFloat(slider.value))} ${editSlotB.name}`;
        }
    });

    return panel;
}

// --- Public API ---

export function openEdit(patch) {
    if (editMode === 'morph' && editSlot && patch) {
        if (editSlot.id !== patch.id) {
            editSlotB = patch;
        }
    } else {
        editSlot = patch;
        editSlotB = null;
    }
    currentMutation = null;
    renderEditPanel();
}

// --- Mode switching ---

function setEditMode(mode) {
    editMode = mode;
    currentMutation = null;
    document.querySelectorAll('.edit-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    renderEditPanel();
}

// --- Render ---

function renderEditPanel() {
    const slotArea = document.getElementById('edit-slot-area');
    const sliderRow = document.getElementById('edit-slider-row');
    const paramsArea = document.getElementById('edit-params-area');
    const tagsArea = document.getElementById('edit-tags-area');
    const goBtn = document.getElementById('edit-go');
    const statusEl = document.getElementById('edit-status');

    if (!slotArea || !goBtn || !statusEl || !tagsArea) return;

    if (!editSlot && !editSlotB) {
        slotArea.innerHTML = '';
        sliderRow.style.display = 'none';
        paramsArea.style.display = 'none';
        tagsArea.innerHTML = '';
        goBtn.disabled = true;
        goBtn.textContent = 'Morph';
        statusEl.textContent = 'Open Edit on any patch to begin';
        return;
    }

    // Always show tags for the primary edit slot
    tagsArea.innerHTML = '<div class="edit-section-title">Patch Tags</div>';
    tagsArea.appendChild(createTagEditor(editSlot, (updated) => patchStore.put(updated)));

    if (editMode === 'morph') {
        renderMorphMode(slotArea, sliderRow, paramsArea, goBtn, statusEl);
    } else if (editMode === 'params') {
        renderParamsMode(slotArea, sliderRow, paramsArea, goBtn, statusEl);
    } else if (editMode === 'random') {
        renderRandomMode(slotArea, sliderRow, paramsArea, goBtn, statusEl);
    }
}

function renderEditSlot(container, patch, slotIdx, showRemove) {
    container.innerHTML = '';
    // Remove any existing sibling remove button
    const existingBtn = container.parentNode?.querySelector('.edit-slot-remove');
    if (existingBtn) existingBtn.remove();

    if (!patch) {
        const empty = document.createElement('span');
        empty.className = 'edit-slot-empty';
        empty.textContent = 'Click 🔧 on any patch';
        container.appendChild(empty);
        container.classList.remove('filled');
        return;
    }
    container.classList.add('filled');

    const nameEl = document.createElement('div');
    nameEl.className = 'edit-slot-name';
    nameEl.textContent = patch.name;
    container.appendChild(nameEl);

    const infoEl = document.createElement('div');
    infoEl.className = 'edit-slot-info';
    infoEl.textContent = `A${patch.algorithm} FB${patch.feedback}`;
    container.appendChild(infoEl);

    if (showRemove) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'edit-slot-remove';
        removeBtn.textContent = '×';
        removeBtn.title = 'Remove';
        removeBtn.addEventListener('click', () => {
            if (slotIdx === 0) { editSlot = null; } else { editSlotB = null; }
            renderEditPanel();
        });
        container.parentNode.insertBefore(removeBtn, container.nextSibling);
    }
}

// --- Morph Mode ---

function renderMorphMode(slotArea, sliderRow, paramsArea, goBtn, statusEl) {
    sliderRow.style.display = '';
    paramsArea.style.display = 'none';

    const slider = document.getElementById('edit-slider');
    const sliderLabel = document.getElementById('edit-slider-label');
    slider.min = '-1'; slider.max = '1'; slider.step = '0.01';
    if (!slider.dataset.morphInit) { slider.value = '0.5'; slider.dataset.morphInit = '1'; }
    sliderLabel.textContent = 'Distance: ';
    const valSpan = document.createElement('span');
    valSpan.id = 'edit-slider-val';
    valSpan.textContent = parseFloat(slider.value).toFixed(2);
    sliderLabel.appendChild(valSpan);

    slotArea.innerHTML = '';
    const slotsDiv = document.createElement('div');
    slotsDiv.className = 'edit-slots';

    const slotA = document.createElement('div');
    slotA.className = 'edit-slot';
    slotA.id = 'edit-slot-a';
    const labelA = document.createElement('div');
    labelA.className = 'edit-slot-label';
    labelA.textContent = 'A';
    const contentA = document.createElement('div');
    contentA.className = 'edit-slot-content';
    slotA.appendChild(labelA);
    slotA.appendChild(contentA);
    renderEditSlot(contentA, editSlot, 0, true);

    const swapBtn = document.createElement('button');
    swapBtn.className = 'edit-swap-btn';
    swapBtn.textContent = '⇄';
    swapBtn.title = 'Swap A ↔ B';
    swapBtn.addEventListener('click', () => {
        if (!editSlot || !editSlotB) return;
        [editSlot, editSlotB] = [editSlotB, editSlot];
        renderEditPanel();
    });

    const slotB = document.createElement('div');
    slotB.className = 'edit-slot';
    slotB.id = 'edit-slot-b';
    const labelB = document.createElement('div');
    labelB.className = 'edit-slot-label';
    labelB.textContent = 'B';
    const contentB = document.createElement('div');
    contentB.className = 'edit-slot-content';
    slotB.appendChild(labelB);
    slotB.appendChild(contentB);
    renderEditSlot(contentB, editSlotB, 1, true);

    slotsDiv.appendChild(slotA);
    slotsDiv.appendChild(swapBtn);
    slotsDiv.appendChild(slotB);
    slotArea.appendChild(slotsDiv);

    goBtn.disabled = !(editSlot && editSlotB);
    goBtn.textContent = 'Morph';

    if (editSlot && editSlotB) {
        const r = parseFloat(slider.value);
        statusEl.textContent = `Ready: ${editSlot.name} ${ratioLabel(r)} ${editSlotB.name}`;
    } else if (editSlot) {
        statusEl.textContent = `${editSlot.name} — add a target (B)`;
    } else {
        statusEl.textContent = '';
    }
}

// --- Params Mode ---

function renderParamsMode(slotArea, sliderRow, paramsArea, goBtn, statusEl) {
    sliderRow.style.display = 'none';
    paramsArea.style.display = '';

    slotArea.innerHTML = '';
    const slotsDiv = document.createElement('div');
    slotsDiv.className = 'edit-slots';
    const slotA = document.createElement('div');
    slotA.className = 'edit-slot';
    const labelA = document.createElement('div');
    labelA.className = 'edit-slot-label';
    labelA.textContent = 'A';
    const contentA = document.createElement('div');
    contentA.className = 'edit-slot-content';
    slotA.appendChild(labelA);
    slotA.appendChild(contentA);
    renderEditSlot(contentA, editSlot, 0, true);
    slotsDiv.appendChild(slotA);
    slotArea.appendChild(slotsDiv);

    if (!currentMutation) {
        currentMutation = JSON.parse(JSON.stringify(editSlot));
        if (editSlot.voice_data && !editSlot.ops) {
            try {
                const bytes = atob(editSlot.voice_data);
                const arr = new Uint8Array(bytes.length);
                for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
                currentMutation.ops = [];
                for (let i = 0; i < 6; i++) {
                    const base = i * 17;
                    currentMutation.ops.push({
                        outputLevel: arr[base + 14],
                        freqCoarse: (arr[base + 15] >> 1) & 0x1F,
                    });
                }
                currentMutation.feedback = arr[111] & 0x07;
                currentMutation.algorithm = arr[110];
            } catch {
                currentMutation.ops = Array.from({length: 6}, () => ({ outputLevel: 0, freqCoarse: 1 }));
                currentMutation.feedback = editSlot.feedback || 0;
            }
        }
        if (!currentMutation.ops) {
            currentMutation.ops = Array.from({length: 6}, () => ({ outputLevel: 0, freqCoarse: 1 }));
        }
    }

    paramsArea.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'edit-params-grid';

    for (let i = 0; i < 6; i++) {
        const op = currentMutation.ops[i] || { outputLevel: 0, freqCoarse: 1 };

        const rowOL = document.createElement('div');
        rowOL.className = 'edit-param-row';
        const lblOL = document.createElement('span');
        lblOL.className = 'edit-param-label';
        lblOL.textContent = `Op${6-i} `;
        const smallOL = document.createElement('small');
        smallOL.textContent = 'Level';
        lblOL.appendChild(smallOL);
        rowOL.appendChild(lblOL);
        const slOL = document.createElement('input');
        slOL.type = 'range'; slOL.min = '0'; slOL.max = '99'; slOL.value = String(op.outputLevel);
        slOL.className = 'edit-param-slider';
        const valOL = document.createElement('span');
        valOL.className = 'edit-param-val';
        valOL.textContent = op.outputLevel;
        slOL.addEventListener('input', () => {
            currentMutation.ops[i].outputLevel = parseInt(slOL.value);
            valOL.textContent = slOL.value;
        });
        rowOL.appendChild(slOL);
        rowOL.appendChild(valOL);
        grid.appendChild(rowOL);

        const rowFC = document.createElement('div');
        rowFC.className = 'edit-param-row';
        const lblFC = document.createElement('span');
        lblFC.className = 'edit-param-label';
        const smallFC = document.createElement('small');
        smallFC.textContent = 'Freq';
        lblFC.appendChild(smallFC);
        rowFC.appendChild(lblFC);
        const slFC = document.createElement('input');
        slFC.type = 'range'; slFC.min = '0'; slFC.max = '31'; slFC.value = String(op.freqCoarse);
        slFC.className = 'edit-param-slider';
        const valFC = document.createElement('span');
        valFC.className = 'edit-param-val';
        valFC.textContent = op.freqCoarse;
        slFC.addEventListener('input', () => {
            currentMutation.ops[i].freqCoarse = parseInt(slFC.value);
            valFC.textContent = slFC.value;
        });
        rowFC.appendChild(slFC);
        rowFC.appendChild(valFC);
        grid.appendChild(rowFC);

        if (i < 5) {
            const sep = document.createElement('hr');
            sep.className = 'edit-param-sep';
            grid.appendChild(sep);
        }
    }

    const fbRow = document.createElement('div');
    fbRow.className = 'edit-feedback-row';
    const fbLbl = document.createElement('span');
    fbLbl.className = 'edit-feedback-label';
    fbLbl.textContent = 'Feedback';
    fbRow.appendChild(fbLbl);
    const fbSl = document.createElement('input');
    fbSl.type = 'range'; fbSl.min = '0'; fbSl.max = '7';
    fbSl.value = String(currentMutation.feedback || 0);
    fbSl.className = 'edit-param-slider';
    const fbVal = document.createElement('span');
    fbVal.className = 'edit-param-val';
    fbVal.textContent = currentMutation.feedback || 0;
    fbSl.addEventListener('input', () => {
        currentMutation.feedback = parseInt(fbSl.value);
        fbVal.textContent = fbSl.value;
    });
    fbRow.appendChild(fbSl);
    fbRow.appendChild(fbVal);
    grid.appendChild(fbRow);

    paramsArea.appendChild(grid);

    const playBtn = document.createElement('button');
    playBtn.textContent = '▶ Play';
    playBtn.className = 'edit-play-btn';
    playBtn.type = 'button';
    playBtn.addEventListener('click', previewParamsEdit);
    paramsArea.appendChild(playBtn);

    goBtn.disabled = false;
    goBtn.textContent = 'Save as new';
    statusEl.textContent = `Editing ${editSlot.name} — tweak sliders, then save`;
}

// --- Random Mode ---

function renderRandomMode(slotArea, sliderRow, paramsArea, goBtn, statusEl) {
    sliderRow.style.display = '';
    paramsArea.style.display = 'none';

    const slider = document.getElementById('edit-slider');
    const sliderLabel = document.getElementById('edit-slider-label');
    slider.min = '0'; slider.max = '100'; slider.step = '1';
    if (!slider.dataset.randomInit) { slider.value = '30'; slider.dataset.randomInit = '1'; }
    sliderLabel.textContent = 'Mutation: ';
    const valSpan = document.createElement('span');
    valSpan.id = 'edit-slider-val';
    valSpan.textContent = slider.value;
    sliderLabel.appendChild(valSpan);
    sliderLabel.appendChild(document.createTextNode('%'));

    slotArea.innerHTML = '';
    const slotsDiv = document.createElement('div');
    slotsDiv.className = 'edit-slots';
    const slotA = document.createElement('div');
    slotA.className = 'edit-slot';
    const labelA = document.createElement('div');
    labelA.className = 'edit-slot-label';
    labelA.textContent = 'A';
    const contentA = document.createElement('div');
    contentA.className = 'edit-slot-content';
    slotA.appendChild(labelA);
    slotA.appendChild(contentA);
    renderEditSlot(contentA, editSlot, 0, true);
    slotsDiv.appendChild(slotA);
    slotArea.appendChild(slotsDiv);

    goBtn.disabled = false;
    goBtn.textContent = currentMutation ? 'Save as new' : 'Mutate';
    statusEl.textContent = currentMutation
        ? `Mutation ready — save or mutate again`
        : `${editSlot.name} — set intensity, then mutate`;
}

// --- Helpers ---

function ratioLabel(r) {
    if (r < 0) return `← ${Math.abs(r).toFixed(2)}`;
    if (r === 0) return '↔ 0';
    return `→ ${r.toFixed(2)}`;
}

function morphName(nameA, nameB) {
    let a = '?';
    for (const ch of nameA) { if (/[A-Za-z0-9]/.test(ch)) { a = ch.toUpperCase(); break; } }
    let b = '?';
    for (const ch of nameB) { if (/[A-Za-z0-9]/.test(ch)) { b = ch.toUpperCase(); break; } }
    return a + '_' + b;
}

// --- Actions ---

async function runEditAction() {
    if (editMode === 'morph') {
        await runMorphEdit();
    } else if (editMode === 'params') {
        await saveParamsEdit();
    } else if (editMode === 'random') {
        if (currentMutation) {
            await saveMutation();
        } else {
            await runRandomMutate();
        }
    }
}

async function fetchVoiceData(patch) {
    if (patch.voice_data) return patch.voice_data;
    if (patch.syx_url) {
        const resp = await fetch(baseUrlRef + '/api/voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ syx_url: patch.syx_url, slot: patch.slot || 0 })
        });
        const d = await resp.json();
        return d.voice_data;
    }
    return null;
}

async function runMorphEdit() {
    if (!editSlot || !editSlotB) return;
    const goBtn = document.getElementById('edit-go');
    const statusEl = document.getElementById('edit-status');
    const ratio = parseFloat(document.getElementById('edit-slider').value);

    goBtn.disabled = true;
    statusEl.textContent = 'Fetching patches...';

    try {
        const [srcData, tgtData] = await Promise.all([
            fetchVoiceData(editSlot),
            fetchVoiceData(editSlotB),
        ]);
        if (!srcData || !tgtData) {
            statusEl.textContent = 'Error: could not fetch voice data';
            goBtn.disabled = false;
            return;
        }

        statusEl.textContent = 'Morphing...';
        const resp = await fetch(baseUrlRef + '/api/morph', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_data: srcData, target_data: tgtData, note: 60, ratio })
        });
        const data = await resp.json();
        if (data.error) {
            statusEl.textContent = 'Error: ' + data.error;
            goBtn.disabled = false;
            return;
        }

        statusEl.textContent = `Done — distance: ${data.source_dist.toFixed(4)} → ${data.morph_dist.toFixed(4)} (${ratioLabel(data.ratio)})`;
        if (data.wav_url) new Audio(baseUrlRef + data.wav_url).play();

        const morphPatch = createPatch({
            name: morphName(editSlot.name, editSlotB.name),
            voice_data: data.voice_data || null,
            algorithm: editSlot.algorithm,
            feedback: editSlot.feedback,
            source: 'morph',
        });

        patchStore.put(morphPatch);
        if (onPatchCreated) onPatchCreated(morphPatch);

        editSlot = morphPatch;
        editSlotB = null;
        renderEditPanel();
    } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        goBtn.disabled = false;
    }
}

async function buildModifiedVoiceData() {
    if (!currentMutation) return null;
    let voiceData = await fetchVoiceData(editSlot);
    if (!voiceData || !currentMutation.ops) return voiceData;

    const bytes = atob(voiceData);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);

    for (let i = 0; i < 6; i++) {
        const op = currentMutation.ops[i];
        if (!op) continue;
        const base = i * 17;
        arr[base + 14] = op.outputLevel;
        arr[base + 15] = ((op.freqCoarse & 0x1F) << 1) | (arr[base + 15] & 1);
    }
    arr[111] = (arr[111] & 0xF8) | (currentMutation.feedback & 0x07);

    let newB64 = '';
    for (let i = 0; i < arr.length; i++) newB64 += String.fromCharCode(arr[i]);
    return btoa(newB64);
}

async function previewParamsEdit() {
    if (!currentMutation) return;
    const statusEl = document.getElementById('edit-status');
    try {
        statusEl.textContent = 'Rendering preview...';
        const voiceData = await buildModifiedVoiceData();
        if (!voiceData) { statusEl.textContent = 'Error: no voice data'; return; }
        const resp = await fetch(baseUrlRef + '/api/play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voice_data: voiceData, note: 60 })
        });
        const d = await resp.json();
        if (d.wav_url) {
            new Audio(baseUrlRef + d.wav_url).play();
            statusEl.textContent = 'Playing preview...';
        } else {
            statusEl.textContent = 'Error: no WAV returned';
        }
    } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
    }
}

async function saveParamsEdit() {
    if (!currentMutation) return;
    const statusEl = document.getElementById('edit-status');

    try {
        const voiceData = await buildModifiedVoiceData();
        if (!voiceData) { statusEl.textContent = 'Error: no voice data'; return; }

        statusEl.textContent = 'Rendering...';
        const resp = await fetch(baseUrlRef + '/api/play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voice_data: voiceData, note: 60 })
        });
        const playData = await resp.json();

        const newPatch = createPatch({
            name: editSlot.name + ' tweaked',
            voice_data: voiceData,
            algorithm: editSlot.algorithm,
            feedback: currentMutation.feedback || editSlot.feedback,
            source: 'params',
        });

        if (playData.wav_url) new Audio(baseUrlRef + playData.wav_url).play();

        patchStore.put(newPatch);
        if (onPatchCreated) onPatchCreated(newPatch);

        statusEl.textContent = `Saved: ${newPatch.name}`;
    } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
    }
}

async function runRandomMutate() {
    if (!editSlot) return;
    const statusEl = document.getElementById('edit-status');
    const intensity = parseInt(document.getElementById('edit-slider').value) / 100;

    statusEl.textContent = 'Mutating...';

    try {
        const voiceData = await fetchVoiceData(editSlot);
        if (!voiceData) {
            status.textContent = 'Error: no voice data';
            return;
        }

        const bytes = atob(voiceData);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);

        const gaussRand = () => {
            let u = 0, v = 0;
            while (u === 0) u = Math.random();
            while (v === 0) v = Math.random();
            return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        };

        const mutatedOps = [];
        for (let i = 0; i < 6; i++) {
            const base = i * 17;
            const origOL = arr[base + 14];
            const origFC = (arr[base + 15] >> 1) & 0x1F;

            let newOL = Math.round(origOL + gaussRand() * intensity * 15);
            newOL = Math.max(0, Math.min(99, newOL));
            let newFC = Math.round(origFC + gaussRand() * intensity * 2);
            newFC = Math.max(0, Math.min(31, newFC));

            arr[base + 14] = newOL;
            arr[base + 15] = ((newFC & 0x1F) << 1) | (arr[base + 15] & 1);
            mutatedOps.push({ outputLevel: newOL, freqCoarse: newFC });
        }

        const origFB = arr[111] & 0x07;
        let newFB = Math.round(origFB + gaussRand() * intensity * 1.5);
        newFB = Math.max(0, Math.min(7, newFB));
        arr[111] = (arr[111] & 0xF8) | newFB;

        let newB64 = '';
        for (let i = 0; i < arr.length; i++) newB64 += String.fromCharCode(arr[i]);
        const mutatedB64 = btoa(newB64);

        currentMutation = {
            ...editSlot,
            voice_data: mutatedB64,
            feedback: newFB,
            ops: mutatedOps,
            name: editSlot.name + ' *',
        };

        const resp = await fetch(baseUrlRef + '/api/play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voice_data: mutatedB64, note: 60 })
        });
        const playData = await resp.json();
        if (playData.wav_url) {
            currentMutation.wav_url = playData.wav_url;
            new Audio(baseUrlRef + playData.wav_url).play();
        }

        const goBtn = document.getElementById('edit-go');
        goBtn.textContent = 'Save as new';
        statusEl.textContent = `Mutation ready — save or mutate again (intensity: ${Math.round(intensity*100)}%)`;
    } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
    }
}

async function saveMutation() {
    if (!currentMutation) return;
    const statusEl = document.getElementById('edit-status');

    try {
        if (!currentMutation.wav_url && currentMutation.voice_data) {
            const resp = await fetch(baseUrlRef + '/api/play', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ voice_data: currentMutation.voice_data, note: 60 })
            });
            const playData = await resp.json();
            if (playData.wav_url) currentMutation.wav_url = playData.wav_url;
        }

        const newPatch = createPatch({
            name: currentMutation.name || (editSlot.name + ' mutated'),
            voice_data: currentMutation.voice_data,
            algorithm: currentMutation.algorithm || editSlot.algorithm,
            feedback: currentMutation.feedback,
            source: 'random',
        });

        if (currentMutation.wav_url) new Audio(baseUrlRef + currentMutation.wav_url).play();

        patchStore.put(newPatch);
        if (onPatchCreated) onPatchCreated(newPatch);

        statusEl.textContent = `Saved: ${newPatch.name}`;
        currentMutation = null;
        const goBtn = document.getElementById('edit-go');
        goBtn.textContent = 'Mutate';
    } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
    }
}
