// Tracker model — the pure half of the Tracker tab.
//
// The tracker is the Section editor on steroids: rows are the edited
// section's sixteenths, columns are the project's tracks, and each track is
// split into 1–MAX_LANES monophonic **sub-lanes**. A pattern's notes carry
// no voice and, until the tracker looked at them, no lane either: a chord
// in the piano roll is just notes that overlap. So lanes are **derived**,
// and the result is stored on the notes (`note.lane`, omitted for 0) so a
// note keeps its lane from one look to the next.
//
// Derivation honours a stored lane while that lane is free, so notes do not
// hop between lanes as the pattern is edited around them. Only a note whose
// lane is taken (or that never had one) moves, and it takes the lowest free
// lane. When every lane is busy the **oldest** sounding note is stolen, as
// a synth steals a voice: it is cut where the new note starts, and that is
// reported (`stolenAt`) so the view can mark it. The model keeps the
// note's full length — the piano roll and the sequencer still play it.
//
// The mapping between a lane of notes and a tracker column is exact both
// ways, so switching between the roll and the tracker never changes data:
//   - a note shows at its start row and holds until its end;
//   - its end shows as an OFF unless something else explains it — the next
//     note in the lane starting right there (legato), the end of the
//     pattern, the end of the clip, or a steal;
//   - typing a note cuts whatever sounds in the lane there, and the new
//     note inherits the rest of it (an OFF below stays where it was);
//   - typing OFF cuts the sounding note there;
//   - clearing a note gives its time back to the note it had cut short.
//
// Pure: no DOM, no session, no storage. The edit operations mutate the
// pattern's `notes` array in place, the way the piano roll does, and leave
// committing to the caller (session.touchPattern).

import { MAX_LANES, clipCols, patternCols, getPattern } from './project-model.js';

export { MAX_LANES };

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

/** Tracker spelling: middle C (60) is `C-4`, its sharp `C#4`. */
export function noteName(midi) {
    const m = Math.round(Number(midi));
    if (!Number.isFinite(m) || m < 0 || m > 127) return '???';
    return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
}

const storedLane = (n) => (Number.isInteger(n.lane) && n.lane > 0 ? n.lane : 0);
const endOf = (n) => n.start + n.dur;

/**
 * Spread `notes` over at most `maxLanes` monophonic lanes.
 *
 * Notes are taken in time order; at one start, notes with a stored lane go
 * first (they have a claim), then by pitch, low to high.
 *
 * @param {Array<{midi,start,dur,lane?}>} notes
 * @returns {{
 *   lane: Map<object, number>,      // every note → its lane
 *   stolenAt: Map<object, number>,  // notes cut short by a steal → the column they stop at
 *   needed: number,                 // lanes in use at the busiest moment (≤ maxLanes)
 * }}
 */
export function deriveLanes(notes, { maxLanes = MAX_LANES } = {}) {
    const order = [...notes].sort((a, b) =>
        a.start - b.start
        || (('lane' in b) - ('lane' in a))
        || a.midi - b.midi);
    const lane = new Map();
    const stolenAt = new Map();
    const holder = new Array(maxLanes).fill(null);   // the note sounding in each lane
    let needed = 0;

    for (const n of order) {
        // Free every lane whose note has ended by now (a steal ends it early).
        for (let l = 0; l < maxLanes; l++) {
            const h = holder[l];
            if (h && (stolenAt.has(h) ? stolenAt.get(h) : endOf(h)) <= n.start) holder[l] = null;
        }
        let pick = -1;
        const want = storedLane(n);
        if (want < maxLanes && !holder[want]) pick = want;
        if (pick < 0) pick = holder.findIndex(h => !h);
        if (pick < 0) {
            // Every lane is busy: steal the oldest. Lowest lane on a tie.
            pick = 0;
            for (let l = 1; l < maxLanes; l++) {
                if (holder[l].start < holder[pick].start) pick = l;
            }
            stolenAt.set(holder[pick], n.start);
        }
        holder[pick] = n;
        lane.set(n, pick);
        needed = Math.max(needed, holder.filter(Boolean).length);
    }
    return { lane, stolenAt, needed };
}

/**
 * Write a derivation onto the notes: `lane` for lanes 1+, absent for 0.
 * @returns {number} how many notes changed
 */
export function applyLanes(notes, derived) {
    let changed = 0;
    for (const n of notes) {
        const l = derived.lane.get(n) || 0;
        if (storedLane(n) === l && (l > 0 || !('lane' in n))) continue;
        if (l > 0) n.lane = l; else delete n.lane;
        changed++;
    }
    return changed;
}

/** Derive and store in one go; what the tracker does after the edit debounce. */
export function relane(pattern) {
    return applyLanes(pattern.notes, deriveLanes(pattern.notes));
}

// --- The section, as the tracker shows it ---

function trackClips(section, track) {
    return (section ? section.clips : [])
        .filter(c => c.trackId === track.id)
        .sort((a, b) => a.startCol - b.startCol);
}

/**
 * Lanes to show for `track`: its stored count, widened to what any of its
 * patterns here needs.
 */
export function trackLaneCount(project, section, track) {
    let n = Math.max(1, Math.min(MAX_LANES, track.lanes || 1));
    for (const clip of trackClips(section, track)) {
        const p = getPattern(project, clip.patternId);
        if (p) n = Math.max(n, deriveLanes(p.notes).needed);
    }
    return n;
}

/**
 * Lay out one track of the section: its clips as blocks, and every note of
 * every repeat as an event at its absolute column.
 *
 * Event fields: `col`/`end` (absolute, end exclusive, already cut by the
 * clip and any steal), `lane`, `midi`, `off` (an OFF row shows at `end`),
 * `stolen` (cut short by a steal), and `clip`/`pattern`/`note`/`patternCol`
 * for the editor to write back through.
 */
export function expandTrack(project, section, track) {
    const blocks = [];
    const events = [];
    const derivedCache = new Map();
    for (const clip of trackClips(section, track)) {
        const pattern = getPattern(project, clip.patternId);
        const span = clipCols(clip, pattern);
        if (!pattern || !span) continue;
        blocks.push({ clip, pattern, startCol: span.startCol, endCol: span.endCol });

        if (!derivedCache.has(pattern.id)) derivedCache.set(pattern.id, deriveLanes(pattern.notes));
        const d = derivedCache.get(pattern.id);
        const len = patternCols(pattern);
        // Legato: a note in the lane starting exactly where another ends.
        const starts = new Set(pattern.notes.map(n => d.lane.get(n) + ':' + n.start));

        for (let base = span.startCol; base < span.endCol; base += len) {
            for (const n of pattern.notes) {
                const col = base + n.start;
                if (col >= span.endCol) continue;
                const l = d.lane.get(n);
                const natural = base + endOf(n);
                const stolen = d.stolenAt.has(n) && d.stolenAt.get(n) < endOf(n);
                const cut = stolen ? base + d.stolenAt.get(n) : Infinity;
                const end = Math.min(natural, cut, span.endCol);
                const off = !stolen
                    && natural < span.endCol
                    && endOf(n) < len
                    && !starts.has(l + ':' + endOf(n));
                events.push({
                    col, end, lane: l, midi: n.midi, off, stolen,
                    clip, pattern, note: n, patternCol: n.start,
                });
            }
        }
    }
    events.sort((a, b) => a.col - b.col || a.lane - b.lane);
    return { lanes: trackLaneCount(project, section, track), blocks, events };
}

/**
 * The clip under absolute column `col` on `track`, and where in its pattern
 * that falls. Null when the track has nothing there.
 */
export function locate(project, section, track, col) {
    for (const clip of trackClips(section, track)) {
        const pattern = getPattern(project, clip.patternId);
        const span = clipCols(clip, pattern);
        if (!span || col < span.startCol || col >= span.endCol) continue;
        return { clip, pattern, patternCol: (col - span.startCol) % patternCols(pattern) };
    }
    return null;
}

// --- Editing a pattern, tracker-style ---
//
// Each operation first freezes the current derivation onto the notes: what
// is edited is exactly what the user sees, and the notes around the edit
// keep their lanes.

function freeze(pattern) {
    const d = deriveLanes(pattern.notes);
    applyLanes(pattern.notes, d);
    return d;
}

function inLane(pattern, d, lane) {
    return pattern.notes.filter(n => d.lane.get(n) === lane).sort((a, b) => a.start - b.start);
}

/** Sounding end as the view shows it: a stolen note stops at the steal. */
function heldUntil(d, n) {
    return d.stolenAt.has(n) ? Math.min(endOf(n), d.stolenAt.get(n)) : endOf(n);
}

function sortNotes(pattern) {
    pattern.notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
}

function setLane(n, lane) {
    if (lane > 0) n.lane = lane; else delete n.lane;
}

/**
 * Put `midi` at `col` in `lane`. Replaces the pitch of a note starting
 * there; otherwise cuts what sounds in the lane and inherits the rest of
 * it, or — over silence — holds until the lane's next note or the end.
 * @returns {object} the note now at the cell
 */
export function putNote(pattern, col, lane, midi) {
    const d = freeze(pattern);
    const notes = inLane(pattern, d, lane);
    const here = notes.find(n => n.start === col);
    if (here) {
        here.midi = midi;
        return here;
    }
    const len = patternCols(pattern);
    const sounding = notes.find(n => n.start < col && col < heldUntil(d, n));
    let end;
    if (sounding) {
        end = heldUntil(d, sounding);
        sounding.dur = col - sounding.start;
    } else {
        const next = notes.find(n => n.start > col);
        end = next ? next.start : len;
    }
    const note = { midi, start: col, dur: Math.max(1, end - col) };
    setLane(note, lane);
    pattern.notes.push(note);
    sortNotes(pattern);
    return note;
}

/**
 * Put an OFF at `col` in `lane`: cut the note sounding there, or turn a
 * note starting there into the end of the one before.
 * @returns {boolean} whether anything changed — an OFF over silence is not
 *   storable (there is nothing to stop), so it is refused
 */
export function putOff(pattern, col, lane) {
    const d = freeze(pattern);
    const notes = inLane(pattern, d, lane);
    const here = notes.find(n => n.start === col);
    if (here) {
        pattern.notes.splice(pattern.notes.indexOf(here), 1);
        return true;
    }
    const sounding = notes.find(n => n.start < col && col < heldUntil(d, n));
    if (!sounding) return false;
    sounding.dur = col - sounding.start;
    return true;
}

/**
 * Clear the cell at `col` in `lane`.
 *   - a note: removed, and a note it had cut short (legato) gets its time;
 *   - an OFF: the note it ended holds on, to the lane's next note or the end.
 * @returns {'note'|'off'|null} what was cleared
 */
export function clearCell(pattern, col, lane) {
    const d = freeze(pattern);
    const notes = inLane(pattern, d, lane);
    const len = patternCols(pattern);
    const here = notes.find(n => n.start === col);
    if (here) {
        const prev = notes.find(n => n !== here && endOf(n) === col);
        if (prev) prev.dur = endOf(here) - prev.start;
        pattern.notes.splice(pattern.notes.indexOf(here), 1);
        return 'note';
    }
    const ended = notes.find(n => endOf(n) === col && !d.stolenAt.has(n));
    if (ended && col < len) {
        const next = notes.find(n => n.start > col);
        ended.dur = (next ? next.start : len) - ended.start;
        return 'off';
    }
    return null;
}
