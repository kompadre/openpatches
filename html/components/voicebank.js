// VoiceBank — the Mixer. One vertical channel strip per slot: fader (drag
// vertically, 0-127), Mute, Solo, preview and remove. Each entry has a
// color that maps to pianoroll note colors.
//
// The bank is a fixed array of MAX_SLOTS positions: the slot index IS the
// synth channel (AGENTS.md), so entries never shift. Removing one leaves a
// hole; colors are a pure function of the index and never move. The one
// write path is assignToSlot — no drag-in, no reordering — and it enforces
// the invariant that a voice (by voiceKey) occupies at most one slot.
//
// Mute/Solo are plain channel-volume overrides, no engine change:
// `entry.volume` stays the fader's value, `entry.effectiveVolume` is what
// the engine hears — 0 when muted, or when another strip is soloed and this
// one is not. Both the live onVolumeChange callback and audio-manager's
// sendVoiceSnapshot speak effectiveVolume, so a snapshot can never un-mute
// a channel behind the user's back.

import { voiceKey } from './patch-model.js';
import { createTrack } from './project-model.js';

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
    const { onSelect, onVolumeChange, onPreview, onSnapshot, session } = opts;
    let entries = new Array(MAX_SLOTS).fill(null);
    let activeId = null;

    function notifySnapshot() {
        if (onSnapshot) onSnapshot(entries);
    }

    const container = document.createElement('div');
    container.className = 'voicebank';

    const header = document.createElement('div');
    header.className = 'voicebank-header';
    header.textContent = 'Mixer';
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

    // --- Mute / Solo ---

    function anySolo() {
        return entries.some(e => e && e.solo);
    }

    function effVol(entry) {
        const vol = entry.volume ?? DEFAULT_VOLUME;
        if (anySolo()) return entry.solo ? vol : 0;
        return entry.muted ? 0 : vol;
    }

    /**
     * Recompute every strip's effectiveVolume. Mute and Solo couple the
     * strips (soloing one silences the others; removing the soloed one
     * un-silences them), so this runs over the whole bank after any change.
     * Slots whose effective volume moved are pushed via onVolumeChange.
     */
    function applyMix(fire = true) {
        for (let i = 0; i < MAX_SLOTS; i++) {
            const e = entries[i];
            if (!e) continue;
            const v = effVol(e);
            if (e.effectiveVolume !== v) {
                e.effectiveVolume = v;
                if (fire && onVolumeChange) onVolumeChange(i, v);
            }
        }
    }

    function toggleMute(idx) {
        const e = entries[idx];
        if (!e) return;
        e.muted = !e.muted;
        applyMix();
        render();
        saveState();
        notifySnapshot();
    }

    function toggleSolo(idx) {
        const e = entries[idx];
        if (!e) return;
        e.solo = !e.solo;
        applyMix();
        render();
        saveState();
        notifySnapshot();
    }

    // --- Render ---

    function render() {
        reindexColors();
        list.innerHTML = '';
        for (let i = 0; i < MAX_SLOTS; i++) {
            const entry = entries[i];
            const item = document.createElement('div');
            item.className = 'voicebank-item'
                + (entry && entry.id === activeId ? ' active' : '')
                + (entry && entry.muted ? ' muted' : '')
                + (entry && entry.solo ? ' soloed' : '')
                + (entry && entry.effectiveVolume === 0 && (entry.volume ?? DEFAULT_VOLUME) > 0 ? ' silenced' : '');
            item.dataset.vbIdx = i;

            // Slot number — doubles as the color chip
            const slotNum = document.createElement('span');
            slotNum.className = 'voicebank-slot-num';
            slotNum.textContent = (i + 1);
            if (entry) slotNum.style.background = entry.color;
            item.appendChild(slotNum);

            if (entry) {
                const nameEl = document.createElement('span');
                nameEl.className = 'voicebank-name';
                nameEl.textContent = entry.name;
                nameEl.title = entry.name;
                item.appendChild(nameEl);

                // Fader: a vertical track whose fill is the user volume.
                // Dimmed by CSS when the strip is effectively silent.
                const fader = document.createElement('div');
                fader.className = 'voicebank-fader';
                const overlay = document.createElement('div');
                overlay.className = 'voicebank-volume-overlay';
                overlay.style.background = entry.color;
                overlay.style.height = ((entry.volume ?? DEFAULT_VOLUME) / 127 * 100) + '%';
                fader.appendChild(overlay);
                item.appendChild(fader);

                const volEl = document.createElement('span');
                volEl.className = 'voicebank-vol';
                volEl.textContent = entry.volume ?? DEFAULT_VOLUME;
                item.appendChild(volEl);

                // M / S / preview / remove
                const controls = document.createElement('div');
                controls.className = 'voicebank-strip-controls';

                const muteBtn = document.createElement('button');
                muteBtn.className = 'voicebank-mute' + (entry.muted ? ' on' : '');
                muteBtn.textContent = 'M';
                muteBtn.title = entry.muted ? 'Unmute' : 'Mute';
                muteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleMute(i);
                });
                controls.appendChild(muteBtn);

                const soloBtn = document.createElement('button');
                soloBtn.className = 'voicebank-solo' + (entry.solo ? ' on' : '');
                soloBtn.textContent = 'S';
                soloBtn.title = entry.solo ? 'Unsolo' : 'Solo';
                soloBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleSolo(i);
                });
                controls.appendChild(soloBtn);

                const playBtn = document.createElement('button');
                playBtn.className = 'voicebank-play';
                playBtn.textContent = '▶';
                playBtn.title = 'Preview';
                playBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (onPreview) onPreview(entry, i);
                });
                controls.appendChild(playBtn);

                const removeBtn = document.createElement('button');
                removeBtn.className = 'voicebank-remove';
                removeBtn.textContent = '×';
                removeBtn.title = 'Remove';
                removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeEntry(entry.id);
                });
                controls.appendChild(removeBtn);

                item.appendChild(controls);

                // Click anywhere else on the strip to select
                item.addEventListener('click', (e) => {
                    if (item._dragging) return;
                    activeId = entry.id;
                    render();
                    fireSelect();
                    saveState();
                });

                // Fader drag (mouse or touch), vertical. A tap without
                // movement falls through to selection.
                function handleVolStart(e) {
                    if (e.type === 'mousedown' && e.button !== 0) return;
                    if (e.type === 'touchstart') e.preventDefault();
                    const rect = fader.getBoundingClientRect();
                    let didDrag = false;

                    function onMove(ev) {
                        const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
                        const y = rect.bottom - clientY;
                        const pct = Math.max(0, Math.min(1, y / rect.height));
                        overlay.style.height = (pct * 100) + '%';
                        const vol = Math.round(pct * 127);
                        entry.volume = vol;
                        volEl.textContent = vol;
                        didDrag = true;
                        // The engine hears the fader through the mix: a
                        // muted or solo-silenced strip stays silent.
                        entry.effectiveVolume = effVol(entry);
                        if (onVolumeChange) onVolumeChange(i, entry.effectiveVolume);
                    }

                    function onUp() {
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

                fader.addEventListener('mousedown', handleVolStart);
                fader.addEventListener('touchstart', handleVolStart, { passive: false });
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
            muted: false,
            solo: false,
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
     * THE write path. Puts a voice into slot `idx`. One voice, one slot:
     *  - target occupied, voice not in the bank → silent overwrite;
     *  - voice already in another slot → the two slots swap (a plain move
     *    when the target is empty), entries keep their ids and volumes;
     *  - voice already in `idx` → just select it.
     * Returns true if the bank changed or the voice was already in place.
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
        if (existingIdx >= 0) {
            // Swap: whatever sits in the target takes the vacated slot.
            const moving = entries[existingIdx];
            entries[existingIdx] = entries[idx];
            entries[idx] = moving;
            activeId = moving.id;
        } else {
            const newEntry = makeEntry(idx, name, voiceCopy, patchId, key, null);
            entries[idx] = newEntry;
            activeId = newEntry.id;
        }
        applyMix();
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
        // Removing the soloed strip un-silences the others.
        applyMix();
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

    /**
     * Write the strips back onto the project's **tracks**.
     *
     * A track and a mixer strip are one thing: the slot is the channel, and
     * the name, patch, volume, mute and solo all describe the same voice.
     * They used to be two records with two mute flags that could disagree —
     * the song's track gated whether notes were *scheduled* while the bank
     * entry gated the channel's *volume*, and nothing kept them in step.
     *
     * Tracks with no voice are left alone: the roll makes one the moment a
     * note is drawn, before any patch is assigned, and that track's clips
     * must survive the bank not knowing about it yet.
     */
    function saveState() {
        if (!session || !session.get()) return;
        session.update((project) => {
            const bySlot = new Map(project.tracks.map(t => [t.slot, t]));
            for (let slot = 0; slot < MAX_SLOTS; slot++) {
                const entry = entries[slot];
                const track = bySlot.get(slot);
                if (!entry) {
                    // The strip was emptied. The track keeps its place and
                    // its clips; it just has nothing to sound with.
                    if (track) { track.patchId = null; track.voiceData = null; }
                    continue;
                }
                const fields = {
                    name: entry.name,
                    patchId: entry.patchId || null,
                    voiceData: entry.voiceData,
                    volume: entry.volume,
                    mute: !!entry.muted,
                    solo: !!entry.solo,
                };
                if (track) Object.assign(track, fields);
                // The new track takes the strip's id, so the two never have
                // two identities for one voice — and so a strip survives a
                // save/reload cycle as the same object to its subscribers.
                else project.tracks.push(createTrack({ ...fields, id: entry.id, slot }));
            }
            project.tracks.sort((a, b) => a.slot - b.slot);
        }, 'voicebank', 'tracks');
    }

    /**
     * Read the strips back off the project's tracks. A track with no voice
     * data is not a strip — the roll creates bare tracks for notes, and an
     * empty slot is how the mixer shows one.
     *
     * The entry's id **is** the track id, so selecting a strip and
     * selecting a track are the same act.
     */
    function loadState() {
        const project = session && session.get();
        if (!project) return;
        const next = new Array(MAX_SLOTS).fill(null);
        const seen = new Set();
        for (const track of project.tracks) {
            if (track.slot < 0 || track.slot >= MAX_SLOTS) continue;
            const voiceCopy = copyVoice(track.voiceData);
            if (!voiceCopy) continue;
            const key = voiceKey(voiceCopy);
            // One voice, one slot — the invariant assignToSlot enforces.
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);
            next[track.slot] = {
                id: track.id,
                name: track.name,
                patchId: track.patchId || null,
                voiceData: voiceCopy,
                voiceKey: key,
                color: PATCH_COLORS[track.slot % PATCH_COLORS.length],
                volume: track.volume == null ? DEFAULT_VOLUME : track.volume,
                muted: !!track.mute,
                solo: !!track.solo,
            };
        }
        entries = next;
        if (activeId && !entries.find(e => e && e.id === activeId)) activeId = null;
        if (!activeId) {
            const first = entries.find(e => e);
            activeId = first ? first.id : null;
        }
    }

    // Init. The mix is computed silently — the engine is not up yet; the
    // first snapshot carries the effective volumes.
    loadState();
    applyMix(false);
    render();

    // Another editor changed the band, or the project was switched: the
    // strips are a view of the tracks, so re-read them. Our own writes are
    // skipped — re-reading mid-edit would fight the user's drag.
    if (session) {
        session.subscribe((ev) => {
            if (ev.source === 'voicebank') return;
            if (ev.kind !== 'project' && ev.kind !== 'tracks') return;
            loadState();
            applyMix(false);
            render();
            notifySnapshot();
        });
    }

    container._addEntry = addEntry;
    container._assignToSlot = assignToSlot;
    container._firstEmptySlot = firstEmptySlot;
    container._removeEntry = removeEntry;
    container._toggleMute = toggleMute;
    container._toggleSolo = toggleSolo;
    container._clear = () => { entries = new Array(MAX_SLOTS).fill(null); activeId = null; render(); saveState(); notifySnapshot(); };
    container._reload = () => { loadState(); applyMix(false); render(); notifySnapshot(); };
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
