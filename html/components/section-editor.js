// Section editor — arrange patterns as clips on tracks.
//
// A **section** is one smaller piece of the project; this edits the one
// the session says is current. A grid: tracks are rows, bars are columns.
// Left of it a palette of every pattern in the project. Pick a pattern,
// click an empty spot on a lane, and a clip is placed there; drag a clip
// to move it, drag its right edge to lengthen it, select it and press
// Delete (or the Remove button) to take it out.
//
// **A lane is a track is a Mixer strip is a voice.** One record: the slot
// is the synth channel, and the name, patch, volume, mute and solo all
// describe the same thing. Mute here is the mute the Mixer shows. The
// slot select *swaps* with whatever holds the slot already, because two
// tracks on one channel is two voices fighting over one output.
//
// Placing, moving and lengthening all happen at the **snap** resolution,
// a bar by default and down to a sixteenth — clips are not bar-aligned by
// nature, their geometry is columns (see project-model.js). **Zoom** widens
// the bar so the finer resolutions are something a pointer can hit.
//
// Everything autosaves through the project session; there is no Save
// button. Choosing, creating and deleting *projects* is not here — a
// project is the whole piece, and that lives in the File menu.
//
// Opening a clip (double-click, or the ✎ button when selected) hands its
// pattern to the piano roll via opts.onOpenPattern.

import {
    addClip, updateClip, removeClip, removeTrack, setTrackSlot,
    clipCols, clipRepeats, sectionLength, createTrack, patternCols,
    COLS_PER_MEASURE, MAX_SLOTS, MIN_BPM, MAX_BPM,
} from './project-model.js';

export const MEASURE_W = 48;      // px per measure in the grid, at zoom ×1
const MIN_GRID_MEASURES = 16;     // never show an empty, zero-width grid
const DRAG_THRESHOLD = 4;         // px before a press becomes a drag
const LONG_PRESS_MS = 600;        // a still press this long opens the clip in the roll
const DOUBLE_TAP_MS = 400;        // two presses on one clip within this remove it (as in the roll)

const SNAP_KEY = 'openpatches_song_snap';
const ZOOM_KEY = 'openpatches_song_zoom';
// Grid resolutions, in columns. A bar is the default, so the grid behaves
// exactly as it always did until the user asks for something finer.
export const SNAPS = [
    { cols: COLS_PER_MEASURE, label: 'Bar' },
    { cols: 8, label: '1/2' },
    { cols: 4, label: '1/4' },
    { cols: 2, label: '1/8' },
    { cols: 1, label: '1/16' },
];
export const ZOOMS = [1, 2, 4, 8];

function loadNum(key, allowed, fallback) {
    try {
        const v = Number(localStorage.getItem(key));
        return allowed.includes(v) ? v : fallback;
    } catch { return fallback; }
}

export function createSectionEditor(opts = {}) {
    const session = opts.session;
    const transport = opts.transport || null;
    const log = opts.log || (() => {});
    const getSlotData = opts.getSlotData || (() => null);
    const getPattern = (id) => session.getPattern(id);
    /** The section being edited — where this editor's clips and loop live. */
    const sec = () => session.getSection();

    let selectedPatternId = null;
    let selectedClipId = null;
    let playBtn = null;        // transport buttons, re-created by renderToolbar, synced per tick
    let stopBtn = null;
    let lastPress = { clipId: null, at: 0 };   // last body press, for double-tap removal
    let unsubscribe = null;
    let unsubscribeTransport = null;
    let playheadEl = null;
    let snapCols = loadNum(SNAP_KEY, SNAPS.map(s => s.cols), COLS_PER_MEASURE);
    let zoom = loadNum(ZOOM_KEY, ZOOMS, 1);

    /** Grid scale. One bar is MEASURE_W at zoom ×1; a column is 1/16 of it. */
    const measureW = () => MEASURE_W * zoom;
    const colW = () => measureW() / COLS_PER_MEASURE;
    /** Round a column count to the snap resolution (a delta, or a position). */
    const snap = (cols) => Math.round(cols / snapCols) * snapCols;

    const root = document.createElement('div');
    root.className = 'section-editor';

    const toolbar = document.createElement('div');
    toolbar.className = 'section-toolbar';
    const body = document.createElement('div');
    body.className = 'section-body';
    const palette = document.createElement('div');
    palette.className = 'section-palette';
    const grid = document.createElement('div');
    grid.className = 'section-grid';
    const status = document.createElement('div');
    status.className = 'section-status';
    body.appendChild(palette);
    body.appendChild(grid);
    root.appendChild(toolbar);
    root.appendChild(body);
    root.appendChild(status);

    function say(msg) {
        status.textContent = msg || '';
        if (msg) log(`[section] ${msg}`);
    }

    /** Apply a model change; the model's refusals ('Clip overlaps') become status text. */
    function change(mutator) {
        try {
            session.update(mutator, 'section-editor');
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

    function gridMeasures(project) {
        return Math.max(MIN_GRID_MEASURES, sectionLength(project, sec()) + 4);
    }

    // --- Toolbar: the section's name, the project's tempo, the section's loop ---

    function button(label, title, onClick, className = 'section-btn') {
        const b = document.createElement('button');
        b.className = className;
        b.textContent = label;
        if (title) b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
        return b;
    }

    function renderToolbar(project) {
        toolbar.innerHTML = '';

        // Play here is the whole section; the roll's Play loops one pattern.
        if (transport) {
            playBtn = button('\u25B6 Play', 'Play the section from the start of its loop', () => {
                transport.play({ mode: 'section' });
            }, 'section-btn section-play');
            // Armed for an external clock: Play is taken but nothing runs
            // until the device starts us. The pulse says so; Stop disarms.
            const waitTitle = 'Waiting for the external MIDI clock to start';
            playBtn.dataset.waitTitle = waitTitle;
            stopBtn = button('\u25A0 Stop', 'Stop', () => transport.stop(), 'section-btn section-stop');
            toolbar.appendChild(playBtn);
            toolbar.appendChild(stopBtn);
            syncTransportButtons({
                playing: transport.isPlaying(), recording: transport.isRecording(), mode: transport.getMode(),
                waiting: transport.isWaiting ? transport.isWaiting() : false,
            });
        }

        // This toolbar edits the **section** on screen. Choosing, creating
        // and deleting *projects* used to live here too — a project is the
        // whole piece now, far bigger than this panel, so it moved to the
        // File menu.
        const name = document.createElement('input');
        name.className = 'section-name';
        name.type = 'text';
        name.value = sec().name;
        name.title = 'Section name';
        name.addEventListener('change', () => {
            const v = String(name.value).trim();
            if (!v) { name.value = sec().name; return; }
            session.renameSection(v, 'section-editor');
        });
        toolbar.appendChild(name);

        const bpmLabel = document.createElement('label');
        bpmLabel.className = 'section-field';
        bpmLabel.textContent = 'BPM ';
        const bpm = document.createElement('input');
        bpm.className = 'section-bpm';
        bpm.type = 'number';
        bpm.min = String(MIN_BPM);
        bpm.max = String(MAX_BPM);
        bpm.value = String(project.bpm);
        bpm.addEventListener('change', () => {
            const v = parseInt(bpm.value);
            const clamped = Number.isFinite(v) ? Math.max(MIN_BPM, Math.min(MAX_BPM, v)) : project.bpm;
            change((s) => { s.bpm = clamped; });
        });
        bpmLabel.appendChild(bpm);
        toolbar.appendChild(bpmLabel);

        // Loop range, shown as inclusive 1-based bars ("bars 1 to 4"),
        // stored as a 0-based half-open range ({start: 0, end: 4}).
        const loopLabel = document.createElement('label');
        loopLabel.className = 'section-field';
        const loopOn = document.createElement('input');
        loopOn.type = 'checkbox';
        loopOn.className = 'section-loop-on';
        loopOn.checked = !!sec().loop;
        loopLabel.appendChild(loopOn);
        loopLabel.appendChild(document.createTextNode(' Loop bars '));
        const loopStart = document.createElement('input');
        loopStart.type = 'number';
        loopStart.className = 'section-loop-start';
        loopStart.min = '1';
        loopStart.value = String(sec().loop ? sec().loop.start + 1 : 1);
        const loopEnd = document.createElement('input');
        loopEnd.type = 'number';
        loopEnd.className = 'section-loop-end';
        loopEnd.min = '1';
        loopEnd.value = String(sec().loop ? sec().loop.end : Math.max(1, sectionLength(project, sec())));
        loopLabel.appendChild(loopStart);
        loopLabel.appendChild(document.createTextNode(' to '));
        loopLabel.appendChild(loopEnd);
        const applyLoop = () => {
            if (!loopOn.checked) { change((project, section) => { section.loop = null; }); return; }
            const a = parseInt(loopStart.value), b = parseInt(loopEnd.value);
            if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) {
                say('Loop range must be from a bar to a later (or the same) bar');
                return;
            }
            change((project, section) => { section.loop = { start: a - 1, end: b }; });
        };
        loopOn.addEventListener('change', applyLoop);
        loopStart.addEventListener('change', applyLoop);
        loopEnd.addEventListener('change', applyLoop);
        toolbar.appendChild(loopLabel);

        // Snap and zoom are view settings, not part of the project: they are
        // persisted on their own and a re-render reads them back.
        toolbar.appendChild(chooser('Snap ', 'section-snap',
            'Grid resolution for placing, moving and lengthening clips',
            SNAPS.map(x => [x.cols, x.label]), snapCols,
            (v) => { snapCols = v; store(SNAP_KEY, v); render(); }));
        toolbar.appendChild(chooser('Zoom ', 'section-zoom',
            'Width of a bar — the finer snaps need the room',
            ZOOMS.map(z => [z, '\u00d7' + z]), zoom,
            (v) => { zoom = v; store(ZOOM_KEY, v); render(); }));
    }

    function store(key, value) {
        try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
    }

    /** A labelled <select> over numeric [value, label] pairs. */
    function chooser(text, className, title, options, value, onPick) {
        const label = document.createElement('label');
        label.className = 'section-field';
        label.textContent = text;
        const sel = document.createElement('select');
        sel.className = className;
        sel.title = title;
        for (const [v, l] of options) {
            const opt = document.createElement('option');
            opt.value = String(v);
            opt.textContent = l;
            if (v === value) opt.selected = true;
            sel.appendChild(opt);
        }
        sel.value = String(value);
        sel.addEventListener('change', () => onPick(Number(sel.value)));
        label.appendChild(sel);
        return label;
    }

    // --- Palette: the pattern library ---

    function renderPalette(project) {
        palette.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'section-palette-head';
        head.textContent = 'Patterns';
        head.appendChild(button('+', 'New pattern', () => {
            const p = session.createPattern({ name: `Pattern ${session.listPatterns().length + 1}` }, 'section-editor');
            selectedPatternId = p.id;
            session.notifyPattern(p.id, 'section-editor');
            render();
        }, 'section-btn section-pattern-new'));
        palette.appendChild(head);

        const list = document.createElement('div');
        list.className = 'section-pattern-list';
        const patterns = session.listPatterns();
        if (patterns.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'section-empty';
            empty.textContent = 'No patterns yet — draw one in the piano roll, or press +.';
            list.appendChild(empty);
        }
        if (selectedPatternId && !patterns.some(p => p.id === selectedPatternId)) selectedPatternId = null;

        for (const p of patterns) {
            const item = document.createElement('div');
            item.className = 'section-pattern-item' + (p.id === selectedPatternId ? ' selected' : '');
            item.dataset.patternId = p.id;
            item.title = 'Click to select, then click a lane to place';

            // The pattern's colour — what its clips are painted with. The
            // swatch is the picker; a click on it must not toggle selection.
            const swatch = document.createElement('input');
            swatch.type = 'color';
            swatch.className = 'section-pattern-swatch';
            swatch.value = p.color;
            swatch.title = 'Pattern colour';
            swatch.addEventListener('click', (e) => e.stopPropagation());
            swatch.addEventListener('input', () => { item.style.borderLeftColor = swatch.value; });
            swatch.addEventListener('change', () => {
                session.updatePattern(p.id, { color: swatch.value }, 'section-editor');
                render();
            });
            item.appendChild(swatch);
            item.style.borderLeftColor = p.color;

            const nameEl = document.createElement('span');
            nameEl.className = 'section-pattern-name';
            nameEl.textContent = p.name;
            item.appendChild(nameEl);

            const len = document.createElement('span');
            len.className = 'section-pattern-len';
            len.textContent = p.measures + (p.measures === 1 ? ' bar' : ' bars');
            item.appendChild(len);

            // Rename in place, the way patch rows and containers do. The
            // button exists for touch, where a double-click is not a thing.
            const beginRename = () => {
                nameEl.contentEditable = 'true';
                nameEl.focus();
            };
            item.appendChild(button('✎', 'Rename pattern', beginRename, 'section-btn section-pattern-rename'));
            item.appendChild(button('⧉', 'Duplicate', () => {
                const copy = session.createPattern({ ...p, id: undefined, name: p.name + ' copy', created: undefined }, 'section-editor');
                selectedPatternId = copy.id;
                session.notifyPattern(copy.id, 'section-editor');
                render();
            }, 'section-btn section-pattern-dup'));
            item.appendChild(button('✕', 'Delete pattern', () => {
                const used = session.patternUsage(p.id);
                if (used.length > 0) {
                    say(`"${p.name}" is placed in ${used.length} section${used.length > 1 ? 's' : ''} — remove its clips first`);
                    return;
                }
                if (!confirm(`Delete pattern "${p.name}"?`)) return;
                session.removePattern(p.id, 'section-editor');
                if (selectedPatternId === p.id) selectedPatternId = null;
                session.notifyPattern(p.id, 'section-editor');
                render();
            }, 'section-btn section-pattern-del'));

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
                    session.updatePattern(p.id, { name: v }, 'section-editor');
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
        // On touchend `e.touches` exists but is EMPTY — the finger just left
        // the screen; its final position is in `changedTouches`. Checking
        // truthiness instead of length made every touch-drag of a clip throw
        // right at the commit step, so clips could not be moved on a phone.
        const t = (e.touches && e.touches.length) ? e.touches[0]
            : (e.changedTouches && e.changedTouches.length) ? e.changedTouches[0]
            : e;
        return { x: t.clientX, y: t.clientY };
    }

    /**
     * The column a click lands on, floored to the snap cell the way a click
     * used to be floored to its bar: anywhere inside a cell means that cell.
     */
    function colAt(lane, clientX) {
        const rect = lane.getBoundingClientRect();
        const col = (clientX - rect.left + (lane.scrollLeft || 0)) / colW();
        return Math.max(0, Math.floor(col / snapCols) * snapCols);
    }

    /** "bar 3" / "bar 3 beat 2.5" — where a column is, for a tooltip. */
    function positionLabel(col) {
        const bar = Math.floor(col / COLS_PER_MEASURE) + 1;
        const beat = (col % COLS_PER_MEASURE) / 4;
        if (beat === 0) return `bar ${bar}`;
        return `bar ${bar} beat ${Math.round((beat + 1) * 100) / 100}`;
    }

    function renderGrid(project) {
        grid.innerHTML = '';
        const cols = gridMeasures(project);
        // The bar lines and the (fainter) snap lines are gradients in the
        // stylesheet; these are their periods. At Bar snap the two coincide
        // and the snap layer is invisible, which is the point.
        grid.style.setProperty('--section-measure-w', measureW() + 'px');
        grid.style.setProperty('--section-snap-w', (snapCols * colW()) + 'px');

        // Measure ruler
        const ruler = document.createElement('div');
        ruler.className = 'section-ruler';
        const rulerHead = document.createElement('div');
        rulerHead.className = 'section-track-head section-ruler-head';
        rulerHead.textContent = 'Track';
        ruler.appendChild(rulerHead);
        const rulerLane = document.createElement('div');
        rulerLane.className = 'section-ruler-lane';
        rulerLane.style.width = (cols * measureW()) + 'px';
        for (let m = 0; m < cols; m++) {
            const tick = document.createElement('span');
            tick.className = 'section-ruler-tick';
            tick.style.left = (m * measureW()) + 'px';
            tick.textContent = String(m + 1);
            rulerLane.appendChild(tick);
        }
        if (sec().loop) {
            const band = document.createElement('div');
            band.className = 'section-loop-band';
            band.style.left = (sec().loop.start * measureW()) + 'px';
            band.style.width = ((sec().loop.end - sec().loop.start) * measureW()) + 'px';
            rulerLane.appendChild(band);
        }
        ruler.appendChild(rulerLane);
        grid.appendChild(ruler);

        // Re-created by each render, then only moved on a tick: rebuilding
        // every clip element sixteen times a bar is not an option.
        playheadEl = document.createElement('div');
        playheadEl.className = 'section-playhead';
        playheadEl.style.display = 'none';
        grid.appendChild(playheadEl);
        if (transport) movePlayhead(transport.isRunning() ? transport.getColumn() : -1);

        if (project.tracks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'section-empty';
            empty.textContent = 'No tracks. Add one, or draw a note in the piano roll.';
            grid.appendChild(empty);
        }

        for (const track of project.tracks) grid.appendChild(renderTrack(project, track, cols));

        const addRow = document.createElement('div');
        addRow.className = 'section-add-track-row';
        const used = new Set(project.tracks.map(t => t.slot));
        addRow.appendChild(button('+ Track', 'Add a track on the first free voice', () => {
            let slot = 0;
            while (slot < MAX_SLOTS && used.has(slot)) slot++;
            if (slot >= MAX_SLOTS) { say(`All ${MAX_SLOTS} voices have a track`); return; }
            change((s) => { s.tracks.push(createTrack({ name: slotLabel(slot), slot })); });
        }, 'section-btn section-add-track'));
        grid.appendChild(addRow);

        // Selected-clip actions live here rather than on the clip so they
        // are reachable by touch, where there is no hover and no Delete key.
        if (selectedClipId && sec().clips.some(c => c.id === selectedClipId)) {
            const bar = document.createElement('div');
            bar.className = 'section-clip-actions';
            bar.appendChild(button('✎ Open in piano roll', 'Edit this clip\'s pattern', () => openClip(selectedClipId), 'section-btn section-clip-open'));
            bar.appendChild(button('Remove clip', 'Remove this clip from the section', () => deleteClip(selectedClipId), 'section-btn section-clip-remove'));
            grid.appendChild(bar);
        }
    }

    function renderTrack(project, track, cols) {
        const row = document.createElement('div');
        row.className = 'section-track';
        row.dataset.trackId = track.id;

        const head = document.createElement('div');
        head.className = 'section-track-head';
        head.style.borderLeftColor = slotColor(track.slot);

        const slotSel = document.createElement('select');
        slotSel.className = 'section-track-slot';
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
            // Swaps when the slot is taken. Assigning it directly would put
            // two tracks on one channel, and the next load resolves that by
            // dropping one — with its clips, in every section.
            change((project) => { setTrackSlot(project, track.id, slot); });
        });
        head.appendChild(slotSel);

        head.appendChild(button('M', 'Mute', () => {
            change((s) => { const t = s.tracks.find(x => x.id === track.id); t.mute = !t.mute; });
        }, 'section-btn section-track-mute' + (track.mute ? ' active' : '')));
        head.appendChild(button('S', 'Solo', () => {
            change((s) => { const t = s.tracks.find(x => x.id === track.id); t.solo = !t.solo; });
        }, 'section-btn section-track-solo' + (track.solo ? ' active' : '')));
        head.appendChild(button('✕', 'Remove track', () => {
            const n = sec().clips.filter(c => c.trackId === track.id).length;
            if (n > 0 && !confirm(`Remove this track and its ${n} clip${n > 1 ? 's' : ''}?`)) return;
            if (selectedClipId && sec().clips.some(c => c.id === selectedClipId && c.trackId === track.id)) selectedClipId = null;
            change((project) => { removeTrack(project, track.id); });
        }, 'section-btn section-track-remove'));
        row.appendChild(head);

        const lane = document.createElement('div');
        lane.className = 'section-lane';
        lane.style.width = (cols * measureW()) + 'px';
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
            const startCol = colAt(lane, e.clientX);
            change((project, section) => {
                const clip = addClip(project, section, { trackId: track.id, patternId: selectedPatternId, startCol });
                selectedClipId = clip.id;
            });
        });

        for (const clip of sec().clips) {
            if (clip.trackId !== track.id) continue;
            const pattern = getPattern(clip.patternId);
            const span = clipCols(clip, pattern);
            if (!span) continue;                     // dangling: silence, not a crash
            lane.appendChild(renderClip(clip, pattern, span, track, lane));
        }
        row.appendChild(lane);
        return row;
    }

    /** ' ×3' / ' ×2.5' — how many times the clip plays its pattern, '' for once. */
    function repeatLabel(clip, pattern) {
        const reps = clipRepeats(clip, pattern);
        if (reps === 1) return '';
        return ' \u00d7' + (Math.round(reps * 100) / 100);
    }

    function renderClip(clip, pattern, span, track, lane) {
        const el = document.createElement('div');
        el.className = 'section-clip' + (clip.id === selectedClipId ? ' selected' : '');
        el.dataset.clipId = clip.id;
        el.style.left = (span.startCol * colW()) + 'px';
        el.style.width = ((span.endCol - span.startCol) * colW() - 2) + 'px';
        el.style.background = pattern.color;
        const reps = repeatLabel(clip, pattern);
        el.title = `${pattern.name}${reps} at ${positionLabel(span.startCol)} — drag to move (to another track too), `
            + 'drag the edge to lengthen, hold to open, double-click to remove';

        const label = document.createElement('span');
        label.className = 'section-clip-label';
        label.textContent = pattern.name + reps;
        el.appendChild(label);

        const handle = document.createElement('span');
        handle.className = 'section-clip-handle';
        el.appendChild(handle);

        el.addEventListener('click', (e) => {
            e.stopPropagation();
            // The click after a double-tap's second press arrives for a clip
            // that press just removed; it must not re-select a ghost.
            if (!sec().clips.some(c => c.id === clip.id)) return;
            selectedClipId = clip.id;
            selectedPatternId = clip.patternId;
            render();
        });
        // Move (body) or lengthen (handle). Pointer deltas are snapped to
        // the snap resolution — the delta, not the position, so a clip put
        // deliberately off the grid stays off it — and the model decides
        // whether the result is legal. Below DRAG_THRESHOLD a press is a
        // click: no preview, no re-render.
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
                for (const l of Array.from(grid.querySelectorAll('.section-lane'))) {
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
                const dCols = snap(dx / colW());
                if (mode === 'move') {
                    el.style.left = (Math.max(0, span.startCol + dCols) * colW()) + 'px';
                    // Preview across lanes: re-parent the element. It keeps
                    // its pattern colour — the lane's tint says which voice.
                    const over = laneAt(pt.y) || targetLane;
                    if (over !== targetLane) {
                        targetLane = over;
                        targetLane.appendChild(el);
                    }
                } else {
                    el.style.width = (resizedLength(span, dCols) * colW() - 2) + 'px';
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
                const dCols = snap((pointer(ev).x - origin.x) / colW());
                selectedClipId = clip.id;
                if (mode === 'move') {
                    const startCol = Math.max(0, span.startCol + dCols);
                    const trackId = targetLane.dataset.trackId || clip.trackId;
                    if (startCol === clip.startCol && trackId === clip.trackId) { render(); return; }
                    change((project, section) => { updateClip(project, section, clip.id, { startCol, trackId }); });
                } else {
                    // Dragging the edge gives the clip a length of its own;
                    // it stops following its pattern's (see createClip).
                    const lengthCols = resizedLength(span, dCols);
                    if (lengthCols === span.endCol - span.startCol) { render(); return; }
                    change((project, section) => { updateClip(project, section, clip.id, { lengthCols }); });
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

    /** A clip's length after dragging its edge by `dCols`, never under one snap cell. */
    function resizedLength(span, dCols) {
        return Math.max(snapCols, span.endCol - span.startCol + dCols);
    }

    /**
     * Park the playhead at a section column. Both modes have one — pattern
     * mode loops a window of the project — except a pattern placed nowhere,
     * which reports no project column and so hides it.
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
        playheadEl.style.left = ((col / COLS_PER_MEASURE) * measureW()) + 'px';
    }

    function deleteClip(clipId) {
        change((project, section) => { removeClip(section, clipId); });
        if (selectedClipId === clipId) selectedClipId = null;
    }

    function syncTransportButtons(pos) {
        if (!playBtn) return;
        const running = pos.playing || pos.recording || !!pos.waiting;
        playBtn.disabled = running;
        stopBtn.disabled = !running;
        playBtn.classList.toggle('active', !!pos.playing && pos.mode === 'section');
        playBtn.classList.toggle('waiting', !!pos.waiting);
        playBtn.title = pos.waiting ? playBtn.dataset.waitTitle : 'Play the section from the start of its loop';
    }

    function openClip(clipId) {
        const project = session.get();
        const clip = sec().clips.find(c => c.id === clipId);
        if (!clip) return;
        selectedClipId = clipId;
        selectedPatternId = clip.patternId;
        // Park the project position on this clip so it, and not another
        // placement of the same pattern, is what the roll's Play loops.
        if (transport && transport.setSectionPosition) transport.setSectionPosition(clip.startCol);
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
        const project = session.get();
        if (!project) return;
        renderToolbar(project);
        renderPalette(project);
        renderGrid(project);
    }

    unsubscribe = session.subscribe((ev) => {
        // Patch and canvas edits belong to the other half of the app.
        if (ev.kind === 'patches') return;
        render();
    });
    if (transport) {
        unsubscribeTransport = transport.subscribe((pos) => {
            movePlayhead(pos.sectionCol != null ? pos.sectionCol : pos.col);
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
