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
// Position state lives here, in memory, never in the project and never
// synced. Per-track settings (the divider) are the track's; the divider is
// applied by the sequence from the head's row, so a moved head keeps the
// right pattern column for free.

/**
 * @param {object} sequence  a section, piece or pattern sequence
 */
export function createPlayer(sequence) {
    // The current scope: its sequence, its range, where it sits on the
    // outer timeline (`base` + `start` is the column the outer sequence
    // calls row 0 of this scope), and the piece bookkeeping.
    let scope = null;
    let heads = [];
    let clock = -1;                // rows since the scope began; -1 before the first advance
    let armed = [];                // events gathered for the next tick
    let seam = false;              // the armed row is row 0 after a transition
    let pendingTransition = false;

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
            trackId: t.trackId, slot: t.slot, row: sc.start - 1, end: t.end, looped: false, clockOnly: false,
        }));
        // Nothing placed in the scope (a take into an empty range, say):
        // one silent head keeps the clock wrapping on the range.
        if (list.length === 0) list.push({ trackId: null, slot: -1, row: sc.start - 1, end: sc.end, looped: false, clockOnly: true });
        return list;
    }

    // --- The walk ---

    function arm() {
        armed = [];
        for (const h of heads) {
            if (h.clockOnly) continue;
            for (const e of scope.seq.eventsAt(h.row, h.trackId)) armed.push(e);
        }
    }

    const atLast = (h) => h.row === h.end - 1;

    function transitionDue() {
        return heads.some(h => atLast(h) && !h.looped
            && heads.every(o => o === h || o.looped || atLast(o)));
    }

    function advance() {
        if (pendingTransition) {
            scope = nextScope();
            heads = headsFor(scope);
            for (const h of heads) h.row = scope.start;
            clock = 0;
            seam = true;
            pendingTransition = false;
        } else {
            clock++;
            seam = false;
            for (const h of heads) {
                h.row++;
                if (h.row >= h.end) { h.row = scope.start; h.looped = true; }
            }
        }
        arm();
        if (transitionDue()) pendingTransition = true;
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
            for (const h of heads) {
                const span = h.end - scope.start;
                if (span <= 0) { h.row = scope.start; continue; }
                h.row = scope.start + (clock % span);
                h.looped = clock >= span;
            }
            seam = false;
            arm();
            pendingTransition = transitionDue();
        },

        /** Is the Player positioned (start() has run on a playable sequence)? */
        ready() { return !!scope; },

        /**
         * One tick: what fires now, where the outer playhead is, and whether
         * this row is the first of a new pass. Then the heads advance.
         */
        tick() {
            if (!scope) return { col: 0, events: [], seam: false };
            const out = { col: api.col(), events: armed, seam };
            advance();
            return out;
        },

        /** The outer column of the row now armed — what today's `col` was. */
        col() {
            return scope ? scope.base + scope.start + clock : -1;
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

        /** The heads, for tests and the views: `[{trackId, slot, row, looped}]`. */
        positions() {
            return heads.filter(h => !h.clockOnly).map(h => ({ trackId: h.trackId, slot: h.slot, row: h.row, looped: h.looped }));
        },

        /** Piece bookkeeping of the current scope: `{part, pass}` (0, 0 outside the piece). */
        where() {
            return scope ? { part: scope.part, pass: scope.pass } : { part: 0, pass: 0 };
        },
    };
    return api;
}
