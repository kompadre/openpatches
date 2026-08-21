// VoiceBank — patch selector for pianoroll
// Each entry has a color that maps to pianoroll note colors.
// Volume overlay: click+drag horizontally to adjust channel volume (0-127).

const STORAGE_KEY = 'openpatches_voicebank';
const MAX_SLOTS = 8;
const DEFAULT_VOLUME = 100;

const PATCH_COLORS = ['#e94560', '#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4', '#ff5722', '#607d8b'];

export function createVoiceBank(opts) {
    const { onSelect, onVolumeChange, onPreview, onSnapshot } = opts;
    let entries = [];
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

    // Drop target for canvas patches
    container.addEventListener('dragover', (e) => {
        if (!window._draggedPatch) return;
        e.preventDefault();
        e.stopPropagation();
        container.classList.add('voicebank-drag-over');
        const items = [...list.querySelectorAll('.voicebank-item')];
        items.forEach(i => i.classList.remove('voicebank-drop-target'));
        const afterItem = getInsertAfterItem(items, e.clientY);
        if (afterItem) {
            afterItem.classList.add('voicebank-drop-target');
        } else if (items.length > 0) {
            items[items.length - 1].classList.add('voicebank-drop-target');
        }
    });

    container.addEventListener('dragleave', (e) => {
        if (!container.contains(e.relatedTarget)) {
            container.classList.remove('voicebank-drag-over');
            list.querySelectorAll('.voicebank-drop-target').forEach(i => i.classList.remove('voicebank-drop-target'));
        }
    });

    container.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.classList.remove('voicebank-drag-over');
        list.querySelectorAll('.voicebank-drop-target').forEach(i => i.classList.remove('voicebank-drop-target'));
        if (!window._draggedPatch) return;

        const patch = window._draggedPatch;
        const items = [...list.querySelectorAll('.voicebank-item')];
        const afterItem = getInsertAfterItem(items, e.clientY);
        console.log('[voicebank] drop afterItem:', afterItem?.dataset?.vbIdx, 'entries:', entries.length, 'patch:', patch.name, 'voice_data type:', typeof patch.voice_data, 'length:', patch.voice_data?.length);

        // Determine target slot index
        let targetIdx = entries.length; // default: append
        if (afterItem) {
            const idx = parseInt(afterItem.dataset.vbIdx);
            // If targeting bottom half of previous slot, use that slot
            if (idx > 0 && !entries[idx] && entries[idx - 1]) {
                targetIdx = idx - 1;
            } else {
                targetIdx = idx;
            }
        }
        console.log('[voicebank] targetIdx:', targetIdx, 'entries[targetIdx]:', entries[targetIdx]?.name || null);

        // Deep copy voice data
        let voiceCopy;
        if (typeof patch.voice_data === 'string') {
            voiceCopy = patch.voice_data;
        } else if (patch.voice_data instanceof Uint8Array) {
            voiceCopy = new Uint8Array(patch.voice_data);
        } else if (Array.isArray(patch.voice_data)) {
            voiceCopy = patch.voice_data.slice();
        } else {
            console.log('[voicebank] voice_data not a recognized type, aborting');
            window._draggedPatch = null;
            return;
        }
        console.log('[voicebank] voiceCopy ready, type:', typeof voiceCopy, 'length:', voiceCopy?.length);

        // Dedup: remove existing entry with same voice data
        const voiceKey = typeof voiceCopy === 'string' ? voiceCopy : Array.from(voiceCopy).join(',');
        const existingIdx = entries.findIndex(e => {
            if (!e) return false;
            if (typeof e.voiceData === 'string' && typeof voiceCopy === 'string') return e.voiceData === voiceCopy;
            if (Array.isArray(e.voiceData) && Array.isArray(voiceCopy)) return Array.from(e.voiceData).join(',') === voiceKey;
            return false;
        });
        if (existingIdx >= 0) {
            console.log('[voicebank] dedup: removing existing at', existingIdx);
            entries.splice(existingIdx, 1);
            if (existingIdx < targetIdx) targetIdx--;
        }
        console.log('[voicebank] inserting at', targetIdx, 'entries before:', entries.length);

        // Insert at target position, shift others down
        const color = PATCH_COLORS[targetIdx % PATCH_COLORS.length];
        const newEntry = {
            id: 'vb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            name: patch.name || 'Untitled',
            voiceData: voiceCopy,
            patchId: patch.name,
            color,
            volume: DEFAULT_VOLUME,
        };
        entries.splice(targetIdx, 0, newEntry);

        // Trim to max slots
        while (entries.length > MAX_SLOTS) entries.pop();

        activeId = newEntry.id;
        render();
        fireSelect();
        saveState();
        notifySnapshot();

        window._draggedPatch = null;
    });

    function getInsertAfterItem(items, clientY) {
        for (const item of items) {
            const rect = item.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) return item;
        }
        return null;
    }

    function fireSelect() {
        const active = entries.find(e => e && e.id === activeId);
        if (onSelect && active) {
            const slot = entries.indexOf(active);
            onSelect(active, slot);
        }
    }

    function render() {
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
                    const vol = (entry.volume || DEFAULT_VOLUME) / 127 * 100;
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
                    overlay.style.width = ((entry.volume || DEFAULT_VOLUME) / 127 * 100) + '%';
                }
                item.appendChild(overlay);

                // Slot number (for compact mode)
                const slotNum = document.createElement('span');
                slotNum.className = 'voicebank-slot-num';
                slotNum.textContent = (i + 1);
                item.appendChild(slotNum);

                // Drag handle for reordering
                const dragHandle = document.createElement('button');
                dragHandle.className = 'voicebank-drag-handle';
                dragHandle.textContent = '\u2B0D';
                dragHandle.title = 'Drag to reorder';
                dragHandle.draggable = true;
                dragHandle.addEventListener('click', (e) => e.stopPropagation());
                dragHandle.addEventListener('dragstart', (e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', entry.id);
                    item.classList.add('dragging');
                    window._vbDragSourceId = entry.id;
                });
                dragHandle.addEventListener('dragend', () => {
                    item.classList.remove('dragging');
                    window._vbDragSourceId = null;
                    list.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
                        el.classList.remove('drag-over-top', 'drag-over-bottom');
                    });
                });
                item.appendChild(dragHandle);

                const playBtn = document.createElement('button');
                playBtn.className = 'voicebank-play';
                playBtn.textContent = '\u25B6';
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
                volEl.textContent = entry.volume || DEFAULT_VOLUME;
                item.appendChild(volEl);

                const removeBtn = document.createElement('button');
                removeBtn.className = 'voicebank-remove';
                removeBtn.textContent = '\u00D7';
                removeBtn.title = 'Remove';
                removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeEntry(entry.id);
                });
                item.appendChild(removeBtn);

                // Reorder drop targets
                item.addEventListener('dragover', (e) => {
                    if (!window._vbDragSourceId) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    const rect = item.getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    item.classList.remove('drag-over-top', 'drag-over-bottom');
                    item.classList.add(e.clientY < midY ? 'drag-over-top' : 'drag-over-bottom');
                });
                item.addEventListener('dragleave', () => {
                    item.classList.remove('drag-over-top', 'drag-over-bottom');
                });
                item.addEventListener('drop', (e) => {
                    e.preventDefault();
                    item.classList.remove('drag-over-top', 'drag-over-bottom');
                    if (window._draggedPatch) {
                        // External drop — let it bubble to container handler
                        return;
                    }
                    e.stopPropagation();
                    if (!window._vbDragSourceId) return;
                    const fromId = window._vbDragSourceId;
                    const fromIdx = entries.findIndex(en => en && en.id === fromId);
                    let toIdx = i;
                    const rect = item.getBoundingClientRect();
                    if (e.clientY >= rect.top + rect.height / 2) toIdx = i + 1;
                    if (fromIdx < 0 || fromIdx === toIdx || fromIdx === toIdx - 1) return;
                    const [moved] = entries.splice(fromIdx, 1);
                    if (toIdx > fromIdx) toIdx--;
                    entries.splice(toIdx, 0, moved);
                    render();
                    saveState();
                    notifySnapshot();
                });

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

    function addEntry(name, voiceData, patchId) {
        if (!voiceData) return;
        if (entries.length >= MAX_SLOTS) return;

        // Deep copy voiceData to avoid stale references
        let voiceCopy;
        if (typeof voiceData === 'string') {
            voiceCopy = voiceData; // strings are immutable
        } else if (voiceData instanceof Uint8Array) {
            voiceCopy = new Uint8Array(voiceData); // true deep copy
        } else if (Array.isArray(voiceData)) {
            voiceCopy = voiceData.slice();
        } else {
            return;
        }

        // Dedup by content (string compare for base64, byte compare for arrays)
        const voiceKey = typeof voiceCopy === 'string' ? voiceCopy : Array.from(voiceCopy).join(',');
        const existing = entries.find(e => {
            if (!e) return false;
            if (typeof e.voiceData === 'string' && typeof voiceCopy === 'string') {
                return e.voiceData === voiceCopy;
            }
            if (Array.isArray(e.voiceData) && Array.isArray(voiceCopy)) {
                return Array.from(e.voiceData).join(',') === voiceKey;
            }
            return false;
        });
        if (existing) {
            activeId = existing.id;
            render();
            fireSelect();
            saveState();
            return;
        }

        insertEntry(entries.length, name, voiceCopy, patchId);
    }

    function addEntryAt(idx, name, voiceData, patchId) {
        if (!voiceData || idx < 0 || idx >= MAX_SLOTS) return;

        let voiceCopy;
        if (typeof voiceData === 'string') {
            voiceCopy = voiceData;
        } else if (voiceData instanceof Uint8Array) {
            voiceCopy = new Uint8Array(voiceData);
        } else if (Array.isArray(voiceData)) {
            voiceCopy = voiceData.slice();
        } else {
            return;
        }

        insertEntry(idx, name, voiceCopy, patchId);
    }

    function insertEntry(idx, name, voiceCopy, patchId) {
        const color = PATCH_COLORS[idx % PATCH_COLORS.length];
        const newEntry = {
            id: 'vb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            name: name || 'Untitled',
            voiceData: voiceCopy,
            patchId: patchId || name,
            color,
            volume: DEFAULT_VOLUME,
        };

        entries[idx] = newEntry;
        activeId = newEntry.id;
        render();
        fireSelect();
        saveState();
        notifySnapshot();
    }

    function removeEntry(id) {
        const idx = entries.findIndex(e => e && e.id === id);
        if (idx >= 0) {
            entries.splice(idx, 1);
        }
        if (activeId === id) {
            const first = entries[0] || null;
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

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
            entries = (data.entries || []).filter(e => e != null);
            activeId = data.activeId || null;
            if (activeId && !entries.find(e => e.id === activeId)) {
                activeId = entries.length > 0 ? entries[0].id : null;
            }
            // Backfill volume for entries saved before volume feature
            for (const entry of entries) {
                if (entry.volume === undefined) entry.volume = DEFAULT_VOLUME;
            }
        } catch (e) {
            console.warn('VoiceBank load failed:', e);
        }
    }

    // Init
    loadState();
    render();

    container._addEntry = addEntry;
    container._removeEntry = removeEntry;
    container._clear = () => { entries = []; activeId = null; render(); saveState(); notifySnapshot(); };
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

    return container;
}
