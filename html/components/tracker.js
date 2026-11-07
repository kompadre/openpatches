// Tracker — the Section editor on steroids, as a main tab.
//
// Rows are the edited section's sixteenths (time runs down, like the
// Section pane), columns are the project's tracks, and each track splits
// into monophonic sub-lanes — *expanded* (a sub-lane per concurrent note)
// or *compact* (one column; a cell holding several events shows the first
// plus `+n`, the rest in a tooltip). Clips show as blocks in their
// pattern's colour, subdued, with the pattern's name on the row the clip
// starts; the gap between tracks carries a small ✎ there, opening a
// popover to change the clip's repeats or add a bar to the pattern.
//
// Phase 2: a view. It renders, follows the playhead, syncs the active
// track with the Mixer and the roll, reports its viewport to the Section
// pane, and edits only through the ✎ popover. Typing notes is phase 3.
//
// All drawing is one canvas (a section is hundreds of rows × up to eight
// tracks of text cells; DOM cells at that scale are what the piano roll
// already refused). The playhead is a DOM line over it, moved on each
// tick, so playback does not redraw the world.

import {
    expandTrack, compactCells, noteName,
} from './tracker-model.js';
import {
    COLS_PER_MEASURE, updateClip, clipRepeats, sectionLength, getPattern,
} from './project-model.js';

const ROW_H = 16;
const LANE_W = 46;
const GAP_W = 18;        // between tracks; the ✎ lives here
const RULER_W = 36;
const MIN_MEASURES = 4;  // never a zero-height grid
const FOLLOW_KEY = 'openpatches_tracker_follow';

const DEFAULT_COLORS = ['#e94560', '#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4', '#ff5722', '#607d8b'];

export function createTracker(opts) {
    const { session, transport } = opts;
    const log = opts.log || (() => {});

    let activeSlot = 0;
    let shown = false;
    let layout = [];          // per track: { track, x, w, lanes, blocks, events }
    let rows = MIN_MEASURES * COLS_PER_MEASURE;
    let followPlayhead = false;
    try { followPlayhead = localStorage.getItem(FOLLOW_KEY) === '1'; } catch { /* view pref only */ }

    // --- DOM ---

    const container = document.createElement('div');
    container.className = 'tracker-container';

    const controls = document.createElement('div');
    controls.className = 'tracker-controls';
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
    inner.appendChild(canvas);

    const playheadEl = document.createElement('div');
    playheadEl.className = 'tracker-playhead';
    playheadEl.style.display = 'none';
    inner.appendChild(playheadEl);

    // --- Helpers ---

    function slotColor(slot) {
        const entry = opts.getSlotData ? opts.getSlotData(slot) : null;
        if (entry && entry.color) return entry.color;
        return DEFAULT_COLORS[slot % DEFAULT_COLORS.length];
    }

    function tint(hex, alpha) {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }

    function trackAt(x) {
        return layout.find(t => x >= t.x && x < t.x + t.w) || null;
    }

    /** The ✎ hotspots: one per clip block, in the gap right of its track. */
    let pencils = [];   // { x, y, w, h, track, block }

    // --- Layout + draw ---

    function rebuild() {
        const project = session.get();
        const section = session.getSection();
        layout = [];
        pencils = [];
        if (!project || !section) return;

        rows = Math.max(MIN_MEASURES, sectionLength(project, section)) * COLS_PER_MEASURE;
        let x = RULER_W;
        for (const track of [...project.tracks].sort((a, b) => a.slot - b.slot)) {
            const r = expandTrack(project, section, track);
            const lanes = track.compact ? 1 : r.lanes;
            const t = { track, x, lanes, w: lanes * LANE_W, ...r };
            t.cells = track.compact ? compactCells(t.events) : null;
            layout.push(t);
            x += t.w + GAP_W;
        }
        inner.style.width = x + 'px';
        inner.style.height = (heads.offsetHeight + rows * ROW_H) + 'px';
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
        const headH = heads.offsetHeight || 26;
        const w = Math.max(inner.offsetWidth, RULER_W + 1);
        const h = rows * ROW_H;
        canvas.width = w;
        canvas.height = h;
        canvas.style.top = headH + 'px';
        const ctx = canvas.getContext('2d');
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

        // The active track, marked the way the roll marks its lane.
        const active = layout.find(t => t.track.slot === activeSlot);
        if (active) {
            ctx.fillStyle = 'rgba(233, 69, 96, 0.05)';
            ctx.fillRect(active.x, 0, active.w, h);
        }
        reportViewport();
    }

    function drawTrack(ctx, t) {
        // Lane separators, faint, across the whole column.
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        for (let l = 0; l <= t.lanes; l++) {
            const x = t.x + l * LANE_W;
            ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, rows * ROW_H); ctx.stroke();
        }

        // Clip blocks: the pattern's colour, subdued, and its name where it
        // starts. The ✎ sits in the gap right of the block's first row.
        for (const b of t.blocks) {
            const y = b.startCol * ROW_H;
            const bh = (b.endCol - b.startCol) * ROW_H;
            ctx.fillStyle = tint(b.pattern.color, 0.13);
            ctx.fillRect(t.x, y, t.w, bh);
            ctx.fillStyle = tint(b.pattern.color, 0.35);
            ctx.fillRect(t.x, y, t.w, ROW_H);
            ctx.fillStyle = '#ddd';
            ctx.font = 'bold 9px sans-serif';
            ctx.fillText(clipName(b), t.x + 3, y + ROW_H / 2, t.w - 6);
            ctx.font = '10px monospace';

            // Repeat seams, so a 3× clip reads as three passes.
            const len = b.pattern.measures * COLS_PER_MEASURE;
            ctx.strokeStyle = tint(b.pattern.color, 0.4);
            for (let c = b.startCol + len; c < b.endCol; c += len) {
                ctx.beginPath(); ctx.moveTo(t.x, c * ROW_H + 0.5); ctx.lineTo(t.x + t.w, c * ROW_H + 0.5); ctx.stroke();
            }

            const px = t.x + t.w + 2;
            ctx.fillStyle = '#9ab';
            ctx.fillText('✎', px, y + ROW_H / 2);
            pencils.push({ x: px - 2, y, w: GAP_W, h: ROW_H, track: t, block: b });
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
            ctx.fillStyle = '#e8e8f0';
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

    // --- The ✎ popover: the clip's repeats, and a new bar for the pattern ---

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
        popover.style.top = ((heads.offsetHeight || 26) + hit.y) + 'px';

        const title = document.createElement('div');
        title.className = 'tracker-popover-title';
        title.textContent = block.pattern.name;
        popover.appendChild(title);

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
                        log('[tracker] ' + e.message);   // an overlap, usually
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
            session.updatePattern(block.pattern.id, { measures: block.pattern.measures + 1 }, 'tracker');
            closePopover();
        });
        popover.appendChild(addBar);

        inner.appendChild(popover);
    }

    // --- Interaction ---

    function selectTrack(slot) {
        activeSlot = slot;
        if (opts.onSelectTrack) opts.onSelectTrack(slot);
        render();
    }

    canvas.addEventListener('click', (e) => {
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        const hit = pencils.find(p => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
        if (hit) { openPopover(hit); return; }
        closePopover();
        const t = trackAt(x);
        if (t && t.track.slot !== activeSlot) selectTrack(t.track.slot);
    });

    // Compact `+` cells carry their full story in the canvas title.
    canvas.addEventListener('mousemove', (e) => {
        const r = canvas.getBoundingClientRect();
        const t = trackAt(e.clientX - r.left);
        const col = Math.floor((e.clientY - r.top) / ROW_H);
        let tip = '';
        if (t && t.track.compact && t.cells) {
            const cell = t.cells.get(col);
            if (cell && cell.starts.length + cell.offs.length > 1) {
                tip = cell.starts.map(ev => noteName(ev.midi) + ' (lane ' + (ev.lane + 1) + ')')
                    .concat(cell.offs.map(ev => 'OFF (lane ' + (ev.lane + 1) + ')'))
                    .join(', ');
            }
        }
        if (canvas.title !== tip) canvas.title = tip;
    });

    document.addEventListener('click', (e) => {
        if (popover && !popover.contains(e.target) && e.target !== canvas) closePopover();
    }, true);

    // --- Playhead + follow ---

    function moveTo(col) {
        if (!(col >= 0)) { playheadEl.style.display = 'none'; return; }
        playheadEl.style.display = '';
        playheadEl.style.top = ((heads.offsetHeight || 26) + col * ROW_H) + 'px';
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

    function reportViewport() {
        if (!opts.onViewport) return;
        if (!shown) { opts.onViewport(null); return; }
        const headH = heads.offsetHeight || 26;
        const top = Math.max(0, scroll.scrollTop - headH);
        opts.onViewport({
            startCol: Math.floor(top / ROW_H),
            endCol: Math.min(rows, Math.ceil((top + scroll.clientHeight) / ROW_H)),
        });
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
        closePopover();
        render();
    });

    return {
        element: container,
        render,
        /** The dock shows/hides panels with CSS; a hidden canvas measures 0. */
        setShown(on) {
            shown = !!on;
            if (shown) render(); else reportViewport();
        },
        setActiveSlot(slot) {
            if (slot === activeSlot) return;
            activeSlot = slot;
            if (shown) render();
        },
        getViewport() {
            const headH = heads.offsetHeight || 26;
            const top = Math.max(0, scroll.scrollTop - headH);
            return { startCol: Math.floor(top / ROW_H), endCol: Math.ceil((top + scroll.clientHeight) / ROW_H) };
        },
    };
}
