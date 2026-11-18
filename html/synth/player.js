// Player — one Playhead per track, walking a Section together.
//
// The transport owns the clock (ticks, tempo, modes, external sync, MIDI
// clock out); the Player owns *where everything is* and *what fires*. It
// wraps a sequence (section, piece or lone pattern — section-sequencer.js)
// and keeps the state the sequence deliberately does not: the heads.
//
// A **head** walks its track's timeline inside the current **scope** — the
// Section's range (section mode), one pass of one part (piece mode), or
// the placement window (pattern mode). It gathers the events under it row
// by row; over a gap between clips it gathers nothing and keeps stepping;
// at the **end of its track's last clip** — exactly there, never rounded to
// the bar — it wraps to the scope's first row and is **looped**. Short
// tracks therefore loop against longer ones (3 against 4 is the point).
// A track with no clip in the scope has no head: it takes no part.
//
// **Transition.** The Section ends on the tick a head sits on its last row
// *not yet looped* while every other head has looped, or sits on its own
// last row this same tick (so tracks of equal length all leave together).
// Then every head is sent to row −1 of the next scope — the next pass or
// part of the piece, or this Section again — and the following advance
// lands them all on row 0, looped status cleared: the realignment. The
// tick that lands there carries `seam`, the recorder's cue.
//
// **One row ahead.** A head *at row N* has gathered row N's events and
// armed them for the next tick. `tick()` fires what is armed, then
// advances every head and arms the next row. `start(col)` puts the heads
// where a run from the top would have them at that column (a short
// track's head already looped and wrapped), so play-from-a-block, an
// external clock's `continue`, and a worker tick that skipped are all one
// operation: seek, then carry on.
//
// **Notes are explicit** (phase 2). An armed row's notes go out as
// `{type:'on', …, vel, dur}` events; the Player keeps what it has sounding
// — `{slot, midi, ticksLeft}` — counts the ticks down, and emits
// `{type:'off'}` when a note's time is up. The count is time, not rows: a
// seek never cuts a note (what sounds keeps sounding) — the one exception
// is the **Section transition**, where everything sounding is flushed as
// offs, placed *ahead of* the new row 0's ons. A second on for a sounding
// slot-and-pitch replaces its entry: a retrigger, as today.
//
// **Commands** (phase 4, tracker-commands.js) sit on the section per
// track and are read live, like mute. A head arriving at a row reads the
// row's command: `break` (D) is a vote decided — the Section ends after
// this row; the others take effect on the head's *next step* instead of
// row + 1: `jump` (B) to a row, `back` (R) and `skip` (K) by rows, `stop`
// (S) — the head rests, arms nothing and counts as satisfied. A move that
// goes backwards, or past the track's end, is a loop: the head is
// `looped`. Nothing a command does leaves the Section.
//
// **Humanize** (phase 5). A track with `humanize` on gets each note nudged:
// velocity by up to ±32·velocity, timing by up to ±½ row·timing — in rows,
// as `offset`; the transport turns it into milliseconds at the live
// tempo. A note nudged *early* (offset < 0) rides the one-row lookahead:
// `tick()` hands it out one tick ahead in `early`, due before the next
// tick, and leaves it out of that tick's events. The nudges are drawn from
// a PRNG seeded by (track, row, pass since Play, seed): every pass
// breathes differently, every Play reproduces the same performance — and
// `seed` is one number away from varying every time.
//
// **Speed** (2026-11-18, was the clock divider). A track may run at a
// fraction of the Section's pace: at 1/n its head stays on each row for n
// ticks (`phase` counts them) and only then steps — the whole timeline
// plays, n times slower, and its notes last n times as many ticks. The
// sequence speaks in rows and knows nothing of it; `ticksPerRow(trackId)`
// is read live off the track (stored as `track.divider`), so a change
// mid-play lands at the end of the row being held. A row's notes fire on
// its first tick; its command is read on arrival and acts on the head's
// next step, n ticks later; and a slow head is *on its last row* for the
// vote only on that row's last tick, so the Section waits for it. The
// outer column keeps the Section's own pace and wraps at its range: a
// Section stretched by a slow track goes round under it.
//
// Position state lives here, in memory, never in the project and never
// synced.

import { commandByLetter } from './tracker-commands.js';

/**
 * @param {object} sequence  a section, piece or pattern sequence
 */
export function createPlayer(sequence, { seed = 0 } = {}) {
    // The current scope: its sequence, its range, where it sits on the
    // outer timeline (`base` + `start` is the column the outer sequence
    // calls row 0 of this scope), and the piece bookkeeping.
    let scope = null;
    let heads = [];
    let clock = -1;                // rows since the scope began; -1 before the first advance
    let armed = [];                // events gathered for the next tick
    let seam = false;              // the armed row is row 0 after a transition
    let pendingTransition = false;
    let sounding = [];             // { slot, midi, trackId, ticksLeft } — the notes out
    let passes = 0;                // scope restarts since start(): the humanize seed's pass

    const isPiece = sequence.kind === 'piece';
    const parts = isPiece && sequence.parts ? sequence.parts() : [];

    // --- Scopes ---

    /** The scope holding outer column `col`. */
    function scopeAt(col) {
        if (!isPiece || parts.length === 0) {
            return { seq: sequence, base: 0, start: sequence.range.startCol, end: sequence.range.endCol, part: 0, pass: 0 };
        }
        let i = parts.findIndex(p => col >= p.startCol && col < p.endCol);
        if (i < 0) i = parts.length - 1;
        const p = parts[i];
        const pass = Math.min(p.repeats - 1, Math.max(0, Math.floor((col - p.startCol) / p.passCols)));
        return scopeOf(i, pass);
    }

    function scopeOf(part, pass) {
        const p = parts[part];
        return { seq: p.seq, base: p.startCol + pass * p.passCols, start: 0, end: p.passCols, part, pass };
    }

    /** The scope after this one: the next pass, the next part, or round again. */
    function nextScope() {
        if (!isPiece || parts.length === 0) return scope;
        const p = parts[scope.part];
        if (scope.pass + 1 < p.repeats) return scopeOf(scope.part, scope.pass + 1);
        return scopeOf((scope.part + 1) % parts.length, 0);
    }

    /** Heads for a scope: one per track with a clip in it, parked at row −1. */
    function headsFor(sc) {
        const list = sc.seq.tracks().map(t => ({
            trackId: t.trackId, slot: t.slot, row: sc.start - 1, end: t.end, phase: 0,
            looped: false, stopped: false, cmd: null, brk: false, clockOnly: false,
        }));
        // Nothing placed in the scope (a take into an empty range, say):
        // one silent head keeps the clock wrapping on the range.
        if (list.length === 0) {
            list.push({ trackId: null, slot: -1, row: sc.start - 1, end: sc.end, phase: 0, looped: false, stopped: false, cmd: null, brk: false, clockOnly: true });
        }
        return list;
    }

    // --- The walk ---

    /** Ticks one row of this head's track lasts (its speed, read live). */
    function ticksPerRow(h) {
        if (h.clockOnly || !scope.seq.ticksPerRow) return 1;
        return Math.max(1, scope.seq.ticksPerRow(h.trackId) || 1);
    }

    /** Is this the head's last tick on its row — will its next advance step? */
    const leaving = (h) => h.phase >= ticksPerRow(h) - 1;

    /**
     * The command under a head's row, kept on the head until its next
     * step; a `break` votes for the Section to end after this row. Read on
     * every tick the head holds the row (live, like mute), so re-reading a
     * slow head's row is the same answer.
     */
    function readCommand(h) {
        h.cmd = null;
        h.brk = false;
        if (h.clockOnly || h.stopped) return;
        const entry = scope.seq.commandAt(h.trackId, h.row);
        const c = entry && commandByLetter(entry.cmd);
        if (!c) return;
        if (c.name === 'break') { h.brk = true; return; }
        h.cmd = { name: c.name, arg: entry.arg };
    }

    /**
     * One step of a head: row + 1, or what its command says; past the end
     * of its track — or backwards — it is a loop. A stopped head stays.
     */
    function moveHead(h) {
        if (h.stopped) return;
        const from = h.row;
        let next = from + 1;
        const c = h.cmd;
        h.cmd = null;
        if (c) {
            switch (c.name) {
            case 'jump': next = Math.max(scope.start, Math.min(h.end - 1, scope.start + c.arg)); break;
            case 'back': next = Math.max(scope.start, from + 1 - c.arg); break;
            case 'skip': next = from + 1 + c.arg; break;
            case 'stop': h.stopped = true; return;
            default: break;
            }
            if (next <= from) h.looped = true;
        }
        if (next >= h.end) { next = scope.start; h.looped = true; }
        h.row = next;
    }

    /**
     * One tick of a head: another tick on its row, or — on the row's last
     * tick at the track's speed — the step. True when it arrived on a row.
     */
    function tickHead(h) {
        if (h.stopped) return false;
        h.phase++;
        if (h.phase < ticksPerRow(h)) return false;
        h.phase = 0;
        h.brk = false;
        moveHead(h);
        return true;
    }

    // --- Humanize: a small seeded PRNG (mulberry32) over (track, row, pass, seed) ---

    function hashString(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    }

    function rng(trackId, row) {
        let a = (hashString(String(trackId)) ^ Math.imul(row + 1, 2654435761) ^ Math.imul(passes + 1, 40503) ^ (seed | 0)) >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /** The note's nudges, if its track humanizes: `vel` moved, `offset` in rows, `early` when negative. */
    function humanize(ev, row) {
        const h = ev.humanize;
        if (!h) return;
        const next = rng(ev.trackId, row);
        if (h.velocity > 0) {
            const base = ev.vel == null ? 100 : ev.vel;
            ev.vel = Math.max(1, Math.min(127, Math.round(base + (next() * 2 - 1) * h.velocity * 32)));
        }
        if (h.timing > 0) {
            ev.offset = (next() * 2 - 1) * h.timing * 0.5;
            ev.early = ev.offset < 0;
        }
    }

    /**
     * Gather the rows the heads just arrived on as note-ons, each entered
     * into `sounding`; read every head's command. A slow head holding its
     * row gathers nothing — its notes went out on the row's first tick,
     * lasting `ticksPerRow` times as many ticks.
     */
    function armOns() {
        const ons = [];
        for (const h of heads) {
            if (h.clockOnly) continue;
            readCommand(h);
            if (h.stopped || h.phase !== 0) continue;
            const tpr = ticksPerRow(h);
            for (const e of scope.seq.eventsAt(h.row, h.trackId)) {
                const on = { type: 'on', ...e, dur: e.dur * tpr };
                humanize(on, h.row);
                ons.push(on);
                // A sounding slot-and-pitch hit again: superseded, one entry.
                sounding = sounding.filter(n => !(n.slot === e.slot && n.midi === e.midi));
                sounding.push({ slot: e.slot, midi: e.midi, trackId: e.trackId, ticksLeft: Math.max(1, on.dur) });
            }
        }
        return ons;
    }

    /** Count the sounding notes one tick down; the spent ones become offs. */
    function dueOffs() {
        const offs = [];
        const left = [];
        for (const n of sounding) {
            n.ticksLeft--;
            if (n.ticksLeft <= 0) offs.push({ type: 'off', slot: n.slot, midi: n.midi, trackId: n.trackId });
            else left.push(n);
        }
        sounding = left;
        return offs;
    }

    /** Everything sounding, off — the Section transition's clean slate. */
    function flushOffs() {
        const offs = sounding.map(n => ({ type: 'off', slot: n.slot, midi: n.midi, trackId: n.trackId }));
        sounding = [];
        return offs;
    }

    // On its last row — and, for a slow head, on that row's last tick.
    const atLast = (h) => h.row === h.end - 1 && leaving(h);
    const satisfied = (h) => h.looped || h.stopped || atLast(h);

    /**
     * The vote (2026-11-17): a head on its last row, not yet looped, while
     * every other head has looped, is stopped, or is on its own last row
     * this tick. A `break` decides it once its row is done; every head
     * stopped ends it too (no one is left to arrive).
     */
    function transitionDue() {
        if (heads.some(h => h.brk && !h.stopped && leaving(h))) return true;
        if (heads.length && heads.every(h => h.stopped)) return true;
        return heads.some(h => atLast(h) && !h.looped && !h.stopped
            && heads.every(o => o === h || satisfied(o)));
    }

    function advance() {
        let offs;
        if (pendingTransition) {
            scope = nextScope();
            heads = headsFor(scope);
            for (const h of heads) h.row = scope.start;
            clock = 0;
            seam = true;
            pendingTransition = false;
            passes++;
            // All notes off at the transition — ahead of the new row 0's ons.
            offs = flushOffs();
        } else {
            clock++;
            seam = false;
            for (const h of heads) tickHead(h);
            offs = dueOffs();
        }
        const ons = armOns();
        // The transition's offs go out just before any early row-0 note.
        const earliest = Math.min(0, ...ons.filter(o => o.early).map(o => o.offset));
        if (seam && earliest < 0) for (const o of offs) { o.offset = earliest - 0.01; o.early = true; }
        armed = [...offs, ...ons];
        if (transitionDue()) pendingTransition = true;
    }

    /** After a seek or a restore there was no earlier tick: nothing can be early. */
    function noEarly() {
        for (const e of armed) if (e.early) { e.early = false; e.offset = 0; }
    }

    // --- API ---

    const api = {
        /**
         * Seek: every head where a run from the scope's top would have it at
         * outer column `col`, that row armed. A no-op without a range.
         */
        start(col) {
            if (!sequence.range) return;
            scope = scopeAt(col);
            heads = headsFor(scope);
            clock = Math.max(0, col - scope.base - scope.start);
            // Replay the walk from the top, commands included, so the heads
            // stand exactly where a run would have them — in rows only; no
            // notes are gathered on the way.
            for (const h of heads) { h.row = scope.start; h.phase = 0; }
            for (let i = 0; i < clock; i++) {
                for (const h of heads) { readCommand(h); tickHead(h); }
            }
            seam = false;
            passes = 0;
            // A seek never cuts a note: what sounds keeps sounding, its
            // off still counting (the transition is the one exception).
            armed = armOns();
            noEarly();
            pendingTransition = transitionDue();
        },

        /** Is the Player positioned (start() has run on a playable sequence)? */
        ready() { return !!scope; },

        /**
         * One tick: what fires now, where the outer playhead is, and whether
         * this row is the first of a new pass. Then the heads advance.
         */
        tick() {
            if (!scope) return { col: 0, events: [], seam: false, early: [] };
            // What is due now — the early-released notes went out last tick.
            const out = { col: api.col(), events: armed.filter(e => !e.early), seam };
            advance();
            // The next row's early notes: due before the next tick.
            out.early = armed.filter(e => e.early);
            return out;
        },

        /** The outer column of the row now armed — what today's `col` was. */
        col() {
            if (!scope) return -1;
            // The Section's own pace, wrapped at its range: a slow track (or
            // a jump) can keep the Section going past its nominal end, and
            // the outer playhead goes round under it rather than run on into
            // the next part.
            const len = scope.end - scope.start;
            return scope.base + scope.start + (len > 0 ? clock % len : clock);
        },

        /**
         * Where the playhead is, for drawing: the outer sequence's view of
         * `col()`, with every track's entry taken from its own head — so a
         * looped track reads where it really is.
         */
        locate() {
            if (!scope) return sequence.locate(0);
            const here = sequence.locate(api.col());
            const tracks = {};
            for (const h of heads) {
                if (h.clockOnly) continue;
                const at = scope.seq.locate(h.row).tracks[h.trackId];
                if (at) tracks[h.trackId] = at;
            }
            return { ...here, tracks };
        },

        /** The notes out right now — and the hand-over: refresh() rebuilds the
         *  Player mid-play and the new one adopts them so their offs still come. */
        sounding() { return sounding.map(n => ({ ...n })); },
        adopt(notes) { if (Array.isArray(notes)) sounding = notes.map(n => ({ ...n })); },

        /** The heads, for tests and the views: `[{trackId, slot, row, looped, stopped}]`. */
        positions() {
            return heads.filter(h => !h.clockOnly)
                .map(h => ({ trackId: h.trackId, slot: h.slot, row: h.row, looped: h.looped, stopped: h.stopped }));
        },

        /**
         * The whole position state, for a hand-over: the transport rebuilds
         * the Player on every edit mid-play and restores this into the new
         * one, so the heads carry on from where they are — no seek by a
         * nominal column that a jump-stretched Section would belie.
         */
        snapshot() {
            if (!scope) return null;
            return {
                part: scope.part, pass: scope.pass, clock, pendingTransition, passes,
                heads: heads.filter(h => !h.clockOnly).map(h => ({ trackId: h.trackId, row: h.row, phase: h.phase, looped: h.looped, stopped: h.stopped })),
                sounding: sounding.map(n => ({ ...n })),
            };
        },

        /** Restore a snapshot onto this Player's sequence. False when it does not fit (seek instead). */
        restore(snap) {
            if (!snap || !sequence.range) return false;
            if (isPiece && parts.length === 0) return false;
            if (isPiece && !(snap.part < parts.length && snap.pass < parts[snap.part].repeats)) return false;
            scope = isPiece ? scopeOf(snap.part, snap.pass) : scopeAt(sequence.range.startCol);
            heads = headsFor(scope);
            for (const h of heads) {
                const was = snap.heads.find(o => o.trackId === h.trackId);
                if (!was) { h.row = scope.start + Math.min(snap.clock, Math.max(0, h.end - scope.start - 1)); continue; }
                h.row = was.row >= h.end || was.row < scope.start ? scope.start : was.row;
                // Mid-row: its notes are out already; carry on holding it.
                h.phase = h.row === was.row ? (was.phase || 0) : 0;
                h.looped = was.looped;
                h.stopped = was.stopped;
            }
            clock = snap.clock;
            sounding = snap.sounding.map(n => ({ ...n }));
            passes = snap.passes || 0;
            seam = false;
            armed = armOns();
            noEarly();
            pendingTransition = snap.pendingTransition || transitionDue();
            return true;
        },

        /** Piece bookkeeping of the current scope: `{part, pass}` (0, 0 outside the piece). */
        where() {
            return scope ? { part: scope.part, pass: scope.pass } : { part: 0, pass: 0 };
        },
    };
    return api;
}
