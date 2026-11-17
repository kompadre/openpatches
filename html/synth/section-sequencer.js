// Sequencer core — turns a Section of a Project (or a lone Pattern) into
// "what starts at column N, on which slot".
//
// Supersedes the Song-era sequencer. The difference is where
// the pieces come from: the **project** owns the tracks and the pattern
// library, the **section** owns the clips and the loop. A clip therefore
// needs both in hand to resolve, which is also why the cross-record
// invariants live in project-model's `normalizeProject()` rather than here.
//
// Pure: no DOM, no worker, no audio. The transport owns the tick worker and
// the clock; it calls `columnForTick(rawCol)` to map the worker's running
// count onto the section, then `eventsAt(col)` to get the notes to fire.
// Both editors use `locate(col)` to draw their playheads.
//
// Two deliberate properties, worth keeping:
//  - A sequence **snapshots** its patterns when created, so a tick is never
//    a store read. Editing a pattern or a clip needs a rebuild; the
//    transport re-creates on every change notification, which is cheap.
//  - Mute/solo are read **live** off the project's tracks, so toggling them
//    mid-playback takes effect on the next column without a rebuild. So is
//    a track's clock divider (see `trackColumn`).

import {
    COLS_PER_MEASURE, clipCols, patternCols as patternColsOf,
    audibleTracks, getPattern as getProjectPattern, pieceLayout, dividerOf, fxAt,
} from '../components/project-model.js';

/**
 * Where a placement's pattern is at section column `col`, under the track's
 * clock divider: a track divided by n advances its pattern one column every
 * n ticks, counted from the clip's start, so the pattern plays n times
 * slower inside the clip's span (a one-bar clip at ÷2 plays the pattern's
 * first half). `local` is the pattern-local column; `tick` says whether the
 * pattern advanced on this column at all — only then can a note start.
 * The divider is read live off the track, like mute and solo.
 */
function trackColumn(p, col) {
    const d = dividerOf(p.track.divider);
    const since = col - p.startCol;
    return {
        local: Math.floor(since / d) % p.patternCols,
        tick: since % d === 0,
        divider: d,
    };
}

/**
 * The ids of the tracks that may sound. The rule itself lives in
 * project-model beside `effectiveVolume()`, so the scheduler's view of who
 * is audible and the mixer's view of who is at zero gain cannot drift apart
 * — which is exactly what happened when the arrangement's track and the
 * voice bank entry each kept their own mute flag.
 */
export function audibleTrackIds(tracks) {
    return new Set(audibleTracks(tracks).map(t => t.id));
}

/**
 * The columns a section plays: its loop range if it has one (the loop is
 * set in whole bars), otherwise the whole section. `null` when there is
 * nothing to play — the transport treats that like an empty roll and
 * refuses to start.
 */
export function playbackRange(section, lengthCols) {
    if (section.loop) {
        return {
            startCol: section.loop.start * COLS_PER_MEASURE,
            endCol: section.loop.end * COLS_PER_MEASURE,
        };
    }
    if (lengthCols <= 0) return null;
    return { startCol: 0, endCol: lengthCols };
}

/** Map the worker's running count (0, 1, 2, …) onto a column in the range. */
export function wrapToRange(rawCol, range) {
    const len = range.endCol - range.startCol;
    return range.startCol + (((rawCol % len) + len) % len);
}

function emptySequence(kind) {
    return {
        kind,
        length: 0,
        range: null,
        columnForTick: () => 0,
        eventsAt: () => [],
        locate: () => ({ col: 0, measure: 0, colInMeasure: 0, tracks: {} }),
        tracks: () => [],
        commandAt: () => null,
    };
}

/**
 * Every place a pattern sounds in a section, one entry per repeat: a clip
 * of two bars repeated three times is three placements of two bars. Sorted
 * by start. This is what pattern mode loops over — one placement, with the
 * rest of the section playing along inside it.
 *
 * @returns {Array<{clipId, trackId, startCol, endCol}>}
 */
export function patternPlacements(project, section, patternId) {
    const out = [];
    const pattern = getProjectPattern(project, patternId);
    if (!pattern) return out;
    const patternCols = patternColsOf(pattern);
    for (const clip of section.clips) {
        if (clip.patternId !== patternId) continue;
        const span = clipCols(clip, pattern);
        if (!span) continue;
        // A clip may end part-way through a repeat; that last placement is
        // short, and looping it is what the roll's Play then hears.
        for (let at = span.startCol; at < span.endCol; at += patternCols) {
            out.push({
                clipId: clip.id, trackId: clip.trackId,
                startCol: at, endCol: Math.min(at + patternCols, span.endCol),
            });
        }
    }
    out.sort((a, b) => a.startCol - b.startCol);
    return out;
}

/**
 * The placement nearest a column: the one containing it if any, otherwise
 * the closest edge. Ties go to the earliest. A negative column (no position
 * yet) picks the first.
 */
export function nearestPlacement(placements, col) {
    if (placements.length === 0) return null;
    if (!(col >= 0)) return placements[0];
    let best = null;
    let bestDist = Infinity;
    for (const p of placements) {
        const dist = col < p.startCol ? p.startCol - col : col >= p.endCol ? col - p.endCol + 1 : 0;
        if (dist < bestDist) { best = p; bestDist = dist; }
    }
    return best;
}

/**
 * Compile a section. Every clip is resolved once: its pattern (a snapshot),
 * its absolute column span, and its track. Clips whose pattern or track is
 * missing are skipped — a dangling reference is silence, not a crash.
 * (`normalizeProject()` drops those on load; this guard is for a section
 * compiled mid-edit, before the body has been renormalised.)
 *
 * @param {object} project   supplies the tracks and the pattern library
 * @param {object} section   supplies the clips and the loop
 * @param {{
 *   range?: {startCol:number, endCol:number},  loop these columns instead of
 *           the section's own loop/length (pattern mode)
 *   onlyTrackId?: string,                      sound this track alone — the
 *           roll recording a pattern without the rest of the section
 * }} [opts]
 */
export function createSectionSequence(project, section, opts = {}) {
    const trackById = new Map(project.tracks.map(t => [t.id, t]));
    const placed = [];
    let lengthCols = 0;

    for (const clip of section.clips) {
        const pattern = getProjectPattern(project, clip.patternId);
        const track = trackById.get(clip.trackId);
        const span = clipCols(clip, pattern);
        if (!pattern || !track || !span) continue;
        const patternCols = patternColsOf(pattern);
        const entry = {
            clip,
            track,
            pattern,
            patternCols,
            startCol: span.startCol,
            endCol: span.endCol,
            // Notes indexed by pattern-local start column, so a tick is a
            // map lookup, not a scan of every note in every clip.
            notesByCol: indexNotes(pattern.notes),
        };
        placed.push(entry);
        if (entry.endCol > lengthCols) lengthCols = entry.endCol;
    }

    // A section plays to the end of the bar its last clip ends in, not to
    // the clip's own end: a clip cut to one beat would otherwise loop the
    // section every beat. Clips sit off the bar line; the arrangement does
    // not.
    const playCols = Math.ceil(lengthCols / COLS_PER_MEASURE) * COLS_PER_MEASURE;
    const range = opts.range || playbackRange(section, playCols);
    if (!range) return emptySequence('section');

    // Which placements cover a column — resolved per column on demand; a
    // section has tens of clips, so the scan is nothing next to a note-on.
    function placementsAt(col) {
        const out = [];
        for (const p of placed) {
            if (col >= p.startCol && col < p.endCol) out.push(p);
        }
        return out;
    }

    return {
        kind: 'section',
        /** Section length in columns (not the loop — the furthest clip end). */
        length: lengthCols,
        range,
        columnForTick(rawCol) {
            return wrapToRange(rawCol, range);
        },
        /**
         * Notes that start exactly at absolute column `col`, on audible
         * tracks. `dur` is in columns; the transport converts with the bpm.
         */
        eventsAt(col, trackId = null) {
            const audible = audibleTrackIds(project.tracks);
            const events = [];
            for (const p of placementsAt(col)) {
                if (trackId != null && p.track.id !== trackId) continue;
                if (opts.onlyTrackId && p.track.id !== opts.onlyTrackId) continue;
                if (!audible.has(p.track.id)) continue;
                const { local, tick, divider } = trackColumn(p, col);
                if (!tick) continue;
                const notes = p.notesByCol.get(local);
                if (!notes) continue;
                for (const n of notes) {
                    events.push({
                        midi: n.midi,
                        vel: n.vel,
                        // A divided track's notes last as many ticks as the
                        // pattern is slowed by. Cut at the clip's end: a clip
                        // stopped part-way through its pattern takes its
                        // notes with it.
                        dur: Math.min(n.dur * divider, p.endCol - col),
                        slot: p.track.slot,
                        trackId: p.track.id,
                        clipId: p.clip.id,
                        patternId: p.pattern.id,
                        // The note object itself: the recorder marks the
                        // notes it just wrote so they are not echoed back at
                        // the player on the same pass.
                        note: n,
                    });
                }
            }
            return events;
        },
        /**
         * The effects command on `trackId` at section row `row`, read live
         * off the section (like mute and solo): `{row, cmd, arg}` or null.
         */
        commandAt(trackId, row) {
            return fxAt(section, trackId, row);
        },
        /**
         * The tracks the Player walks: every track with a clip inside the
         * range, and where its last clip ends — **exactly**, never rounded
         * to the bar (a short track loops against the longer ones from
         * there), clipped to the range. A track with nothing in the range
         * is not listed: it takes no part in the Section's transition.
         */
        tracks() {
            const ends = new Map();
            for (const p of placed) {
                if (p.endCol <= range.startCol || p.startCol >= range.endCol) continue;
                const end = Math.min(p.endCol, range.endCol);
                if (!ends.has(p.track.id) || ends.get(p.track.id).end < end) {
                    ends.set(p.track.id, { trackId: p.track.id, slot: p.track.slot, end });
                }
            }
            return [...ends.values()].sort((a, b) => a.slot - b.slot);
        },
        /**
         * Where the playhead is, for drawing: the measure and the
         * pattern-local column on every track that has a clip under it.
         * Muted tracks are included — the playhead still moves over them.
         * A divided track's pattern column is the divided one — where its
         * pattern really is — so the roll's playhead matches what sounds.
         */
        locate(col) {
            const tracks = {};
            for (const p of placementsAt(col)) {
                tracks[p.track.id] = {
                    clipId: p.clip.id,
                    patternId: p.pattern.id,
                    patternCol: trackColumn(p, col).local,
                };
            }
            return {
                col,
                measure: Math.floor(col / COLS_PER_MEASURE),
                colInMeasure: col % COLS_PER_MEASURE,
                tracks,
            };
        },
    };
}

/**
 * The whole piece: every entry of the arrangement in order, end to end
 * (`pieceLayout`) — a section placed twice plays twice — each
 * compiled as a section sequence over its full length — a section's own
 * loop is for working on it, not for the piece. A column is handed to the
 * section it falls in, shifted into that section's own columns, so the
 * events, the playhead and the tempo are each section's own. An entry with
 * `repeats` plays its section that many times in a row: the column is
 * folded into one pass (`pass` says which), so every pass starts its
 * section — and its tempo ramp — from the top.
 */
export function createPieceSequence(project) {
    const layout = pieceLayout(project);
    const parts = layout.parts
        .filter(p => p.endCol > p.startCol)
        .map(p => ({
            ...p,
            seq: createSectionSequence(project, p.section, { range: { startCol: 0, endCol: p.passCols } }),
        }));
    if (parts.length === 0 || layout.total <= 0) return emptySequence('piece');
    const range = { startCol: 0, endCol: layout.total };

    /** The part a piece column falls in (the last one for the end column). */
    function partAt(col) {
        for (const p of parts) if (col >= p.startCol && col < p.endCol) return p;
        return parts[parts.length - 1];
    }

    /** A piece column inside its part: the pass, and the column in that pass. */
    function inPart(p, col) {
        const partCol = col - p.startCol;
        const pass = Math.min(p.repeats - 1, Math.max(0, Math.floor(partCol / p.passCols)));
        return { partCol, pass, col: partCol - pass * p.passCols };
    }

    return {
        kind: 'piece',
        length: layout.total,
        range,
        /** The piece's parts in order, each with its own section sequence (for the Player). */
        parts() { return parts; },
        tracks() { return []; },
        columnForTick(rawCol) { return wrapToRange(rawCol, range); },
        eventsAt(col) {
            const p = partAt(col);
            return p.seq.eventsAt(inPart(p, col).col);
        },
        locate(col) {
            const p = partAt(col);
            const at = inPart(p, col);
            const here = p.seq.locate(at.col);
            return { ...here, sectionId: p.section.id, entryId: p.entry.id, sectionCol: at.col, pass: at.pass };
        },
        /**
         * Which section a piece column is in, and the column inside it.
         * `entryId` says *which* placement of it — a chorus placed three
         * times is the same section at three entries. `col` is inside the
         * section (one pass); `partCol` counts from the entry's start, over
         * all its passes; `pass` is which one, from 0.
         */
        localize(col) {
            const p = partAt(col);
            const at = inPart(p, col);
            return {
                section: p.section, sectionId: p.section.id, entryId: p.entry.id,
                col: at.col, partCol: at.partCol, pass: at.pass, repeats: p.repeats,
            };
        },
    };
}

/**
 * A lone pattern: loop one pattern on one slot. Pattern mode uses this only
 * for a pattern placed nowhere in the section (otherwise it loops the
 * section over one placement — see the transport). Same interface, so the
 * transport has one code path. The pattern object is read live (the editor
 * is mutating it); only the note scan is per column, which is cheap for one
 * pattern.
 */
export function createPatternSequence(pattern, slot) {
    if (!pattern) return emptySequence('pattern');
    const patternCols = () => pattern.measures * COLS_PER_MEASURE;
    const trackId = 'pattern';

    return {
        kind: 'pattern',
        get length() { return patternCols(); },
        get range() { return { startCol: 0, endCol: patternCols() }; },
        columnForTick(rawCol) {
            const len = patternCols();
            return ((rawCol % len) + len) % len;
        },
        eventsAt(col) {
            const events = [];
            for (const n of pattern.notes) {
                if (n.start !== col) continue;
                events.push({ midi: n.midi, dur: n.dur, slot, trackId, clipId: null, patternId: pattern.id, note: n });
            }
            return events;
        },
        locate(col) {
            return {
                col,
                measure: Math.floor(col / COLS_PER_MEASURE),
                colInMeasure: col % COLS_PER_MEASURE,
                tracks: { [trackId]: { clipId: null, patternId: pattern.id, patternCol: col } },
            };
        },
        tracks() { return [{ trackId, slot, end: patternCols() }]; },
        commandAt() { return null; },
    };
}

function indexNotes(notes) {
    const map = new Map();
    for (const n of notes) {
        let list = map.get(n.start);
        if (!list) { list = []; map.set(n.start, list); }
        list.push(n);
    }
    return map;
}

/** Milliseconds per sixteenth note at a tempo — the one timing formula. */
export function msPerColumn(bpm) {
    return 60000 / bpm / 4;
}
