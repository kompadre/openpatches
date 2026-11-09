// Tracker — the Section editor on steroids, as a main tab.
//
// Rows are the edited section's sixteenths (time runs down, like the
// Section pane), columns are the project's tracks, and each track splits
// into monophonic sub-lanes — *expanded* (a sub-lane per concurrent note)
// or *compact* (one column; a cell holding several events shows the first
// plus `+n`, the rest in a tooltip). Clips show as blocks in their
// pattern's colour, subdued. The gap right of each track is the clip's
// margin: a ✎ on the clip's first row (Edit in the Pattern editor,
// repeats, + Bar to pattern) and, under it, the pattern's name reading
// downward.
//
// **Editing** (FT2-style). Click a cell or focus the grid, then:
//   Z-row / Q-row          notes, as a piano (Z = C of the octave, Q = C above)
//   1                      OFF       Delete / Backspace   clear the cell
//   arrows, PgUp/PgDn, Home/End, Tab / Shift-Tab           move
//   Numpad + / −           octave
// The cursor advances by the edit step after an entry. A note is heard on
// its track's voice as it goes in. Typing where the track has no clip
// refuses with a message. **Double-click empty space** in a track to make a
// new one-bar pattern there, or drag one in from the Section pane's
// library (`dropPattern`, called by the library's drag); grow it here with
// the ✎ or by dragging a note down past the pattern's end.
// The active track shows one spare sub-lane when expanded, so a chord can
// be typed one note at a time.
//
// **Commits are debounced.** An edit changes the pattern object at once
// (the tracker redraws, every placement of the pattern with it, and the
// transport re-snapshots so it is heard), marks the pattern dirty, and the
// commit — a fresh lane derivation (fewest lanes) and the session event
// the roll, the Section pane and autosave listen to — waits for 3 s of
// quiet, so lanes do not reshuffle under the cursor while typing. Leaving
// the tab or the page commits at once.
//
// All drawing is one canvas (a section is hundreds of rows × up to eight
// tracks of text cells; DOM cells at that scale are what the piano roll
// already refused). The playhead is a DOM line over it, moved on each
// tick, so playback does not redraw the world.

import {
    expandTrack, compactCells, noteName, locate, MAX_LANES,
    putNote, putOff, clearCell, relane, growBlocker, measuresFor, moveNote,
} from './tracker-model.js';
import {
    COLS_PER_MEASURE, updateClip, clipRepeats, sectionLength, addClip,
} from './project-model.js';

const ROW_H = 16;
const LANE_W = 46;
const GAP_W = 18;        // between tracks: the ✎ and the pattern's name live here
const RULER_W = 36;
const HEAD_H = 26;
const MIN_MEASURES = 4;  // never a zero-height grid
const COMMIT_MS = 3000;  // quiet time before an edited pattern is committed
const FOLLOW_KEY = 'openpatches_tracker_follow';

const DEFAULT_COLORS = ['#e94560', '#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4', '#ff5722', '#607d8b'];

// FT2's two-row piano, by physical key (layout-independent): semitones
// from the C of the current octave.
const NOTE_KEYS = {
    KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8,
    KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
    KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19,
    Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27,
    KeyP: 28, BracketLeft: 29, Equal: 30, BracketRight: 31,
};

export function createTracker(opts) {
    const { session, transport } = opts;
    const log = opts.log || (() => {});

    let activeSlot = 0;
    let shown = false;
    let layout = [];          // per track: { track, x, w, lanes, viewLanes, blocks, events, cells }
    let rows = MIN_MEASURES * COLS_PER_MEASURE;
    let followPlayhead = false;
    try { followPlayhead = localStorage.getItem(FOLLOW_KEY) === '1'; } catch { /* view pref only */ }

    const cursor = { slot: 0, lane: 0, col: 0 };
    let focused = false;
    let octave = 4;
    let step = 1;
    const dirty = new Map();  // patternId → pattern, awaiting commit
    let commitTimer = null;
    let drag = null;          // { event, track, row } while a note is dragged

    // --- DOM ---

    const container = document.createElement('div');
    container.className = 'tracker-container';

    const controls = document.createElement('div');
    controls.className = 'tracker-controls';

    function selectField(label, cls, values, value, onPick) {
        const wrap = document.createElement('label');
        wrap.className = 'tracker-field';
        wrap.textContent = label + ' ';
        const sel = document.createElement('select');
        sel.className = cls;
        for (const v of values) {
            const o = document.createElement('option');
            o.value = String(v);
            o.textContent = String(v);
            sel.appendChild(o);
        }
        sel.value = String(value);
        sel.addEventListener('change', () => onPick(Number(sel.value)));
        wrap.appendChild(sel);
        controls.appendChild(wrap);
        return sel;
    }
    const octaveSel = selectField('Octave', 'tracker-octave', [0, 1, 2, 3, 4, 5, 6, 7, 8], octave,
        (v) => { octave = v; });
    selectField('Step', 'tracker-step', [0, 1, 2, 3, 4, 8, 16], step, (v) => { step = v; });

    const followBtn = document.createElement('button');
    followBtn.className = 'tracker-btn tracker-follow' + (followPlayhead ? ' active' : '');
    followBtn.textContent = '⇩ Follow';
    followBtn.title = 'Scroll with the playhead';
    followBtn.addEventListener('click', () => {
        followPlayhead = !followPlayhead;
        followBtn.classList.toggle('active', followPlayhead);
        try { localStorage.setItem(FOLLOW_KEY, followPlayhead ? '1' : '0'); } catch { /* ignore */ }
    });
    controls.appendChild(followBtn);
    const status = document.createElement('span');
    status.className = 'tracker-status';
    controls.appendChild(status);
    container.appendChild(controls);

    const scroll = document.createElement('div');
    scroll.className = 'tracker-scroll';
    container.appendChild(scroll);

    const inner = document.createElement('div');
    inner.className = 'tracker-inner';
    scroll.appendChild(inner);

    const heads = document.createElement('div');
    heads.className = 'tracker-heads';
    inner.appendChild(heads);

    const canvas = document.createElement('canvas');
    canvas.className = 'tracker-canvas';
    canvas.tabIndex = 0;
    canvas.title = '';
    inner.appendChild(canvas);

    const playheadEl = document.createElement('div');
    playheadEl.className = 'tracker-playhead';
    playheadEl.style.display = 'none';
    inner.appendChild(playheadEl);

    // --- Helpers ---

    function say(msg) { status.textContent = msg; }

    function slotData(slot) { return opts.getSlotData ? opts.getSlotData(slot) : null; }

    function slotColor(slot) {
        const entry = slotData(slot);
        if (entry && entry.color) return entry.color;
        return DEFAULT_COLORS[slot % DEFAULT_COLORS.length];
    }

    function tint(hex, alpha) {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }

    const trackAt = (x) => layout.find(t => x >= t.x && x < t.x + t.w) || null;
    const bySlot = (slot) => layout.find(t => t.track.slot === slot) || null;

    /** The ✎ hotspots: one per clip block, in the gap right of its track. */
    let pencils = [];   // { x, y, w, h, track, block }

    // --- Layout + draw ---

    function rebuild() {
        const project = session.get();
        const section = session.getSection();
        layout = [];
        if (!project || !section) return;

        rows = Math.max(MIN_MEASURES, sectionLength(project, section)) * COLS_PER_MEASURE;
        let x = RULER_W;
        for (const track of [...project.tracks].sort((a, b) => a.slot - b.slot)) {
            const r = expandTrack(project, section, track);
            // The active track gets one spare sub-lane to type a chord into.
            const spare = !track.compact && track.slot === activeSlot && r.lanes < MAX_LANES ? 1 : 0;
            const viewLanes = track.compact ? 1 : r.lanes + spare;
            const t = { track, x, viewLanes, w: viewLanes * LANE_W, ...r };
            t.cells = track.compact ? compactCells(t.events) : null;
            layout.push(t);
            x += t.w + GAP_W;
        }
        inner.style.width = x + 'px';
        inner.style.height = (HEAD_H + rows * ROW_H) + 'px';
        clampCursor();
    }

    function renderHeads() {
        heads.innerHTML = '';
        const corner = document.createElement('div');
        corner.className = 'tracker-corner';
        corner.textContent = 'Row';
        heads.appendChild(corner);
        for (const t of layout) {
            const head = document.createElement('div');
            head.className = 'tracker-head' + (t.track.slot === activeSlot ? ' active' : '');
            head.style.left = t.x + 'px';
            head.style.width = t.w + 'px';
            const name = document.createElement('button');
            name.className = 'tracker-head-name';
            name.style.color = slotColor(t.track.slot);
            name.textContent = (t.track.slot + 1) + ' ' + t.track.name;
            name.title = 'Make this the active voice';
            name.addEventListener('click', () => selectTrack(t.track.slot));
            head.appendChild(name);
            const mode = document.createElement('button');
            mode.className = 'tracker-mode';
            mode.textContent = t.track.compact ? '▣' : '▥';
            mode.title = t.track.compact
                ? 'Compact: one column, chords folded into a cell — click to expand'
                : 'Expanded: a sub-lane per concurrent note — click to fold';
            mode.addEventListener('click', () => {
                session.update((project) => {
                    const tr = project.tracks.find(o => o.id === t.track.id);
                    if (!tr) return;
                    if (tr.compact) delete tr.compact; else tr.compact = true;
                }, 'tracker');
            });
            head.appendChild(mode);
            heads.appendChild(head);
        }
    }

    function draw() {
        const w = Math.max(inner.offsetWidth, RULER_W + 1);
        const h = rows * ROW_H;
        canvas.width = w;
        canvas.height = h;
        canvas.style.top = HEAD_H + 'px';
        const ctx = canvas.getContext('2d');
        pencils = [];
        if (!ctx) return;

        ctx.fillStyle = '#101020';
        ctx.fillRect(0, 0, w, h);

        // Row shading and the ruler. Every 4th row lifted, bar rows lined.
        ctx.font = '10px monospace';
        ctx.textBaseline = 'middle';
        for (let r = 0; r < rows; r++) {
            const y = r * ROW_H;
            if (r % 4 === 0) {
                ctx.fillStyle = r % COLS_PER_MEASURE === 0 ? 'rgba(255,255,255,0.055)' : 'rgba(255,255,255,0.025)';
                ctx.fillRect(0, y, w, ROW_H);
            }
            if (r % COLS_PER_MEASURE === 0) {
                ctx.strokeStyle = 'rgba(255,255,255,0.14)';
                ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
                ctx.fillStyle = '#9ab';
                ctx.fillText(String(r / COLS_PER_MEASURE + 1), 4, y + ROW_H / 2);
            } else {
                ctx.fillStyle = '#445';
                ctx.fillText(String(r % COLS_PER_MEASURE).padStart(2, '0'), 4, y + ROW_H / 2);
            }
        }

        for (const t of layout) drawTrack(ctx, t);

        const active = bySlot(activeSlot);
        if (active) {
            ctx.fillStyle = 'rgba(233, 69, 96, 0.05)';
            ctx.fillRect(active.x, 0, active.w, h);
        }
        drawCursor(ctx);
        drawDrag(ctx);
        reportViewport();
    }

    function drawTrack(ctx, t) {
        // Lane separators, faint; the spare lane (if any) a shade darker.
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        for (let l = 0; l <= t.viewLanes; l++) {
            const x = t.x + l * LANE_W;
            ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, rows * ROW_H); ctx.stroke();
        }
        if (t.viewLanes > t.lanes && !t.track.compact) {
            ctx.fillStyle = 'rgba(0,0,0,0.18)';
            ctx.fillRect(t.x + t.lanes * LANE_W, 0, LANE_W, rows * ROW_H);
        }

        for (const b of t.blocks) {
            const y = b.startCol * ROW_H;
            const bh = (b.endCol - b.startCol) * ROW_H;
            ctx.fillStyle = tint(b.pattern.color, 0.13);
            ctx.fillRect(t.x, y, t.w, bh);
            // The clip's start, as a line in the pattern's colour.
            ctx.fillStyle = tint(b.pattern.color, 0.7);
            ctx.fillRect(t.x, y, t.w, 2);

            // Repeat seams, so a 3× clip reads as three passes.
            const len = b.pattern.measures * COLS_PER_MEASURE;
            ctx.strokeStyle = tint(b.pattern.color, 0.4);
            for (let c = b.startCol + len; c < b.endCol; c += len) {
                ctx.beginPath(); ctx.moveTo(t.x, c * ROW_H + 0.5); ctx.lineTo(t.x + t.w, c * ROW_H + 0.5); ctx.stroke();
            }

            // The margin: ✎ on the first row, the name reading down under it.
            const gx = t.x + t.w;
            ctx.fillStyle = tint(b.pattern.color, 0.22);
            ctx.fillRect(gx + 2, y, GAP_W - 4, bh);
            ctx.fillStyle = '#cdd';
            ctx.fillText('✎', gx + 3, y + ROW_H / 2);
            pencils.push({ x: gx, y, w: GAP_W, h: ROW_H, track: t, block: b });
            const room = bh - ROW_H - 4;
            if (room > 12) {
                ctx.save();
                ctx.translate(gx + GAP_W / 2, y + ROW_H + 2);
                ctx.rotate(Math.PI / 2);
                ctx.font = 'bold 9px sans-serif';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = '#ddd';
                ctx.fillText(clipName(b), 0, 0, room);
                ctx.restore();
                ctx.font = '10px monospace';
            }
        }

        if (t.track.compact) drawCompact(ctx, t);
        else drawExpanded(ctx, t);
    }

    function clipName(b) {
        const r = clipRepeats(b.clip, b.pattern);
        return b.pattern.name + (r !== 1 ? ' ×' + (Number.isInteger(r) ? r : r.toFixed(2)) : '');
    }

    function drawExpanded(ctx, t) {
        for (const e of t.events) {
            const x = t.x + e.lane * LANE_W + 4;
            ctx.fillStyle = drag && drag.event === e ? '#666' : '#e8e8f0';
            ctx.fillText(noteName(e.midi), x, e.col * ROW_H + ROW_H / 2);
            if (e.off) {
                ctx.fillStyle = '#667';
                ctx.fillText('OFF', x, e.end * ROW_H + ROW_H / 2);
            }
        }
    }

    function drawCompact(ctx, t) {
        for (const [col, cell] of t.cells) {
            const n = cell.starts.length + cell.offs.length;
            if (n === 0) continue;
            const first = cell.starts[0];
            const label = (first ? noteName(first.midi) : 'OFF') + (n > 1 ? ' +' + (n - 1) : '');
            ctx.fillStyle = first ? '#e8e8f0' : '#667';
            ctx.fillText(label, t.x + 4, col * ROW_H + ROW_H / 2, t.w - 8);
        }
    }

    function drawCursor(ctx) {
        const t = bySlot(cursor.slot);
        if (!t) return;
        const x = t.x + cursor.lane * LANE_W;
        const y = cursor.col * ROW_H;
        ctx.fillStyle = focused ? 'rgba(233, 69, 96, 0.22)' : 'rgba(233, 69, 96, 0.08)';
        ctx.fillRect(x, y, LANE_W, ROW_H);
        ctx.strokeStyle = focused ? '#e94560' : 'rgba(233, 69, 96, 0.5)';
        ctx.strokeRect(x + 0.5, y + 0.5, LANE_W - 1, ROW_H - 1);
    }

    function drawDrag(ctx) {
        if (!drag || drag.row === drag.event.col) return;
        const t = drag.track;
        const x = t.x + drag.event.lane * LANE_W + 4;
        ctx.fillStyle = '#e94560';
        ctx.fillText(noteName(drag.event.midi), x, drag.row * ROW_H + ROW_H / 2);
    }

    // --- The ✎ popover: Edit, the clip's repeats, and a new bar for the pattern ---

    let popover = null;

    function closePopover() {
        if (popover) { popover.remove(); popover = null; }
    }

    function openPopover(hit) {
        closePopover();
        const { block } = hit;
        popover = document.createElement('div');
        popover.className = 'tracker-popover';
        popover.style.left = (hit.x + GAP_W) + 'px';
        popover.style.top = (HEAD_H + hit.y) + 'px';

        const title = document.createElement('div');
        title.className = 'tracker-popover-title';
        title.textContent = block.pattern.name;
        popover.appendChild(title);

        // Edit: open this clip in the Pattern editor, as the Section pane
        // does — pending edits committed first, the project position
        // parked on this clip so the roll's Play loops it.
        if (opts.onOpenPattern) {
            const edit = document.createElement('button');
            edit.className = 'tracker-btn tracker-popover-edit';
            edit.textContent = 'Edit';
            edit.title = 'Open the pattern in the Pattern editor';
            edit.addEventListener('click', () => {
                commit();
                closePopover();
                if (transport && transport.setSectionPosition) transport.setSectionPosition(block.clip.startCol);
                opts.onOpenPattern(block.clip.id, block.clip.trackId, block.pattern.id);
            });
            popover.appendChild(edit);
        }

        // Repeats: only meaningful on a clip spelled in repeats; a clip cut
        // to a column count keeps its cut (the Section pane resizes those).
        if (block.clip.repeats != null) {
            const row = document.createElement('div');
            row.className = 'tracker-popover-row';
            const label = document.createElement('span');
            label.textContent = 'Repeats';
            row.appendChild(label);
            const mk = (txt, delta) => {
                const b = document.createElement('button');
                b.className = 'tracker-btn';
                b.textContent = txt;
                b.addEventListener('click', () => {
                    const next = block.clip.repeats + delta;
                    if (next < 1) return;
                    try {
                        session.update((project, section) => {
                            updateClip(project, section, block.clip.id, { repeats: next });
                        }, 'tracker');
                    } catch (e) {
                        say(e.message === 'Clip overlaps' ? 'No room: the next clip is in the way' : e.message);
                    }
                    closePopover();
                });
                return b;
            };
            row.appendChild(mk('−', -1));
            const count = document.createElement('span');
            count.className = 'tracker-popover-count';
            count.textContent = '×' + block.clip.repeats;
            row.appendChild(count);
            row.appendChild(mk('+', 1));
            popover.appendChild(row);
        }

        const addBar = document.createElement('button');
        addBar.className = 'tracker-btn tracker-popover-addbar';
        addBar.textContent = '+ Bar to pattern';
        addBar.title = 'Lengthen the pattern itself by one bar — every clip playing it follows';
        addBar.addEventListener('click', () => {
            const why = growBlocker(session.get(), block.pattern.id, block.pattern.measures + 1);
            if (why) say('No room: ' + why);
            else session.updatePattern(block.pattern.id, { measures: block.pattern.measures + 1 }, 'tracker');
            closePopover();
        });
        popover.appendChild(addBar);

        inner.appendChild(popover);
    }

    // --- Cursor ---

    function clampCursor() {
        if (layout.length === 0) return;
        let t = bySlot(cursor.slot);
        if (!t) { t = bySlot(activeSlot) || layout[0]; cursor.slot = t.track.slot; }
        cursor.lane = Math.max(0, Math.min(t.viewLanes - 1, cursor.lane));
        cursor.col = Math.max(0, Math.min(rows - 1, cursor.col));
    }

    function setCursor(slot, lane, col) {
        cursor.slot = slot;
        cursor.lane = lane;
        cursor.col = col;
        if (slot !== activeSlot) { selectTrack(slot); return; }   // re-renders
        clampCursor();
        draw();
        revealCursor();
    }

    function revealCursor() {
        const y = cursor.col * ROW_H;
        const viewH = scroll.clientHeight - HEAD_H;
        if (y < scroll.scrollTop) scroll.scrollTop = y;
        else if (viewH > ROW_H && y + ROW_H > scroll.scrollTop + viewH) scroll.scrollTop = y + ROW_H - viewH;
        const t = bySlot(cursor.slot);
        if (!t) return;
        const x = t.x + cursor.lane * LANE_W;
        if (x < scroll.scrollLeft + RULER_W) scroll.scrollLeft = Math.max(0, x - RULER_W);
        else if (x + LANE_W > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = x + LANE_W - scroll.clientWidth;
    }

    function moveLane(delta) {
        const i = layout.findIndex(t => t.track.slot === cursor.slot);
        if (i < 0) return;
        const lane = cursor.lane + delta;
        if (lane >= 0 && lane < layout[i].viewLanes) { setCursor(cursor.slot, lane, cursor.col); return; }
        const j = i + (delta > 0 ? 1 : -1);
        if (j < 0 || j >= layout.length) return;
        setCursor(layout[j].track.slot, delta > 0 ? 0 : MAX_LANES, cursor.col);
    }

    function moveTrack(delta) {
        const i = layout.findIndex(t => t.track.slot === cursor.slot);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= layout.length) return;
        setCursor(layout[j].track.slot, 0, cursor.col);
    }

    const moveRow = (delta) => setCursor(cursor.slot, cursor.lane, cursor.col + delta);

    // --- Editing ---

    /** Where an entry at the cursor lands, or null after saying why not. */
    function target() {
        const project = session.get();
        const section = session.getSection();
        const t = bySlot(cursor.slot);
        if (!project || !section || !t) return null;
        const loc = locate(project, section, t.track, cursor.col);
        if (!loc) {
            say('No pattern here — place one in Section, or grow a clip with ✎');
            return null;
        }
        return { ...loc, track: t.track, lane: t.track.compact ? 0 : cursor.lane };
    }

    function edited(pattern) {
        dirty.set(pattern.id, pattern);
        // Audible on the next pass without waiting for the commit.
        if (transport && transport.refresh) transport.refresh();
        clearTimeout(commitTimer);
        commitTimer = setTimeout(commit, COMMIT_MS);
        say('Editing ' + pattern.name + '…');
        render();
    }

    /** Pack lanes afresh and tell everyone. Called after the quiet time, or on leaving. */
    function commit() {
        clearTimeout(commitTimer);
        commitTimer = null;
        if (dirty.size === 0) return;
        const patterns = [...dirty.values()];
        dirty.clear();
        for (const p of patterns) {
            relane(p, { fresh: true });
            session.touchPattern(p.id, 'tracker');
        }
        say('');
        render();
    }

    function enterNote(semis) {
        const at = target();
        if (!at) return;
        const midi = Math.max(0, Math.min(127, (octave + 1) * 12 + semis));
        putNote(at.pattern, at.patternCol, at.lane, midi);
        if (opts.playNote) opts.playNote(midi, at.track.slot);
        edited(at.pattern);
        moveRow(step);
    }

    function enterOff() {
        const at = target();
        if (!at) return;
        if (!putOff(at.pattern, at.patternCol, at.lane)) { say('Nothing sounding here to stop'); return; }
        edited(at.pattern);
        moveRow(step);
    }

    function clearHere() {
        const at = target();
        if (!at) return;
        if (!clearCell(at.pattern, at.patternCol, at.lane)) { moveRow(step); return; }
        edited(at.pattern);
        moveRow(step);
    }

    canvas.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        let handled = true;
        if (e.code in NOTE_KEYS && !e.shiftKey) enterNote(NOTE_KEYS[e.code]);
        else if (e.code === 'Digit1') enterOff();
        else if (e.key === 'Delete' || e.key === 'Backspace') clearHere();
        else if (e.key === 'ArrowUp') moveRow(-1);
        else if (e.key === 'ArrowDown') moveRow(1);
        else if (e.key === 'PageUp') moveRow(-COLS_PER_MEASURE);
        else if (e.key === 'PageDown') moveRow(COLS_PER_MEASURE);
        else if (e.key === 'Home') moveRow(-rows);
        else if (e.key === 'End') moveRow(rows);
        else if (e.key === 'ArrowLeft') moveLane(-1);
        else if (e.key === 'ArrowRight') moveLane(1);
        else if (e.key === 'Tab') moveTrack(e.shiftKey ? -1 : 1);
        else if (e.code === 'NumpadAdd') { octave = Math.min(8, octave + 1); octaveSel.value = String(octave); }
        else if (e.code === 'NumpadSubtract') { octave = Math.max(0, octave - 1); octaveSel.value = String(octave); }
        else handled = false;
        if (handled) {
            // Keep the Section's Delete, the roll's tools, the keyboard's
            // shortcuts out of it: the tracker has the keys while focused.
            e.preventDefault();
            e.stopPropagation();
        }
    });

    canvas.addEventListener('focus', () => { focused = true; draw(); });
    canvas.addEventListener('blur', () => { focused = false; draw(); });

    // --- Pointer: ✎, cursor placement, and note drags ---

    function pointAt(e) {
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        return { x, y, row: Math.max(0, Math.min(rows - 1, Math.floor(y / ROW_H))) };
    }

    canvas.addEventListener('mousedown', (e) => {
        const p = pointAt(e);
        const hit = pencils.find(h => p.x >= h.x && p.x < h.x + h.w && p.y >= h.y && p.y < h.y + h.h);
        if (hit) { openPopover(hit); return; }
        closePopover();
        // preventScroll: a plain focus() scrolls the (tall) canvas into
        // view, which tucks the top rows under the sticky heads.
        if (canvas.focus) canvas.focus({ preventScroll: true });
        const t = trackAt(p.x);
        if (!t) return;
        const lane = t.track.compact ? 0 : Math.floor((p.x - t.x) / LANE_W);
        // A note's start cell can be dragged up or down; any other press
        // just puts the cursor there.
        const ev = !t.track.compact && t.events.find(v => v.col === p.row && v.lane === lane);
        if (ev) {
            drag = { event: ev, track: t, row: p.row };
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }
        setCursor(t.track.slot, lane, p.row);
    });

    function onDragMove(e) {
        if (!drag) return;
        const row = Math.max(0, Math.floor((e.clientY - canvas.getBoundingClientRect().top) / ROW_H));
        if (row !== drag.row) { drag.row = row; draw(); }
    }

    function onDragEnd(e) {
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
        if (!drag) return;
        onDragMove(e);
        const { event, row } = drag;
        drag = null;
        const delta = row - event.col;
        if (delta === 0) { draw(); return; }
        const pattern = event.pattern;
        const start = event.patternCol + delta;
        if (start < 0) { say('A note cannot move before its pattern starts'); draw(); return; }
        // Past the end: the pattern grows by the bars it takes to hold it.
        const need = measuresFor(start);
        if (need > pattern.measures) {
            const why = growBlocker(session.get(), pattern.id, need);
            if (why) { say('No room: ' + why); draw(); return; }
            pattern.measures = need;
        }
        moveNote(pattern, event.note, start);
        cursor.col = row;
        edited(pattern);
    }

    // --- New patterns: double-click empty space, or a library drop ---

    /** The track whose lanes — or the gap right of them — hold x. */
    const trackOrGapAt = (x) => layout.find(t => x >= t.x && x < t.x + t.w + GAP_W) || null;

    /**
     * Place `patternId` on `t` at `row`, refusing (with a message) where a
     * clip already is or the next one leaves no room. True when placed.
     */
    function placePattern(t, patternId, row) {
        const inside = t.blocks.find(b => row >= b.startCol && row < b.endCol);
        if (inside) { say('There is a clip here already: ' + inside.pattern.name); return false; }
        let placed = null;
        try {
            session.update((p, section) => {
                placed = addClip(p, section, { trackId: t.track.id, patternId, startCol: row });
            }, 'tracker');
        } catch (e) {
            say(e.message === 'Clip overlaps' ? 'No room: the next clip is in the way' : e.message);
            return false;
        }
        return !!placed;
    }

    /** Room on track `t` from `row` to the next clip's start (Infinity: none). */
    function roomAt(t, row) {
        let next = Infinity;
        for (const b of t.blocks) if (b.startCol >= row) next = Math.min(next, b.startCol);
        return next - row;
    }

    canvas.addEventListener('dblclick', (e) => {
        const p = pointAt(e);
        const t = trackAt(p.x);
        if (!t) return;
        if (t.blocks.some(b => p.row >= b.startCol && b.endCol > p.row)) return;   // a clip: that is editing
        // Checked before creating: a refused double-click must not leave
        // an orphan pattern in the library.
        if (roomAt(t, p.row) < COLS_PER_MEASURE) { say('No room for a bar here: the next clip is in the way'); return; }
        commit();
        const pattern = session.createPattern({ name: `Pattern ${session.listPatterns().length + 1}`, measures: 1 }, 'tracker');
        if (!pattern) return;
        if (!placePattern(t, pattern.id, p.row)) { session.removePattern(pattern.id, 'tracker'); return; }
        say(pattern.name + ' — type notes into it');
        setCursor(t.track.slot, 0, p.row);
    });

    /**
     * A pattern dragged from the Section pane's library, released at a
     * client point. False when the point is not over the grid (the caller
     * tries its own targets); true when it was — placed, or refused with a
     * message.
     */
    function dropPattern(clientX, clientY, patternId) {
        if (!shown || !session.getPattern(patternId)) return false;
        const view = scroll.getBoundingClientRect();
        if (clientX < view.left || clientX >= view.right || clientY < view.top + HEAD_H || clientY >= view.bottom) return false;
        const r = canvas.getBoundingClientRect();
        const x = clientX - r.left;
        const y = clientY - r.top;
        const t = trackOrGapAt(x);
        if (!t || y < 0) return false;
        const row = Math.min(rows - 1, Math.floor(y / ROW_H));
        commit();
        if (placePattern(t, patternId, row)) {
            say(session.getPattern(patternId).name + ' placed at row ' + row);
            setCursor(t.track.slot, 0, row);
        }
        return true;
    }

    // Compact `+` cells carry their full story in the canvas title.
    canvas.addEventListener('mousemove', (e) => {
        const p = pointAt(e);
        const t = trackAt(p.x);
        let tip = '';
        if (t && t.track.compact && t.cells) {
            const cell = t.cells.get(p.row);
            if (cell && cell.starts.length + cell.offs.length > 1) {
                tip = cell.starts.map(ev => noteName(ev.midi) + ' (lane ' + (ev.lane + 1) + ')')
                    .concat(cell.offs.map(ev => 'OFF (lane ' + (ev.lane + 1) + ')'))
                    .join(', ');
            }
        }
        if (canvas.title !== tip) canvas.title = tip;
    });

    document.addEventListener('mousedown', (e) => {
        if (popover && !popover.contains(e.target) && e.target !== canvas) closePopover();
    }, true);

    // --- Track selection ---

    function selectTrack(slot) {
        activeSlot = slot;
        cursor.slot = slot;
        if (opts.onSelectTrack) opts.onSelectTrack(slot);
        render();
        revealCursor();
    }

    // --- Playhead + follow ---

    function moveTo(col) {
        if (!(col >= 0)) { playheadEl.style.display = 'none'; return; }
        playheadEl.style.display = '';
        playheadEl.style.top = (HEAD_H + col * ROW_H) + 'px';
        if (followPlayhead && shown) {
            const y = col * ROW_H;
            if (y < scroll.scrollTop || y > scroll.scrollTop + scroll.clientHeight - ROW_H * 4) {
                scroll.scrollTop = Math.max(0, y - scroll.clientHeight / 3);
            }
        }
    }

    if (transport) {
        transport.subscribe((pos) => {
            moveTo(pos.playing || pos.recording ? pos.sectionCol : -1);
        });
    }

    // --- Viewport, for the Section pane's rectangle ---

    function viewport() {
        // The heads are sticky inside the scroller, so the rows on screen
        // start at scrollTop and fill what is left under the heads.
        const startCol = Math.floor(scroll.scrollTop / ROW_H);
        const endCol = Math.min(rows, Math.ceil((scroll.scrollTop + Math.max(0, scroll.clientHeight - HEAD_H)) / ROW_H));
        return { startCol, endCol: Math.max(startCol + 1, endCol) };
    }

    function reportViewport() {
        if (!opts.onViewport) return;
        opts.onViewport(shown ? viewport() : null);
    }
    scroll.addEventListener('scroll', reportViewport);

    // --- Render + wiring ---

    function render() {
        rebuild();
        renderHeads();
        draw();
    }

    session.subscribe((ev) => {
        if (ev.kind === 'patches') return;   // canvas drags; nothing of ours
        // Another editor changed a pattern we hold uncommitted: ours is the
        // same object, so nothing is lost — but commit now, so the lanes
        // and the event order stay simple.
        if (ev.source !== 'tracker' && dirty.size) commit();
        closePopover();
        render();
    });

    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('pagehide', commit);
    }

    return {
        element: container,
        render,
        /** The dock shows/hides panels with CSS; a hidden canvas measures 0. */
        setShown(on) {
            shown = !!on;
            if (shown) render();
            else { commit(); reportViewport(); }
        },
        setActiveSlot(slot) {
            if (slot === activeSlot) return;
            activeSlot = slot;
            cursor.slot = slot;
            if (shown) render();
        },
        getViewport: viewport,
        dropPattern,
        /** For tests and the e2e: commit pending edits now. */
        flush: commit,
        getCursor: () => ({ ...cursor }),
    };
}
