// Pianoroll: 3 octaves (C3–C6) × 1 measure of 4/4 (16 sixteenth notes)
// Click+drag creates notes, double-click removes, sequencer plays all notes.
// The roll is a **pattern editor**: it edits one monotimbral Pattern at a
// time — the one belonging to the active voice-bank slot's track. Notes
// therefore carry no slot; the track does. Other tracks are drawn behind as
// read-only ghosts so the arrangement stays visible while one voice is
// edited, and playback runs every track through the phase-2 sequencer.

const logRecord = () => {};

const NOTES = [
    { midi: 84, name: 'C6',  white: true },
    { midi: 83, name: 'B5',  white: true },
    { midi: 82, name: 'A#5', white: false },
    { midi: 81, name: 'A5',  white: true },
    { midi: 80, name: 'G#5', white: false },
    { midi: 79, name: 'G5',  white: true },
    { midi: 78, name: 'F#5', white: false },
    { midi: 77, name: 'F5',  white: true },
    { midi: 76, name: 'E5',  white: true },
    { midi: 75, name: 'D#5', white: false },
    { midi: 74, name: 'D5',  white: true },
    { midi: 73, name: 'C#5', white: false },
    { midi: 72, name: 'C5',  white: true },
    { midi: 71, name: 'B4',  white: true },
    { midi: 70, name: 'A#4', white: false },
    { midi: 69, name: 'A4',  white: true },
    { midi: 68, name: 'G#4', white: false },
    { midi: 67, name: 'G4',  white: true },
    { midi: 66, name: 'F#4', white: false },
    { midi: 65, name: 'F4',  white: true },
    { midi: 64, name: 'E4',  white: true },
    { midi: 63, name: 'D#4', white: false },
    { midi: 62, name: 'D4',  white: true },
    { midi: 61, name: 'C#4', white: false },
    { midi: 60, name: 'C4',  white: true },
    { midi: 59, name: 'B3',  white: true },
    { midi: 58, name: 'A#3', white: false },
    { midi: 57, name: 'A3',  white: true },
    { midi: 56, name: 'G#3', white: false },
    { midi: 55, name: 'G3',  white: true },
    { midi: 54, name: 'F#3', white: false },
    { midi: 53, name: 'F3',  white: true },
    { midi: 52, name: 'E3',  white: true },
    { midi: 51, name: 'D#3', white: false },
    { midi: 50, name: 'D3',  white: true },
    { midi: 49, name: 'C#3', white: false },
    { midi: 48, name: 'C3',  white: true },
    { midi: 47, name: 'B2',  white: true },
    { midi: 46, name: 'A#2', white: false },
    { midi: 45, name: 'A2',  white: true },
    { midi: 44, name: 'G#2', white: false },
    { midi: 43, name: 'G2',  white: true },
    { midi: 42, name: 'F#2', white: false },
    { midi: 41, name: 'F2',  white: true },
    { midi: 40, name: 'E2',  white: true },
    { midi: 39, name: 'D#2', white: false },
    { midi: 38, name: 'D2',  white: true },
    { midi: 37, name: 'C#2', white: false },
    { midi: 36, name: 'C2',  white: true },
];

import { selectionMade, onSelectionElsewhere } from './selection-bus.js';
import {
    COLS_PER_MEASURE, createTrack, addClip, clipCols,
    MIN_BPM, MAX_BPM,
} from './project-model.js';
import { msPerColumn } from '../synth/section-sequencer.js';
import { createTransport } from '../synth/transport.js';

const ROW_H = 20;
const COL_W = 30;
const LABEL_W = 36;
const HEADER_H = 14; // reserved for measure numbers above grid

const LEGACY_KEY = 'openpatches_pianoroll';   // migrated by the session; read here only for the follow pref
const PREFS_KEY = 'openpatches_roll_prefs';   // view-only state (follow-scroll)
const DEFAULT_BPM = 120;
const PLAYHEAD_COLOR = '#ff3b3b';
const DEFAULT_COLORS = ['#e94560', '#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4', '#ff5722', '#607d8b'];

export function createPianoroll(opts) {
    const { playNoteFn, onNotesChange } = opts;
    // The open project is shared with the Section editor through the session;
    // the roll edits one pattern placed in it. `tracks` is the roll's view:
    // one entry per project track (sorted by slot) with the clip and pattern
    // being edited on it. `notes` is always the active entry's note array,
    // so the editing code below goes on working against a single list.
    const session = opts.session;
    let tracks = [];
    let activeTrackIdx = -1;
    let notes = [];
    let openClipId = null;        // openClip(): edit this clip's pattern, not the track's first
    const liveCache = new Map();  // patternId → the copy the roll is editing
    let measures = 1;

    // The clock lives in the transport — it owns the tick worker and decides
    // what sounds. The roll supplies the live patterns and says which one is
    // being edited; in return it gets a position on every tick.
    const transport = opts.transport || createTransport({
        session,
        tickWorker: opts.tickWorker,
        startWorker: opts.startWorker,
        stopWorker: opts.stopWorker,
        tempoWorker: opts.tempoWorker,
        playNote: (midi, durMs, voiceData, slot) => playNoteFn(midi, durMs, voiceData, slot),
        getSlotData: (slot) => getSlotData(slot),
        getPattern: (id) => livePattern(id),
        getEditTarget: () => editTarget(),
        onStop: opts.onStopPlayback || null,
        log: opts.log || null,
    });
    /** The pattern on screen, as the transport and the step record see it. */
    function editTarget() {
        const e = activeEntry();
        if (!e || !e.pattern) return null;
        return { trackId: e.id, clipId: e.clipId, pattern: e.pattern, slot: e.slot };
    }
    const CANVAS_H = HEADER_H + NOTES.length * ROW_H;
    let looping = false;
    // Scroll the view to keep the playhead in sight while playing/recording.
    // Off by default: every tick then costs a full redraw of a double-wide
    // canvas plus a scrollLeft write (forced layout), which lags badly on
    // slower machines. With it off the canvas stays single-width, the user
    // owns the scroll position and the red playhead shows where we are.
    let followPlayhead = false;
    let recordingActive = false;   // between startRecording() and stopRecording()
    let waitingForClock = false;   // armed, and the external clock has not started us

    function totalCols() { return measures * COLS_PER_MEASURE; }
    function gridWidth() { return totalCols() * COL_W; }
    function baseWidth() { return LABEL_W + gridWidth(); }
    // The second copy of the grid exists only so the follow-scroll can run
    // seamlessly past the loop seam; without follow it is pure overhead.
    function doubleWide() { return looping && followPlayhead; }
    function canvasWidth() { return doubleWide() ? LABEL_W + gridWidth() * 2 : baseWidth(); }

    // --- Helpers to look up voice bank data by slot ---
    function getSlotData(slot) {
        if (opts.getSlotData) return opts.getSlotData(slot);
        return null;
    }

    function slotColor(slot) {
        const entry = getSlotData(slot);
        if (entry && entry.color) return entry.color;
        return DEFAULT_COLORS[slot % DEFAULT_COLORS.length];
    }

    function slotName(slot) {
        const entry = getSlotData(slot);
        return entry ? entry.name : 'Slot ' + slot;
    }

    // --- Tracks ---

    function currentSlot() {
        return opts.activeSlot != null ? opts.activeSlot : 0;
    }

    function activeEntry() {
        return activeTrackIdx >= 0 ? tracks[activeTrackIdx] || null : null;
    }

    function activePattern() {
        const e = activeEntry();
        return e ? e.pattern : null;
    }

    /**
     * The roll's working copy of a pattern: fetched once, edited live,
     * written back by saveState(). Cleared whenever another editor changes
     * something, so a rename done there is never overwritten from here.
     */
    function livePattern(id) {
        if (!id) return null;
        if (!liveCache.has(id)) {
            const p = session.getPattern(id);
            if (!p) return null;
            liveCache.set(id, p);
        }
        return liveCache.get(id);
    }

    /** Point `notes` at entry `i`'s pattern (or at a scratch list if none). */
    function setActiveTrack(i) {
        activeTrackIdx = i;
        const p = i >= 0 && tracks[i] ? tracks[i].pattern : null;
        notes = p ? p.notes : [];
        if (p) measures = p.measures;
    }

    function selectSlot(slot) {
        setActiveTrack(tracks.findIndex(t => t.slot === slot));
    }

    /**
     * Rebuild the roll's view of the project. The band is the project's
     * tracks; the clips are the edited section's. Each track edits the clip
     * opened from the Section editor, else its first; a track with no clips
     * here has nothing to edit until a note is drawn on it.
     */
    function adoptProject(project) {
        if (!project) return;
        const section = session.getSection();
        const clipsHere = section ? section.clips : [];
        tracks = project.tracks.map(t => {
            const clips = clipsHere
                .filter(c => c.trackId === t.id)
                .sort((a, b) => a.startCol - b.startCol);
            const clip = clips.find(c => c.id === openClipId) || clips[0] || null;
            return {
                id: t.id, slot: t.slot, name: t.name,
                clipId: clip ? clip.id : null,
                pattern: clip ? livePattern(clip.patternId) : null,
            };
        }).sort((a, b) => a.slot - b.slot);
        selectSlot(currentSlot());
        // Nothing to edit on this voice: size the grid to the project's longest
        // pattern so a freshly loaded project looks its length straight away.
        if (!activePattern()) {
            measures = Math.max(1, ...tracks.map(t => (t.pattern ? t.pattern.measures : 1)));
        }
    }

    /**
     * Give `slot` a track with a pattern to edit, creating what is missing:
     * a voice gets a pattern the moment the user puts a note on it, not when
     * the slot is selected. The clip goes at measure 0 — a track reaches here
     * only when it has no clips, so nothing can be in the way.
     */
    function ensureTrackForSlot(slot) {
        let entry = tracks.find(t => t.slot === slot);
        if (entry && entry.pattern) return entry;
        const pattern = session.createPattern({ name: slotName(slot), measures }, 'roll');
        liveCache.set(pattern.id, pattern);
        // Tracks are the project's band; the clip goes in the edited section.
        session.update((project, section) => {
            let track = entry ? project.tracks.find(t => t.id === entry.id) : null;
            if (!track) {
                track = createTrack({ name: slotName(slot), slot });
                project.tracks.push(track);
            }
            addClip(project, section, { trackId: track.id, patternId: pattern.id, startCol: 0 });
        }, 'roll');
        adoptProject(session.get());
        return tracks.find(t => t.slot === slot);
    }

    function ensureActiveTrack() {
        const entry = ensureTrackForSlot(currentSlot());
        selectSlot(currentSlot());
        return entry;
    }

    function allNotes() {
        const out = [];
        for (const t of tracks) {
            if (!t.pattern) continue;
            for (const n of t.pattern.notes) out.push({ note: n, track: t });
        }
        return out;
    }

    /** The project's tempo — the transport bar's BPM box writes it. */
    function getBpm() {
        const project = session.get();
        const v = project ? parseInt(project.bpm) : NaN;
        return Number.isFinite(v) ? Math.max(MIN_BPM, Math.min(MAX_BPM, v)) : DEFAULT_BPM;
    }

    // Rebuilt on every edit rather than per tick: the sequencer snapshots
    // patterns on purpose, and editing while the loop runs must still be
    // heard on the next pass. Mute/solo it reads live off the session's project.
    function refreshSequence() {
        transport.refresh();
    }

    // Changes made by other editors: re-read the project.
    //
    // A write from the **Mixer** is a special case. It used to be skipped
    // outright, because the bank kept its own array and re-adopting would
    // only throw away the roll's working copies. The bank writes the
    // project's *tracks* now — the same records the roll draws its lanes
    // from — so skipping it left the roll with a stale track list and,
    // worse, made it create a second track on a slot that already had one.
    //
    // So the track list is always refreshed, and only a change that could
    // have touched the patterns drops the cached copies. Keeping them on a
    // Mixer write is what stops a gesture in progress dying under the user.
    session.subscribe((ev) => {
        if (ev.source === 'roll') return;
        // A patch moved on the canvas is not an arrangement change, and
        // dragging one fires on every pointer move.
        if (ev.kind === 'patches') return;
        // A popover commit from the Mixer (`voicebank-fx`) is a Mixer
        // write too: only track.fx moved, no pattern could have.
        if (ev.source !== 'voicebank' && ev.source !== 'voicebank-fx') liveCache.clear();
        adoptProject(session.get());
        updateMeasureButtons();
        refreshSequence();
        draw();
        renderLegend();
    });

    const container = document.createElement('div');
    container.className = 'pianoroll-container';

    // Controls row
    const controls = document.createElement('div');
    controls.className = 'pianoroll-controls';

    // Play, Stop and BPM used to open this row; they are the transport
    // bar's now (components/transport-bar.js), above every panel.

    // Which pattern is on screen — and a switch to any other, without a
    // trip to the Section pane. A pattern placed on the current voice's
    // track opens there; else wherever it is placed (its voice becomes the
    // active one); a pattern placed nowhere is placed at the end of the
    // current track first, since the roll edits clips, not loose patterns.
    const patternLabel = document.createElement('label');
    patternLabel.className = 'pianoroll-pattern-field';
    patternLabel.textContent = 'Pattern ';
    const patternSel = document.createElement('select');
    patternSel.className = 'pianoroll-pattern';
    patternSel.title = 'The pattern being edited — pick another to switch to it';
    patternLabel.appendChild(patternSel);
    controls.appendChild(patternLabel);
    patternSel.addEventListener('change', () => switchToPattern(patternSel.value));

    // Grouped, so the list stays readable as patterns accumulate: the ones
    // placed in this section first, then those placed elsewhere in the
    // piece, then the unplaced. Within a group, by name.
    function renderPatternSelect() {
        const project = session.get();
        const section = session.getSection();
        const current = activePattern();
        patternSel.innerHTML = '';
        if (!current) {
            const none = document.createElement('option');
            none.value = '';
            none.textContent = '— none —';
            none.disabled = true;
            none.selected = true;
            patternSel.appendChild(none);
        }
        if (!project) return;
        const here = new Set(section ? section.clips.map(c => c.patternId) : []);
        const elsewhere = new Set();
        for (const s of project.sections) {
            if (section && s.id === section.id) continue;
            for (const c of s.clips) elsewhere.add(c.patternId);
        }
        const groups = [
            { label: 'In this section', test: (p) => here.has(p.id) },
            { label: 'In other sections', test: (p) => !here.has(p.id) && elsewhere.has(p.id) },
            { label: 'Not placed', test: (p) => !here.has(p.id) && !elsewhere.has(p.id) },
        ];
        const all = session.listPatterns();
        const several = project.sections.length > 1;
        for (const g of groups) {
            const members = all.filter(g.test);
            if (members.length === 0) continue;
            // One section: "elsewhere" is empty and the two groups left need
            // no headings — a flat list reads better than two of one.
            const parent = several || g.label === 'Not placed' ? document.createElement('optgroup') : patternSel;
            if (parent !== patternSel) { parent.label = g.label; patternSel.appendChild(parent); }
            for (const p of members) {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.name;
                if (current && p.id === current.id) opt.selected = true;
                parent.appendChild(opt);
            }
        }
        if (current) patternSel.value = current.id;
    }

    function switchToPattern(patternId) {
        const project = session.get();
        const section = session.getSection();
        if (!project || !section || !patternId) return false;
        const here = project.tracks.find(t => t.slot === currentSlot()) || project.tracks[0] || null;
        const clips = section.clips.filter(c => c.patternId === patternId)
            .sort((a, b) => a.startCol - b.startCol);
        let clip = (here && clips.find(c => c.trackId === here.id)) || clips[0] || null;
        if (!clip) {
            if (!here) { renderPatternSelect(); return false; }
            let end = 0;
            for (const c of section.clips) {
                if (c.trackId !== here.id) continue;
                const span = clipCols(c, session.getPattern(c.patternId));
                if (span && span.endCol > end) end = span.endCol;
            }
            session.update((p, s) => { clip = addClip(p, s, { trackId: here.id, patternId, startCol: end }); }, 'roll');
        }
        if (opts.onOpenClip) opts.onOpenClip(clip.id, clip.trackId);
        else api.openClip(clip.id);
        return true;
    }


    const FOLLOW_LABEL = '\u21E5 Follow';
    const FOLLOW_TITLE = 'Scroll the roll to keep the playhead in view while playing. ' +
        'Off by default: it costs a lot of redrawing on slower machines.';
    const followBtn = document.createElement('button');
    followBtn.className = 'pianoroll-btn pianoroll-follow';
    followBtn.textContent = FOLLOW_LABEL;
    followBtn.title = FOLLOW_TITLE;
    controls.appendChild(followBtn);

    // Everything the roll starts — Play and Record — loops this pattern's
    // placement and is never longer than the pattern. This button does not
    // touch that: it decides whether the rest of the section is heard inside
    // the window, or only the pattern being written.
    const accompanyBtn = document.createElement('button');
    accompanyBtn.className = 'pianoroll-btn pianoroll-accompany';
    controls.appendChild(accompanyBtn);

    function updateAccompanyButton() {
        const on = transport.getAccompany();
        accompanyBtn.textContent = on ? '\u266B With section' : '\u25AD Pattern only';
        accompanyBtn.title = on
            ? 'The other tracks play along inside this pattern — click to hear this pattern alone'
            : 'Only this pattern sounds — click to hear the rest of the section along with it';
        accompanyBtn.classList.toggle('active', !on);
    }
    accompanyBtn.addEventListener('click', () => {
        transport.setAccompany(!transport.getAccompany());
        updateAccompanyButton();
    });
    updateAccompanyButton();

    // Desktop clear button (also in moreMenu for mobile)
    const clearBtnDesktop = document.createElement('button');
    clearBtnDesktop.className = 'pianoroll-btn pianoroll-clear-desktop';
    clearBtnDesktop.textContent = '\u{1F9F9} Clear';
    controls.appendChild(clearBtnDesktop);

    // The tool — what a press on the grid does. One split button, after
    // the transport's Play: the label names the current tool, the caret
    // opens the list. Edit draws notes (Shift-drag still marquees). Select
    // makes a drag a marquee until changed back; Select once is the same
    // for a single rectangle and then returns to Edit by itself. Erase
    // deletes the note under the pointer and every note a drag crosses.
    // Copy arms the stamp. Mobile copies live in the more-menu below.
    const TOOLS = [
        { id: 'edit', label: '\u270E Edit', title: 'Edit: drag on the grid to draw a note; drag a note to move it, its edge to resize it; double-click removes it. Shift-drag selects.' },
        { id: 'select-once', label: '\u2B1A Select once', title: 'Select once: drag a rectangle over notes to select them, then back to Edit.' },
        { id: 'select', label: '\u2B1A Select', title: 'Select: every drag on empty grid is a rectangle that selects the notes it crosses; drag any selected note to move them all, Delete removes them, Copy stamps a copy.' },
        { id: 'erase', label: '\u2326 Erase', title: 'Erase: click a note to remove it, or drag across notes to remove each one you cross.' },
    ];
    const toolById = (id) => TOOLS.find(t => t.id === id) || TOOLS[0];
    const COPY_LABEL = '\u2398 Copy';
    const COPY_TITLE = 'Copy the selected notes: a shadow of them follows the pointer — click where they should go '
        + '(Ctrl+C; Escape or Copy again to cancel)';
    const mkBtn = (cls, label, title) => {
        const b = document.createElement('button');
        b.className = 'pianoroll-btn ' + cls;
        b.textContent = label;
        b.title = title;
        return b;
    };
    // [ ✎ Edit | ▾ ] — the label shows the tool; label and caret both open
    // the list (there is nothing else a press on the name could mean).
    const toolSplit = document.createElement('div');
    toolSplit.className = 'pianoroll-tool-split';
    const toolBtn = mkBtn('pianoroll-tool', TOOLS[0].label, TOOLS[0].title);
    const toolCaret = mkBtn('pianoroll-tool-caret', '\u25BE', 'Choose the tool');
    const toolMenu = document.createElement('div');
    toolMenu.className = 'pianoroll-tool-menu';
    toolMenu.hidden = true;
    const toolModeBtns = [];
    const mkToolMode = (t) => {
        const b = mkBtn('pianoroll-tool-mode', t.label, t.title);
        b.dataset.tool = t.id;
        b.addEventListener('click', (e) => { e.stopPropagation(); setTool(t.id); closeToolMenu(); });
        toolModeBtns.push(b);
        return b;
    };
    for (const t of TOOLS) toolMenu.appendChild(mkToolMode(t));
    toolSplit.appendChild(toolBtn);
    toolSplit.appendChild(toolCaret);
    toolSplit.appendChild(toolMenu);
    const toolOutside = (e) => { if (!toolSplit.contains(e.target)) closeToolMenu(); };
    const toolEsc = (e) => { if (e.key === 'Escape') closeToolMenu(); };
    function openToolMenu() {
        toolMenu.hidden = false;
        toolCaret.classList.add('open');
        document.addEventListener('mousedown', toolOutside);
        document.addEventListener('touchstart', toolOutside);
        document.addEventListener('keydown', toolEsc);
    }
    function closeToolMenu() {
        toolMenu.hidden = true;
        toolCaret.classList.remove('open');
        document.removeEventListener('mousedown', toolOutside);
        document.removeEventListener('touchstart', toolOutside);
        document.removeEventListener('keydown', toolEsc);
    }
    for (const b of [toolBtn, toolCaret]) {
        b.addEventListener('click', (e) => { e.stopPropagation(); toolMenu.hidden ? openToolMenu() : closeToolMenu(); });
    }
    const copyBtn = mkBtn('pianoroll-copy', COPY_LABEL, COPY_TITLE);
    copyBtn.disabled = true;
    controls.appendChild(toolSplit);
    controls.appendChild(copyBtn);

    // Ellipsis menu (mobile)
    const moreBtn = document.createElement('button');
    moreBtn.className = 'pianoroll-btn pianoroll-more';
    moreBtn.textContent = '\u22EF';
    moreBtn.title = 'More options';
    controls.appendChild(moreBtn);

    const moreMenu = document.createElement('div');
    moreMenu.className = 'pianoroll-more-menu';
    moreMenu.style.display = 'none';

    const clearBtn = document.createElement('button');
    clearBtn.className = 'pianoroll-btn';
    clearBtn.textContent = '\u{1F9F9} Clear';
    moreMenu.appendChild(clearBtn);

    const followBtnMobile = document.createElement('button');
    followBtnMobile.className = 'pianoroll-btn pianoroll-follow';
    followBtnMobile.textContent = FOLLOW_LABEL;
    followBtnMobile.title = FOLLOW_TITLE;
    moreMenu.appendChild(followBtnMobile);

    // The more-menu lists the tools flat — it is a menu already.
    for (const t of TOOLS) moreMenu.appendChild(mkToolMode(t));
    const copyBtnMobile = mkBtn('pianoroll-copy', COPY_LABEL, COPY_TITLE);
    copyBtnMobile.disabled = true;
    moreMenu.appendChild(copyBtnMobile);
    // Copy arms the stamp; Copy again while armed cancels it.
    for (const b of [copyBtn, copyBtnMobile]) b.addEventListener('click', () => { if (placing) cancelPlacement(); else copySelection(); });

    const addMeasureBtnMobile = document.createElement('button');
    addMeasureBtnMobile.className = 'pianoroll-btn';
    addMeasureBtnMobile.textContent = '+ Msr';
    addMeasureBtnMobile.title = 'Add measure';
    moreMenu.appendChild(addMeasureBtnMobile);

    const cloneMeasureBtnMobile = document.createElement('button');
    cloneMeasureBtnMobile.className = 'pianoroll-btn';
    cloneMeasureBtnMobile.textContent = '\u29C9 Clone';
    cloneMeasureBtnMobile.title = 'Clone last measure to new';
    moreMenu.appendChild(cloneMeasureBtnMobile);

    const removeMeasureBtnMobile = document.createElement('button');
    removeMeasureBtnMobile.className = 'pianoroll-btn';
    removeMeasureBtnMobile.textContent = '\u2715 Msr';
    removeMeasureBtnMobile.title = 'Remove last measure';
    removeMeasureBtnMobile.disabled = true;
    moreMenu.appendChild(removeMeasureBtnMobile);

    const addMeasureBtn = document.createElement('button');
    addMeasureBtn.className = 'pianoroll-btn';
    addMeasureBtn.textContent = '+ Msr';
    addMeasureBtn.title = 'Add measure';
    controls.appendChild(addMeasureBtn);

    const cloneMeasureBtn = document.createElement('button');
    cloneMeasureBtn.className = 'pianoroll-btn';
    cloneMeasureBtn.textContent = '\u29C9 Clone';
    cloneMeasureBtn.title = 'Clone last measure to new';
    controls.appendChild(cloneMeasureBtn);

    const removeMeasureBtn = document.createElement('button');
    removeMeasureBtn.className = 'pianoroll-btn';
    removeMeasureBtn.textContent = '\u2715 Msr';
    removeMeasureBtn.title = 'Remove last measure';
    removeMeasureBtn.disabled = true;
    controls.appendChild(removeMeasureBtn);

    function updateMeasureButtons() {
        removeMeasureBtn.disabled = measures <= 1;
        removeMeasureBtnMobile.disabled = measures <= 1;
    }

    function toggleMoreMenu() {
        const open = moreMenu.style.display === 'none';
        moreMenu.style.display = open ? 'flex' : 'none';
        moreBtn.classList.toggle('active', open);
    }

    function closeMoreMenu() {
        moreMenu.style.display = 'none';
        moreBtn.classList.remove('active');
    }

    moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMoreMenu();
    });

    // Close on button press inside menu
    moreMenu.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') closeMoreMenu();
    });

    // Close on outside click
    document.addEventListener('click', closeMoreMenu);

    container.appendChild(controls);
    container.appendChild(moreMenu);

    // --- Measure management ---
    // Patterns have their own lengths; the measure buttons act on the one
    // being edited. With nothing to edit yet they only size the grid.
    function setMeasures(n) {
        measures = n;
        const p = activePattern();
        if (p) p.measures = n;
    }

    addMeasureBtn.addEventListener('click', () => {
        setMeasures(measures + 1);
        updateMeasureButtons();
        draw();
        saveState();
    });

    cloneMeasureBtn.addEventListener('click', () => {
        const offset = (measures - 1) * COLS_PER_MEASURE;
        const cloned = notes
            .filter(n => n.start >= offset && n.start < offset + COLS_PER_MEASURE)
            .map(n => ({ midi: n.midi, start: n.start + COLS_PER_MEASURE, dur: n.dur }));
        setMeasures(measures + 1);
        notes.push(...cloned);
        updateMeasureButtons();
        draw();
        renderLegend();
        onNotesChange();
        saveState();
    });

    removeMeasureBtn.addEventListener('click', () => {
        if (measures <= 1) return;
        const cutoff = (measures - 1) * COLS_PER_MEASURE;
        for (let i = notes.length - 1; i >= 0; i--) {
            if (notes[i].start >= cutoff) notes.splice(i, 1);
        }
        setMeasures(measures - 1);
        updateMeasureButtons();
        draw();
        renderLegend();
        onNotesChange();
        saveState();
    });

    function setFollowPlayhead(on) {
        followPlayhead = !!on;
        followBtn.classList.toggle('active', followPlayhead);
        followBtnMobile.classList.toggle('active', followPlayhead);
        // Switching off mid-loop can leave the view parked in the second
        // copy of the grid, which is about to disappear.
        if (!followPlayhead) scroll.scrollLeft = scroll.scrollLeft % gridWidth();
        draw();
        saveState();
    }
    followBtn.addEventListener('click', () => setFollowPlayhead(!followPlayhead));
    followBtnMobile.addEventListener('click', () => setFollowPlayhead(!followPlayhead));

    addMeasureBtnMobile.addEventListener('click', () => addMeasureBtn.click());
    cloneMeasureBtnMobile.addEventListener('click', () => cloneMeasureBtn.click());
    removeMeasureBtnMobile.addEventListener('click', () => removeMeasureBtn.click());

    // Scrollable canvas area
    const scroll = document.createElement('div');
    scroll.className = 'pianoroll-scroll';

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth();
    canvas.height = CANVAS_H;
    canvas.className = 'pianoroll-canvas';
    scroll.appendChild(canvas);
    container.appendChild(scroll);

    // Legend
    const legend = document.createElement('div');
    legend.className = 'pianoroll-legend';
    container.appendChild(legend);

    const ctx = canvas.getContext('2d');
    let playing = false;
    let playCol = -1;
    let stepCol = -1;   // the step record's cursor; drawn as the playhead while the clock is stopped
    let dragging = false;
    let dragStart = null;

    // Note move/resize state
    let movingNote = null;
    let resizingNote = null;
    let resizeSide = null; // 'left' or 'right'
    let moveStartPos = null;
    let moveOriginal = null;
    let moveCommitted = false;

    const MOVE_THRESHOLD = 5;
    const RESIZE_MARGIN = 8;
    const TOUCH_RESIZE_MARGIN = 20;
    const PLAYHEAD_GRAB = 6;          // px either side of the step cursor's line that grab it
    const TOUCH_PLAYHEAD_GRAB = 16;

    // Selection: a set of the edited track's notes. Made by a marquee (a
    // drag on empty grid in Select mode, or with Shift held), moved as one
    // by dragging any selected note, copied and pasted by the buttons.
    const selected = new Set();
    let tool = 'edit';                // one of TOOLS[].id
    const isSelecting = () => tool === 'select' || tool === 'select-once';
    let erasing = false;              // Erase: the button is down, notes under the pointer go
    let erasedAny = false;
    let marquee = null;               // {x0, y0, x1, y1} in folded canvas px while dragging one
    let groupMove = null;             // [{note, start, midi}] originals while moving a selection
    // The stamp: Copy takes the selection off the grid as a shadow that
    // follows the pointer; a click puts it down. `notes` are relative to
    // the group's top-left cell (first column, highest row); `col`/`row`
    // is that cell under the pointer, null while the pointer is off-grid.
    let placing = null;               // {notes: [{rowOff, start, dur}], span, rows, col, row}
    /**
     * Write the edited pattern(s) back and refresh playback. Only patterns
     * the roll changed are written — a pattern renamed in the Section editor
     * must not be clobbered by a stale copy from here. Called on every
     * edit, so it also rebuilds the sequence (the sequencer snapshots
     * patterns; an edit must be audible on the next pass).
     */
    function saveState(patterns) {
        const list = patterns || (activePattern() ? [activePattern()] : []);
        try {
            for (const p of list) session.touchPattern(p.id, 'roll');
            localStorage.setItem(PREFS_KEY, JSON.stringify({ followPlayhead }));
        } catch (e) { /* ignore */ }
        refreshSequence();
    }

    function loadState() {
        try {
            // Follow-scroll is a view preference, not part of a project. Read
            // the legacy blob as a fallback so the user's toggle survives.
            let follow = false;
            try {
                const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
                const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}');
                follow = prefs.followPlayhead === true
                    || (prefs.followPlayhead === undefined && legacy.followPlayhead === true);
            } catch { /* ignore */ }
            if (follow) {
                followPlayhead = true;
                followBtn.classList.add('active');
                followBtnMobile.classList.add('active');
            }

            // app.js has already opened the project — the store is async,
            // so the session cannot be initialised from here any more.
            adoptProject(session.get());
            refreshSequence();
            updateMeasureButtons();
        } catch (e) { /* ignore */ }
    }

    // --- Drawing ---
    function resizeCanvas() {
        // Assigning canvas.width — even to the same value — resets the
        // context and reallocates the backing store; at tick rate that is a
        // measurable part of the per-frame cost, so only do it on change.
        const w = canvasWidth();
        if (canvas.width !== w) canvas.width = w;
    }

    // --- Drawing helpers (parameterized by context and offset) ---

    function drawLabels(ctx) {
        ctx.font = '10px monospace';
        ctx.textBaseline = 'middle';
        for (let r = 0; r < NOTES.length; r++) {
            const y = HEADER_H + r * ROW_H + ROW_H / 2;
            ctx.fillStyle = NOTES[r].white ? '#aaa' : '#666';
            ctx.textAlign = 'right';
            ctx.fillText(NOTES[r].name, LABEL_W - 4, y);
        }
    }

    function drawGrid(ctx, ox) {
        const cols = totalCols();
        const gridW = cols * COL_W;

        // Row backgrounds
        for (let r = 0; r < NOTES.length; r++) {
            const y = HEADER_H + r * ROW_H;
            ctx.fillStyle = NOTES[r].white ? '#1a1a2e' : '#12121f';
            ctx.fillRect(ox + LABEL_W, y, gridW, ROW_H);
        }

        // Column lines
        for (let c = 0; c <= cols; c++) {
            const x = ox + LABEL_W + c * COL_W;
            const isMeasureStart = c % COLS_PER_MEASURE === 0;
            const isBeat = c % 4 === 0;
            ctx.strokeStyle = isMeasureStart ? '#666' : isBeat ? '#444' : '#2a2a3a';
            ctx.lineWidth = isMeasureStart ? 2 : isBeat ? 1.5 : 0.5;
            ctx.beginPath();
            ctx.moveTo(x, HEADER_H);
            ctx.lineTo(x, CANVAS_H);
            ctx.stroke();
        }

        // Measure numbers in header area (left-aligned at each odd measure start)
        ctx.font = '9px monospace';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        for (let m = 0; m < measures; m++) {
            if (m % 2 === 0) continue;
            const x = ox + LABEL_W + m * COLS_PER_MEASURE * COL_W + 2;
            ctx.fillStyle = '#555';
            ctx.fillText(String(m + 1), x, 1);
        }

        // C octave stamps at measure starts (notes draw over these)
        ctx.font = '8px monospace';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#3a3a4a';
        for (let m = 0; m < measures; m++) {
            const col = m * COLS_PER_MEASURE;
            const x = ox + LABEL_W + col * COL_W + 2;
            for (let r = 0; r < NOTES.length; r++) {
                if (NOTES[r].midi % 12 === 0) {
                    ctx.fillText(NOTES[r].name, x, HEADER_H + r * ROW_H + ROW_H / 2);
                }
            }
        }

        // Row lines
        for (let r = 0; r <= NOTES.length; r++) {
            const y = HEADER_H + r * ROW_H;
            ctx.strokeStyle = '#2a2a3a';
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(ox + LABEL_W, y);
            ctx.lineTo(ox + baseWidth(), y);
            ctx.stroke();
        }

        // Loop boundary markers
        if (looping) {
            // Start marker (left edge of first copy)
            ctx.strokeStyle = '#e94560';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(ox + LABEL_W, HEADER_H);
            ctx.lineTo(ox + LABEL_W, CANVAS_H);
            ctx.stroke();

            // End marker (right edge of first copy = left edge of second copy)
            ctx.strokeStyle = '#e94560';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(ox + baseWidth(), HEADER_H);
            ctx.lineTo(ox + baseWidth(), CANVAS_H);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    function drawNote(ctx, ox, n, color, active) {
        const r = NOTES.findIndex(nn => nn.midi === n.midi);
        if (r < 0) return;
        const x = ox + LABEL_W + n.start * COL_W;
        const y = HEADER_H + r * ROW_H;
        const w = n.dur * COL_W - 1;
        const isSel = active && selected.has(n);
        ctx.fillStyle = color;
        ctx.globalAlpha = isSel ? 1 : active ? 0.85 : 0.25;
        ctx.fillRect(x + 1, y + 1, w, ROW_H - 2);
        ctx.globalAlpha = 1.0;
        if (!active) return;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = isSel ? 2 : 0.5;
        ctx.strokeRect(x + 1, y + 1, w, ROW_H - 2);
        ctx.lineWidth = 0.5;
        const handleW = Math.min(4, w / 4);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(x + 1, y + 1, handleW, ROW_H - 2);
        ctx.fillRect(x + w - handleW, y + 1, handleW, ROW_H - 2);
    }

    function drawNotes(ctx, ox) {
        // Ghosts first, so the edited track always sits on top of them.
        for (let i = 0; i < tracks.length; i++) {
            if (i === activeTrackIdx) continue;
            const t = tracks[i];
            if (!t.pattern) continue;
            for (const n of t.pattern.notes) drawNote(ctx, ox, n, slotColor(t.slot), false);
        }
        const activeColor = slotColor(activeTrackIdx >= 0 ? tracks[activeTrackIdx].slot : currentSlot());
        for (const n of notes) drawNote(ctx, ox, n, activeColor, true);

        // Ghost note(s): where a move started from.
        if (movingNote && moveCommitted && moveOriginal) {
            const ghosts = groupMove ? groupMove.map(g => ({ start: g.start, midi: g.midi, dur: g.note.dur }))
                : [{ start: moveOriginal.start, midi: moveOriginal.midi, dur: movingNote.dur }];
            for (const g of ghosts) {
                const origRow = NOTES.findIndex(nn => nn.midi === g.midi);
                if (origRow < 0) continue;
                const gx = ox + LABEL_W + g.start * COL_W;
                const gy = HEADER_H + origRow * ROW_H;
                const gw = g.dur * COL_W - 1;
                ctx.fillStyle = slotColor(activeTrackIdx >= 0 ? tracks[activeTrackIdx].slot : currentSlot());
                ctx.globalAlpha = 0.12;
                ctx.fillRect(gx + 1, gy + 1, gw, ROW_H - 2);
                ctx.globalAlpha = 1.0;
                ctx.strokeStyle = 'rgba(255,255,255,0.2)';
                ctx.lineWidth = 0.5;
                ctx.setLineDash([3, 3]);
                ctx.strokeRect(gx + 1, gy + 1, gw, ROW_H - 2);
                ctx.setLineDash([]);
            }
        }

        // The marquee being dragged.
        if (marquee) {
            const mx = ox + Math.min(marquee.x0, marquee.x1);
            const my = Math.min(marquee.y0, marquee.y1);
            const mw = Math.abs(marquee.x1 - marquee.x0);
            const mh = Math.abs(marquee.y1 - marquee.y0);
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            ctx.fillRect(mx, my, mw, mh);
            ctx.strokeStyle = 'rgba(255,255,255,0.7)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(mx + 0.5, my + 0.5, mw, mh);
            ctx.setLineDash([]);
        }

        // The stamp's shadow, under the pointer.
        if (placing && placing.col != null) {
            const color = slotColor(activeTrackIdx >= 0 ? tracks[activeTrackIdx].slot : currentSlot());
            for (const c of placing.notes) {
                const r = placing.row + c.rowOff;
                const start = placing.col + c.start;
                const w = clampDur(start, c.dur) * COL_W - 1;
                const x = ox + LABEL_W + start * COL_W;
                const y = HEADER_H + r * ROW_H;
                ctx.fillStyle = color;
                ctx.globalAlpha = 0.45;
                ctx.fillRect(x + 1, y + 1, w, ROW_H - 2);
                ctx.globalAlpha = 1.0;
                ctx.strokeStyle = 'rgba(255,255,255,0.8)';
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 2]);
                ctx.strokeRect(x + 1.5, y + 1.5, w - 1, ROW_H - 3);
                ctx.setLineDash([]);
            }
        }

        // Playhead: a red line at the leading edge of the current column,
        // with a marker in the header so it reads even over dense notes.
        // Deliberately high-contrast — with follow-scroll off this is the
        // only thing telling the user where playback is.
        const cursorCol = playCol >= 0 ? playCol : stepCol;
        if (cursorCol >= 0) {
            const x = ox + LABEL_W + cursorCol * COL_W;
            ctx.fillStyle = PLAYHEAD_COLOR;
            ctx.fillRect(x - 1, 0, 2, CANVAS_H);
            ctx.beginPath();
            ctx.moveTo(x - 5, 0);
            ctx.lineTo(x + 5, 0);
            ctx.lineTo(x, HEADER_H - 4);
            ctx.closePath();
            ctx.fill();
        }

        // Drag preview
        if (dragging && dragStart) {
            const cur = lastMousePos;
            if (cur) {
                const endCol = pixelToCol(cur.x);
                const endRow = pixelToRow(cur.y);
                if (endRow === dragStart.row) {
                    const minC = Math.min(dragStart.col, endCol);
                    const maxC = Math.max(dragStart.col, endCol);
                    const x = ox + LABEL_W + minC * COL_W;
                    const w = (maxC - minC + 1) * COL_W;
                    ctx.fillStyle = 'rgba(255,255,255,0.1)';
                    ctx.fillRect(x, HEADER_H + dragStart.row * ROW_H, w, ROW_H);
                }
            }
        }
    }

    function draw() {
        // The selection only ever holds the edited track's live notes: a
        // switch of track or pattern, a delete, a Clear all drop members.
        for (const n of selected) if (!notes.includes(n)) selected.delete(n);
        updateSelectionButtons();
        resizeCanvas();
        ctx.clearRect(0, 0, canvasWidth(), CANVAS_H);

        drawLabels(ctx);
        drawGrid(ctx, 0);
        drawNotes(ctx, 0);

        if (doubleWide()) {
            drawGrid(ctx, gridWidth());
            drawNotes(ctx, gridWidth());
        }
    }

    function pixelToCol(px) {
        const col = Math.floor((px - LABEL_W) / COL_W);
        return Math.max(0, Math.min(totalCols() - 1, col % totalCols()));
    }

    function pixelToRow(py) {
        return Math.max(0, Math.min(NOTES.length - 1, Math.floor((py - HEADER_H) / ROW_H)));
    }

    // A note ends at the loop end at the latest; anything longer would play
    // into the next pass and overlap its own repeat.
    function clampDur(start, dur) {
        return Math.max(1, Math.min(totalCols() - start, dur));
    }

    function noteAt(row, col) {
        const midi = NOTES[row].midi;
        return notes.find(n => n.midi === midi && col >= n.start && col < n.start + n.dur);
    }

    function activeNoteAt(row, col) {
        const midi = NOTES[row].midi;
        return notes.find(n => n.midi === midi && col >= n.start && col < n.start + n.dur);
    }

    // In follow mode the grid is drawn twice for a seamless loop; a click on
    // the second copy must find the same notes as the first, or the user ends
    // up creating a duplicate on top of a note they can see but cannot grab.
    function foldX(x) {
        return doubleWide() && x >= baseWidth() ? x - gridWidth() : x;
    }

    function findInteractionTarget(x, y) {
        x = foldX(x);
        const row = pixelToRow(y);
        if (row < 0 || row >= NOTES.length) return null;
        const midi = NOTES[row].midi;

        // Proximity check for notes in this row (the edited track only)
        const candidates = notes.filter(n => n.midi === midi);
        for (const n of candidates) {
            const startX = LABEL_W + n.start * COL_W;
            const endX = LABEL_W + (n.start + n.dur) * COL_W;
            if (Math.abs(x - endX) <= RESIZE_MARGIN) return { note: n, side: 'right' };
            if (Math.abs(x - startX) <= RESIZE_MARGIN) return { note: n, side: 'left' };
            if (x > startX && x < endX) return { note: n, side: 'move' };
        }
        return null;
    }

    let lastMousePos = null;
    let lastClickTime = 0;
    let lastClickRow = -1;
    let lastClickCol = -1;
    let seekingPlayhead = false;

    // --- Selection, group move, copy and paste ---------------------------

    /** Is the (folded) x within grabbing distance of the step cursor's line? */
    function nearPlayhead(x, margin) {
        if (stepCol < 0) return false;
        return Math.abs(foldX(x) - (LABEL_W + stepCol * COL_W)) <= margin;
    }

    function commitNotes() {
        draw();
        renderLegend();
        onNotesChange();
        saveState();
    }

    function clearSelection() {
        if (selected.size === 0) return;
        selected.clear();
        draw();
    }

    /**
     * Clamp a canvas-relative point onto the canvas (folding follow mode's
     * second grid copy). The marquee's natural sweep for notes at the
     * canvas edge runs *past* that edge; clamped back on, the rectangle
     * reaches the border notes it was aimed at instead of stopping a pixel
     * short of them.
     */
    function marqueePoint(x, y) {
        return {
            x: foldX(Math.max(0, Math.min(canvasWidth(), x))),
            y: Math.max(0, Math.min(CANVAS_H, y)),
        };
    }

    function commitMarquee() {
        const m = marquee;
        marquee = null;
        if (!m) return;
        // A bare click on empty grid in Select mode drops the selection.
        if (Math.abs(m.x1 - m.x0) < 4 && Math.abs(m.y1 - m.y0) < 4) { selected.clear(); draw(); }
        else selectInRect(m.x0, m.y0, m.x1, m.y1);
        // Select once is spent by its one rectangle — or its one click.
        if (tool === 'select-once') setTool('edit');
    }

    /** Erase: remove the note under (x, y), if any. Committed on release. */
    function eraseAt(x, y, finder) {
        const target = finder(x, y);
        if (!target || !target.note) return false;
        const idx = notes.indexOf(target.note);
        if (idx >= 0) notes.splice(idx, 1);
        selected.delete(target.note);
        erasedAny = true;
        draw();
        return true;
    }

    function endErase() {
        if (!erasing) return;
        erasing = false;
        if (erasedAny) commitNotes();
        erasedAny = false;
    }

    // A mouse marquee lives on the document, not the canvas: leaving the
    // canvas mid-drag must neither kill it (mouseleave) nor freeze it at
    // the last in-canvas pixel — the sweep for border notes goes outside.
    function marqueeDocMove(e) {
        if (!marquee) return;
        const rect = canvas.getBoundingClientRect();
        const pt = marqueePoint(e.clientX - rect.left, e.clientY - rect.top);
        marquee.x1 = pt.x;
        marquee.y1 = pt.y;
        draw();
    }
    function marqueeDocUp() {
        document.removeEventListener('mousemove', marqueeDocMove);
        document.removeEventListener('mouseup', marqueeDocUp);
        commitMarquee();
    }

    /** Select the edited track's notes that intersect a canvas-px rectangle. */
    function selectInRect(x0, y0, x1, y1) {
        const left = Math.min(x0, x1), right = Math.max(x0, x1);
        const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
        selected.clear();
        for (const n of notes) {
            const r = NOTES.findIndex(nn => nn.midi === n.midi);
            if (r < 0) continue;
            const nx0 = LABEL_W + n.start * COL_W, nx1 = nx0 + n.dur * COL_W;
            const ny0 = HEADER_H + r * ROW_H, ny1 = ny0 + ROW_H;
            if (nx0 < right && left < nx1 && ny0 < bottom && top < ny1) selected.add(n);
        }
        draw();
    }

    /** Begin moving `note` — and every selected note with it when it is one of them. */
    function beginMove(note, x, y) {
        if (!selected.has(note)) selected.clear();     // grabbing an unselected note drops the selection
        movingNote = note;
        moveStartPos = { x, y };
        moveOriginal = { start: note.start, midi: note.midi, dur: note.dur };
        moveCommitted = false;
        groupMove = selected.size > 1 ? [...selected].map(n => ({ note: n, start: n.start, midi: n.midi })) : null;
    }

    /**
     * Apply a move delta. A group moves as one block: the delta is clamped
     * so that no member leaves the grid, which keeps their spacing intact.
     */
    function applyMoveDelta(colOffset, rowOffset) {
        if (!groupMove) {
            const newStart = Math.max(0, Math.min(totalCols() - movingNote.dur, moveOriginal.start + colOffset));
            const newRow = Math.max(0, Math.min(NOTES.length - 1, NOTES.findIndex(nn => nn.midi === moveOriginal.midi) + rowOffset));
            movingNote.start = newStart;
            movingNote.midi = NOTES[newRow].midi;
            return;
        }
        let minStart = Infinity, maxEnd = -Infinity, minRow = Infinity, maxRow = -Infinity;
        for (const g of groupMove) {
            const r = NOTES.findIndex(nn => nn.midi === g.midi);
            minStart = Math.min(minStart, g.start);
            maxEnd = Math.max(maxEnd, g.start + g.note.dur);
            minRow = Math.min(minRow, r);
            maxRow = Math.max(maxRow, r);
        }
        const dc = Math.max(-minStart, Math.min(totalCols() - maxEnd, colOffset));
        const dr = Math.max(-minRow, Math.min(NOTES.length - 1 - maxRow, rowOffset));
        for (const g of groupMove) {
            g.note.start = g.start + dc;
            g.note.midi = NOTES[NOTES.findIndex(nn => nn.midi === g.midi) + dr].midi;
        }
    }

    /** Put a move back where it started (mouseleave / touchcancel). */
    function restoreMove() {
        if (groupMove) {
            for (const g of groupMove) { g.note.start = g.start; g.note.midi = g.midi; }
        } else if (movingNote && moveOriginal) {
            movingNote.start = moveOriginal.start;
            movingNote.midi = moveOriginal.midi;
        }
    }

    function endMove() {
        movingNote = null;
        moveStartPos = null;
        moveOriginal = null;
        moveCommitted = false;
        groupMove = null;
    }

    function deleteSelected() {
        if (selected.size === 0) return;
        for (const n of selected) {
            const idx = notes.indexOf(n);
            if (idx >= 0) notes.splice(idx, 1);
        }
        selected.clear();
        commitNotes();
    }

    /**
     * Copy: arm the stamp. The selection is taken as a block relative to its
     * top-left cell; a shadow of it follows the pointer from here on, and
     * the next click on the grid puts the copy down (see placeStamp).
     */
    function copySelection() {
        if (selected.size === 0) return false;
        const list = [...selected];
        const minStart = Math.min(...list.map(n => n.start));
        const rowOf = (n) => NOTES.findIndex(nn => nn.midi === n.midi);
        const minRow = Math.min(...list.map(rowOf));
        const maxRow = Math.max(...list.map(rowOf));
        placing = {
            notes: list.map(n => ({ rowOff: rowOf(n) - minRow, start: n.start - minStart, dur: n.dur })),
            span: Math.max(...list.map(n => n.start + n.dur)) - minStart,
            rows: maxRow - minRow + 1,
            col: null, row: null,
        };
        // Hovering already: show the shadow at once rather than on the next move.
        if (lastMousePos) moveStamp(lastMousePos.x, lastMousePos.y);
        else draw();
        return true;
    }

    /** Put the shadow's top-left cell under a canvas point, kept inside the grid. */
    function moveStamp(x, y) {
        if (!placing) return;
        const col = pixelToCol(foldX(x)), row = pixelToRow(y);
        placing.col = Math.max(0, Math.min(totalCols() - Math.min(placing.span, totalCols()), col));
        placing.row = Math.max(0, Math.min(NOTES.length - placing.rows, row));
        draw();
    }

    /**
     * The click: the shadow becomes notes, which become the selection, and
     * the stamp is spent — Copy again (they are selected) to stamp once more.
     * During a step record the cursor moves past what was placed.
     */
    function placeStamp() {
        if (!placing || placing.col == null) return false;
        const at = placing.col, top = placing.row;
        const stamp = placing;
        placing = null;
        ensureActiveTrack();
        selected.clear();
        for (const c of stamp.notes) {
            const start = at + c.start;
            if (start >= totalCols()) continue;
            const n = { midi: NOTES[top + c.rowOff].midi, start, dur: clampDur(start, c.dur) };
            notes.push(n);
            selected.add(n);
        }
        if (stepCol >= 0) seekStep(Math.min(totalCols() - 1, at + stamp.span) % totalCols());
        commitNotes();
        return true;
    }

    onSelectionElsewhere('roll', () => {
        if (!selected.size && !placing) return;
        selected.clear();
        placing = null;
        draw();
    });

    function cancelPlacement() {
        if (!placing) return;
        placing = null;
        draw();
    }

    function setTool(id) {
        const t = toolById(id);
        tool = t.id;
        toolBtn.textContent = t.label;
        toolBtn.title = t.title;
        // Lit whenever the grid does something other than draw.
        toolBtn.classList.toggle('active', tool !== 'edit');
        for (const b of toolModeBtns) b.classList.toggle('active', b.dataset.tool === tool);
        if (tool !== 'erase') endErase();
    }
    setTool('edit');

    /** Back-compat: Select on, Edit off. */
    function setSelectMode(on) {
        setTool(on ? 'select' : 'edit');
    }

    function updateSelectionButtons() {
        // Called from every draw: holding a selection deselects the
        // Section's clips (selection-bus.js), and the reverse is below.
        if (selected.size || placing) selectionMade('roll');
        if (!copyBtn) return;
        for (const b of [copyBtn, copyBtnMobile]) {
            b.disabled = selected.size === 0 && !placing;
            b.classList.toggle('active', !!placing);     // lit while the stamp is armed
        }
    }

    // Keyboard: Delete removes the selection, Escape drops it (or cancels an
    // armed stamp), Ctrl/Cmd+C copies — never while typing in a field.
    function onKeyDown(e) {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (e.target && e.target.isContentEditable) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && (e.key === 'c' || e.key === 'C')) { if (copySelection()) e.preventDefault(); return; }
        if (placing && e.key === 'Escape') { cancelPlacement(); return; }
        if (selected.size === 0) return;
        if (e.key === 'Escape') { clearSelection(); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    }
    document.addEventListener('keydown', onKeyDown);

    // Step record: drag the playhead by its header marker. Only live while
    // the step cursor is shown (the clock is stopped — playCol owns the
    // header otherwise). The toolbar is told so its own cursor follows.
    function seekStep(col) {
        col = Math.max(0, Math.min(totalCols() - 1, col));
        if (col === stepCol) return;
        stepCol = col;
        draw();
        if (opts.onStepSeek) opts.onStepSeek(col);
    }

    function stepSeekTo(x) {
        seekStep(pixelToCol(foldX(x)));
    }

    canvas.addEventListener('mousedown', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const row = pixelToRow(y);
        const col = pixelToCol(x);

        if (col < 0) return;

        // The header strip belongs to the playhead: while a step record is
        // armed it is the cursor's drag handle, and it never draws notes —
        // pixelToRow clamps, so a header click used to land a note on the
        // top row.
        if (y <= HEADER_H) {
            if (stepCol >= 0) {
                seekingPlayhead = true;
                stepSeekTo(x);
            }
            return;
        }

        // An armed stamp: the click is where the copy goes, nothing else.
        if (placing) {
            moveStamp(x, y);
            placeStamp();
            return;
        }

        const now = Date.now();

        // Erase: the press removes the note under it, and the drag that may
        // follow removes every note it crosses (mousemove), committed once
        // on release. Empty grid does nothing — no note is drawn.
        if (tool === 'erase') {
            erasing = true;
            erasedAny = false;
            eraseAt(x, y, findInteractionTarget);
            return;
        }

        const target = findInteractionTarget(x, y);

        // Double-click detection
        if (target && target.note && now - lastClickTime < 350 && row === lastClickRow && Math.abs(col - lastClickCol) <= 1) {
            const idx = notes.indexOf(target.note);
            if (idx >= 0) notes.splice(idx, 1);
            selected.delete(target.note);
            commitNotes();
            lastClickTime = 0;
            return;
        }

        lastClickTime = now;
        lastClickRow = row;
        lastClickCol = col;

        if (target) {
            if (target.side === 'left' || target.side === 'right') {
                resizingNote = target.note;
                resizeSide = target.side;
                moveStartPos = { x, y };
                moveOriginal = { start: target.note.start, dur: target.note.dur };
                moveCommitted = false;
                return;
            }
            beginMove(target.note, x, y);
            return;
        }

        // The step cursor's line is a drag handle along its whole height —
        // after the notes, which keep their say over anything under them.
        if (nearPlayhead(x, PLAYHEAD_GRAB)) {
            seekingPlayhead = true;
            return;
        }

        // Empty grid. With a Select tool (or with Shift) a drag is a
        // marquee; otherwise it draws a note. The rest of the gesture is
        // tracked on the document (see marqueeDocMove) so it survives the
        // canvas edge.
        if (isSelecting() || e.shiftKey) {
            const pt = marqueePoint(x, y);
            marquee = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
            document.addEventListener('mousemove', marqueeDocMove);
            document.addEventListener('mouseup', marqueeDocUp);
            draw();
            return;
        }
        dragging = true;
        dragStart = { row, col };
        lastMousePos = { x, y };
        draw();
    });

    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        lastMousePos = { x, y };

        if (seekingPlayhead) {
            stepSeekTo(x);
            return;
        }

        if (placing) {
            canvas.style.cursor = 'copy';
            if (y > HEADER_H) moveStamp(x, y);
            return;
        }

        if (marquee) return;        // the document handlers own the gesture

        if (erasing) {
            eraseAt(x, y, findInteractionTarget);
            return;
        }

        if (resizingNote && moveStartPos) {
            const dx = x - moveStartPos.x;
            if (!moveCommitted && Math.abs(dx) < MOVE_THRESHOLD) return;
            if (!moveCommitted) canvas.style.cursor = 'ew-resize';
            moveCommitted = true;

            const colDelta = Math.round(dx / COL_W);
            if (resizeSide === 'right') {
                resizingNote.dur = clampDur(moveOriginal.start, moveOriginal.dur + colDelta);
            } else {
                const maxStart = moveOriginal.start + moveOriginal.dur - 1;
                const newStart = Math.max(0, Math.min(maxStart, moveOriginal.start + colDelta));
                const actualDelta = newStart - moveOriginal.start;
                resizingNote.start = newStart;
                resizingNote.dur = moveOriginal.dur - actualDelta;
            }
            draw();
            return;
        }

        if (movingNote && moveStartPos) {
            const dx = x - moveStartPos.x;
            const dy = y - moveStartPos.y;
            if (!moveCommitted && Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) {
                return;
            }
            if (!moveCommitted) {
                canvas.style.cursor = 'grabbing';
            }
            moveCommitted = true;
            applyMoveDelta(Math.round(dx / COL_W), Math.round(dy / ROW_H));
            draw();
            return;
        }

        if (dragging) {
            draw();
            return;
        }

        // Hover cursor
        const target = findInteractionTarget(x, y);
        if (target) {
            if (target.side === 'left' || target.side === 'right') {
                canvas.style.cursor = 'ew-resize';
            } else {
                canvas.style.cursor = 'grab';
            }
        } else if (y > HEADER_H && nearPlayhead(x, PLAYHEAD_GRAB)) {
            canvas.style.cursor = 'ew-resize';
        } else {
            canvas.style.cursor = isSelecting() ? 'cell' : tool === 'erase' ? 'pointer' : 'crosshair';
        }
    });

    canvas.addEventListener('mouseup', (e) => {
        canvas.style.cursor = '';

        if (seekingPlayhead) {
            seekingPlayhead = false;
            return;
        }

        if (marquee) return;        // the document mouseup commits it

        if (erasing) {
            endErase();
            return;
        }

        if (resizingNote) {
            if (moveCommitted) {
                draw();
                onNotesChange();
                saveState();
            } else {
                // Click preview
                const entry = getSlotData(currentSlot());
                const voiceData = entry ? entry.voiceData : null;
                const bpm = getBpm();
                const msPerSixteenth = 60000 / bpm / 4;
                playNoteFn(resizingNote.midi, resizingNote.dur * msPerSixteenth, voiceData, currentSlot());
            }
            resizingNote = null;
            resizeSide = null;
            moveStartPos = null;
            moveOriginal = null;
            moveCommitted = false;
            return;
        }

        if (movingNote) {
            if (moveCommitted) {
                commitNotes();
            } else {
                // Click preview — look up voice data from slot
                const entry = getSlotData(currentSlot());
                const voiceData = entry ? entry.voiceData : null;
                const bpm = getBpm();
                const msPerSixteenth = 60000 / bpm / 4;
                playNoteFn(movingNote.midi, movingNote.dur * msPerSixteenth, voiceData, currentSlot());
            }
            endMove();
            return;
        }

        if (!dragging || !dragStart) {
            dragging = false;
            return;
        }

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const endCol = pixelToCol(x);
        const endRow = pixelToRow(y);

        if (endRow === dragStart.row) {
            const minC = Math.min(dragStart.col, endCol);
            const maxC = Math.max(dragStart.col, endCol);
            const dur = maxC - minC + 1;
            const midi = NOTES[dragStart.row].midi;

            ensureActiveTrack();
            notes.push({ midi, start: minC, dur });
            commitNotes();
        }

        dragging = false;
        dragStart = null;
        lastMousePos = null;
        draw();
    });

    canvas.addEventListener('mouseleave', () => {
        endErase();
        canvas.style.cursor = '';
        // A seek is already committed as it moves; just stop following.
        // (A live marquee is NOT cancelled: it is a document-level drag.)
        seekingPlayhead = false;
        // The stamp stays armed; its shadow just leaves with the pointer.
        if (placing) { placing.col = null; placing.row = null; draw(); }
        if (resizingNote && moveOriginal) {
            resizingNote.dur = moveOriginal.dur;
            resizingNote.start = moveOriginal.start;
            resizingNote = null;
            resizeSide = null;
            moveStartPos = null;
            moveOriginal = null;
            moveCommitted = false;
            draw();
        }
        if (movingNote && moveOriginal) {
            restoreMove();
            endMove();
            draw();
        }
        if (dragging) {
            dragging = false;
            dragStart = null;
            lastMousePos = null;
            draw();
        }
    });

    // --- Touch events for mobile ---
    function findInteractionTargetTouch(x, y) {
        x = foldX(x);
        const row = pixelToRow(y);
        if (row < 0 || row >= NOTES.length) return null;
        const midi = NOTES[row].midi;
        const candidates = notes.filter(n => n.midi === midi);
        for (const n of candidates) {
            const startX = LABEL_W + n.start * COL_W;
            const endX = LABEL_W + (n.start + n.dur) * COL_W;
            if (Math.abs(x - endX) <= TOUCH_RESIZE_MARGIN) return { note: n, side: 'right' };
            if (Math.abs(x - startX) <= TOUCH_RESIZE_MARGIN) return { note: n, side: 'left' };
            if (x > startX && x < endX) return { note: n, side: 'move' };
        }
        return null;
    }

    let lastTapTime = 0;
    let longPressTimer = null;
    let longPressPos = null;
    let isTouchScrolling = false;
    let touchScrollStart = null;

    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const touch = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;
        const row = pixelToRow(y);
        const col = pixelToCol(x);

        if (col < 0) return;

        // The header strip is the step cursor's handle on touch as well; it
        // never draws (pixelToRow clamps, so a header tap used to land a
        // note on the top row).
        if (y <= HEADER_H) {
            if (stepCol >= 0) {
                seekingPlayhead = true;
                stepSeekTo(x);
            }
            return;
        }

        // An armed stamp: the finger carries the shadow; lifting it places.
        if (placing) {
            moveStamp(x, y);
            return;
        }

        const now = Date.now();

        if (tool === 'erase') {
            erasing = true;
            erasedAny = false;
            eraseAt(x, y, findInteractionTargetTouch);
            return;
        }

        const target = findInteractionTargetTouch(x, y);
        const isStopped = !playing && !looping;

        // Double-tap detection
        if (target && target.note && now - lastTapTime < 400 && row === lastClickRow && Math.abs(col - lastClickCol) <= 1) {
            const idx = notes.indexOf(target.note);
            if (idx >= 0) notes.splice(idx, 1);
            selected.delete(target.note);
            commitNotes();
            lastTapTime = 0;
            return;
        }
        lastTapTime = now;
        lastClickRow = row;
        lastClickCol = col;

        // Existing note interactions (resize/move) — always active
        if (target) {
            if (target.side === 'left' || target.side === 'right') {
                resizingNote = target.note;
                resizeSide = target.side;
                moveStartPos = { x, y };
                moveOriginal = { start: target.note.start, dur: target.note.dur };
                moveCommitted = false;
                return;
            }
            beginMove(target.note, x, y);
            return;
        }

        // The step cursor's line, grabbed anywhere along it — notes first.
        if (nearPlayhead(x, TOUCH_PLAYHEAD_GRAB)) {
            seekingPlayhead = true;
            return;
        }

        // A Select tool: a drag on empty grid is a marquee, a tap drops the
        // selection. No document handlers here: a touch keeps streaming to
        // the element it started on even outside its bounds.
        if (isSelecting()) {
            const pt = marqueePoint(x, y);
            marquee = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
            draw();
            return;
        }

        // Empty space — when stopped: long-press to create, drag to scroll
        if (isStopped) {
            longPressPos = { x, y, row, col };
            longPressTimer = setTimeout(() => {
                // 1 second hold — create note
                longPressTimer = null;
                longPressPos = null;
                const midi = NOTES[row].midi;
                ensureActiveTrack();
                notes.push({ midi, start: col, dur: 1 });
                draw();
                renderLegend();
                onNotesChange();
                saveState();
            }, 1000);
            return;
        }

        // Playing/recording — original drag-to-create behavior
        dragging = true;
        dragStart = { row, col };
        lastMousePos = { x, y };
        draw();
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const touch = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;
        lastMousePos = { x, y };

        if (seekingPlayhead) {
            stepSeekTo(x);
            return;
        }

        if (placing) {
            if (y > HEADER_H) moveStamp(x, y);
            return;
        }

        if (marquee) {
            const pt = marqueePoint(x, y);
            marquee.x1 = pt.x;
            marquee.y1 = pt.y;
            draw();
            return;
        }

        if (erasing) {
            eraseAt(x, y, findInteractionTargetTouch);
            return;
        }

        // Long-press pending — check if moved (scroll instead)
        if (longPressTimer && longPressPos) {
            const dx = x - longPressPos.x;
            const dy = y - longPressPos.y;
            if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
                isTouchScrolling = true;
                touchScrollStart = { sx: scroll.scrollLeft, sy: scroll.scrollTop, x, y };
            }
            return;
        }

        // Active touch scrolling
        if (isTouchScrolling && touchScrollStart) {
            const dx = touchScrollStart.x - x;
            const dy = touchScrollStart.y - y;
            scroll.scrollLeft = touchScrollStart.sx + dx;
            scroll.scrollTop = touchScrollStart.sy + dy;
            return;
        }

        if (resizingNote && moveStartPos) {
            const dx = x - moveStartPos.x;
            if (!moveCommitted && Math.abs(dx) < MOVE_THRESHOLD) return;
            moveCommitted = true;
            const colDelta = Math.round(dx / COL_W);
            if (resizeSide === 'right') {
                resizingNote.dur = clampDur(moveOriginal.start, moveOriginal.dur + colDelta);
            } else {
                const maxStart = moveOriginal.start + moveOriginal.dur - 1;
                const newStart = Math.max(0, Math.min(maxStart, moveOriginal.start + colDelta));
                const actualDelta = newStart - moveOriginal.start;
                resizingNote.start = newStart;
                resizingNote.dur = moveOriginal.dur - actualDelta;
            }
            draw();
            return;
        }

        if (movingNote && moveStartPos) {
            const dx = x - moveStartPos.x;
            const dy = y - moveStartPos.y;
            if (!moveCommitted && Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return;
            moveCommitted = true;
            applyMoveDelta(Math.round(dx / COL_W), Math.round(dy / ROW_H));
            draw();
            return;
        }

        if (dragging) {
            draw();
        }
    }, { passive: false });

    // The browser took the touch (call, system gesture, scroll handoff).
    // Nothing is committed: pending moves/resizes snap back, as on mouseleave.
    canvas.addEventListener('touchcancel', () => {
        if (longPressTimer) clearTimeout(longPressTimer);
        longPressTimer = null;
        longPressPos = null;
        isTouchScrolling = false;
        touchScrollStart = null;
        if (resizingNote && moveOriginal) {
            resizingNote.dur = moveOriginal.dur;
            resizingNote.start = moveOriginal.start;
        }
        if (movingNote && moveOriginal) restoreMove();
        seekingPlayhead = false;
        marquee = null;
        resizingNote = null;
        resizeSide = null;
        endMove();
        dragging = false;
        dragStart = null;
        lastMousePos = null;
        draw();
    });

    canvas.addEventListener('touchend', (e) => {
        e.preventDefault();

        // Cancel long press if still pending
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
            longPressPos = null;
        }
        isTouchScrolling = false;
        touchScrollStart = null;

        if (seekingPlayhead) {
            seekingPlayhead = false;
            return;
        }

        if (placing) {
            placeStamp();
            return;
        }

        if (marquee) {
            commitMarquee();
            return;
        }

        if (erasing) {
            endErase();
            return;
        }

        if (resizingNote) {
            if (moveCommitted) {
                draw();
                onNotesChange();
                saveState();
            }
            resizingNote = null;
            resizeSide = null;
            moveStartPos = null;
            moveOriginal = null;
            moveCommitted = false;
            return;
        }

        if (movingNote) {
            if (moveCommitted) commitNotes();
            endMove();
            return;
        }

        if (!dragging || !dragStart) {
            dragging = false;
            return;
        }

        const endCol = lastMousePos ? pixelToCol(lastMousePos.x) : dragStart.col;
        const endRow = lastMousePos ? pixelToRow(lastMousePos.y) : dragStart.row;

        if (endRow === dragStart.row) {
            const minC = Math.min(dragStart.col, endCol);
            const maxC = Math.max(dragStart.col, endCol);
            const dur = maxC - minC + 1;
            const midi = NOTES[dragStart.row].midi;
            ensureActiveTrack();
            notes.push({ midi, start: minC, dur });
            draw();
            renderLegend();
            onNotesChange();
            saveState();
        }

        dragging = false;
        dragStart = null;
        lastMousePos = null;
        draw();
    }, { passive: false });

    // --- Transport (the clock is the transport's; this is the view) ---

    function startPlayback() {
        // Play from the roll loops the pattern being edited — the section,
        // confined to this pattern's nearest placement, so the other
        // tracks play along. Record does the same; the Section tab's Play
        // is the whole-section one.
        // Rewind the view only when it is following; otherwise the user
        // owns the scroll position and yanking it would undo whatever
        // they were looking at.
        // The toolbar may claim the press first: Play during a step record
        // turns it into a live take rather than playing over it.
        if (opts.onBeforePlay && opts.onBeforePlay()) return;
        if (transport.play({ mode: 'pattern' }) && followPlayhead) scroll.scrollLeft = LABEL_W;
    }

    function stopPlayback() {
        transport.stop();
    }

    /**
     * Every tick, and every start/stop: the transport says where it is and
     * the roll is purely a view of that. `edit` is the position inside the
     * pattern on screen — absent when the section's playhead is somewhere this
     * pattern is not placed, and then there is no playhead to draw.
     */
    transport.subscribe((pos) => {
        playing = pos.playing;
        recordingActive = pos.recording;
        waitingForClock = !!pos.waiting;
        looping = pos.playing || pos.recording;
        // Armed for an external clock counts as "going" for the buttons —
        // Stop is how you take it back — but not for the drawing.
        playCol = pos.edit ? pos.edit.patternCol : -1;

        if (!looping) {
            scroll.scrollLeft = scroll.scrollLeft % gridWidth();
            draw();
            return;
        }
        draw();
        if (!followPlayhead || playCol < 0) return;
        // Recomputed each tick: measures change under us (loadState, +/- Msr)
        const gw = gridWidth();
        scroll.scrollLeft = LABEL_W + playCol * COL_W;
        if (scroll.scrollLeft >= LABEL_W + gw) scroll.scrollLeft -= gw;
    });

    // --- Tick Worker Handler ---
    // (gone: the transport owns the worker subscription now)

    clearBtn.addEventListener('click', clearPattern);
    clearBtnDesktop.addEventListener('click', clearPattern);

    // Clear empties the pattern on screen and nothing else: its notes go and
    // it shrinks back to one measure. The tracks, the patches on them and
    // the section's clips are the project's, not the roll's — a clip of the
    // cleared pattern stays where it is, now one bar of silence.
    function clearPattern() {
        notes.length = 0;   // `notes` is the edited pattern's own array
        setMeasures(1);
        updateMeasureButtons();
        draw();
        renderLegend();
        onNotesChange();
        saveState();
    }

    function renderLegend() {
        renderPatternSelect();
        legend.innerHTML = '';
        if (tracks.length === 0) {
            legend.style.display = 'none';
            return;
        }
        legend.style.display = '';
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const item = document.createElement('span');
            // The edited track is marked: with ghosts on screen the user
            // needs to know which notes answer to the mouse.
            item.className = 'pianoroll-legend-item' + (i === activeTrackIdx ? ' active' : '');
            const dot = document.createElement('span');
            dot.className = 'pianoroll-legend-dot';
            dot.style.background = slotColor(track.slot);
            item.appendChild(dot);
            const name = document.createElement('span');
            name.textContent = slotName(track.slot);
            item.appendChild(name);
            // The edited pattern's name, renamable in place: the roll is
            // where a pattern is made, so it should not take a trip to the
            // Section tab to call it something.
            if (i === activeTrackIdx && track.pattern) item.appendChild(patternNameField(track));
            legend.appendChild(item);
        }
    }

    function patternNameField(track) {
        const pattern = track.pattern;
        const field = document.createElement('span');
        field.className = 'pianoroll-legend-pattern';
        field.textContent = pattern.name;
        field.title = 'Pattern name — click to rename';
        field.addEventListener('click', (e) => {
            e.stopPropagation();
            if (field.contentEditable === 'true') return;
            field.contentEditable = 'true';
            field.focus();
        });
        field.addEventListener('blur', () => {
            if (field.contentEditable !== 'true') return;
            field.contentEditable = 'false';
            const v = String(field.textContent).trim();
            if (v && v !== pattern.name) {
                pattern.name = v;
                saveState([pattern]);
            }
            renderLegend();
        });
        field.addEventListener('keydown', (e) => {
            e.stopPropagation();   // document-level shortcuts (Delete on the Section tab) must not see typing
            if (e.key === 'Enter') { e.preventDefault(); if (field.blur) field.blur(); }
            if (e.key === 'Escape') { field.textContent = pattern.name; field.contentEditable = 'false'; }
        });
        return field;
    }

    // Load persisted state
    loadState();
    draw();
    renderLegend();

    const api = {
        element: container,
        draw,
        startPlayback,
        stopPlayback,
        /** Also true while armed for an external clock: the toolbar's Play/Stop toggle must be able to disarm. */
        isPlaying() { return playing || waitingForClock; },
        isFollowing() { return followPlayhead; },
        setFollowPlayhead,
        /** Select the voice slot being edited — its track becomes active. */
        setActiveSlot(slot) {
            opts.activeSlot = slot;
            selectSlot(slot);
            draw();
            renderLegend();
        },
        /**
         * Insert a note on `slot`'s track (the recorder names the slot it
         * recorded on, which need not be the one being edited).
         */
        addNote({ midi, start, dur, slot, clipId, reveal }) {
            const target = slot != null ? slot : currentSlot();
            // The recorder names the clip when the section's playhead is over
            // one; otherwise the voice's own track takes the note.
            let track = clipId ? tracks.find(t => t.clipId === clipId) : null;
            if (!track || !track.pattern) track = ensureTrackForSlot(target);
            selectSlot(currentSlot());
            const note = { midi, start, dur };
            track.pattern.notes.push(note);
            draw();
            renderLegend();
            if (onNotesChange) onNotesChange();
            saveState([track.pattern]);
            // Stopped: bring the new note to the centre. Recording: the
            // horizontal position is the follow-scroll's (or the user's), so
            // only nudge vertically, and only if the note is off screen.
            // `reveal: 'row'` (the step record) centres the row every time
            // and scrolls sideways only if the column is out of view.
            if (reveal === 'row') { this.centerRow(midi); this.revealCol(start); }
            else if (looping) this.revealRow(midi);
            else this.scrollTo(start, midi);
            return note;
        },
        /**
         * Scroll vertically so `midi`'s row is centred — but only when the
         * row is outside the viewport. A note already in view must not
         * move the grid under a user who is playing it.
         */
        revealRow(midi) {
            const row = NOTES.findIndex(n => n.midi === midi);
            if (row < 0) return false;
            const y = HEADER_H + row * ROW_H;
            const top = scroll.scrollTop;
            const bottom = top + scroll.clientHeight;
            if (y >= top && y + ROW_H <= bottom) return false;
            scroll.scrollTop = Math.max(0, y + ROW_H / 2 - scroll.clientHeight / 2);
            return true;
        },
        /**
         * Change a note's length in place — the step record grows a held
         * note a sixteenth at a time. Saved like any edit; no clamping
         * here, the caller knows the pattern's end.
         */
        setNoteDur(note, dur) {
            const owner = tracks.find(t => t.pattern && t.pattern.notes.indexOf(note) >= 0);
            if (!owner || !(dur >= 1) || note.dur === dur) return false;
            note.dur = dur;
            draw();
            if (onNotesChange) onNotesChange();
            saveState([owner.pattern]);
            return true;
        },
        /**
         * Park the step record's cursor at a pattern column, or hide it
         * with -1. Drawn exactly like the playhead, which takes over
         * whenever the clock runs.
         */
        // Selection, for the tests and the toolbar.
        getSelectedNotes() { return [...selected]; },
        selectNotes(list) { selected.clear(); for (const n of list) if (notes.includes(n)) selected.add(n); draw(); },
        clearSelection() { clearSelection(); },
        deleteSelected() { deleteSelected(); },
        copySelection() { return copySelection(); },
        isPlacing() { return !!placing; },
        /** The shadow's top-left cell, or null while the pointer is off-grid / nothing is armed. */
        getPlacement() { return placing && placing.col != null ? { col: placing.col, row: placing.row } : null; },
        cancelPlacement() { cancelPlacement(); },
        setSelectMode(on) { setSelectMode(on); },
        isSelectMode() { return isSelecting(); },
        /** The grid tool: 'edit' | 'select-once' | 'select' | 'erase'. */
        setTool(id) { setTool(id); },
        getTool() { return tool; },
        setStepCursor(col) {
            stepCol = col >= 0 ? col : -1;
            draw();
            if (stepCol >= 0) this.revealCol(stepCol);
        },
        getStepCursor() { return stepCol; },
        // Programmatic twin of the header drag: moves the step cursor and
        // reports it through the same onStepSeek callback. No-op unless a
        // step record is showing the cursor.
        seekStep(col) { if (stepCol >= 0) seekStep(col); },
        /** { trackId, clipId, pattern, slot } for the pattern on screen, or null. */
        getEditTarget() { return editTarget(); },
        /** Scroll vertically so `midi`'s row is centred, whether or not it was in view. */
        centerRow(midi) {
            const row = NOTES.findIndex(n => n.midi === midi);
            if (row < 0) return false;
            const y = HEADER_H + row * ROW_H;
            scroll.scrollTop = Math.max(0, y + ROW_H / 2 - scroll.clientHeight / 2);
            return true;
        },
        /** Scroll sideways to centre column `col`, but only when it is out of view. */
        revealCol(col) {
            const x = LABEL_W + col * COL_W;
            const left = scroll.scrollLeft;
            const right = left + scroll.clientWidth;
            if (x >= left + LABEL_W && x + COL_W <= right) return false;
            scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 2);
            return true;
        },
        removeNote(note) {
            // Undo may reach a note on another track — search them all.
            const owner = tracks.find(t => t.pattern && t.pattern.notes.indexOf(note) >= 0);
            const list = owner ? owner.pattern.notes : notes;
            const idx = list.indexOf(note);
            if (idx >= 0) {
                list.splice(idx, 1);
                draw();
                renderLegend();
                if (onNotesChange) onNotesChange();
                saveState(owner ? [owner.pattern] : undefined);
            }
        },
        scrollTo(col, midi) {
            const row = NOTES.findIndex(n => n.midi === midi);
            const x = LABEL_W + col * COL_W;
            const y = row >= 0 ? HEADER_H + row * ROW_H : 0;
            if (looping) {
                scroll.scrollLeft = x;
            } else {
                scroll.scrollTo({
                    left: Math.max(0, x - scroll.clientWidth / 2),
                    top: Math.max(0, y - scroll.clientHeight / 2),
                    behavior: 'smooth',
                });
            }
        },
        scrollToCol(col) {
            // The recorder calls this every tick; it is the recording-side
            // twin of the follow-scroll in handlePlaybackTick.
            if (!followPlayhead) return;
            if (!looping) {
                const x = LABEL_W + col * COL_W;
                scroll.scrollTo({
                    left: Math.max(0, x - scroll.clientWidth / 2),
                    behavior: 'smooth',
                });
                return;
            }
            const gw = gridWidth();
            const target = LABEL_W + (col * COL_W % gw);
            scroll.scrollLeft = target;
        },
        startRecording() {
            // A take from the roll loops the pattern window, like Play.
            transport.startRecording({ mode: 'pattern' });
        },
        stopRecording() {
            transport.stop();
            for (const { note } of allNotes()) delete note._recordedInSession;
        },
        clearRecordingFlags() {
            for (const { note } of allNotes()) delete note._recordedInSession;
        },
        /** The edited pattern's notes (no slot — the track carries it). */
        getNotes() { return notes; },
        /** The pattern under the cursor, for the Section editor in phase 4. */
        getPattern() { return activeTrackIdx >= 0 ? tracks[activeTrackIdx].pattern : null; },
        getTracks() {
            return tracks.map(t => ({ id: t.id, slot: t.slot, clipId: t.clipId, patternId: t.pattern ? t.pattern.id : null }));
        },
        /**
         * Edit the pattern of a specific clip (the Section editor's "open").
         * Selects the clip's track and voice; returns false for a stale id.
         */
        openClip(clipId) {
            const project = session.get();
            const section = session.getSection();
            const clip = section && section.clips.find(c => c.id === clipId);
            const track = clip && project.tracks.find(t => t.id === clip.trackId);
            if (!track) return false;
            openClipId = clipId;
            opts.activeSlot = track.slot;
            adoptProject(project);
            updateMeasureButtons();
            scroll.scrollLeft = 0;
            draw();
            renderLegend();
            return true;
        },
        getSession() { return session; },
        getTransport() { return transport; },
        getMode() { return transport.getMode(); },
        setMode(m) { transport.setMode(m); },
        getAccompany() { return transport.getAccompany(); },
        setAccompany(on) { transport.setAccompany(on); updateAccompanyButton(); },
        getBpm,
        /** Switch the roll to a pattern by id (see the Pattern select). */
        switchToPattern,
        /**
         * Every note across every track, flattened and slot-tagged.
         * Nothing in the app needs this — the tests do, for assertions
         * that span tracks, which is otherwise a nested walk at every
         * call site. (It is the shape the long-gone song bar spoke.)
         */
        getAllNotes() {
            const flat = [];
            for (const t of tracks) {
                if (!t.pattern) continue;
                for (const n of t.pattern.notes) {
                    flat.push({ midi: n.midi, start: n.start, dur: n.dur, slot: t.slot });
                }
            }
            return { notes: flat, bpm: getBpm(), measures };
        },
        /**
         * Replace the sequencer state wholesale. Validates like loadState()
         * — the data comes from storage and may be stale or hand-edited.
         */
        totalCols() { return totalCols(); },
        renderLegend,
        saveState,
    };
    return api;
}
