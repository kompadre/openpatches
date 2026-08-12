// Unified patch row rendering — used on canvas, in containers, and in edit panel.

import { decodeWavSamples, drawMiniWaveform, wavSampleCache } from './patch.js';
import { createTagEditor } from './tag-editor.js';
import { patchStore } from './patch-model.js';
import { batchRenderWaveforms } from '../synth/dx7-synth.js';

// Global drag state (shared with canvas.js for drop detection)
let _draggedPatch = null;
export function getDraggedPatch() { return _draggedPatch; }
export function clearDraggedPatch() { _draggedPatch = null; }

// --- Star drag handle (for dragging patches out of lists onto canvas) ---

export function makeStarDraggable(star, row, patch) {
    star.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        row.draggable = true;
    });
    document.addEventListener('mouseup', () => {
        row.draggable = false;
    });

    row.addEventListener('dragstart', (e) => {
        _draggedPatch = patch;
        window._draggedPatch = patch;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
        requestAnimationFrame(() => row.classList.add('drag-ghost'));
    });
    row.addEventListener('dragend', () => {
        row.classList.remove('dragging', 'drag-ghost');
        row.draggable = false;
        _draggedPatch = null;
        window._draggedPatch = null;
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
}

// --- Patch row ---

export function createPatchRow(patch, opts = {}) {
    const {
        onSelect, onPlay, onEdit, onRemove,
        baseUrl, isSelected, isMinified,
    } = opts;

    const row = document.createElement('div');
    row.className = 'patch-row' + (isSelected ? ' selected' : '') + (isMinified ? ' patch-row-minified' : '');
    row.dataset.patchId = patch.id;

    // Star (drag handle)
    const star = document.createElement('button');
    star.className = 'patch-star fav-active';
    star.textContent = '★';
    star.title = 'Drag to canvas';
    row.appendChild(star);
    makeStarDraggable(star, row, patch);

    if (isMinified) {
        // Minified: star + name + mini spec + play + assign
        const nameEl = document.createElement('span');
        nameEl.className = 'patch-name';
        nameEl.textContent = patch.name || ('#' + (patch.rank || ''));
        nameEl.title = patch.name || ('#' + (patch.rank || ''));
        row.appendChild(nameEl);

        // Mini spectrogram + play button
        const specWrap = document.createElement('div');
        specWrap.className = 'patch-spec patch-spec-mini';
        const specCanvas = document.createElement('canvas');
        specCanvas.width = 120;
        specCanvas.height = 32;
        specCanvas.className = 'patch-canvas';
        specWrap.appendChild(specCanvas);

        const playBtn = document.createElement('button');
        playBtn.className = 'patch-play';
        playBtn.textContent = '▶';
        playBtn.title = 'Play';
        specWrap.appendChild(playBtn);

        if (onPlay) {
            let waveformDrawn = false;
            playBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const result = onPlay(patch);
                if (!waveformDrawn && result && typeof result.then === 'function') {
                    try {
                        const wavUrl = await result;
                        if (wavUrl && !waveformDrawn) {
                            waveformDrawn = true;
                            const wavResp = await fetch(wavUrl);
                            const wavBuf = await wavResp.arrayBuffer();
                            const samples = decodeWavSamples(wavBuf);
                            if (samples && samples.length > 0) drawMiniWaveform(specCanvas, samples);
                        }
                    } catch (_) {}
                }
            });
        }
        row.appendChild(specWrap);

        const assignBtn = document.createElement('button');
        assignBtn.className = 'patch-assign';
        assignBtn.textContent = '♫';
        assignBtn.title = 'Add to voicebank';
        assignBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onSelect) onSelect(patch);
        });
        row.appendChild(assignBtn);

        if (onEdit) {
            const editBtn = document.createElement('button');
            editBtn.className = 'patch-edit-btn';
            editBtn.textContent = '🔧';
            editBtn.title = 'Edit patch';
            editBtn.style.opacity = '0.6';
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onEdit(patch);
            });
            row.appendChild(editBtn);
        }

        if (onRemove) {
            const removeBtn = document.createElement('button');
            removeBtn.className = 'sky-remove';
            removeBtn.textContent = '×';
            removeBtn.title = 'Remove';
            removeBtn.style.opacity = '0.6';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onRemove(patch);
            });
            row.appendChild(removeBtn);
        }

        // Rename on double-click
        nameEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            nameEl.contentEditable = 'true';
            nameEl.focus();
            const range = document.createRange();
            range.selectNodeContents(nameEl);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });
        nameEl.addEventListener('blur', () => {
            nameEl.contentEditable = 'false';
            const newName = nameEl.textContent.trim();
            if (newName && newName !== patch.name) {
                patch.name = newName;
                import('./patch-model.js').then(m => m.patchStore.put(patch));
            }
        });
        nameEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                nameEl.blur();
            }
            if (e.key === 'Escape') {
                nameEl.textContent = patch.name;
                nameEl.contentEditable = 'false';
            }
        });

        // Tap to activate (mobile) — makes row draggable
        row.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            const wasActive = row.classList.contains('active');
            row.parentElement.querySelectorAll('.patch-row.active').forEach(r => r.classList.remove('active'));
            if (!wasActive) row.classList.add('active');
        });

        // Touch drag when active — creates floating clone
        row.addEventListener('touchstart', (e) => {
            if (!row.classList.contains('active')) return;
            if (e.target.tagName === 'BUTTON') return;
            const touch = e.touches[0];
            const startX = touch.clientX;
            const startY = touch.clientY;
            let clone = null;
            let didMove = false;

            function onMove(ev) {
                const t = ev.touches[0];
                const dx = Math.abs(t.clientX - startX);
                const dy = Math.abs(t.clientY - startY);
                if (!didMove && (dx > 8 || dy > 8)) {
                    didMove = true;
                    // Create floating clone
                    clone = row.cloneNode(true);
                    clone.className = 'patch-row patch-row-minified patch-drag-clone';
                    clone.style.position = 'fixed';
                    clone.style.zIndex = '10000';
                    clone.style.pointerEvents = 'none';
                    clone.style.width = row.offsetWidth + 'px';
                    clone.style.opacity = '0.85';
                    document.body.appendChild(clone);
                    row.classList.add('dragging');
                    _draggedPatch = patch;
                    window._draggedPatch = patch;
                }
                if (clone) {
                    ev.preventDefault();
                    clone.style.left = (t.clientX - 20) + 'px';
                    clone.style.top = (t.clientY - 15) + 'px';
                }
            }

            function onEnd(ev) {
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
                if (clone) {
                    clone.remove();
                    row.classList.remove('dragging');
                    // Find container under the last touch position
                    const t = ev.changedTouches[0];
                    const el = document.elementFromPoint(t.clientX, t.clientY);
                    const containerEl = el ? el.closest('.sky-container') : null;
                    if (containerEl && containerEl.dataset.containerId) {
                        window._touchDropPatch = patch;
                        window._touchDropContainerId = containerEl.dataset.containerId;
                        // Dispatch a custom event so canvas.js can handle it
                        window.dispatchEvent(new CustomEvent('touch-drop-patch'));
                    }
                    _draggedPatch = null;
                    window._draggedPatch = null;
                }
            }

            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        }, { passive: true });
    } else {
        // Full row: spec + name + algo + fb + dist + actions

        // Spectrogram + play button
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

        if (onPlay) {
            let waveformDrawn = false;
            playBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const result = onPlay(patch);
                if (!waveformDrawn && result && typeof result.then === 'function') {
                    try {
                        const wavUrl = await result;
                        if (wavUrl && !waveformDrawn) {
                            waveformDrawn = true;
                            const wavResp = await fetch(wavUrl);
                            const wavBuf = await wavResp.arrayBuffer();
                            const samples = decodeWavSamples(wavBuf);
                            if (samples && samples.length > 0) drawMiniWaveform(canvas, samples);
                        }
                    } catch (_) {}
                }
            });
        }

        row.appendChild(specWrap);

        // Fetch and render waveform from server wav_url (cached)
        if (patch.wav_url) {
            const wavUrl = (baseUrl || '') + patch.wav_url;
            const cached = wavSampleCache.get(wavUrl);
            if (cached) {
                if (cached.length > 0) drawMiniWaveform(canvas, cached);
            } else {
                fetch(wavUrl)
                    .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
                    .then(buf => {
                        const samples = decodeWavSamples(buf);
                        if (samples && samples.length > 0) {
                            wavSampleCache.set(wavUrl, samples);
                            drawMiniWaveform(canvas, samples);
                        }
                    })
                    .catch(() => {});
            }
        }

        // Name
        const nameEl = document.createElement('span');
        nameEl.className = 'patch-name';
        nameEl.textContent = patch.name || ('#' + (patch.rank || ''));
        nameEl.title = patch.name || ('#' + (patch.rank || ''));
        row.appendChild(nameEl);

        // Algo
        const algoEl = document.createElement('span');
        algoEl.className = 'patch-col patch-algo';
        algoEl.textContent = patch.algorithm;
        row.appendChild(algoEl);

        // FB
        const fbEl = document.createElement('span');
        fbEl.className = 'patch-col patch-fb';
        fbEl.textContent = patch.feedback;
        row.appendChild(fbEl);

        // Dist
        const distEl = document.createElement('span');
        distEl.className = 'patch-col patch-dist';
        distEl.textContent = (patch.distance || 0).toFixed(4);
        row.appendChild(distEl);

        // Tags
        const tagsWrapper = document.createElement('div');
        tagsWrapper.className = 'patch-tags';
        tagsWrapper.appendChild(createTagEditor(patch, (updated) => patchStore.put(updated)));
        row.appendChild(tagsWrapper);

        // Assign to voicebank
        const assignBtn = document.createElement('button');
        assignBtn.className = 'patch-assign';
        assignBtn.textContent = '♫';
        assignBtn.title = 'Add to voicebank';
        assignBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onSelect) onSelect(patch);
        });
        row.appendChild(assignBtn);

        // Edit button
        if (onEdit) {
            const editBtn = document.createElement('button');
            editBtn.className = 'patch-edit-btn';
            editBtn.textContent = '🔧';
            editBtn.title = 'Edit patch';
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onEdit(patch);
            });
            row.appendChild(editBtn);
        }

        // Remove button (for canvas context)
        if (onRemove) {
            const removeBtn = document.createElement('button');
            removeBtn.className = 'sky-remove';
            removeBtn.textContent = '×';
            removeBtn.title = 'Remove';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onRemove(patch);
            });
            row.appendChild(removeBtn);
        }

        // Click row → select
        row.addEventListener('click', () => {
            if (onSelect) onSelect(patch);
        });
    }

    // Store patch data reference
    row._patch = patch;
    return row;
}

// --- Batch render waveforms for a set of patch rows ---

export function batchRenderPatchRows(container, patches, baseUrl, midiNote) {
    const patchEls = [];
    container.querySelectorAll('.patch-row').forEach(row => {
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
        }, midiNote);
    }
}
