// VoiceBank — patch selector for pianoroll
// Each entry has a color that maps to pianoroll note colors.
// Volume overlay: click+drag horizontally to adjust channel volume (0-127).
//
// The bank is a fixed array of MAX_SLOTS positions: the slot index IS the
// synth channel (AGENTS.md), so entries never shift. Removing one leaves a
// hole; colors are a pure function of the index and never move. The one
// write path is assignToSlot — no drag-in, no reordering — and it enforces
// the invariant that a voice (by voiceKey) occupies at most one slot.

import { voiceKey } from './patch-model.js';

const STORAGE_KEY = 'openpatches_voicebank';
const MAX_SLOTS = 8;
const DEFAULT_VOLUME = 100;

const PATCH_COLORS = ['#e94560', '#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4', '#ff5722', '#607d8b'];

// Deep copy of voice data in any of its travelling encodings; null if the
// input is none of them. Strings are immutable, so they pass through.
function copyVoice(voiceData) {
    if (typeof voiceData === 'string') return voiceData;
    if (voiceData instanceof Uint8Array) return new Uint8Array(voiceData);
    if (Array.isArray(voiceData)) return voiceData.slice();
    return null;
}

export function createVoiceBank(opts) {
    const { onSelect, onVolumeChange, onPreview, onSnapshot } = opts;
    let entries = new Array(MAX_SLOTS).fill(null);
    let activeId = null;

    function notifySnapshot() {
        if (onSnapshot) onSnapshot(entries);
    }

    const container = document.createElement('div');
    container.className = 'voicebank';

    const header = document.createElement('div');
    header.className = 'voicebank-header';
    header.textContent = 'Voices';
    container.appendChild(header);

    const list = document.createElement('div');
    list.className = 'voicebank-list';
    container.appendChild(list);

    function fireSelect() {
        const active = entries.find(e => e && e.id === activeId);
        if (onSelect && active) {
            const slot = entries.indexOf(active);
            onSelect(active, slot);
        }
    }

    // Colors are a function of the slot index. Slots no longer shift, but
    // state saved by the old splice-based bank can still carry stale colors.
    function reindexColors() {
        for (let i = 0; i < MAX_SLOTS; i++) {
            if (entries[i]) entries[i].color = PATCH_COLORS[i % PATCH_COLORS.length];
        }
    }

    function render() {
        reindexColors();
        list.innerHTML = '';
        for (let i = 0; i < MAX_SLOTS; i++) {
            const entry = entries[i];
            const item = document.createElement('div');
            item.className = 'voicebank-item' + (entry && entry.id === activeId ? ' active' : '');
            item.dataset.vbIdx = i;

            if (entry) {
                const isCompact = container.classList.contains('compact');

                // Volume overlay
                const overlay = document.createElement('div');
                overlay.className = 'voicebank-volume-overlay voicebank-dot';
                overlay.style.background = entry.color;
                if (isCompact) {
                    const vol = (entry.volume ?? DEFAULT_VOLUME) / 127 * 100;
                    overlay.style.position = 'absolute';
                    overlay.style.left = '0';
                    overlay.style.bottom = '0';
                    overlay.style.top = 'auto';
                    overlay.style.width = '100%';
                    overlay.style.height = vol + '%';
                    overlay.style.opacity = entry.id === activeId ? '0.5' : '0.15';
                    overlay.style.pointerEvents = 'none';
                    overlay.style.zIndex = '0';
                } else {
                    overlay.style.width = ((entry.volume ?? DEFAULT_VOLUME) / 127 * 100) + '%';
                }
                item.appendChild(overlay);

                // Slot number (for compact mode)
                const slotNum = document.createElement('span');
                slotNum.className = 'voicebank-slot-num';
                slotNum.textContent = (i + 1);
                item.appendChild(slotNum);

                const playBtn = document.createElement('button');
                playBtn.className = 'voicebank-play';
                playBtn.textContent = '▶';
                playBtn.title = 'Preview';
                playBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (onPreview) onPreview(entry, i);
                });
                item.appendChild(playBtn);

                // Normal dot for list mode
                const dot = document.createElement('span');
                dot.className = 'voicebank-dot';
                dot.style.background = entry.color;
                if (isCompact) dot.style.display = 'none';
                item.appendChild(dot);

                const nameEl = document.createElement('span');
                nameEl.className = 'voicebank-name';
                nameEl.textContent = isCompact ? entry.name : (i + 1) + '. ' + entry.name;
                item.appendChild(nameEl);

                // Volume label
                const volEl = document.createElement('span');
                volEl.className = 'voicebank-vol';
                volEl.textContent = entry.volume ?? DEFAULT_VOLUME;
                item.appendChild(volEl);

                const removeBtn = document.createElement('button');
                removeBtn.className = 'voicebank-remove';
                removeBtn.textContent = '×';
                removeBtn.title = 'Remove';
                removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeEntry(entry.id);
                });
                item.appendChild(removeBtn);

                // Click to select (desktop only — mobile uses handleVolStart tap detection)
                item.addEventListener('click', (e) => {
                    if (item._dragging) return;
                    activeId = entry.id;
                    render();
                    fireSelect();
                    saveState();
                });

                // Volume drag + tap-to-select
                function handleVolStart(e) {
                    if (e.type === 'mousedown' && e.button !== 0) return;
                    if (e.type === 'touchstart') e.preventDefault();
                    const rect = item.getBoundingClientRect();
                    let didDrag = false;

                    function onMove(ev) {
                        let pct;
                        if (isCompact) {
                            const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
                            const y = rect.bottom - clientY;
                            pct = Math.max(0, Math.min(1, y / rect.height));
                            overlay.style.height = (pct * 100) + '%';
                        } else {
                            const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
                            const x = clientX - rect.left;
                            pct = Math.max(0, Math.min(1, x / rect.width));
                            overlay.style.width = (pct * 100) + '%';
                        }
                        const vol = Math.round(pct * 127);
                        entry.volume = vol;
                        volEl.textContent = vol;
                        didDrag = true;
                        if (onVolumeChange) onVolumeChange(i, vol);
                    }

                    function onUp(ev) {
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                        document.removeEventListener('touchmove', onMove);
                        document.removeEventListener('touchend', onUp);
                        if (didDrag) {
                            item._dragging = true;
                            setTimeout(() => { item._dragging = false; }, 50);
                            saveState();
                        } else {
                            // Tap without drag = select
                            activeId = entry.id;
                            saveState();
                            fireSelect();
                            // Defer render to avoid killing DOM during touch event chain
                            requestAnimationFrame(() => render());
                        }
                    }

                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                    document.addEventListener('touchmove', onMove, { passive: false });
                    document.addEventListener('touchend', onUp);
                }

                item.addEventListener('mousedown', handleVolStart);
                item.addEventListener('touchstart', handleVolStart, { passive: false });
            } else {
                item.classList.add('voicebank-empty');
                const placeholder = document.createElement('span');
                placeholder.className = 'voicebank-placeholder';
                placeholder.textContent = '—';
                item.appendChild(placeholder);
            }

            list.appendChild(item);
        }
    }

    function makeEntry(idx, name, voiceCopy, patchId, key, volume) {
        return {
            id: 'vb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            name: name || 'Untitled',
            voiceData: voiceCopy,
            patchId: patchId || name,
            voiceKey: key,
            color: PATCH_COLORS[idx % PATCH_COLORS.length],
            volume: volume == null ? DEFAULT_VOLUME : volume,
        };
    }

    function firstEmptySlot() {
        return entries.findIndex(e => !e);
    }

    function findSlotByKey(key) {
        if (!key) return -1;
        return entries.findIndex(e => e && e.voiceKey === key);
    }

    /**
     * THE write path. Puts a voice into slot `idx`, replacing whatever is
     * there. One voice, one slot: if these bytes (by voiceKey) already live
     * in another slot, this is a move — the old slot empties rather than
     * leaving a duplicate. Returns true if the bank changed or the voice was
     * already in place (which just selects it).
     */
    function assignToSlot(idx, { name, voiceData, patchId }) {
        if (idx < 0 || idx >= MAX_SLOTS) return false;
        const voiceCopy = copyVoice(voiceData);
        if (!voiceCopy) return false;
        const key = voiceKey(voiceCopy);

        const existingIdx = findSlotByKey(key);
        if (existingIdx === idx) {
            // Same voice, same slot: just select it. The existing entry
            // keeps its id and volume.
            activeId = entries[idx].id;
            render();
            fireSelect();
            saveState();
            return true;
        }
        let volume = null;
        if (existingIdx >= 0) {
            volume = entries[existingIdx].volume;
            entries[existingIdx] = null;
        }

        const newEntry = makeEntry(idx, name, voiceCopy, patchId, key, volume);
        entries[idx] = newEntry;
        activeId = newEntry.id;
        render();
        fireSelect();
        saveState();
        notifySnapshot();
        return true;
    }

    // Interim single entry point until the per-patch slot picker lands:
    // assign to the first empty slot; a voice already in the bank just
    // becomes the selection.
    function addEntry(name, voiceData, patchId) {
        const voiceCopy = copyVoice(voiceData);
        if (!voiceCopy) return;
        const existingIdx = findSlotByKey(voiceKey(voiceCopy));
        if (existingIdx >= 0) {
            activeId = entries[existingIdx].id;
            render();
            fireSelect();
            saveState();
            return;
        }
        const idx = firstEmptySlot();
        if (idx < 0) return;
        assignToSlot(idx, { name, voiceData: voiceCopy, patchId });
    }

    function removeEntry(id) {
        const idx = entries.findIndex(e => e && e.id === id);
        if (idx < 0) return;
        // A hole, not a splice: the slot is the channel, entries below must
        // keep their index, color and volume.
        entries[idx] = null;
        if (activeId === id) {
            const first = entries.find(e => e) || null;
            activeId = first ? first.id : null;
            if (activeId) fireSelect();
        }
        render();
        saveState();
        notifySnapshot();
    }

    function getActive() {
        return entries.find(e => e && e.id === activeId) || null;
    }

    function setActive(id) {
        if (entries.find(e => e && e.id === id)) {
            activeId = id;
            render();
            fireSelect();
            saveState();
        }
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries, activeId }));
        } catch (e) {
            console.warn('VoiceBank save failed:', e);
        }
    }

    // Rebuild the fixed slot array from a plain list, keeping positions and
    // dropping voiceKey duplicates (first occurrence wins). Shared by
    // loadState and _setEntries; old saved state (dense, spliced) comes
    // through unchanged because its indices were already its slots.
    function slotsFromList(list, mapEntry) {
        const slots = new Array(MAX_SLOTS).fill(null);
        const seen = new Set();
        (Array.isArray(list) ? list : []).slice(0, MAX_SLOTS).forEach((e, i) => {
            if (!e || !e.voiceData) return;
            const voiceCopy = copyVoice(e.voiceData);
            if (!voiceCopy) return;
            const key = e.voiceKey || voiceKey(voiceCopy);
            if (key && seen.has(key)) return;
            if (key) seen.add(key);
            slots[i] = mapEntry(e, i, voiceCopy, key);
        });
        return slots;
    }

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
            // Saved entries keep their ids and volumes; only the fixed-array
            // shape, the voiceKey backfill and the dedup are imposed here.
            entries = slotsFromList(data.entries, (e, i, voiceCopy, key) => ({
                ...e,
                voiceData: voiceCopy,
                voiceKey: key,
                volume: e.volume == null ? DEFAULT_VOLUME : e.volume,
            }));
            activeId = data.activeId || null;
            if (activeId && !entries.find(e => e && e.id === activeId)) {
                const first = entries.find(e => e);
                activeId = first ? first.id : null;
            }
        } catch (e) {
            console.warn('VoiceBank load failed:', e);
        }
    }

    // Init
    loadState();
    render();

    container._addEntry = addEntry;
    container._assignToSlot = assignToSlot;
    container._firstEmptySlot = firstEmptySlot;
    container._removeEntry = removeEntry;
    container._clear = () => { entries = new Array(MAX_SLOTS).fill(null); activeId = null; render(); saveState(); notifySnapshot(); };
    container._getActive = getActive;
    container._setActive = setActive;
    container._getEntries = () => entries;
    container._setActiveSlot = (idx) => {
        if (entries[idx]) {
            activeId = entries[idx].id;
            render();
            fireSelect();
            saveState();
        }
    };
    container._render = render;
    container._notifySnapshot = notifySnapshot;
    // Replace every slot at once (song load). Entries get fresh ids but keep
    // their saved slot positions; the first occupied slot becomes active so
    // the piano roll and keyboard follow, exactly as after a reload.
    container._setEntries = (list) => {
        entries = slotsFromList(list, (e, i, voiceCopy, key) =>
            makeEntry(i, e.name, voiceCopy, e.patchId || e.name, key, e.volume));
        const first = entries.find(e => e);
        activeId = first ? first.id : null;
        render();
        fireSelect();
        saveState();
        notifySnapshot();
    };

    return container;
}
