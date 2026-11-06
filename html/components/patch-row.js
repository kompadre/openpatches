// Unified patch row rendering — used on canvas, in containers, and in edit panel.

import { decodeWavSamples, drawMiniWaveform, wavSampleCache, releaseWavUrl } from './patch.js';
import { createTagEditor } from './tag-editor.js';
import { patchStore, canvasStore, voiceKey } from './patch-model.js';
import { batchRenderWaveforms } from '../synth/dx7-synth.js';
import { slotAt, dropOnSlot } from './slot-drop.js';

// Global drag state (shared with canvas.js for drop detection)
let _draggedPatch = null;
export function getDraggedPatch() { return _draggedPatch; }
export function clearDraggedPatch() { _draggedPatch = null; }

// --- Star drag handle (for dragging patches out of lists onto canvas) ---

// Only one row can be armed at a time, so a single document listener
// disarms it. The previous per-row listener was never removed, and rows are
// re-created on every canvas render.
let _armedRow = null;
let _armedListenerInstalled = false;

export function makeStarDraggable(star, row, patch) {
    star.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        row.draggable = true;
        _armedRow = row;
    });
    if (!_armedListenerInstalled) {
        _armedListenerInstalled = true;
        document.addEventListener('mouseup', () => {
            if (_armedRow) _armedRow.draggable = false;
            _armedRow = null;
        });
    }

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

// Move `patchId` next to `targetId` in a list, in place. Returns false if
// either id is missing from the list.
function moveWithin(list, patchId, targetId, before) {
    const fromIdx = list.indexOf(patchId);
    let toIdx = list.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return false;
    if (!before) toIdx++;
    list.splice(fromIdx, 1);
    if (toIdx > fromIdx) toIdx--;
    list.splice(toIdx, 0, patchId);
    return true;
}

/**
 * Touch reorder of a patch inside a container. A grouped container (WAV
 * match results) renders `group.patchIds`, a flat one renders
 * `ctr.patchIds`, so the move is applied to whichever group holds both rows
 * and to the flat list, and only persisted when something actually moved.
 */
export function reorderContainerPatch(containerId, patchId, targetId, before) {
    const ctr = canvasStore.getContainer(containerId);
    if (!ctr || patchId === targetId) return false;
    let moved = false;
    if (ctr.groups && ctr.groups.length > 0) {
        // Grouped: the rows on screen are a group's list, so a move only
        // counts if some group holds both ids. Across groups it is refused.
        for (const g of ctr.groups) {
            if (moveWithin(g.patchIds || [], patchId, targetId, before)) { moved = true; break; }
        }
        if (moved) moveWithin(ctr.patchIds || [], patchId, targetId, before);
    } else {
        moved = moveWithin(ctr.patchIds || [], patchId, targetId, before);
    }
    if (moved) canvasStore.putContainer(ctr);
    return moved;
}

// --- Voice bank slot badges ---

// voiceKey → {slot, color} for every occupied slot, rebuilt from each bank
// snapshot. Patches are identified by their voice bytes, not their id, so
// every row showing the same voice — canvas, container, edit panel, a
// renamed copy — wears the same slot number.
const _slotByVoiceKey = new Map();

function applyBadge(badge) {
    const key = badge.dataset.voiceKey;
    const hit = key ? _slotByVoiceKey.get(key) : null;
    if (hit) {
        badge.textContent = hit.slot + 1;
        badge.title = 'Voice bank slot ' + (hit.slot + 1);
        badge.style.background = hit.color || '';
        badge.style.display = '';
    } else {
        badge.textContent = '';
        badge.title = 'Not in the voice bank';
        badge.style.display = 'none';
    }
}

/**
 * Point every badge on screen at the current bank. Rows are rebuilt
 * constantly (every canvas render), so badges are refreshed by query rather
 * than by subscription — nothing to unsubscribe when a row is discarded.
 */
export function updateBankSlots(entries) {
    _slotByVoiceKey.clear();
    (entries || []).forEach((e, i) => {
        if (e && e.voiceKey) _slotByVoiceKey.set(e.voiceKey, { slot: i, color: e.color });
    });
    document.querySelectorAll('.patch-slot-badge').forEach(applyBadge);
}

/** The slot pill for a patch: its number when banked, hidden when not. */
export function createSlotBadge(patch) {
    const badge = document.createElement('span');
    badge.className = 'patch-slot-badge';
    const key = voiceKey(patch.voice_data);
    if (key) badge.dataset.voiceKey = key;
    applyBadge(badge);
    return badge;
}

// --- Assign popover ---

// Only one popover at a time; opening one closes the other.
let _openPopover = null;

/**
 * The ♫ button's slot picker — the one way into the voice bank. Eight
 * buttons, one per slot, each wearing its occupant's name and color; the
 * first empty slot is pre-focused. Clicking a slot commits at once:
 *  - occupied slot, patch not in the bank → silent overwrite;
 *  - patch already in another slot → the two slots swap.
 * (Both are assignToSlot's contract — the popover only picks the index.)
 *
 * Without onAssignSlot/getBankEntries wiring the button falls back to
 * onSelect, the legacy first-empty-slot assign.
 */
export function attachAssignPopover(assignBtn, anchorEl, patch, opts) {
    const { onAssignSlot, getBankEntries, onSelect } = opts;
    if (!onAssignSlot || !getBankEntries) {
        assignBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onSelect) onSelect(patch);
        });
        return;
    }

    let pop = null;

    function close() {
        if (!pop) return;
        pop.remove();
        pop = null;
        if (_openPopover === close) _openPopover = null;
        document.removeEventListener('click', onDocClick);
        document.removeEventListener('keydown', onKeyDown);
    }

    function onDocClick(e) {
        if (pop && !pop.contains(e.target) && e.target !== assignBtn) close();
    }

    function onKeyDown(e) {
        if (e.key === 'Escape') close();
    }

    assignBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pop) { close(); return; }
        if (_openPopover) _openPopover();
        _openPopover = close;

        const entries = getBankEntries() || [];
        const key = voiceKey(patch.voice_data);
        const currentSlot = key ? entries.findIndex(en => en && en.voiceKey === key) : -1;

        pop = document.createElement('div');
        pop.className = 'patch-assign-pop';
        let focusBtn = null;
        for (let i = 0; i < 8; i++) {
            const occ = entries[i];
            const btn = document.createElement('button');
            btn.className = 'patch-assign-slot'
                + (occ ? ' occupied' : '')
                + (i === currentSlot ? ' current' : '');
            btn.textContent = i + 1;
            btn.title = i === currentSlot ? 'Current slot'
                : occ ? occ.name : 'Empty slot ' + (i + 1);
            if (occ && occ.color) btn.style.borderColor = occ.color;
            if (!occ && !focusBtn) focusBtn = btn;
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                close();
                onAssignSlot(patch, i);
            });
            pop.appendChild(btn);
        }
        anchorEl.appendChild(pop);
        if (focusBtn) focusBtn.focus();
        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onKeyDown);
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
    star.className = 'patch-drag';
    star.textContent = '⠿';
    star.title = 'Drag to canvas';
    row.appendChild(star);
    makeStarDraggable(star, row, patch);

    if (isMinified) {
        // Minified: star + slot badge + name + mini spec + play + assign
        row.appendChild(createSlotBadge(patch));

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
                if (result && typeof result.then === 'function') {
                    let wavUrl = null;
                    try {
                        wavUrl = await result;
                        if (wavUrl && !waveformDrawn) {
                            waveformDrawn = true;
                            const wavResp = await fetch(wavUrl);
                            if (!wavResp.ok) throw new Error('Waveform fetch failed');
                            const wavBuf = await wavResp.arrayBuffer();
                            const samples = decodeWavSamples(wavBuf);
                            if (samples && samples.length > 0) drawMiniWaveform(specCanvas, samples);
                        }
                    } catch (err) {
                        if (window._showError) window._showError('Failed to load waveform');
                    } finally {
                        releaseWavUrl(wavUrl);
                    }
                }
            });
        }
        row.appendChild(specWrap);

        const assignBtn = document.createElement('button');
        assignBtn.className = 'patch-assign';
        assignBtn.textContent = '♫';
        assignBtn.title = 'Assign to voicebank slot';
        attachAssignPopover(assignBtn, row, patch, opts);
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

        // Touch drag when active — reorder inside container or drag out
        row.addEventListener('touchstart', (e) => {
            if (!row.classList.contains('active')) return;
            if (e.target.tagName === 'BUTTON') return;
            const touch = e.touches[0];
            const startX = touch.clientX;
            const startY = touch.clientY;
            const body = row.closest('.sky-container-body');
            const containerEl = row.closest('.sky-container');
            let clone = null;
            let didMove = false;
            let isOutside = false;
            let insertIndicator = null;
            let targetRow = null;

            function getRowUnder(y) {
                if (!body) return null;
                const rows = [...body.querySelectorAll('.patch-row')];
                for (const r of rows) {
                    if (r === row) continue;
                    const rect = r.getBoundingClientRect();
                    if (y < rect.top + rect.height / 2) return { row: r, before: true };
                }
                return rows.length > 0 ? { row: rows[rows.length - 1], before: false } : null;
            }

            function showInsertIndicator(target) {
                if (insertIndicator) insertIndicator.remove();
                if (!target || !body) return;
                insertIndicator = document.createElement('div');
                insertIndicator.className = 'patch-insert-indicator';
                if (target.before) {
                    target.row.parentNode.insertBefore(insertIndicator, target.row);
                } else {
                    target.row.parentNode.insertBefore(insertIndicator, target.row.nextSibling);
                }
            }

            function onMove(ev) {
                const t = ev.touches[0];
                const dx = Math.abs(t.clientX - startX);
                const dy = Math.abs(t.clientY - startY);
                if (!didMove && (dx > 8 || dy > 8)) {
                    didMove = true;
                    row.classList.add('dragging');
                }
                if (!didMove) return;
                ev.preventDefault();

                const bodyRect = body ? body.getBoundingClientRect() : null;
                const outside = !bodyRect || t.clientX < bodyRect.left || t.clientX > bodyRect.right ||
                    t.clientY < bodyRect.top || t.clientY > bodyRect.bottom;

                if (outside && !isOutside) {
                    // Transition: reorder → drag out
                    isOutside = true;
                    if (insertIndicator) { insertIndicator.remove(); insertIndicator = null; }
                    targetRow = null;
                    if (!clone) {
                        clone = row.cloneNode(true);
                        clone.className = 'patch-row patch-row-minified patch-drag-clone';
                        clone.style.position = 'fixed';
                        clone.style.zIndex = '10000';
                        clone.style.pointerEvents = 'none';
                        clone.style.width = row.offsetWidth + 'px';
                        clone.style.opacity = '0.85';
                        document.body.appendChild(clone);
                    }
                    _draggedPatch = patch;
                    window._draggedPatch = patch;
                } else if (!outside && isOutside) {
                    // Transition back: drag out → reorder. Without this the
                    // finger coming home still ended as a "drop on canvas"
                    // and cloned the patch.
                    isOutside = false;
                    if (clone) { clone.remove(); clone = null; }
                    _draggedPatch = null;
                    window._draggedPatch = null;
                }

                if (isOutside && clone) {
                    clone.style.left = (t.clientX - 20) + 'px';
                    clone.style.top = (t.clientY - 15) + 'px';
                } else if (!isOutside) {
                    // Reorder: show insert indicator
                    targetRow = getRowUnder(t.clientY);
                    showInsertIndicator(targetRow);
                }
            }

            function cleanup() {
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
                document.removeEventListener('touchcancel', onCancel);
                row.classList.remove('dragging');
                if (insertIndicator) { insertIndicator.remove(); insertIndicator = null; }
                if (clone) { clone.remove(); clone = null; }
            }

            // The browser took the touch away (call, gesture, scroll
            // takeover): drop nothing, change nothing.
            function onCancel() {
                cleanup();
                _draggedPatch = null;
                window._draggedPatch = null;
            }

            function onEnd(ev) {
                cleanup();

                if (isOutside) {
                    const t = ev.changedTouches[0];
                    // Onto a Mixer slot: assign it; the row stays where it was.
                    const slot = slotAt(t.clientX, t.clientY);
                    if (slot >= 0 && dropOnSlot(patch, slot)) {
                        _draggedPatch = null;
                        window._draggedPatch = null;
                        return;
                    }
                    const el = document.elementFromPoint(t.clientX, t.clientY);
                    const dropContainer = el ? el.closest('.sky-container') : null;
                    if (dropContainer && dropContainer.dataset.containerId && containerEl &&
                        dropContainer.dataset.containerId !== containerEl.dataset.containerId) {
                        // Dropped on a different container
                        window._touchDropPatch = patch;
                        window._touchDropContainerId = dropContainer.dataset.containerId;
                        window.dispatchEvent(new CustomEvent('touch-drop-patch'));
                    } else {
                        // Dropped on canvas — become a free-floating patch
                        window._touchDropPatch = patch;
                        window._touchDropContainerId = null;
                        window._touchDropX = t.clientX;
                        window._touchDropY = t.clientY;
                        window.dispatchEvent(new CustomEvent('touch-drop-patch'));
                    }
                    _draggedPatch = null;
                    window._draggedPatch = null;
                } else if (didMove && targetRow && containerEl) {
                    // Reorder — update container's patchIds
                    const targetPatchId = targetRow.row.dataset.patchId;
                    if (reorderContainerPatch(containerEl.dataset.containerId, patch.id, targetPatchId, targetRow.before)) {
                        window.dispatchEvent(new CustomEvent('touch-drop-patch'));
                    }
                }
            }

            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
            document.addEventListener('touchcancel', onCancel);
        }, { passive: true });
    } else {
        // Full row: slot badge + spec + name + algo + fb + dist + actions
        row.appendChild(createSlotBadge(patch));

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
                if (result && typeof result.then === 'function') {
                    let wavUrl = null;
                    try {
                        wavUrl = await result;
                        if (wavUrl && !waveformDrawn) {
                            waveformDrawn = true;
                            const wavResp = await fetch(wavUrl);
                            if (!wavResp.ok) throw new Error('Waveform fetch failed');
                            const wavBuf = await wavResp.arrayBuffer();
                            const samples = decodeWavSamples(wavBuf);
                            if (samples && samples.length > 0) drawMiniWaveform(canvas, samples);
                        }
                    } catch (err) {
                        if (window._showError) window._showError('Failed to load waveform');
                    } finally {
                        releaseWavUrl(wavUrl);
                    }
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
                    .catch(() => {
                        if (window._showError) window._showError('Failed to load cached waveform');
                    });
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
        assignBtn.title = 'Assign to voicebank slot';
        attachAssignPopover(assignBtn, row, patch, opts);
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

        // No click-row-to-assign: the ♫ button is the one way into the
        // voice bank, a stray click on a row must not move voices around.
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
            }).catch(() => {});
        }, midiNote);
    }
}
