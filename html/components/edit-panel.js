// Edit Panel — Morph / Params / Random editing modes.
// Extracted from app.js. Lives in the toolbar's Edit tab.

import { createPatch, patchStore, patchIdFromVoiceData } from './patch-model.js';
import { createTagEditor } from './tag-editor.js';
import { decodeVoiceData, encodeVoiceData, readOp, writeOp, readGlobal, writeGlobal, freqDisplay, CURVE_NAMES, WAVEFORM_NAMES, renderAlgoSvg, renderEnvGraph } from './dx7-params.js';

let editSlot = null;
let editSlotB = null;
let editMode = 'morph';
let currentMutation = null;
let baseUrlRef = '';
let onPatchCreated = null; // callback(patch) when a new patch is saved
let showProgressRef = null;
let hideProgressRef = null;

export function createEditPanel(opts) {
    baseUrlRef = opts.baseUrl || '';
    onPatchCreated = opts.onPatchCreated || null;
    showProgressRef = opts.showProgress || null;
    hideProgressRef = opts.hideProgress || null;

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

    // Actions (below slot)
    const actions = document.createElement('div');
    actions.className = 'edit-actions';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn-edit-action';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
        editSlot = null;
        editSlotB = null;
        currentMutation = null;
        renderEditPanel();
    });
    actions.appendChild(clearBtn);
    const goBtn = document.createElement('button');
    goBtn.className = 'btn-edit-action btn-edit-primary';
    goBtn.id = 'edit-go';
    goBtn.disabled = true;
    goBtn.textContent = 'Morph';
    goBtn.addEventListener('click', runEditAction);
    actions.appendChild(goBtn);
    panel.appendChild(actions);

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

    // Parse voice data into currentMutation.ops and .globals
    if (!currentMutation) currentMutation = JSON.parse(JSON.stringify(editSlot));
    if (editSlot.voice_data && !currentMutation._dx7Parsed) {
        try {
            const bytes = decodeVoiceData(editSlot.voice_data);
            currentMutation.ops = [];
            for (let i = 0; i < 6; i++) currentMutation.ops.push(readOp(bytes, i));
            currentMutation.globals = readGlobal(bytes);
            currentMutation._dx7Parsed = true;
        } catch {
            currentMutation.ops = Array.from({ length: 6 }, () => ({
                r1: 99, r2: 99, r3: 99, r4: 99, l1: 99, l2: 0, l3: 0, l4: 0,
                breakPoint: 60, lDepth: 0, rDepth: 0, lCurve: 0, rCurve: 0,
                rateScaling: 0, detune: 4, velSens: 0, amSens: 0,
                outputLevel: 0, oscMode: 0, freqCoarse: 1, freqFine: 0,
            }));
            currentMutation.globals = {
                algorithm: editSlot.algorithm || 0, feedback: editSlot.feedback || 0,
                keySync: 0, lfoSpeed: 35, lfoDelay: 0, lfoPmDepth: 0, lfoAmd: 0,
                lfoSync: 0, lfoWaveform: 0, lfoPmSens: 0, transpose: 24,
                pitchR1: 99, pitchR2: 99, pitchR3: 99, pitchR4: 99,
                pitchL1: 99, pitchL2: 0, pitchL3: 0, pitchL4: 0,
                name: editSlot.name || '',
            };
        }
    }

    paramsArea.innerHTML = '';

    // Main layout: algo diagram left, params right
    const layout = document.createElement('div');
    layout.className = 'dx7-layout';

    // Algorithm diagram (left)
    const algoPanel = document.createElement('div');
    algoPanel.className = 'dx7-algo-panel';
    const algoLabel = document.createElement('div');
    algoLabel.className = 'dx7-algo-label';
    algoLabel.textContent = 'Algorithm ' + (currentMutation.globals.algorithm + 1);
    algoPanel.appendChild(algoLabel);
    const algoSvgContainer = document.createElement('div');
    algoSvgContainer.className = 'dx7-algo-svg-container';
    algoPanel.appendChild(algoSvgContainer);
    renderAlgoSvg(currentMutation.globals.algorithm, algoSvgContainer);
    layout.appendChild(algoPanel);

    // Parameters (right)
    const paramsPanel = document.createElement('div');
    paramsPanel.className = 'dx7-params-panel';

    // Operator sections (Op6 → Op1)
    for (let i = 0; i < 6; i++) {
        const opNum = 6 - i;
        const op = currentMutation.ops[i];
        const details = document.createElement('details');
        details.className = 'dx7-op-section';
        if (i === 0) details.open = true;

        const summary = document.createElement('summary');
        summary.className = 'dx7-op-summary';
        summary.textContent = `Op${opNum}`;
        details.appendChild(summary);

        const body = document.createElement('div');
        body.className = 'dx7-op-body';

        // Envelope graph
        const envGraph = document.createElement('canvas');
        envGraph.width = 160; envGraph.height = 40;
        envGraph.className = 'dx7-env-graph';
        renderEnvGraph(envGraph, [op.r1, op.r2, op.r3, op.r4], [op.l1, op.l2, op.l3, op.l4]);
        body.appendChild(envGraph);

        // Frequency group
        const freqGroup = document.createElement('div');
        freqGroup.className = 'dx7-param-group';
        freqGroup.appendChild(makeGroupLabel('Frequency'));
        freqGroup.appendChild(makeSlider('Mode', op.oscMode, 0, 1, (v) => { op.oscMode = v; }, () => op.oscMode ? 'Fixed' : 'Ratio'));
        freqGroup.appendChild(makeSlider('Coarse', op.freqCoarse, 0, 31, (v) => { op.freqCoarse = v; }, () => freqDisplay(op.oscMode, op.freqCoarse, op.freqFine)));
        freqGroup.appendChild(makeSlider('Fine', op.freqFine, 0, 99, (v) => { op.freqFine = v; }, () => freqDisplay(op.oscMode, op.freqCoarse, op.freqFine)));
        freqGroup.appendChild(makeSlider('Detune', op.detune, 0, 7, (v) => { op.detune = v; }, () => op.detune === 4 ? '0' : (op.detune < 4 ? '-' + (4 - op.detune) : '+' + (op.detune - 4))));
        body.appendChild(freqGroup);

        // Envelope group
        const envGroup = document.createElement('div');
        envGroup.className = 'dx7-param-group';
        envGroup.appendChild(makeGroupLabel('Envelope'));
        envGroup.appendChild(makeSlider('R1', op.r1, 0, 99, (v) => { op.r1 = v; refreshEnv(); }));
        envGroup.appendChild(makeSlider('R2', op.r2, 0, 99, (v) => { op.r2 = v; refreshEnv(); }));
        envGroup.appendChild(makeSlider('R3', op.r3, 0, 99, (v) => { op.r3 = v; refreshEnv(); }));
        envGroup.appendChild(makeSlider('R4', op.r4, 0, 99, (v) => { op.r4 = v; refreshEnv(); }));
        envGroup.appendChild(makeSlider('L1', op.l1, 0, 99, (v) => { op.l1 = v; refreshEnv(); }));
        envGroup.appendChild(makeSlider('L2', op.l2, 0, 99, (v) => { op.l2 = v; refreshEnv(); }));
        envGroup.appendChild(makeSlider('L3', op.l3, 0, 99, (v) => { op.l3 = v; refreshEnv(); }));
        envGroup.appendChild(makeSlider('L4', op.l4, 0, 99, (v) => { op.l4 = v; refreshEnv(); }));
        body.appendChild(envGroup);

        function refreshEnv() {
            renderEnvGraph(envGraph, [op.r1, op.r2, op.r3, op.r4], [op.l1, op.l2, op.l3, op.l4]);
        }

        // Output group
        const outGroup = document.createElement('div');
        outGroup.className = 'dx7-param-group';
        outGroup.appendChild(makeGroupLabel('Output'));
        outGroup.appendChild(makeSlider('Level', op.outputLevel, 0, 99, (v) => { op.outputLevel = v; }));
        outGroup.appendChild(makeSlider('Vel Sens', op.velSens, 0, 3, (v) => { op.velSens = v; }));
        outGroup.appendChild(makeSlider('AM Sens', op.amSens, 0, 3, (v) => { op.amSens = v; }));
        body.appendChild(outGroup);

        // Scaling group
        const scaleGroup = document.createElement('div');
        scaleGroup.className = 'dx7-param-group';
        scaleGroup.appendChild(makeGroupLabel('Keyboard Scaling'));
        scaleGroup.appendChild(makeSlider('Break Pt', op.breakPoint, 0, 99, (v) => { op.breakPoint = v; }));
        scaleGroup.appendChild(makeSlider('L Depth', op.lDepth, 0, 99, (v) => { op.lDepth = v; }));
        scaleGroup.appendChild(makeSlider('R Depth', op.rDepth, 0, 99, (v) => { op.rDepth = v; }));
        scaleGroup.appendChild(makeSlider('L Curve', op.lCurve, 0, 3, (v) => { op.lCurve = v; }, () => CURVE_NAMES[op.lCurve]));
        scaleGroup.appendChild(makeSlider('R Curve', op.rCurve, 0, 3, (v) => { op.rCurve = v; }, () => CURVE_NAMES[op.rCurve]));
        scaleGroup.appendChild(makeSlider('Rate Scaling', op.rateScaling, 0, 7, (v) => { op.rateScaling = v; }));
        body.appendChild(scaleGroup);

        details.appendChild(body);
        paramsPanel.appendChild(details);
    }

    // Global parameters
    const g = currentMutation.globals;
    const globalSection = document.createElement('details');
    globalSection.className = 'dx7-op-section';
    globalSection.open = true;

    const gSummary = document.createElement('summary');
    gSummary.className = 'dx7-op-summary';
    gSummary.textContent = 'Global';
    globalSection.appendChild(gSummary);

    const gBody = document.createElement('div');
    gBody.className = 'dx7-op-body';

    // Algorithm + Feedback
    const algoGroup = document.createElement('div');
    algoGroup.className = 'dx7-param-group';
    algoGroup.appendChild(makeGroupLabel('Algorithm & Feedback'));
    algoGroup.appendChild(makeSlider('Algorithm', g.algorithm, 0, 31, (v) => {
        g.algorithm = v;
        algoLabel.textContent = 'Algorithm ' + (v + 1);
        renderAlgoSvg(v, algoSvgContainer);
    }));
    algoGroup.appendChild(makeSlider('Feedback', g.feedback, 0, 7, (v) => { g.feedback = v; }));
    algoGroup.appendChild(makeSlider('Key Sync', g.keySync, 0, 1, (v) => { g.keySync = v; }, () => g.keySync ? 'On' : 'Off'));
    gBody.appendChild(algoGroup);

    // LFO
    const lfoGroup = document.createElement('div');
    lfoGroup.className = 'dx7-param-group';
    lfoGroup.appendChild(makeGroupLabel('LFO'));
    lfoGroup.appendChild(makeSlider('Speed', g.lfoSpeed, 0, 99, (v) => { g.lfoSpeed = v; }));
    lfoGroup.appendChild(makeSlider('Delay', g.lfoDelay, 0, 99, (v) => { g.lfoDelay = v; }));
    lfoGroup.appendChild(makeSlider('PM Depth', g.lfoPmDepth, 0, 99, (v) => { g.lfoPmDepth = v; }));
    lfoGroup.appendChild(makeSlider('AMD', g.lfoAmd, 0, 99, (v) => { g.lfoAmd = v; }));
    lfoGroup.appendChild(makeSlider('Waveform', g.lfoWaveform, 0, 5, (v) => { g.lfoWaveform = v; }, () => WAVEFORM_NAMES[g.lfoWaveform]));
    lfoGroup.appendChild(makeSlider('Sync', g.lfoSync, 0, 1, (v) => { g.lfoSync = v; }, () => g.lfoSync ? 'On' : 'Off'));
    lfoGroup.appendChild(makeSlider('PM Sens', g.lfoPmSens, 0, 7, (v) => { g.lfoPmSens = v; }));
    gBody.appendChild(lfoGroup);

    // Pitch EG
    const pitchGroup = document.createElement('div');
    pitchGroup.className = 'dx7-param-group';
    pitchGroup.appendChild(makeGroupLabel('Pitch Envelope'));
    pitchGroup.appendChild(makeSlider('R1', g.pitchR1, 0, 99, (v) => { g.pitchR1 = v; }));
    pitchGroup.appendChild(makeSlider('R2', g.pitchR2, 0, 99, (v) => { g.pitchR2 = v; }));
    pitchGroup.appendChild(makeSlider('R3', g.pitchR3, 0, 99, (v) => { g.pitchR3 = v; }));
    pitchGroup.appendChild(makeSlider('R4', g.pitchR4, 0, 99, (v) => { g.pitchR4 = v; }));
    pitchGroup.appendChild(makeSlider('L1', g.pitchL1, 0, 99, (v) => { g.pitchL1 = v; }));
    pitchGroup.appendChild(makeSlider('L2', g.pitchL2, 0, 99, (v) => { g.pitchL2 = v; }));
    pitchGroup.appendChild(makeSlider('L3', g.pitchL3, 0, 99, (v) => { g.pitchL3 = v; }));
    pitchGroup.appendChild(makeSlider('L4', g.pitchL4, 0, 99, (v) => { g.pitchL4 = v; }));
    gBody.appendChild(pitchGroup);

    // Transpose
    const trGroup = document.createElement('div');
    trGroup.className = 'dx7-param-group';
    trGroup.appendChild(makeGroupLabel('Transpose'));
    trGroup.appendChild(makeSlider('Semitones', g.transpose, 0, 48, (v) => { g.transpose = v; }, () => {
        const diff = g.transpose - 24;
        return diff === 0 ? 'C4' : (diff > 0 ? '+' + diff : String(diff));
    }));
    gBody.appendChild(trGroup);

    globalSection.appendChild(gBody);
    algoPanel.appendChild(globalSection);

    layout.appendChild(algoPanel);
    layout.appendChild(paramsPanel);
    paramsArea.appendChild(layout);

    // Add play button to actions (below slot)
    const existingPlayBtn = actions.querySelector('.btn-edit-play');
    if (existingPlayBtn) existingPlayBtn.remove();
    const playBtn = document.createElement('button');
    playBtn.textContent = '▶ Play';
    playBtn.className = 'btn-edit-action btn-edit-play';
    playBtn.type = 'button';
    playBtn.addEventListener('click', previewParamsEdit);
    actions.insertBefore(playBtn, goBtn);

    goBtn.disabled = false;
    goBtn.textContent = 'Save as new';
    statusEl.textContent = `Editing ${editSlot.name} — tweak sliders, then save`;
}

function makeGroupLabel(text) {
    const el = document.createElement('div');
    el.className = 'dx7-group-label';
    el.textContent = text;
    return el;
}

function makeSlider(label, value, min, max, onChange, displayFn) {
    const row = document.createElement('div');
    row.className = 'dx7-slider-row';
    const lbl = document.createElement('span');
    lbl.className = 'dx7-slider-label';
    lbl.textContent = label;
    row.appendChild(lbl);
    const sl = document.createElement('input');
    sl.type = 'range'; sl.min = String(min); sl.max = String(max); sl.value = String(value);
    sl.className = 'dx7-slider';
    row.appendChild(sl);
    const val = document.createElement('span');
    val.className = 'dx7-slider-val';
    val.textContent = displayFn ? displayFn() : value;
    row.appendChild(val);
    sl.addEventListener('input', () => {
        const v = parseInt(sl.value);
        onChange(v);
        val.textContent = displayFn ? displayFn() : v;
    });
    return row;
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
        if (!resp.ok) throw new Error('Voice fetch failed: ' + resp.status);
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
    if (showProgressRef) showProgressRef(10);
    statusEl.textContent = 'Fetching patches...';

    try {
        const [srcData, tgtData] = await Promise.all([
            fetchVoiceData(editSlot),
            fetchVoiceData(editSlotB),
        ]);
        if (!srcData || !tgtData) {
            statusEl.textContent = 'Error: could not fetch voice data';
            if (hideProgressRef) hideProgressRef();
            goBtn.disabled = false;
            return;
        }

        if (showProgressRef) showProgressRef(50);
        statusEl.textContent = 'Morphing...';
        const resp = await fetch(baseUrlRef + '/api/morph', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_data: srcData, target_data: tgtData, note: 60, ratio })
        });
        if (!resp.ok) throw new Error('Morph failed: ' + resp.status);
        const data = await resp.json();
        if (data.error) {
            statusEl.textContent = 'Error: ' + data.error;
            if (hideProgressRef) hideProgressRef();
            goBtn.disabled = false;
            return;
        }

        if (showProgressRef) showProgressRef(100);
        statusEl.textContent = `Done — distance: ${data.source_dist.toFixed(4)} → ${data.morph_dist.toFixed(4)} (${ratioLabel(data.ratio)})`;
        if (data.wav_url) new Audio(baseUrlRef + data.wav_url).play();
        if (hideProgressRef) setTimeout(hideProgressRef, 500);

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
        if (hideProgressRef) hideProgressRef();
        goBtn.disabled = false;
    }
}

async function buildModifiedVoiceData() {
    if (!currentMutation) return null;
    let voiceData = await fetchVoiceData(editSlot);
    if (!voiceData || !currentMutation.ops) return voiceData;

    const bytes = decodeVoiceData(voiceData);

    for (let i = 0; i < 6; i++) {
        if (currentMutation.ops[i]) writeOp(bytes, i, currentMutation.ops[i]);
    }
    if (currentMutation.globals) writeGlobal(bytes, currentMutation.globals);

    return encodeVoiceData(bytes);
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
        if (!resp.ok) throw new Error('Preview failed: ' + resp.status);
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
        if (!resp.ok) throw new Error('Render failed: ' + resp.status);
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
        if (!resp.ok) throw new Error('Mutation preview failed: ' + resp.status);
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
            if (!resp.ok) throw new Error('Render failed: ' + resp.status);
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
