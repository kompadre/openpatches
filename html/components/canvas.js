// Canvas — the main visual area where patches and containers live.
// Replaces night-sky.js. Manages free-floating patches, PatchContainers,
// drag-to-reposition (star handle), and snap-into-container behavior.

import { canvasStore, patchStore, jobStore } from './patch-model.js';
import { createTagEditor } from './tag-editor.js';
import { createPatchRow, getDraggedPatch, clearDraggedPatch } from './patch-row.js';
import { decodeWavSamples, drawMiniWaveform } from './patch.js';
import { batchRenderWaveforms } from '../synth/dx7-synth.js';

let skyEl = null;
let canvasEl = null;
let optsRef = null;
let docListeners = [];

// --- Init ---

export function initCanvas(opts) {
    optsRef = opts;
    skyEl = document.getElementById('night-sky');
    skyEl.innerHTML = '';
    skyEl.classList.add('visible');

    canvasEl = document.createElement('div');
    canvasEl.className = 'night-sky-canvas';
    skyEl.appendChild(canvasEl);

    // "+ Container" button inside canvas
    const ctrBtn = document.createElement('button');
    ctrBtn.className = 'sky-ctr-btn';
    ctrBtn.textContent = '+ Container';
    ctrBtn.title = 'Create a container to group patches';
    ctrBtn.addEventListener('click', () => addContainer('Group'));
    canvasEl.appendChild(ctrBtn);

    // Drop target for patches dragged from external lists
    canvasEl.addEventListener('dragover', (e) => {
        if (!getDraggedPatch() && !window._draggedPatch) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        canvasEl.classList.add('drag-over-sky');
    });
    canvasEl.addEventListener('dragleave', (e) => {
        if (!canvasEl.contains(e.relatedTarget)) {
            canvasEl.classList.remove('drag-over-sky');
        }
    });
    canvasEl.addEventListener('drop', (e) => {
        e.preventDefault();
        canvasEl.classList.remove('drag-over-sky');
        const patch = getDraggedPatch() || window._draggedPatch;
        if (!patch) return;

        const rect = canvasEl.getBoundingClientRect();
        const left = e.clientX - rect.left + (skyEl.scrollLeft || 0);
        const top = e.clientY - rect.top + (skyEl.scrollTop || 0);

        // Store patch in patchStore if not already there
        const stored = patchStore.get(patch.id);
        if (!stored) patchStore.put(patch);

        // Remove from source container if it was in one
        const existing = canvasStore.getCanvasPatch(patch.id);
        if (existing && existing.containerId) {
            const srcCtr = canvasStore.getContainer(existing.containerId);
            if (srcCtr) {
                srcCtr.patchIds = (srcCtr.patchIds || []).filter(id => id !== patch.id);
                canvasStore.putContainer(srcCtr);
            }
        }

        addPatchToCanvas(patch.id, left, top, null);
        clearDraggedPatch();
        window._draggedPatch = null;
    });

    renderAll();

    // Handle touch-drop from patch rows (mobile: reorder, cross-container, or free-float)
    window.addEventListener('touch-drop-patch', () => {
        const patch = window._touchDropPatch;
        const containerId = window._touchDropContainerId;
        if (patch) {
            const existing = canvasStore.getCanvasPatch(patch.id);
            if (containerId) {
                // Cross-container drop
                if (existing && existing.containerId) {
                    const srcCtr = canvasStore.getContainer(existing.containerId);
                    if (srcCtr) {
                        srcCtr.patchIds = (srcCtr.patchIds || []).filter(id => id !== patch.id);
                        canvasStore.putContainer(srcCtr);
                    }
                }
                addPatchToContainer(patch.id, containerId);
            } else if (window._touchDropX != null) {
                // Free-floating on canvas — remove from old container if any
                if (existing && existing.containerId) {
                    const srcCtr = canvasStore.getContainer(existing.containerId);
                    if (srcCtr) {
                        srcCtr.patchIds = (srcCtr.patchIds || []).filter(id => id !== patch.id);
                        canvasStore.putContainer(srcCtr);
                    }
                }
                const rect = canvasEl.getBoundingClientRect();
                const left = window._touchDropX - rect.left + (skyEl.scrollLeft || 0);
                const top = window._touchDropY - rect.top + (skyEl.scrollTop || 0);
                addPatchToCanvas(patch.id, Math.max(0, left), Math.max(0, top), null);
            }
        }
        renderAll();
        window._touchDropPatch = null;
        window._touchDropContainerId = null;
        window._touchDropX = null;
        window._touchDropY = null;
    });
}

// --- Patch on canvas ---

export function addPatchToCanvas(patchId, left, top, containerId) {
    const existing = canvasStore.getCanvasPatch(patchId);
    if (existing) {
        // Update position
        existing.left = left;
        existing.top = top;
        if (containerId !== undefined) existing.containerId = containerId;
        canvasStore.putCanvasPatch(patchId, existing);
    } else {
        canvasStore.putCanvasPatch(patchId, {
            left, top,
            containerId: containerId || null,
            minified: true,
        });
    }
    renderAll();
}

export function removePatchFromCanvas(patchId) {
    const entry = canvasStore.getCanvasPatch(patchId);
    if (entry && entry.containerId) {
        // Remove from container's patchIds
        const ctr = canvasStore.getContainer(entry.containerId);
        if (ctr) {
            ctr.patchIds = (ctr.patchIds || []).filter(id => id !== patchId);
            canvasStore.putContainer(ctr);
        }
    }
    canvasStore.removeCanvasPatch(patchId);
    const el = canvasEl.querySelector(`[data-patch-id="${patchId}"]`);
    if (el) el.remove();
}

// --- Container ---

export function addContainer(name, opts = {}) {
    const ctr = {
        id: opts.id || ('ctr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5)),
        name: name || 'Container',
        left: opts.left || 50 + Math.random() * 100,
        top: opts.top || 50 + Math.random() * 100,
        width: opts.width || 260,
        jobId: opts.jobId || null,
        patchIds: opts.patchIds || [],
        tags: opts.tags || [],
    };
    canvasStore.putContainer(ctr);
    renderAll();
    return ctr;
}

export function addPatchToContainer(patchId, containerId) {
    // Update canvas patch entry
    canvasStore.putCanvasPatch(patchId, { containerId, left: 0, top: 0, minified: true });

    // Update container's patchIds
    const ctr = canvasStore.getContainer(containerId);
    if (ctr) {
        if (!ctr.patchIds) ctr.patchIds = [];
        if (!ctr.patchIds.includes(patchId)) ctr.patchIds.push(patchId);
        canvasStore.putContainer(ctr);
    }
    renderAll();
}

export function removeContainer(id) {
    const ctr = canvasStore.getContainer(id);
    if (!ctr) return;

    // Confirm if container has patches
    if (ctr.patchIds && ctr.patchIds.length > 0) {
        if (!confirm(`Remove "${ctr.name}" and its ${ctr.patchIds.length} patch(es)?`)) return;
    }

    // Only remove canvas entries that belong to this container
    if (ctr.patchIds) {
        for (const pid of ctr.patchIds) {
            const entry = canvasStore.getCanvasPatch(pid);
            if (entry && entry.containerId === id) {
                canvasStore.removeCanvasPatch(pid);
            }
        }
    }
    canvasStore.removeContainer(id);
    renderAll();
}

// --- Render ---

export function refreshCanvas() {
    renderAll();
}

function onDoc(event, handler, opts) {
    document.addEventListener(event, handler, opts);
    docListeners.push({ event, handler, opts });
}

function clearDocListeners() {
    for (const l of docListeners) {
        document.removeEventListener(l.event, l.handler, l.opts);
    }
    docListeners = [];
}

function renderAll() {
    if (!canvasEl) return;
    clearDocListeners();
    canvasEl.querySelectorAll('.patch-float, .sky-container').forEach(el => el.remove());

    const containers = canvasStore.getContainers();
    const canvasPatches = canvasStore.getCanvasPatches();

    // Render containers
    for (const ctr of Object.values(containers)) {
        renderContainer(ctr);
    }

    // Render free-floating patches (not in a container)
    for (const [patchId, entry] of Object.entries(canvasPatches)) {
        if (entry.containerId) continue; // rendered inside container
        renderFloatingPatch(patchId, entry);
    }
}

function renderFloatingPatch(patchId, entry) {
    const patch = patchStore.get(patchId);
    if (!patch) return;

    const el = document.createElement('div');
    el.className = 'patch-float' + (entry.minified ? ' minified' : '');
    el.style.left = entry.left + 'px';
    el.style.top = entry.top + 'px';
    el.dataset.patchId = patchId;

    // Star (drag handle)
    const star = document.createElement('button');
    star.className = 'patch-star fav-active';
    star.textContent = '★';
    star.title = 'Drag to move';
    el.appendChild(star);

    // Name
    const nameEl = document.createElement('span');
    nameEl.className = 'patch-name';
    nameEl.textContent = patch.name;
    el.appendChild(nameEl);

    // Assign to voicebank
    const assignBtn = document.createElement('button');
    assignBtn.className = 'patch-assign';
    assignBtn.textContent = '♫';
    assignBtn.title = 'Add to voicebank';
    assignBtn.style.opacity = '1';
    assignBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (optsRef && optsRef.onSelect) optsRef.onSelect(patch);
    });
    el.appendChild(assignBtn);

    // Edit button (new)
    const editBtn = document.createElement('button');
    editBtn.className = 'patch-edit-btn-inline';
    editBtn.textContent = '🔧';
    editBtn.title = 'Edit patch';
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (optsRef && optsRef.onEdit) optsRef.onEdit(patch);
    });
    el.appendChild(editBtn);

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'sky-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove from canvas';
    removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removePatchFromCanvas(patchId);
    });
    el.appendChild(removeBtn);

    // Expanded fields
    if (!entry.minified) {
        appendFullFields(el, patch);
    }

    // Drag to reposition (from star)
    let dragging = false;
    let startX, startY, origLeft, origTop;
    let didMove = false;

    function handleStart(e) {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        didMove = false;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX;
        startY = clientY;
        origLeft = entry.left;
        origTop = entry.top;
        el.style.cursor = 'grabbing';
        el.style.zIndex = 100;
        el.style.transition = 'none';
    }

    function handleMove(e) {
        if (!dragging) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const dx = clientX - startX;
        const dy = clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didMove = true;
        entry.left = Math.max(0, origLeft + dx);
        entry.top = Math.max(0, origTop + dy);
        el.style.left = entry.left + 'px';
        el.style.top = entry.top + 'px';
    }

    function handleEnd(e) {
        if (!dragging) return;
        dragging = false;
        el.style.cursor = '';
        el.style.zIndex = '';
        el.style.transition = '';

        const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
        const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;

        // Check if dropped over a container
        const hitContainer = findContainerUnder(clientX, clientY);
        if (hitContainer && hitContainer.id) {
            // Snap into container
            removePatchFromCanvas(patchId);
            addPatchToContainer(patchId, hitContainer.id);
        } else {
            // Save free-floating position
            canvasStore.putCanvasPatch(patchId, { left: entry.left, top: entry.top });
        }
    }

    star.addEventListener('mousedown', handleStart);
    onDoc('mousemove', handleMove);
    onDoc('mouseup', handleEnd);

    star.addEventListener('touchstart', handleStart, { passive: false });
    onDoc('touchmove', handleMove, { passive: false });
    onDoc('touchend', handleEnd);

    // Click to expand/collapse (not on star)
    el.addEventListener('click', (e) => {
        if (e.target === star || didMove) return;
        entry.minified = !entry.minified;
        el.classList.toggle('minified', entry.minified);
        if (entry.minified) {
            el.querySelectorAll('.patch-spec, .patch-col, .patch-edit-btn').forEach(n => n.remove());
        } else {
            appendFullFields(el, patch);
        }
        canvasStore.putCanvasPatch(patchId, { minified: entry.minified });
    });

    canvasEl.appendChild(el);
}

function appendFullFields(el, patch) {
    const nameEl = el.querySelector('.patch-name');
    if (!nameEl) return;

    // Spec
    const specWrap = document.createElement('div');
    specWrap.className = 'patch-spec';
    const canvas = document.createElement('canvas');
    canvas.width = 180;
    canvas.height = 48;
    canvas.className = 'patch-canvas';
    specWrap.appendChild(canvas);
    const playBtn = document.createElement('button');
    playBtn.className = 'patch-play';
    playBtn.textContent = '▶';
    playBtn.title = 'Play';
    specWrap.appendChild(playBtn);

    // Algo
    const algoEl = document.createElement('span');
    algoEl.className = 'patch-col patch-algo';
    algoEl.textContent = patch.algorithm;

    // FB
    const fbEl = document.createElement('span');
    fbEl.className = 'patch-col patch-fb';
    fbEl.textContent = patch.feedback;

    // Dist (from canvas entry — may not have distance)
    const distEl = document.createElement('span');
    distEl.className = 'patch-col patch-dist';
    distEl.textContent = (patch.distance || 0).toFixed(4);

    // Append in order after name
    nameEl.insertAdjacentElement('afterend', distEl);

    // Tags
    const tagsWrapper = document.createElement('div');
    tagsWrapper.className = 'patch-tags-canvas';
    tagsWrapper.appendChild(createTagEditor(patch, (updated) => patchStore.put(updated)));
    nameEl.insertAdjacentElement('afterend', tagsWrapper);

    nameEl.insertAdjacentElement('afterend', fbEl);
    nameEl.insertAdjacentElement('afterend', algoEl);
    nameEl.insertAdjacentElement('afterend', specWrap);

    // Play handler
    if (optsRef && optsRef.onPlay) {
        playBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            try {
                const wavUrl = await optsRef.onPlay(patch);
                if (wavUrl) {
                    const resp = await fetch(wavUrl);
                    const buf = await resp.arrayBuffer();
                    const samples = decodeWavSamples(buf);
                    if (samples && samples.length > 0) drawMiniWaveform(canvas, samples);
                }
            } catch (err) {
                console.warn('[canvas] play failed:', err);
            }
        });
    }

    // Render waveform in background if voice_data available
    if (patch.voice_data) {
        batchRenderWaveforms(
            [{ voiceData: patch.voice_data, canvas }],
            (cvs, blob) => {
                blob.arrayBuffer().then(buf => {
                    const samples = decodeWavSamples(buf);
                    if (samples && samples.length > 0) drawMiniWaveform(cvs, samples);
                });
            }
        );
    }
}

// --- Container rendering ---

function renderContainer(ctr) {
    const el = document.createElement('div');
    el.className = 'sky-container';
    el.style.left = ctr.left + 'px';
    el.style.top = ctr.top + 'px';
    el.style.width = ctr.width + 'px';
    if (ctr.jobId) el.style.minWidth = '300px';
    el.dataset.containerId = ctr.id;

    // Header
    const header = document.createElement('div');
    header.className = 'sky-container-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'sky-container-header-left';

    const headerName = document.createElement('span');
    headerName.textContent = ctr.name;
    headerName.className = 'sky-container-name';

    // Check if this is a job container — derive state from job
    const job = ctr.jobId ? jobStore.get(ctr.jobId) : null;
    const isActiveJob = job && (job.status === 'probe_ready' || job.status === 'polling');
    const isFailedJob = job && job.status === 'failed';

    if (isFailedJob) {
        headerName.classList.add('sky-container-name-failed');
    }

    // Rename on double-click
    headerName.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        headerName.contentEditable = 'true';
        headerName.focus();
        const range = document.createRange();
        range.selectNodeContents(headerName);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });
    headerName.addEventListener('blur', () => {
        headerName.contentEditable = 'false';
        const newName = headerName.textContent.trim();
        if (newName && newName !== ctr.name) {
            ctr.name = newName;
            canvasStore.putContainer(ctr);
        }
    });
    headerName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            headerName.blur();
        }
        if (e.key === 'Escape') {
            headerName.textContent = ctr.name;
            headerName.contentEditable = 'false';
        }
    });

    headerLeft.appendChild(headerName);
    header.appendChild(headerLeft);

    const headerRight = document.createElement('div');
    headerRight.className = 'sky-container-header-right';

    // Assign to pianoroll button (assigns first 8 patches to voicebank)
    const assignBtn = document.createElement('button');
    assignBtn.className = 'sky-container-assign';
    assignBtn.textContent = '♫';
    assignBtn.title = 'Assign patches to pianoroll';
    assignBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (optsRef && optsRef.onAssignToPianoroll) {
            const patches = (ctr.patchIds || [])
                .slice(0, 8)
                .map(id => patchStore.get(id))
                .filter(Boolean);
            optsRef.onAssignToPianoroll(patches);
        }
    });
    headerRight.appendChild(assignBtn);

    // Sort button
    const sortBtn = document.createElement('button');
    sortBtn.className = 'sky-container-sort';
    sortBtn.textContent = '↕';
    sortBtn.title = 'Sort patches by algorithm';
    sortBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (optsRef && optsRef.onSortContainer) {
            optsRef.onSortContainer(ctr);
        }
    });
    headerRight.appendChild(sortBtn);

    // Export as .SYX button
    const exportBtn = document.createElement('button');
    exportBtn.className = 'sky-container-export';
    exportBtn.textContent = '💾';
    exportBtn.title = 'Export as .SYX';
    exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (optsRef && optsRef.onExportContainer) {
            const patches = (ctr.patchIds || [])
                .map(id => patchStore.get(id))
                .filter(p => p && p.voice_data);
            optsRef.onExportContainer(patches, ctr.name);
        }
    });
    headerRight.appendChild(exportBtn);

    // Minimize toggle for active job containers
    if (isActiveJob || isFailedJob) {
        const minBtn = document.createElement('button');
        minBtn.className = 'sky-container-minimize';
        minBtn.textContent = '▼';
        minBtn.title = 'Minimize/expand';
        headerRight.appendChild(minBtn);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'sky-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove container';
    removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeContainer(ctr.id);
    });
    headerRight.appendChild(removeBtn);

    header.appendChild(headerRight);
    el.appendChild(header);

    // Tags
    const tagsWrapper = document.createElement('div');
    tagsWrapper.className = 'sky-container-tags';
    tagsWrapper.appendChild(createTagEditor(ctr, (updated) => canvasStore.putContainer(updated)));
    el.appendChild(tagsWrapper);

    // Body
    const body = document.createElement('div');
    body.className = 'sky-container-body';

    // Container body content: job-driven (probe/status) AND/OR patch list
    const hasJobUI = job && optsRef && optsRef.renderJobBody;

    if (hasJobUI) {
        body.classList.add('container-body-probe');
        ctr.width = Math.max(ctr.width, 380);
        el.style.width = ctr.width + 'px';
        optsRef.renderJobBody(job, body);
    }

    const patches = (ctr.patchIds || []).map(id => patchStore.get(id)).filter(Boolean);
    if (patches.length > 0) {
        if (hasJobUI) {
            const hr = document.createElement('hr');
            hr.className = 'container-results-sep';
            body.appendChild(hr);
        }

        for (const patch of patches) {
            const row = createPatchRow(patch, {
                isMinified: true,
                onPlay: optsRef ? optsRef.onPlay : null,
                onSelect: optsRef ? optsRef.onSelect : null,
                onEdit: optsRef ? optsRef.onEdit : null,
                onRemove: (p) => {
                    ctr.patchIds = (ctr.patchIds || []).filter(id => id !== p.id);
                    canvasStore.putContainer(ctr);
                    const canvasPatch = canvasStore.getCanvasPatch(p.id);
                    if (canvasPatch && canvasPatch.containerId === ctr.id) {
                        canvasStore.removeCanvasPatch(p.id);
                    }
                    renderAll();
                },
            });
            body.appendChild(row);
        }

        // Batch render waveforms for minimized patches
        const patchEls = [];
        body.querySelectorAll('.patch-row').forEach(row => {
            const pid = row.dataset.patchId;
            const p = patches.find(pp => pp.id === pid);
            if (p && p.voice_data) {
                const cvs = row.querySelector('.patch-canvas');
                if (cvs) patchEls.push({ voiceData: p.voice_data, canvas: cvs });
            }
        });
        if (patchEls.length > 0) {
            batchRenderWaveforms(patchEls, (canvas, blob) => {
                blob.arrayBuffer().then(buf => {
                    const samples = decodeWavSamples(buf);
                    if (samples && samples.length > 0) drawMiniWaveform(canvas, samples);
                });
            });
        }
    }

    el.appendChild(body);

    // Resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'sky-container-resize';
    el.appendChild(resizeHandle);

    let resizing = false;
    let resizeStartX, resizeStartY, resizeStartW, resizeStartH;
    
    function handleResizeStart(e) {
        e.preventDefault();
        e.stopPropagation();
        resizing = true;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        resizeStartX = clientX;
        resizeStartY = clientY;
        resizeStartW = el.offsetWidth;
        resizeStartH = el.offsetHeight;
        el.style.zIndex = 60;
    }

    function handleResizeMove(e) {
        if (!resizing) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const maxW = canvasEl ? canvasEl.scrollWidth : window.innerWidth;
        const newW = Math.max(200, Math.min(maxW, resizeStartW + (clientX - resizeStartX)));
        const newH = Math.max(80, resizeStartH + (clientY - resizeStartY));
        el.style.width = newW + 'px';
        el.style.height = newH + 'px';
        ctr.width = newW;
    }

    function handleResizeEnd() {
        if (!resizing) return;
        resizing = false;
        el.style.zIndex = '';
        canvasStore.putContainer(ctr);
    }

    resizeHandle.addEventListener('mousedown', handleResizeStart);
    onDoc('mousemove', handleResizeMove);
    onDoc('mouseup', handleResizeEnd);

    resizeHandle.addEventListener('touchstart', handleResizeStart, { passive: false });
    onDoc('touchmove', handleResizeMove, { passive: false });
    onDoc('touchend', handleResizeEnd);

    // Minimize toggle for probe containers
    const minBtn = headerRight.querySelector('.sky-container-minimize');
    if (minBtn) {
        let minimized = false;
        minBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            minimized = !minimized;
            body.style.display = minimized ? 'none' : '';
            minBtn.textContent = minimized ? '▶' : '▼';
            el.style.minHeight = minimized ? '0' : '80px';
        });
    }

    // Drag container by header
    let dragging = false;
    let startX, startY, origLeft, origTop;
    let didMove = false;

    function handleDragStart(e) {
        if (e.target.contentEditable === 'true') return;
        if (e.target.closest('button')) return;
        e.preventDefault();
        dragging = true;
        didMove = false;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX;
        startY = clientY;
        origLeft = ctr.left;
        origTop = ctr.top;
        el.style.zIndex = 50;
    }

    function handleDragMove(e) {
        if (!dragging) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const dx = clientX - startX;
        const dy = clientY - startY;
        if (!didMove && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        didMove = true;
        e.preventDefault();
        const maxLeft = canvasEl ? canvasEl.scrollWidth - el.offsetWidth : window.innerWidth - el.offsetWidth;
        ctr.left = Math.max(0, Math.min(maxLeft, origLeft + dx));
        ctr.top = Math.max(0, origTop + dy);
        el.style.left = ctr.left + 'px';
        el.style.top = ctr.top + 'px';
    }

    function handleDragEnd() {
        if (!dragging) return;
        dragging = false;
        el.style.zIndex = '';
        if (didMove) canvasStore.putContainer(ctr);
    }

    header.addEventListener('mousedown', handleDragStart);
    onDoc('mousemove', handleDragMove);
    onDoc('mouseup', handleDragEnd);

    header.addEventListener('touchstart', handleDragStart, { passive: false });
    onDoc('touchmove', handleDragMove, { passive: false });
    onDoc('touchend', handleDragEnd);

    // Drop patches into container (from external lists)
    el.addEventListener('dragover', (e) => {
        const patch = getDraggedPatch() || window._draggedPatch;
        if (!patch) return;
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('drag-over-container');
    });
    el.addEventListener('dragleave', (e) => {
        if (!el.contains(e.relatedTarget)) {
            el.classList.remove('drag-over-container');
        }
    });
    el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-over-container');
        const patch = getDraggedPatch() || window._draggedPatch;
        if (!patch) return;

        // Store patch if not already
        const stored = patchStore.get(patch.id);
        if (!stored) patchStore.put(patch);

        addPatchToContainer(patch.id, ctr.id);
        clearDraggedPatch();
        window._draggedPatch = null;
    });

    canvasEl.appendChild(el);

    // Render spectrogram for WAV-import containers (if jobId exists)
    // Insert into headerLeft so it appears between name and buttons
    if (ctr.jobId && optsRef && optsRef.onLoadJobWav) {
        optsRef.onLoadJobWav(ctr.jobId, (arrayBuffer) => {
            const samples = decodeWavSamples(arrayBuffer);
            if (samples && samples.length > 0) {
                const specCanvas = document.createElement('canvas');
                specCanvas.width = 240;
                specCanvas.height = 48;
                specCanvas.className = 'container-spectrogram';
                specCanvas.title = 'Click to play original';
                specCanvas.style.cursor = 'pointer';
                drawMiniWaveform(specCanvas, samples);
                specCanvas.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (optsRef.onPlayOriginal) optsRef.onPlayOriginal(ctr.jobId);
                });
                headerLeft.appendChild(specCanvas);
            }
        });
    }
}

// --- Utilities ---

function findContainerUnder(clientX, clientY) {
    const containers = canvasStore.getContainers();
    for (const ctr of Object.values(containers)) {
        const el = canvasEl.querySelector(`[data-container-id="${ctr.id}"]`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
            return ctr;
        }
    }
    return null;
}
