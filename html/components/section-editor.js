// Section editor — arrange patterns as clips on tracks.
//
// A **section** is one smaller piece of the project; this edits the one
// the session says is current. A grid with **time running down**: tracks
// are columns side by side, bars are rows, the ruler is the left column.
// It lives in a tall, narrow place (the desktop's left pane, a phone's
// screen), which is why time is vertical — a section grows downward
// without end, while tracks top out at eight.
//
// There is no pattern list. `+ Pattern` makes a new pattern and places it
// at the end of the **selected track** (click a track head to select one;
// selecting a clip selects its track too). Click a clip to select it and
// its pattern; click an empty spot on a lane to place that pattern there
// again; drag a clip to move it (sideways onto another track too), drag its
// bottom edge to lengthen it, select it and press Delete (or the Remove
// button) to take it out. Renaming, recolouring and duplicating a pattern
// happen in the selected clip's action bar.
//
// **A lane is a track is a Mixer strip is a voice.** One record: the slot
// is the synth channel, and the name, patch, volume, mute and solo all
// describe the same thing. Mute here is the mute the Mixer shows. The
// slot select *swaps* with whatever holds the slot already, because two
// tracks on one channel is two voices fighting over one output.
//
// Placing, moving and lengthening all happen at the **snap** resolution,
// a bar by default and down to a sixteenth — clips are not bar-aligned by
// nature, their geometry is columns (see project-model.js). **Zoom** makes
// the bar taller so the finer resolutions are something a pointer can hit.
//
// Everything autosaves through the project session; there is no Save
// button. Choosing, creating and deleting *projects* is not here — a
// project is the whole piece, and that lives in the File menu.
//
// Opening a clip (long press, or the ✎ button when selected) hands its
// pattern to the piano roll via opts.onOpenPattern.

import {
    addClip, updateClip, removeClip, removeTrack, setTrackSlot, createClip, findClipOverlap,
    clipCols, clipRepeats, sectionLength, createTrack,
    COLS_PER_MEASURE, MAX_SLOTS,
} from './project-model.js';
import { selectionMade, onSelectionElsewhere } from './selection-bus.js';
import { thumbURL } from './pattern-thumbs.js';

export const MEASURE_W = 48;      // px per measure in the grid (its height, time runs down), at zoom ×1
const MIN_GRID_MEASURES = 16;     // never show an empty, zero-height grid
const DRAG_THRESHOLD = 4;         // px before a press becomes a drag
const LONG_PRESS_MS = 600;        // a still press this long opens the clip in the roll
const THUMB_W = 48;               // px a clip's dot map is drawn at; CSS stretches it to the lane
const DOUBLE_TAP_MS = 400;        // two presses on one clip within this remove it (as in the roll)

const SNAP_KEY = 'openpatches_song_snap';
const ZOOM_KEY = 'openpatches_song_zoom';
const LIBRARY_KEY = 'openpatches_section_library';   // '1' while the library is folded
const LIBRARY_SCOPE_KEY = 'openpatches_section_library_scope';   // 'section' | 'global'
// Grid resolutions, in columns. Half a bar is the default: one step finer
// than whole bars, so the faint half-bar lines show that the grid goes
// below the bar and the Snap selector is worth finding.
export const SNAPS = [
    { cols: COLS_PER_MEASURE, label: 'Bar' },
    { cols: 8, label: '1/2' },
    { cols: 4, label: '1/4' },
    { cols: 2, label: '1/8' },
    { cols: 1, label: '1/16' },
];
export const DEFAULT_SNAP = 8;   // 1/2
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
    let selectedTrackId = null;  // where `+ Pattern` lands; a clip's track when one is selected
    let lastPress = { clipId: null, at: 0 };   // last body press, for double-tap removal
    // The selection: the clips a marquee or Shift-click took. `selectedClipId`
    // stays the one the action bar shows (the last clicked); `picked` is
    // every clip Delete removes and Copy stamps. A plain click makes them
    // the same single clip.
    const picked = new Set();
    let selectMode = false;     // a drag on an empty lane is a marquee, not a placement
    let swallowClick = false;   // the click that ends a marquee must not place a clip
    // Copy arms a stamp: the picked clips as a block, relative to its top
    // and its first lane. `at` is where the shadow is ({ laneIdx, col }),
    // null while the pointer is off the grid.
    let stamp = null;
    let unsubscribe = null;
    let unsubscribeTransport = null;
    let playheadEl = null;
    let snapCols = loadNum(SNAP_KEY, SNAPS.map(s => s.cols), DEFAULT_SNAP);
    let zoom = loadNum(ZOOM_KEY, ZOOMS, 1);

    /** Grid scale. One bar is MEASURE_W tall at zoom ×1; a column is 1/16 of it. */
    const measureH = () => MEASURE_W * zoom;
    const colH = () => measureH() / COLS_PER_MEASURE;
    /** Round a column count to the snap resolution (a delta, or a position). */
    const snap = (cols) => Math.round(cols / snapCols) * snapCols;

    const root = document.createElement('div');
    root.className = 'section-editor';

    const toolbar = document.createElement('div');
    toolbar.className = 'section-toolbar';
    const grid = document.createElement('div');
    grid.className = 'section-grid';
    // Selected-clip actions live under the grid rather than on the clip so
    // they are reachable by touch, where there is no hover and no Delete key.
    const actions = document.createElement('div');
    actions.className = 'section-clip-actions';
    const status = document.createElement('div');
    status.className = 'section-status';
    root.appendChild(toolbar);
    root.appendChild(grid);
    root.appendChild(actions);
    root.appendChild(status);
    // The pattern library: every pattern so far, under the grid, folded
    // or not (remembered). Click one to select it — a lane click then
    // places it — or drag it onto a lane.
    const library = document.createElement('div');
    library.className = 'section-library';
    root.appendChild(library);
    // Which patterns the library lists: those placed in this section, or all.
    let libraryScope = (() => { try { return localStorage.getItem(LIBRARY_SCOPE_KEY) === 'section' ? 'section' : 'global'; } catch { return 'global'; } })();
    let libraryFolded = (() => { try { return localStorage.getItem(LIBRARY_KEY) === '1'; } catch { return false; } })();

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

    // --- Tracks: which one is "current", and where it ends ---

    /** The track `+ Pattern` lands on: the selected one, else the first. */
    function currentTrack(project) {
        return project.tracks.find(t => t.id === selectedTrackId) || project.tracks[0] || null;
    }

    /** The column after the track's last clip — 0 on an empty track. */
    function trackEndCol(project, trackId) {
        let end = 0;
        for (const clip of sec().clips) {
            if (clip.trackId !== trackId) continue;
            const span = clipCols(clip, getPattern(clip.patternId));
            if (span && span.endCol > end) end = span.endCol;
        }
        return end;
    }

    /** Add a track on the first free voice. Returns it, or null when all eight are taken. */
    function addTrack() {
        const used = new Set(session.get().tracks.map(t => t.slot));
        let slot = 0;
        while (slot < MAX_SLOTS && used.has(slot)) slot++;
        if (slot >= MAX_SLOTS) { say(`All ${MAX_SLOTS} voices have a track`); return null; }
        let made = null;
        change((s) => { made = createTrack({ name: slotLabel(slot), slot }); s.tracks.push(made); });
        if (made) selectedTrackId = made.id;
        return made;
    }

    /**
     * Place a pattern at the end of a track and select the new clip. Returns
     * the clip, or null when the model refused (reported in the status).
     */
    function placeAtEnd(patternId, trackId) {
        const startCol = trackEndCol(session.get(), trackId);
        let placed = null;
        change((project, section) => {
            placed = addClip(project, section, { trackId, patternId, startCol });
            selectedClipId = placed.id;
        });
        if (placed) { selectedPatternId = patternId; selectedTrackId = trackId; }
        return placed;
    }

    /** `+ Pattern`: a new pattern, placed at the end of the selected track. */
    function newPatternOnTrack() {
        let track = currentTrack(session.get());
        if (!track) track = addTrack();          // nothing to land on yet: make the first track
        if (!track) return;
        const p = session.createPattern({ name: `Pattern ${session.listPatterns().length + 1}` }, 'section-editor');
        placeAtEnd(p.id, track.id);
        session.notifyPattern(p.id, 'section-editor');
        render();
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

        // Play, Stop and BPM used to be here too; they are the transport
        // bar's now, above every panel, with a Section/Pattern switch.
        // The pattern library has no list of its own any more: new patterns
        // are born in place, on the selected track.
        toolbar.appendChild(button('+ Pattern', 'New pattern at the end of the selected track',
            newPatternOnTrack, 'section-btn section-pattern-new'));

        // Selection, as in the roll: Select mode makes a drag on an empty
        // lane a marquee (Shift-drag does it without the mode); Copy turns
        // the selection into a stamp that follows the pointer.
        const sel = button('⬚ Select', 'Select mode: drag over clips to select them (Shift-drag works too, '
            + 'Shift-click adds or removes one); Delete removes them, Copy stamps a copy',
            () => { selectMode = !selectMode; render(); }, 'section-btn section-select-mode' + (selectMode ? ' active' : ''));
        toolbar.appendChild(sel);
        const copy = button('⎘ Copy', 'Copy the selected clips: a shadow of them follows the pointer — '
            + 'click where they should go (Ctrl+C; Escape or Copy again to cancel)',
            () => { if (stamp) cancelStamp(); else armStamp(); },
            'section-btn section-copy' + (stamp ? ' active' : ''));
        copy.disabled = !stamp && picked.size === 0;
        toolbar.appendChild(copy);

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
            'Height of a bar — the finer snaps need the room',
            ZOOMS.map(z => [z, '×' + z]), zoom,
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

    // --- Grid: measures (down) × tracks (across) ---

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
    function colAt(lane, clientY) {
        const rect = lane.getBoundingClientRect();
        const col = (clientY - rect.top + (lane.scrollTop || 0)) / colH();
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
        const measures = gridMeasures(project);
        const gridH = measures * measureH();
        // The bar lines and the (fainter) snap lines are gradients in the
        // stylesheet; these are their periods. At Bar snap the two coincide
        // and the snap layer is invisible, which is the point.
        grid.style.setProperty('--section-measure-h', measureH() + 'px');
        grid.style.setProperty('--section-snap-h', (snapCols * colH()) + 'px');

        if (selectedTrackId && !project.tracks.some(t => t.id === selectedTrackId)) selectedTrackId = null;

        // Track heads: one row across the top, stuck there while the grid
        // scrolls down. The corner above the ruler names the axis.
        const heads = document.createElement('div');
        heads.className = 'section-heads';
        const corner = document.createElement('div');
        corner.className = 'section-ruler-head';
        corner.textContent = 'Bar';
        heads.appendChild(corner);
        const current = currentTrack(project);
        for (const track of project.tracks) heads.appendChild(renderTrackHead(project, track, current));
        const addCell = document.createElement('div');
        addCell.className = 'section-add-track-cell';
        addCell.appendChild(button('+ Track', 'Add a track on the first free voice', () => { addTrack(); },
            'section-btn section-add-track'));
        heads.appendChild(addCell);
        grid.appendChild(heads);

        // Lanes: the ruler down the left, stuck there while the grid scrolls
        // sideways, then one lane per track.
        const lanes = document.createElement('div');
        lanes.className = 'section-lanes';

        const ruler = document.createElement('div');
        ruler.className = 'section-ruler';
        ruler.style.height = gridH + 'px';
        for (let m = 0; m < measures; m++) {
            const tick = document.createElement('span');
            tick.className = 'section-ruler-tick';
            tick.style.top = (m * measureH()) + 'px';
            tick.textContent = String(m + 1);
            ruler.appendChild(tick);
        }
        if (sec().loop) {
            const band = document.createElement('div');
            band.className = 'section-loop-band';
            band.style.top = (sec().loop.start * measureH()) + 'px';
            band.style.height = ((sec().loop.end - sec().loop.start) * measureH()) + 'px';
            ruler.appendChild(band);
        }
        lanes.appendChild(ruler);

        for (const track of project.tracks) lanes.appendChild(renderLane(project, track, gridH, current));

        // Re-created by each render, then only moved on a tick: rebuilding
        // every clip element sixteen times a bar is not an option.
        playheadEl = document.createElement('div');
        playheadEl.className = 'section-playhead';
        playheadEl.style.display = 'none';
        lanes.appendChild(playheadEl);
        if (transport) movePlayhead(transport.isRunning() ? transport.getColumn() : -1);

        grid.appendChild(lanes);

        if (project.tracks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'section-empty';
            empty.textContent = 'No tracks. Add one, press + Pattern, or draw a note in the piano roll.';
            grid.appendChild(empty);
        }

        renderActions(project);
    }

    /**
     * A track's head: two rows of two squares. Top: the track's number —
     * coloured by its voice, a voice picker under it — and remove. Bottom:
     * Mute and Solo. Narrow on purpose: the lanes are what the pane is for.
     */
    function renderTrackHead(project, track, current) {
        const head = document.createElement('div');
        head.className = 'section-track-head' + (current && current.id === track.id ? ' selected' : '');
        head.dataset.trackId = track.id;
        head.style.borderTopColor = slotColor(track.slot);
        head.title = `${slotLabel(track.slot)} — click to select this track (+ Pattern lands at its end)`;
        head.addEventListener('click', () => { selectedTrackId = track.id; render(); });

        // The number square is a label with an invisible <select> stretched
        // over it: the closed select would show the whole "1. BRASS", which
        // does not fit, while its open list should.
        const num = document.createElement('label');
        num.className = 'section-track-num';
        num.style.background = tint(slotColor(track.slot), 0.55);
        num.title = 'Voice this track plays: ' + slotLabel(track.slot);
        const numText = document.createElement('span');
        numText.textContent = String(track.slot + 1);
        num.appendChild(numText);
        const slotSel = document.createElement('select');
        slotSel.className = 'section-track-slot';
        slotSel.title = num.title;
        for (let i = 0; i < MAX_SLOTS; i++) {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = slotLabel(i);
            if (i === track.slot) opt.selected = true;
            slotSel.appendChild(opt);
        }
        slotSel.value = String(track.slot);
        slotSel.addEventListener('click', (e) => e.stopPropagation());
        slotSel.addEventListener('change', () => {
            const slot = parseInt(slotSel.value);
            // Swaps when the slot is taken. Assigning it directly would put
            // two tracks on one channel, and the next load resolves that by
            // dropping one — with its clips, in every section.
            change((project) => { setTrackSlot(project, track.id, slot); });
        });
        num.appendChild(slotSel);
        head.appendChild(num);

        head.appendChild(button('✕', 'Remove track', () => {
            const n = sec().clips.filter(c => c.trackId === track.id).length;
            if (n > 0 && !confirm(`Remove this track and its ${n} clip${n > 1 ? 's' : ''}?`)) return;
            if (selectedClipId && sec().clips.some(c => c.id === selectedClipId && c.trackId === track.id)) selectedClipId = null;
            if (selectedTrackId === track.id) selectedTrackId = null;
            change((project) => { removeTrack(project, track.id); });
        }, 'section-btn section-track-sq section-track-remove'));
        head.appendChild(button('M', 'Mute', () => {
            change((s) => { const t = s.tracks.find(x => x.id === track.id); t.mute = !t.mute; });
        }, 'section-btn section-track-sq section-track-mute' + (track.mute ? ' active' : '')));
        head.appendChild(button('S', 'Solo', () => {
            change((s) => { const t = s.tracks.find(x => x.id === track.id); t.solo = !t.solo; });
        }, 'section-btn section-track-sq section-track-solo' + (track.solo ? ' active' : '')));
        return head;
    }

    function renderLane(project, track, gridH, current) {
        const lane = document.createElement('div');
        lane.className = 'section-lane' + (current && current.id === track.id ? ' selected' : '');
        lane.style.height = gridH + 'px';
        // The whole lane carries the voice, quietly; clips carry their
        // pattern's colour on top. (backgroundColor, not background: the
        // bar grid is a background-image on the same element.)
        lane.style.backgroundColor = tint(slotColor(track.slot), 0.16);
        lane.dataset.trackId = track.id;
        lane.addEventListener('click', (e) => {
            if (e.target !== lane) return;           // a clip handles its own clicks
            if (swallowClick) { swallowClick = false; return; }
            if (stamp) return;                       // the stamp places on mousedown
            selectedTrackId = track.id;
            if (!selectedPatternId) {
                selectedClipId = null;
                say('Select a clip to place its pattern again, or press + Pattern for a new one');
                render();
                return;
            }
            const startCol = colAt(lane, e.clientY);
            change((project, section) => {
                const clip = addClip(project, section, { trackId: track.id, patternId: selectedPatternId, startCol });
                pick(clip.id);
            });
        });
        // An empty spot pressed in Select mode, or with Shift, starts a
        // marquee; with a stamp armed, the press places it.
        const press = (e) => {
            if (e.target !== lane) return;
            if (stamp) { placeStamp(e); return; }
            if (!selectMode && !e.shiftKey) return;
            startMarquee(e);
        };
        lane.addEventListener('mousedown', press);
        lane.addEventListener('touchstart', press, { passive: false });

        for (const clip of sec().clips) {
            if (clip.trackId !== track.id) continue;
            const pattern = getPattern(clip.patternId);
            const span = clipCols(clip, pattern);
            if (!span) continue;                     // dangling: silence, not a crash
            lane.appendChild(renderClip(clip, pattern, span, track, lane));
        }
        return lane;
    }

    /** ' ×3' / ' ×2.5' — how many times the clip plays its pattern, '' for once. */
    function repeatLabel(clip, pattern) {
        const reps = clipRepeats(clip, pattern);
        if (reps === 1) return '';
        return ' ×' + (Math.round(reps * 100) / 100);
    }

    function renderClip(clip, pattern, span, track, lane) {
        const el = document.createElement('div');
        el.className = 'section-clip' + (clip.id === selectedClipId ? ' selected' : '')
            + (picked.has(clip.id) ? ' picked' : '');
        el.dataset.clipId = clip.id;
        el.style.top = (span.startCol * colH()) + 'px';
        el.style.height = ((span.endCol - span.startCol) * colH() - 2) + 'px';
        el.style.background = pattern.color;
        // The notes as dots, one beat × one octave a cell (pattern-thumbs.js),
        // drawn for one pass of the pattern and repeated down the clip.
        const passH = pattern.measures * measureH();
        const thumb = thumbURL(pattern, THUMB_W, passH);
        if (thumb) {
            el.style.backgroundImage = `url(${thumb})`;
            el.style.backgroundSize = `100% ${passH}px`;
            el.style.backgroundRepeat = 'repeat-y';
        }
        const reps = repeatLabel(clip, pattern);
        el.title = `${pattern.name}${reps} at ${positionLabel(span.startCol)} — drag to move (onto another track too), `
            + 'drag the bottom edge to lengthen, hold to open, double-click to remove';

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
            if (e.shiftKey) { togglePick(clip); return; }
            pick(clip.id);
            selectedPatternId = clip.patternId;
            selectedTrackId = clip.trackId;
            render();
        });
        // Move (body) or lengthen (handle). Pointer deltas are snapped to
        // the snap resolution — the delta, not the position, so a clip put
        // deliberately off the grid stays off it — and the model decides
        // whether the result is legal. Below DRAG_THRESHOLD a press is a
        // click: no preview, no re-render.
        //
        // A move is two-dimensional: down or up by measures, and sideways
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
            // An armed stamp places wherever it is pressed, over a clip too
            // (and is refused there, with the reason, if it would overlap).
            if (stamp) { placeStamp(e); return; }
            if (e.shiftKey) return;                  // Shift-click toggles; the click does it
            if (mode === 'move' && lastPress.clipId === clip.id && Date.now() - lastPress.at < DOUBLE_TAP_MS) {
                lastPress = { clipId: null, at: 0 };
                deleteClip(clip.id);
                return;
            }
            const origin = pointer(e);
            // preventDefault on touchstart is what keeps a drag from
            // scrolling the page — and it also swallows the synthetic click
            // a tap would otherwise send, so touch selects here instead.
            const isTouch = !!(e.touches || e.changedTouches);
            let moved = false;
            let hold = null;
            let targetLane = lane;     // where the body is being dragged to
            const laneAt = (clientX) => {
                for (const l of Array.from(grid.querySelectorAll('.section-lane'))) {
                    const r = l.getBoundingClientRect();
                    if (clientX >= r.left && clientX < r.right) return l;
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
                const dCols = snap(dy / colH());
                if (mode === 'move') {
                    el.style.top = (Math.max(0, span.startCol + dCols) * colH()) + 'px';
                    // Preview across lanes: re-parent the element. It keeps
                    // its pattern colour — the lane's tint says which voice.
                    const over = laneAt(pt.x) || targetLane;
                    if (over !== targetLane) {
                        targetLane = over;
                        targetLane.appendChild(el);
                    }
                } else {
                    el.style.height = (resizedLength(span, dCols) * colH() - 2) + 'px';
                }
            };
            const finish = (ev) => {
                detach();
                if (!moved) {
                    // A tap. Only a tap arms the double-tap: re-grabbing a
                    // clip right after dragging it must not remove it.
                    if (mode === 'move') {
                        lastPress = { clipId: clip.id, at: Date.now() };
                        if (isTouch && sec().clips.some(c => c.id === clip.id)) {
                            pick(clip.id);
                            selectedPatternId = clip.patternId;
                            selectedTrackId = clip.trackId;
                            render();
                        }
                    }
                    return;
                }
                const dCols = snap((pointer(ev).y - origin.y) / colH());
                pick(clip.id);
                if (mode === 'move') {
                    const startCol = Math.max(0, span.startCol + dCols);
                    const trackId = targetLane.dataset.trackId || clip.trackId;
                    if (startCol === clip.startCol && trackId === clip.trackId) { render(); return; }
                    selectedTrackId = trackId;
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

    // --- The selected clip's actions: open, remove, and its pattern's name, colour and copies ---

    function renderActions(project) {
        actions.innerHTML = '';
        const clip = selectedClipId ? sec().clips.find(c => c.id === selectedClipId) : null;
        const pattern = clip ? getPattern(clip.patternId) : null;
        actions.style.display = clip && pattern ? '' : 'none';
        if (!clip || !pattern) return;

        // The pattern's colour — what its clips are painted with.
        const swatch = document.createElement('input');
        swatch.type = 'color';
        swatch.className = 'section-pattern-swatch';
        swatch.value = pattern.color;
        swatch.title = 'Pattern colour';
        swatch.addEventListener('input', () => {
            for (const el of grid.querySelectorAll('.section-clip')) {
                const c = sec().clips.find(x => x.id === el.dataset.clipId);
                if (c && c.patternId === pattern.id) el.style.background = swatch.value;
            }
        });
        swatch.addEventListener('change', () => {
            session.updatePattern(pattern.id, { color: swatch.value }, 'section-editor');
            render();
        });
        actions.appendChild(swatch);

        // Rename: the field is the pattern's name; every clip of it follows.
        const name = document.createElement('input');
        name.type = 'text';
        name.className = 'section-pattern-name';
        name.value = pattern.name;
        name.title = 'Pattern name';
        name.addEventListener('change', () => {
            const v = String(name.value).trim();
            if (!v || v === pattern.name) { name.value = pattern.name; return; }
            session.updatePattern(pattern.id, { name: v }, 'section-editor');
            render();
        });
        actions.appendChild(name);

        actions.appendChild(button('✎ Open', 'Edit this clip\'s pattern in the piano roll', () => openClip(clip.id), 'section-btn section-clip-open'));
        actions.appendChild(button('⧉ Duplicate', 'Copy the pattern and place the copy at the end of this track', () => {
            const copy = session.createPattern({ ...pattern, id: undefined, name: pattern.name + ' copy', created: undefined }, 'section-editor');
            placeAtEnd(copy.id, clip.trackId);
            session.notifyPattern(copy.id, 'section-editor');
            render();
        }, 'section-btn section-pattern-dup'));
        actions.appendChild(button('Remove clip', 'Remove this clip from the section', () => deleteClip(clip.id), 'section-btn section-clip-remove'));
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
        // Offset from the top of the lanes; the ruler's width is a rem value
        // the stylesheet adds as margin-left, so the line starts where the
        // lanes do at any root font size instead of a pixel guess.
        playheadEl.style.top = ((col / COLS_PER_MEASURE) * measureH()) + 'px';
    }

    function deleteClip(clipId) {
        picked.delete(clipId);
        if (selectedClipId === clipId) selectedClipId = null;
        change((project, section) => { removeClip(section, clipId); });
    }

    // --- Selection: marquee, Shift-click, Delete, Copy → stamp ---

    /** Select exactly this clip (or nothing). */
    function pick(clipId) {
        picked.clear();
        if (clipId) picked.add(clipId);
        selectedClipId = clipId || null;
    }

    function togglePick(clip) {
        if (picked.has(clip.id)) {
            picked.delete(clip.id);
            if (selectedClipId === clip.id) selectedClipId = picked.size ? [...picked][picked.size - 1] : null;
        } else {
            picked.add(clip.id);
            selectedClipId = clip.id;
            selectedPatternId = clip.patternId;
            selectedTrackId = clip.trackId;
        }
        render();
    }

    /** Drop clips that no longer exist (removed, undone, another section). */
    function prunePicked() {
        const live = new Set(sec().clips.map(c => c.id));
        for (const id of [...picked]) if (!live.has(id)) picked.delete(id);
        if (selectedClipId && !live.has(selectedClipId)) selectedClipId = null;
    }

    function deletePicked() {
        const ids = [...picked];
        if (ids.length === 0) return;
        picked.clear();
        selectedClipId = null;
        change((project, section) => { for (const id of ids) removeClip(section, id); });
    }

    /** The lane under a viewport x, and its index among the tracks. */
    function laneAt(clientX) {
        const all = Array.from(grid.querySelectorAll('.section-lane'));
        for (let i = 0; i < all.length; i++) {
            const r = all[i].getBoundingClientRect();
            if (clientX >= r.left && clientX < r.right) return { lane: all[i], idx: i };
        }
        return null;
    }

    /**
     * A rubber band over the lanes, on the document (as the clip drags are)
     * so it survives leaving the grid. Every clip it touches is selected —
     * touched, not only enclosed, as in the roll. Shift adds to what was
     * selected; a plain marquee replaces it.
     */
    function startMarquee(e) {
        if (e.cancelable && e.preventDefault) e.preventDefault();
        const lanesEl = grid.querySelector('.section-lanes');
        if (!lanesEl) return;
        const origin = pointer(e);
        const keep = e.shiftKey ? new Set(picked) : new Set();
        const box = document.createElement('div');
        box.className = 'section-marquee';
        lanesEl.appendChild(box);
        let moved = false;
        let rect = null;
        const update = (pt) => {
            const base = lanesEl.getBoundingClientRect();
            const x0 = Math.min(origin.x, pt.x), x1 = Math.max(origin.x, pt.x);
            const y0 = Math.min(origin.y, pt.y), y1 = Math.max(origin.y, pt.y);
            rect = { left: x0, right: x1, top: y0, bottom: y1 };
            box.style.left = (x0 - base.left) + 'px';
            box.style.top = (y0 - base.top) + 'px';
            box.style.width = (x1 - x0) + 'px';
            box.style.height = (y1 - y0) + 'px';
        };
        const onMove = (ev) => {
            const pt = pointer(ev);
            if (!moved && Math.abs(pt.x - origin.x) < DRAG_THRESHOLD && Math.abs(pt.y - origin.y) < DRAG_THRESHOLD) return;
            if (ev.cancelable && ev.preventDefault) ev.preventDefault();
            moved = true;
            update(pt);
        };
        const finish = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', finish);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', finish);
            document.removeEventListener('touchcancel', finish);
            if (box.parentNode) box.parentNode.removeChild(box);
            if (!moved) return;                  // a plain press: the click places, as ever
            swallowClick = true;
            picked.clear();
            for (const id of keep) picked.add(id);
            for (const el of Array.from(grid.querySelectorAll('.section-clip'))) {
                const r = el.getBoundingClientRect();
                if (r.left < rect.right && rect.left < r.right && r.top < rect.bottom && rect.top < r.bottom) {
                    picked.add(el.dataset.clipId);
                }
            }
            selectedClipId = picked.size ? [...picked][picked.size - 1] : null;
            say(picked.size ? `${picked.size} clip${picked.size > 1 ? 's' : ''} selected` : '');
            render();
            // A touch sends no click to swallow; don't let the flag linger.
            setTimeout(() => { swallowClick = false; }, 0);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', finish);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', finish);
        document.addEventListener('touchcancel', finish);
    }

    /** Copy: the picked clips become a stamp that follows the pointer. */
    function armStamp() {
        prunePicked();
        const project = session.get();
        const order = project.tracks.map(t => t.id);
        const clips = sec().clips.filter(c => picked.has(c.id) && order.includes(c.trackId));
        if (clips.length === 0) { say('Select clips first: Select, then drag over them (or Shift-click)'); return; }
        const top = Math.min(...clips.map(c => c.startCol));
        const first = Math.min(...clips.map(c => order.indexOf(c.trackId)));
        stamp = {
            items: clips.map(c => ({
                patternId: c.patternId,
                dCol: c.startCol - top,
                dLane: order.indexOf(c.trackId) - first,
                lengthCols: c.lengthCols != null ? c.lengthCols : null,
                repeats: c.repeats,
            })),
            at: null,
        };
        stamp.width = Math.max(...stamp.items.map(i => i.dLane)) + 1;
        document.addEventListener('mousemove', followStamp);
        document.addEventListener('touchmove', followStamp, { passive: false });
        say('Click where the copy should go — Escape or Copy again to cancel');
        render();
    }

    function cancelStamp() {
        if (!stamp) return;
        stamp = null;
        document.removeEventListener('mousemove', followStamp);
        document.removeEventListener('touchmove', followStamp);
        say('');
        render();
    }

    /**
     * Where the stamp lands for a pointer: the lane under it (clamped so
     * the block never hangs off the last track) and the snap cell.
     */
    function stampTarget(pt) {
        const hit = laneAt(pt.x);
        if (!hit) return null;
        const lanes = grid.querySelectorAll('.section-lane').length;
        const laneIdx = Math.max(0, Math.min(hit.idx, lanes - stamp.width));
        return { laneIdx, col: colAt(hit.lane, pt.y) };
    }

    function followStamp(e) {
        if (!stamp) return;
        const pt = pointer(e);
        const r = grid.getBoundingClientRect();
        const inside = pt.x >= r.left && pt.x < r.right && pt.y >= r.top && pt.y < r.bottom;
        if (e.touches && inside && e.cancelable) e.preventDefault();   // the finger carries it, no scroll
        const at = inside ? stampTarget(pt) : null;
        const same = at && stamp.at && at.laneIdx === stamp.at.laneIdx && at.col === stamp.at.col;
        if (same || (!at && !stamp.at)) return;
        stamp.at = at;
        drawStamp();
    }

    /** The shadows: one dashed ghost per stamped clip, in its target lane. */
    function drawStamp() {
        for (const g of Array.from(grid.querySelectorAll('.section-stamp-ghost'))) g.parentNode.removeChild(g);
        if (!stamp || !stamp.at) return;
        const lanes = Array.from(grid.querySelectorAll('.section-lane'));
        for (const item of stamp.items) {
            const lane = lanes[stamp.at.laneIdx + item.dLane];
            const pattern = getPattern(item.patternId);
            if (!lane || !pattern) continue;
            const span = { startCol: stamp.at.col + item.dCol };
            span.endCol = span.startCol + (item.lengthCols != null ? item.lengthCols : pattern.measures * COLS_PER_MEASURE * item.repeats);
            const g = document.createElement('div');
            g.className = 'section-stamp-ghost';
            g.style.top = (span.startCol * colH()) + 'px';
            g.style.height = ((span.endCol - span.startCol) * colH() - 2) + 'px';
            g.style.background = tint(pattern.color, 0.35);
            g.style.borderColor = pattern.color;
            lane.appendChild(g);
        }
    }

    /**
     * Put the copy down. All or nothing: every copy is checked against the
     * section and against the others first, because a mutator that threw
     * half-way would leave the half it had done. The copies become the
     * selection and the stamp is spent — Copy, click, Copy, click repeats.
     */
    function placeStamp(e) {
        if (e.cancelable && e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        const at = stampTarget(pointer(e));
        if (!at) return;
        const project = session.get();
        const section = sec();
        const made = [];
        for (const item of stamp.items) {
            const track = project.tracks[at.laneIdx + item.dLane];
            if (!track) continue;
            const partial = { trackId: track.id, patternId: item.patternId, startCol: at.col + item.dCol };
            if (item.lengthCols != null) partial.lengthCols = item.lengthCols;
            else partial.repeats = item.repeats;
            made.push(createClip(partial));
        }
        const trial = { ...section, clips: [...section.clips] };
        for (const clip of made) {
            if (findClipOverlap(project, trial, clip)) {
                say('The copy would overlap a clip there — pick another spot, or Escape');
                return;
            }
            trial.clips.push(clip);
        }
        swallowClick = true;
        setTimeout(() => { swallowClick = false; }, 0);
        const spent = stamp;
        stamp = null;
        document.removeEventListener('mousemove', followStamp);
        document.removeEventListener('touchmove', followStamp);
        picked.clear();
        const ok = change((project, section) => {
            for (const clip of made) section.clips.push(clip);
        });
        if (!ok) { stamp = spent; return; }
        for (const clip of made) picked.add(clip.id);
        selectedClipId = made.length ? made[made.length - 1].id : null;
        render();
    }

    function openClip(clipId) {
        const clip = sec().clips.find(c => c.id === clipId);
        if (!clip) return;
        selectedClipId = clipId;
        selectedPatternId = clip.patternId;
        selectedTrackId = clip.trackId;
        // Park the project position on this clip so it, and not another
        // placement of the same pattern, is what the roll's Play loops.
        if (transport && transport.setSectionPosition) transport.setSectionPosition(clip.startCol);
        if (opts.onOpenPattern) opts.onOpenPattern(clipId, clip.trackId, clip.patternId);
        render();
    }

    // Delete/Backspace removes the selected clip — unless the user is typing.
    // Delete/Backspace removes the selection; Escape drops a stamp, then
    // the selection; Ctrl/Cmd+C copies. Never while typing in a field. The
    // roll listens to the same keys for its own selection, so these only
    // act when this editor has something selected or armed.
    function onKey(e) {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (e.target && e.target.contentEditable === 'true') return;
        if (e.key === 'Escape') {
            if (stamp) { cancelStamp(); return; }
            if (picked.size) { pick(null); render(); }
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
            if (!picked.size) return;
            e.preventDefault();
            armStamp();
            return;
        }
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        if (!picked.size && !selectedClipId) return;
        e.preventDefault();
        if (picked.size) deletePicked();
        else deleteClip(selectedClipId);
    }
    document.addEventListener('keydown', onKey);

    function render() {
        const project = session.get();
        if (!project) return;
        prunePicked();
        // Notes selected in the roll go when clips are selected here (see
        // selection-bus.js) — and ours go when the roll selects.
        if (picked.size || stamp) selectionMade('section');
        renderToolbar(project);
        renderGrid(project);
        drawStamp();
        renderLibrary(project);
    }

    // --- The pattern library ---

    function renderLibrary(project) {
        library.innerHTML = '';
        const uses = new Map();
        for (const c of sec().clips) uses.set(c.patternId, (uses.get(c.patternId) || 0) + 1);
        const all = session.listPatterns();
        const patterns = libraryScope === 'section' ? all.filter(p => uses.has(p.id)) : all;

        const head = button((libraryFolded ? '▸' : '▾') + ' Patterns (' + patterns.length + ')',
            libraryFolded ? 'Show the pattern library' : 'Fold the pattern library away', () => {
                libraryFolded = !libraryFolded;
                try { localStorage.setItem(LIBRARY_KEY, libraryFolded ? '1' : '0'); } catch { /* ignore */ }
                render();
            }, 'section-library-head');
        const bar = document.createElement('div');
        bar.className = 'section-library-bar';
        bar.appendChild(head);
        if (!libraryFolded) {
            const scopes = document.createElement('div');
            scopes.className = 'section-library-scopes';
            for (const [scope, label, title] of [
                ['section', 'Section', 'Only the patterns placed in this section'],
                ['global', 'Global', 'Every pattern in the project'],
            ]) {
                scopes.appendChild(button(label, title, () => {
                    libraryScope = scope;
                    try { localStorage.setItem(LIBRARY_SCOPE_KEY, scope); } catch { /* ignore */ }
                    render();
                }, 'section-library-scope' + (libraryScope === scope ? ' active' : '')));
            }
            bar.appendChild(scopes);
        }
        library.appendChild(bar);
        library.classList.toggle('folded', libraryFolded);
        if (libraryFolded) return;

        const list = document.createElement('div');
        list.className = 'section-library-list';
        if (patterns.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'section-library-empty';
            empty.textContent = all.length && libraryScope === 'section'
                ? 'None placed in this section — Global lists them all.'
                : 'No patterns yet — + Pattern makes one.';
            list.appendChild(empty);
        }
        for (const pattern of patterns) list.appendChild(renderLibraryItem(pattern, uses.get(pattern.id) || 0));
        library.appendChild(list);
    }

    const LIB_THUMB_W = 28, LIB_THUMB_H = 40;

    function renderLibraryItem(pattern, n) {
        const item = document.createElement('div');
        item.className = 'section-library-item' + (pattern.id === selectedPatternId ? ' selected' : '');
        item.dataset.patternId = pattern.id;
        item.title = `${pattern.name} — ${pattern.measures} bar${pattern.measures > 1 ? 's' : ''}, `
            + (n ? `placed ${n}×` : 'not placed') + '. Click to select (then click a lane), or drag onto a lane.';

        const thumb = document.createElement('div');
        thumb.className = 'section-library-thumb';
        thumb.style.background = pattern.color;
        const url = thumbURL(pattern, LIB_THUMB_W, LIB_THUMB_H);
        if (url) {
            thumb.style.backgroundImage = `url(${url})`;
            thumb.style.backgroundSize = '100% 100%';
        }
        item.appendChild(thumb);

        const name = document.createElement('span');
        name.className = 'section-library-name';
        name.textContent = pattern.name;
        item.appendChild(name);
        const count = document.createElement('span');
        count.className = 'section-library-uses';
        count.textContent = n ? '×' + n : '—';
        item.appendChild(count);

        const press = (e) => startLibraryDrag(e, pattern, item);
        item.addEventListener('mousedown', press);
        item.addEventListener('touchstart', press, { passive: false });
        return item;
    }

    /** Select a library pattern: the next lane click places it. */
    function selectLibraryPattern(pattern) {
        pick(null);
        selectedPatternId = pattern.id;
        say(`${pattern.name} selected — click a lane to place it, or drag it there`);
        render();
    }

    /**
     * Press on a library item: a tap selects the pattern; a drag carries a
     * ghost of it and drops a clip where it is released over a lane (the
     * snap cell under the pointer). Released anywhere else, nothing.
     */
    function startLibraryDrag(e, pattern, item) {
        if (e.cancelable && e.preventDefault) e.preventDefault();
        if (stamp) cancelStamp();
        const origin = pointer(e);
        let ghost = null;
        const onMove = (ev) => {
            const pt = pointer(ev);
            if (!ghost && Math.abs(pt.x - origin.x) < DRAG_THRESHOLD && Math.abs(pt.y - origin.y) < DRAG_THRESHOLD) return;
            if (ev.cancelable && ev.preventDefault) ev.preventDefault();
            if (!ghost) {
                ghost = document.createElement('div');
                ghost.className = 'section-library-ghost';
                ghost.style.background = pattern.color;
                ghost.textContent = pattern.name;
                document.body.appendChild(ghost);
            }
            ghost.style.left = (pt.x + 8) + 'px';
            ghost.style.top = (pt.y + 8) + 'px';
        };
        const finish = (ev) => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', finish);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', finish);
            document.removeEventListener('touchcancel', cancel);
            if (!ghost) { selectLibraryPattern(pattern); return; }
            if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
            const pt = pointer(ev);
            const hit = laneAt(pt.x);
            const r = grid.getBoundingClientRect();
            if (!hit || pt.y < r.top || pt.y >= r.bottom) return;
            const trackId = hit.lane.dataset.trackId;
            const startCol = colAt(hit.lane, pt.y);
            change((project, section) => {
                const clip = addClip(project, section, { trackId, patternId: pattern.id, startCol });
                pick(clip.id);
            });
            selectedPatternId = pattern.id;
            selectedTrackId = trackId;
            render();
        };
        const cancel = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', finish);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', finish);
            document.removeEventListener('touchcancel', cancel);
            if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', finish);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', finish);
        document.addEventListener('touchcancel', cancel);
    }

    const unsubscribeBus = onSelectionElsewhere('section', () => {
        if (!picked.size && !stamp && !selectedClipId) return;
        if (stamp) {
            stamp = null;
            document.removeEventListener('mousemove', followStamp);
            document.removeEventListener('touchmove', followStamp);
        }
        pick(null);
        render();
    });

    unsubscribe = session.subscribe((ev) => {
        // Patch and canvas edits belong to the other half of the app.
        if (ev.kind === 'patches') return;
        render();
    });
    if (transport) {
        unsubscribeTransport = transport.subscribe((pos) => {
            movePlayhead(pos.sectionCol != null ? pos.sectionCol : pos.col);
        });
    }
    render();

    return {
        element: root,
        render,
        getSelectedPatternId() { return selectedPatternId; },
        getSelectedClipId() { return selectedClipId; },
        getSelectedTrackId() { const t = currentTrack(session.get()); return t ? t.id : null; },
        selectPattern(id) { selectedPatternId = id; render(); },
        destroy() {
            document.removeEventListener('keydown', onKey);
            unsubscribeBus();
            if (unsubscribe) unsubscribe();
            if (unsubscribeTransport) unsubscribeTransport();
        },
    };
}
