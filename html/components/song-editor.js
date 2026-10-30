// Song editor — arrange patterns as clips on tracks.
//
// A grid: tracks are rows, measures are columns. Left of it a palette of
// every pattern in the library. Pick a pattern, click an empty spot on a
// lane, and a clip is placed there; drag a clip to move it, drag its right
// edge to repeat it, select it and press Delete (or the Remove button) to
// take it out. Each row binds to a voice-bank slot and has mute/solo.
// Everything autosaves through the song session — there is no Save button
// and no "Song exists": songs are id-keyed, names are just labels.
//
// Opening a clip (double-click, or the ✎ button when selected) hands its
// pattern to the piano roll via opts.onOpenPattern.

import {
    addClip, updateClip, removeClip, removeTrack, clipSpan, songLength,
    createPattern, createTrack, patternStore, patternUsage,
    COLS_PER_MEASURE, MAX_SLOTS, MIN_BPM, MAX_BPM,
} from './song-model.js';
import { createSongSession } from './song-session.js';

export const MEASURE_W = 48;      // px per measure in the grid
const MIN_GRID_MEASURES = 16;     // never show an empty, zero-width song
const DRAG_THRESHOLD = 4;         // px before a press becomes a drag
const LONG_PRESS_MS = 600;        // a still press this long opens the clip in the roll
const DOUBLE_TAP_MS = 400;        // two presses on one clip within this remove it (as in the roll)

export function createSongEditor(opts = {}) {
    const session = opts.session || createSongSession();
    const transport = opts.transport || null;
    const log = opts.log || (() => {});
    const getSlotData = opts.getSlotData || (() => null);
    const getPattern = (id) => session.getPattern(id);

    let selectedPatternId = null;
    let selectedClipId = null;
    let playBtn = null;        // transport buttons, re-created by renderToolbar, synced per tick
    let stopBtn = null;
    let lastPress = { clipId: null, at: 0 };   // last body press, for double-tap removal
    let unsubscribe = null;
    let unsubscribeTransport = null;
    let playheadEl = null;

    const root = document.createElement('div');
    root.className = 'song-editor';

    const toolbar = document.createElement('div');
    toolbar.className = 'song-toolbar';
    const body = document.createElement('div');
    body.className = 'song-body';
    const palette = document.createElement('div');
    palette.className = 'song-palette';
    const grid = document.createElement('div');
    grid.className = 'song-grid';
    const status = document.createElement('div');
    status.className = 'song-status';
    body.appendChild(palette);
    body.appendChild(grid);
    root.appendChild(toolbar);
    root.appendChild(body);
    root.appendChild(status);

    function say(msg) {
        status.textContent = msg || '';
        if (msg) log(`[song] ${msg}`);
    }

    /** Apply a model change; the model's refusals ('Clip overlaps') become status text. */
    function change(mutator) {
        try {
            session.update(mutator, 'song-editor');
            say('');
            return true;
        } catch (e) {
            say(e.message);
            render();
            return false;
        }
    }

    function slotLabel(slot) {
        const entry = getSlotData(slot);
        return (slot + 1) + '. ' + (entry ? entry.name : '—');
    }

    /** `#rrggbb` → `rgba(r,g,b,a)`; anything else is passed through. */
    function tint(hex, alpha) {
        const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
        if (!m) return hex;
        return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
    }

    function slotColor(slot) {
        const entry = getSlotData(slot);
        return entry && entry.color ? entry.color : '#888';
    }

    function gridMeasures(song) {
        return Math.max(MIN_GRID_MEASURES, songLength(song, getPattern) + 4);
    }

    // --- Toolbar: which song, its name, tempo, loop ---

    function button(label, title, onClick, className = 'song-btn') {
        const b = document.createElement('button');
        b.className = className;
        b.textContent = label;
        if (title) b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
        return b;
    }

    function renderToolbar(song) {
        toolbar.innerHTML = '';

        // Play here is the whole song; the roll's Play loops its pattern.
        if (transport) {
            playBtn = button('\u25B6 Play', 'Play the song from the start of its loop', () => {
                transport.play({ mode: 'song' });
            }, 'song-btn song-play');
            stopBtn = button('\u25A0 Stop', 'Stop', () => transport.stop(), 'song-btn song-stop');
            toolbar.appendChild(playBtn);
            toolbar.appendChild(stopBtn);
            syncTransportButtons({
                playing: transport.isPlaying(), recording: transport.isRecording(), mode: transport.getMode(),
            });
        }

        const select = document.createElement('select');
        select.className = 'song-select';
        select.title = 'Song';
        for (const s of session.list()) {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name;
            if (s.id === song.id) opt.selected = true;
            select.appendChild(opt);
        }
        select.value = song.id;
        select.addEventListener('change', () => {
            selectedClipId = null;
            session.open(select.value, 'song-editor');
        });
        toolbar.appendChild(select);

        const name = document.createElement('input');
        name.className = 'song-name';
        name.type = 'text';
        name.value = song.name;
        name.title = 'Song name';
        name.addEventListener('change', () => {
            const v = String(name.value).trim();
            if (!v) { name.value = song.name; return; }
            change((s) => { s.name = v; });
        });
        toolbar.appendChild(name);

        toolbar.appendChild(button('+ Song', 'New empty song', () => {
            selectedClipId = null;
            session.createNew(`Untitled song ${session.list().length + 1}`, 'song-editor');
        }));
        toolbar.appendChild(button('✕', 'Delete this song', () => {
            if (!confirm(`Delete song "${song.name}"?`)) return;
            selectedClipId = null;
            session.remove(song.id, 'song-editor');
        }, 'song-btn song-delete'));

        const bpmLabel = document.createElement('label');
        bpmLabel.className = 'song-field';
        bpmLabel.textContent = 'BPM ';
        const bpm = document.createElement('input');
        bpm.className = 'song-bpm';
        bpm.type = 'number';
        bpm.min = String(MIN_BPM);
        bpm.max = String(MAX_BPM);
        bpm.value = String(song.bpm);
        bpm.addEventListener('change', () => {
            const v = parseInt(bpm.value);
            const clamped = Number.isFinite(v) ? Math.max(MIN_BPM, Math.min(MAX_BPM, v)) : song.bpm;
            change((s) => { s.bpm = clamped; });
        });
        bpmLabel.appendChild(bpm);
        toolbar.appendChild(bpmLabel);

        // Loop range, shown as inclusive 1-based bars ("bars 1 to 4"),
        // stored as a 0-based half-open range ({start: 0, end: 4}).
        const loopLabel = document.createElement('label');
        loopLabel.className = 'song-field';
        const loopOn = document.createElement('input');
        loopOn.type = 'checkbox';
        loopOn.className = 'song-loop-on';
        loopOn.checked = !!song.loop;
        loopLabel.appendChild(loopOn);
        loopLabel.appendChild(document.createTextNode(' Loop bars '));
        const loopStart = document.createElement('input');
        loopStart.type = 'number';
        loopStart.className = 'song-loop-start';
        loopStart.min = '1';
        loopStart.value = String(song.loop ? song.loop.start + 1 : 1);
        const loopEnd = document.createElement('input');
        loopEnd.type = 'number';
        loopEnd.className = 'song-loop-end';
        loopEnd.min = '1';
        loopEnd.value = String(song.loop ? song.loop.end : Math.max(1, songLength(song, getPattern)));
        loopLabel.appendChild(loopStart);
        loopLabel.appendChild(document.createTextNode(' to '));
        loopLabel.appendChild(loopEnd);
        const applyLoop = () => {
            if (!loopOn.checked) { change((s) => { s.loop = null; }); return; }
            const a = parseInt(loopStart.value), b = parseInt(loopEnd.value);
            if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) {
                say('Loop range must be from a bar to a later (or the same) bar');
                return;
            }
            change((s) => { s.loop = { start: a - 1, end: b }; });
        };
        loopOn.addEventListener('change', applyLoop);
        loopStart.addEventListener('change', applyLoop);
        loopEnd.addEventListener('change', applyLoop);
        toolbar.appendChild(loopLabel);
    }

    // --- Palette: the pattern library ---

    function renderPalette(song) {
        palette.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'song-palette-head';
        head.textContent = 'Patterns';
        head.appendChild(button('+', 'New pattern', () => {
            const p = patternStore.create({ name: `Pattern ${patternStore.list().length + 1}` });
            selectedPatternId = p.id;
            session.notifyPattern(p.id, 'song-editor');
            render();
        }, 'song-btn song-pattern-new'));
        palette.appendChild(head);

        const list = document.createElement('div');
        list.className = 'song-pattern-list';
        const patterns = patternStore.list();
        if (patterns.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'song-empty';
            empty.textContent = 'No patterns yet — draw one in the piano roll, or press +.';
            list.appendChild(empty);
        }
        if (selectedPatternId && !patterns.some(p => p.id === selectedPatternId)) selectedPatternId = null;

        for (const p of patterns) {
            const item = document.createElement('div');
            item.className = 'song-pattern-item' + (p.id === selectedPatternId ? ' selected' : '');
            item.dataset.patternId = p.id;
            item.title = 'Click to select, then click a lane to place';

            // The pattern's colour — what its clips are painted with. The
            // swatch is the picker; a click on it must not toggle selection.
            const swatch = document.createElement('input');
            swatch.type = 'color';
            swatch.className = 'song-pattern-swatch';
            swatch.value = p.color;
            swatch.title = 'Pattern colour';
            swatch.addEventListener('click', (e) => e.stopPropagation());
            swatch.addEventListener('input', () => { item.style.borderLeftColor = swatch.value; });
            swatch.addEventListener('change', () => {
                patternStore.put({ ...patternStore.get(p.id), color: swatch.value });
                session.notifyPattern(p.id, 'song-editor');
                render();
            });
            item.appendChild(swatch);
            item.style.borderLeftColor = p.color;

            const nameEl = document.createElement('span');
            nameEl.className = 'song-pattern-name';
            nameEl.textContent = p.name;
            item.appendChild(nameEl);

            const len = document.createElement('span');
            len.className = 'song-pattern-len';
            len.textContent = p.measures + (p.measures === 1 ? ' bar' : ' bars');
            item.appendChild(len);

            // Rename in place, the way patch rows and containers do. The
            // button exists for touch, where a double-click is not a thing.
            const beginRename = () => {
                nameEl.contentEditable = 'true';
                nameEl.focus();
            };
            item.appendChild(button('✎', 'Rename pattern', beginRename, 'song-btn song-pattern-rename'));
            item.appendChild(button('⧉', 'Duplicate', () => {
                const copy = patternStore.create({ ...p, id: undefined, name: p.name + ' copy', created: undefined });
                selectedPatternId = copy.id;
                session.notifyPattern(copy.id, 'song-editor');
                render();
            }, 'song-btn song-pattern-dup'));
            item.appendChild(button('✕', 'Delete pattern', () => {
                const used = patternUsage(p.id);
                if (used.length > 0) {
                    say(`"${p.name}" is placed in ${used.length} song${used.length > 1 ? 's' : ''} — remove its clips first`);
                    return;
                }
                if (!confirm(`Delete pattern "${p.name}"?`)) return;
                patternStore.remove(p.id);
                if (selectedPatternId === p.id) selectedPatternId = null;
                session.notifyPattern(p.id, 'song-editor');
                render();
            }, 'song-btn song-pattern-del'));

            item.addEventListener('click', () => {
                selectedPatternId = selectedPatternId === p.id ? null : p.id;
                render();
            });
            nameEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                beginRename();
            });
            nameEl.addEventListener('blur', () => {
                if (nameEl.contentEditable !== 'true') return;
                nameEl.contentEditable = 'false';
                const v = String(nameEl.textContent).trim();
                if (v && v !== p.name) {
                    patternStore.put({ ...patternStore.get(p.id), name: v });
                    session.notifyPattern(p.id, 'song-editor');
                }
                render();
            });
            nameEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); if (nameEl.blur) nameEl.blur(); }
                if (e.key === 'Escape') { nameEl.textContent = p.name; nameEl.contentEditable = 'false'; }
            });
            list.appendChild(item);
        }
        palette.appendChild(list);
    }

    // --- Grid: tracks × measures ---

    function pointer(e) {
        const t = e.touches ? e.touches[0] : (e.changedTouches ? e.changedTouches[0] : e);
        return { x: t.clientX, y: t.clientY };
    }

    function measureAt(lane, clientX) {
        const rect = lane.getBoundingClientRect();
        return Math.max(0, Math.floor((clientX - rect.left + (lane.scrollLeft || 0)) / MEASURE_W));
    }

    function renderGrid(song) {
        grid.innerHTML = '';
        const cols = gridMeasures(song);

        // Measure ruler
        const ruler = document.createElement('div');
        ruler.className = 'song-ruler';
        const rulerHead = document.createElement('div');
        rulerHead.className = 'song-track-head song-ruler-head';
        rulerHead.textContent = 'Track';
        ruler.appendChild(rulerHead);
        const rulerLane = document.createElement('div');
        rulerLane.className = 'song-ruler-lane';
        rulerLane.style.width = (cols * MEASURE_W) + 'px';
        for (let m = 0; m < cols; m++) {
            const tick = document.createElement('span');
            tick.className = 'song-ruler-tick';
            tick.style.left = (m * MEASURE_W) + 'px';
            tick.textContent = String(m + 1);
            rulerLane.appendChild(tick);
        }
        if (song.loop) {
            const band = document.createElement('div');
            band.className = 'song-loop-band';
            band.style.left = (song.loop.start * MEASURE_W) + 'px';
            band.style.width = ((song.loop.end - song.loop.start) * MEASURE_W) + 'px';
            rulerLane.appendChild(band);
        }
        ruler.appendChild(rulerLane);
        grid.appendChild(ruler);

        // Re-created by each render, then only moved on a tick: rebuilding
        // every clip element sixteen times a bar is not an option.
        playheadEl = document.createElement('div');
        playheadEl.className = 'song-playhead';
        playheadEl.style.display = 'none';
        grid.appendChild(playheadEl);
        if (transport) movePlayhead(transport.isRunning() ? transport.getColumn() : -1);

        if (song.tracks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'song-empty';
            empty.textContent = 'No tracks. Add one, or draw a note in the piano roll.';
            grid.appendChild(empty);
        }

        for (const track of song.tracks) grid.appendChild(renderTrack(song, track, cols));

        const addRow = document.createElement('div');
        addRow.className = 'song-add-track-row';
        const used = new Set(song.tracks.map(t => t.slot));
        addRow.appendChild(button('+ Track', 'Add a track on the first free voice', () => {
            let slot = 0;
            while (slot < MAX_SLOTS && used.has(slot)) slot++;
            if (slot >= MAX_SLOTS) { say(`All ${MAX_SLOTS} voices have a track`); return; }
            change((s) => { s.tracks.push(createTrack({ name: slotLabel(slot), slot })); });
        }, 'song-btn song-add-track'));
        grid.appendChild(addRow);

        // Selected-clip actions live here rather than on the clip so they
        // are reachable by touch, where there is no hover and no Delete key.
        if (selectedClipId && song.clips.some(c => c.id === selectedClipId)) {
            const bar = document.createElement('div');
            bar.className = 'song-clip-actions';
            bar.appendChild(button('✎ Open in piano roll', 'Edit this clip\'s pattern', () => openClip(selectedClipId), 'song-btn song-clip-open'));
            bar.appendChild(button('Remove clip', 'Remove this clip from the song', () => deleteClip(selectedClipId), 'song-btn song-clip-remove'));
            grid.appendChild(bar);
        }
    }

    function renderTrack(song, track, cols) {
        const row = document.createElement('div');
        row.className = 'song-track';
        row.dataset.trackId = track.id;

        const head = document.createElement('div');
        head.className = 'song-track-head';
        head.style.borderLeftColor = slotColor(track.slot);

        const slotSel = document.createElement('select');
        slotSel.className = 'song-track-slot';
        slotSel.title = 'Voice this track plays';
        for (let i = 0; i < MAX_SLOTS; i++) {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = slotLabel(i);
            if (i === track.slot) opt.selected = true;
            slotSel.appendChild(opt);
        }
        slotSel.value = String(track.slot);
        slotSel.addEventListener('change', () => {
            const slot = parseInt(slotSel.value);
            change((s) => { s.tracks.find(t => t.id === track.id).slot = slot; });
        });
        head.appendChild(slotSel);

        head.appendChild(button('M', 'Mute', () => {
            change((s) => { const t = s.tracks.find(x => x.id === track.id); t.mute = !t.mute; });
        }, 'song-btn song-track-mute' + (track.mute ? ' active' : '')));
        head.appendChild(button('S', 'Solo', () => {
            change((s) => { const t = s.tracks.find(x => x.id === track.id); t.solo = !t.solo; });
        }, 'song-btn song-track-solo' + (track.solo ? ' active' : '')));
        head.appendChild(button('✕', 'Remove track', () => {
            const n = song.clips.filter(c => c.trackId === track.id).length;
            if (n > 0 && !confirm(`Remove this track and its ${n} clip${n > 1 ? 's' : ''}?`)) return;
            if (selectedClipId && song.clips.some(c => c.id === selectedClipId && c.trackId === track.id)) selectedClipId = null;
            change((s) => { removeTrack(s, track.id); });
        }, 'song-btn song-track-remove'));
        row.appendChild(head);

        const lane = document.createElement('div');
        lane.className = 'song-lane';
        lane.style.width = (cols * MEASURE_W) + 'px';
        // The whole lane carries the voice, quietly; clips carry their
        // pattern's colour on top. (backgroundColor, not background: the
        // bar grid is a background-image on the same element.)
        lane.style.backgroundColor = tint(slotColor(track.slot), 0.16);
        lane.dataset.trackId = track.id;
        lane.addEventListener('click', (e) => {
            if (e.target !== lane) return;           // a clip handles its own clicks
            if (!selectedPatternId) {
                selectedClipId = null;
                say('Select a pattern in the palette, then click a lane to place it');
                render();
                return;
            }
            const startMeasure = measureAt(lane, e.clientX);
            change((s) => {
                const clip = addClip(s, { trackId: track.id, patternId: selectedPatternId, startMeasure }, getPattern);
                selectedClipId = clip.id;
            });
        });

        for (const clip of song.clips) {
            if (clip.trackId !== track.id) continue;
            const pattern = getPattern(clip.patternId);
            const span = clipSpan(clip, pattern);
            if (!span) continue;                     // dangling: silence, not a crash
            lane.appendChild(renderClip(clip, pattern, span, track, lane));
        }
        row.appendChild(lane);
        return row;
    }

    function renderClip(clip, pattern, span, track, lane) {
        const el = document.createElement('div');
        el.className = 'song-clip' + (clip.id === selectedClipId ? ' selected' : '');
        el.dataset.clipId = clip.id;
        el.style.left = (span.start * MEASURE_W) + 'px';
        el.style.width = ((span.end - span.start) * MEASURE_W - 2) + 'px';
        el.style.background = pattern.color;
        el.title = `${pattern.name} × ${clip.repeats} — drag to move (to another track too), drag the edge to repeat, hold to open, double-click to remove`;

        const label = document.createElement('span');
        label.className = 'song-clip-label';
        label.textContent = clip.repeats > 1 ? `${pattern.name} ×${clip.repeats}` : pattern.name;
        el.appendChild(label);

        const handle = document.createElement('span');
        handle.className = 'song-clip-handle';
        el.appendChild(handle);

        el.addEventListener('click', (e) => {
            e.stopPropagation();
            // The click after a double-tap's second press arrives for a clip
            // that press just removed; it must not re-select a ghost.
            if (!session.get().clips.some(c => c.id === clip.id)) return;
            selectedClipId = clip.id;
            selectedPatternId = clip.patternId;
            render();
        });
        // Move (body) or repeat (handle). Pointer deltas are snapped to
        // measures; the model decides whether the result is legal. Below
        // DRAG_THRESHOLD a press is a click: no preview, no re-render.
        //
        // A move is two-dimensional: sideways by measures, and down or up
        // into another track's lane. A clip is only a pattern placed
        // somewhere — the voice is the track's — so crossing lanes needs
        // nothing but a new trackId, and the model's overlap check covers
        // the destination as it does the origin.
        //
        // The body also carries the two gestures the piano roll's notes
        // have: a second press within DOUBLE_TAP_MS removes the clip, and a
        // press held still for LONG_PRESS_MS opens it in the roll. Both are
        // detected from press/release rather than via `dblclick`, so touch
        // gets them too. The tap memory lives on the editor, not the
        // element, because the click in between re-renders the clip.
        const startDrag = (e, mode) => {
            e.stopPropagation();
            if (e.cancelable && e.preventDefault) e.preventDefault();
            if (mode === 'move' && lastPress.clipId === clip.id && Date.now() - lastPress.at < DOUBLE_TAP_MS) {
                lastPress = { clipId: null, at: 0 };
                deleteClip(clip.id);
                return;
            }
            const origin = pointer(e);
            let moved = false;
            let hold = null;
            let targetLane = lane;     // where the body is being dragged to
            const laneAt = (clientY) => {
                for (const l of Array.from(grid.querySelectorAll('.song-lane'))) {
                    const r = l.getBoundingClientRect();
                    if (clientY >= r.top && clientY < r.bottom) return l;
                }
                return null;
            };
            const detach = () => {
                if (hold) { clearTimeout(hold); hold = null; }
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', finish);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', finish);
                document.removeEventListener('touchcancel', cancel);
            };
            const onMove = (ev) => {
                const pt = pointer(ev);
                const dx = pt.x - origin.x;
                const dy = pt.y - origin.y;
                if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
                if (hold) { clearTimeout(hold); hold = null; }   // it moved: a drag, not a hold
                moved = true;
                const dm = Math.round(dx / MEASURE_W);
                if (mode === 'move') {
                    el.style.left = (Math.max(0, span.start + dm) * MEASURE_W) + 'px';
                    // Preview across lanes: re-parent the element. It keeps
                    // its pattern colour — the lane's tint says which voice.
                    const over = laneAt(pt.y) || targetLane;
                    if (over !== targetLane) {
                        targetLane = over;
                        targetLane.appendChild(el);
                    }
                } else {
                    const reps = Math.max(1, Math.round((span.end - span.start + dm) / pattern.measures));
                    el.style.width = (reps * pattern.measures * MEASURE_W - 2) + 'px';
                }
            };
            const finish = (ev) => {
                detach();
                if (!moved) {
                    // A tap. Only a tap arms the double-tap: re-grabbing a
                    // clip right after dragging it must not remove it.
                    if (mode === 'move') lastPress = { clipId: clip.id, at: Date.now() };
                    return;
                }
                const dm = Math.round((pointer(ev).x - origin.x) / MEASURE_W);
                selectedClipId = clip.id;
                if (mode === 'move') {
                    const startMeasure = Math.max(0, span.start + dm);
                    const trackId = targetLane.dataset.trackId || clip.trackId;
                    if (startMeasure === clip.startMeasure && trackId === clip.trackId) { render(); return; }
                    change((s) => { updateClip(s, clip.id, { startMeasure, trackId }, getPattern); });
                } else {
                    const repeats = Math.max(1, Math.round((span.end - span.start + dm) / pattern.measures));
                    if (repeats === clip.repeats) { render(); return; }
                    change((s) => { updateClip(s, clip.id, { repeats }, getPattern); });
                }
            };
            const cancel = () => {
                detach();
                render();
            };
            if (mode === 'move') {
                hold = setTimeout(() => {
                    hold = null;
                    detach();
                    lastPress = { clipId: null, at: 0 };   // the release must not count as a second tap
                    openClip(clip.id);
                }, LONG_PRESS_MS);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', finish);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', finish);
            document.addEventListener('touchcancel', cancel);
        };
        el.addEventListener('mousedown', (e) => startDrag(e, 'move'));
        el.addEventListener('touchstart', (e) => startDrag(e, 'move'), { passive: false });
        handle.addEventListener('mousedown', (e) => startDrag(e, 'repeat'));
        handle.addEventListener('touchstart', (e) => startDrag(e, 'repeat'), { passive: false });
        return el;
    }

    /**
     * Park the playhead at a song column. Both modes have one — pattern
     * mode loops a window of the song — except a pattern placed nowhere,
     * which reports no song column and so hides it.
     */
    function movePlayhead(col) {
        if (!playheadEl) return;
        if (!(col >= 0)) {
            playheadEl.style.display = 'none';
            return;
        }
        playheadEl.style.display = '';
        // Offset from the lane's left edge; the head column's width is a
        // rem value the stylesheet adds as margin-left, so the playhead
        // tracks it at any root font size instead of a pixel guess.
        playheadEl.style.left = ((col / COLS_PER_MEASURE) * MEASURE_W) + 'px';
    }

    function deleteClip(clipId) {
        change((s) => { removeClip(s, clipId); });
        if (selectedClipId === clipId) selectedClipId = null;
    }

    function syncTransportButtons(pos) {
        if (!playBtn) return;
        const running = pos.playing || pos.recording;
        playBtn.disabled = running;
        stopBtn.disabled = !running;
        playBtn.classList.toggle('active', !!pos.playing && pos.mode === 'song');
    }

    function openClip(clipId) {
        const song = session.get();
        const clip = song.clips.find(c => c.id === clipId);
        if (!clip) return;
        selectedClipId = clipId;
        selectedPatternId = clip.patternId;
        // Park the song position on this clip so it, and not another
        // placement of the same pattern, is what the roll's Play loops.
        if (transport && transport.setSongPosition) transport.setSongPosition(clip.startMeasure * COLS_PER_MEASURE);
        if (opts.onOpenPattern) opts.onOpenPattern(clipId, clip.trackId, clip.patternId);
        render();
    }

    // Delete/Backspace removes the selected clip — unless the user is typing.
    function onKey(e) {
        if (!selectedClipId) return;
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (e.target && e.target.contentEditable === 'true') return;
        e.preventDefault();
        deleteClip(selectedClipId);
    }
    document.addEventListener('keydown', onKey);

    function render() {
        const song = session.get();
        if (!song) return;
        renderToolbar(song);
        renderPalette(song);
        renderGrid(song);
    }

    session.init();
    unsubscribe = session.subscribe(() => render());
    if (transport) {
        unsubscribeTransport = transport.subscribe((pos) => {
            movePlayhead(pos.songCol != null ? pos.songCol : pos.col);
            syncTransportButtons(pos);
        });
    }
    render();

    return {
        element: root,
        render,
        getSelectedPatternId() { return selectedPatternId; },
        getSelectedClipId() { return selectedClipId; },
        selectPattern(id) { selectedPatternId = id; render(); },
        destroy() {
            document.removeEventListener('keydown', onKey);
            if (unsubscribe) unsubscribe();
            if (unsubscribeTransport) unsubscribeTransport();
        },
    };
}
