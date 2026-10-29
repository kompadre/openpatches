// Sequencer core — turns a Song (or a lone Pattern) into "what starts at
// column N, on which slot".
//
// Pure: no DOM, no worker, no audio. The transport owns the tick worker and
// the clock; it calls `columnForTick(rawCol)` to map the worker's running
// count onto the song, then `eventsAt(col)` to get the notes to fire. Both
// editors use `locate(col)` to draw their playheads.
//
// Two deliberate properties:
//  - A sequence **snapshots** its patterns when created. patternStore.get()
//    parses localStorage; that must never happen on a tick. Editing a
//    pattern or a clip therefore needs `createSongSequence()` again — the
//    transport re-creates on every change notification, which is cheap.
//  - Mute/solo are read **live** from the song's track objects, so toggling
//    them mid-playback takes effect on the next column without a rebuild.

import { COLS_PER_MEASURE, clipSpan } from '../components/song-model.js';

/**
 * Tracks that may sound: the soloed ones if any are soloed, otherwise the
 * unmuted ones. Solo wins over mute on the same track (soloing a muted
 * track is a request to hear it).
 */
export function audibleTrackIds(tracks) {
    const soloed = tracks.filter(t => t.solo);
    const pool = soloed.length > 0 ? soloed : tracks.filter(t => !t.mute);
    return new Set(pool.map(t => t.id));
}

/**
 * The columns a song plays: its loop range if it has one (measures →
 * columns), otherwise the whole song. `null` when there is nothing to play —
 * the transport treats that like the empty piano roll and refuses to start.
 */
export function playbackRange(song, lengthMeasures) {
    if (song.loop) {
        return {
            startCol: song.loop.start * COLS_PER_MEASURE,
            endCol: song.loop.end * COLS_PER_MEASURE,
        };
    }
    if (lengthMeasures <= 0) return null;
    return { startCol: 0, endCol: lengthMeasures * COLS_PER_MEASURE };
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
    };
}

/**
 * Every place a pattern sounds in a song, one entry per repeat: a clip of
 * two bars repeated three times is three placements of two bars. Sorted by
 * start. This is what pattern mode loops over — one placement, with the
 * rest of the song playing along inside it.
 *
 * @returns {Array<{clipId, trackId, startCol, endCol}>}
 */
export function patternPlacements(song, patternId, getPattern) {
    const out = [];
    const pattern = getPattern(patternId);
    if (!pattern) return out;
    const patternCols = pattern.measures * COLS_PER_MEASURE;
    for (const clip of song.clips) {
        if (clip.patternId !== patternId) continue;
        const span = clipSpan(clip, pattern);
        if (!span) continue;
        for (let r = 0; r < clip.repeats; r++) {
            const startCol = span.start * COLS_PER_MEASURE + r * patternCols;
            out.push({ clipId: clip.id, trackId: clip.trackId, startCol, endCol: startCol + patternCols });
        }
    }
    out.sort((a, b) => a.startCol - b.startCol);
    return out;
}

/**
 * The placement nearest a song column: the one containing it if any,
 * otherwise the closest edge. Ties go to the earliest. A negative column
 * (no position yet) picks the first.
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
 * Compile a song. Every clip is resolved once: its pattern (a snapshot),
 * its absolute column span, and its track. Clips whose pattern or track is
 * missing are skipped — a dangling reference is silence, not a crash.
 *
 * @param {object} song
 * @param {(id: string) => object|null} getPattern
 * @param {{
 *   range?: {startCol:number, endCol:number},  loop these columns instead of
 *           the song's own loop/length (pattern mode)
 *   onlyTrackId?: string,                      sound this track alone — the
 *           roll recording a pattern without the rest of the song
 * }} [opts]
 */
export function createSongSequence(song, getPattern, opts = {}) {
    const trackById = new Map(song.tracks.map(t => [t.id, t]));
    const placed = [];
    let lengthCols = 0;

    for (const clip of song.clips) {
        const pattern = getPattern(clip.patternId);
        const track = trackById.get(clip.trackId);
        const span = clipSpan(clip, pattern);
        if (!pattern || !track || !span) continue;
        const patternCols = pattern.measures * COLS_PER_MEASURE;
        const entry = {
            clip,
            track,
            pattern,
            patternCols,
            startCol: span.start * COLS_PER_MEASURE,
            endCol: span.end * COLS_PER_MEASURE,
            // Notes indexed by pattern-local start column, so a tick is a
            // map lookup, not a scan of every note in every clip.
            notesByCol: indexNotes(pattern.notes),
        };
        placed.push(entry);
        if (entry.endCol > lengthCols) lengthCols = entry.endCol;
    }

    const lengthMeasures = lengthCols / COLS_PER_MEASURE;
    const range = opts.range || playbackRange(song, lengthMeasures);
    if (!range) return emptySequence('song');

    // Which placements cover a column — resolved per column on demand; a
    // song has tens of clips, so the scan is nothing next to a note-on.
    function placementsAt(col) {
        const out = [];
        for (const p of placed) {
            if (col >= p.startCol && col < p.endCol) out.push(p);
        }
        return out;
    }

    return {
        kind: 'song',
        /** Song length in columns (not the loop — the furthest clip end). */
        length: lengthCols,
        range,
        columnForTick(rawCol) {
            return wrapToRange(rawCol, range);
        },
        /**
         * Notes that start exactly at absolute column `col`, on audible
         * tracks. `dur` is in columns; the transport converts with the bpm.
         */
        eventsAt(col) {
            const audible = audibleTrackIds(song.tracks);
            const events = [];
            for (const p of placementsAt(col)) {
                if (opts.onlyTrackId && p.track.id !== opts.onlyTrackId) continue;
                if (!audible.has(p.track.id)) continue;
                const local = (col - p.startCol) % p.patternCols;
                const notes = p.notesByCol.get(local);
                if (!notes) continue;
                for (const n of notes) {
                    events.push({
                        midi: n.midi,
                        dur: n.dur,
                        slot: p.track.slot,
                        trackId: p.track.id,
                        clipId: p.clip.id,
                        patternId: p.pattern.id,
                        // The note object itself: the recorder marks the
                        // notes it just wrote so they are not echoed back
                        // at the player on the same pass.
                        note: n,
                    });
                }
            }
            return events;
        },
        /**
         * Where the playhead is, for drawing: the song measure and the
         * pattern-local column on every track that has a clip under it.
         * Muted tracks are included — the playhead still moves over them.
         */
        locate(col) {
            const tracks = {};
            for (const p of placementsAt(col)) {
                tracks[p.track.id] = {
                    clipId: p.clip.id,
                    patternId: p.pattern.id,
                    patternCol: (col - p.startCol) % p.patternCols,
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
 * A lone pattern: loop one pattern on one slot. Pattern mode uses this only
 * for a pattern placed nowhere in the song (otherwise it loops the song
 * over one placement, see the transport). Same interface as a song
 * sequence, so the transport has one code path. The pattern object is read live (the editor is mutating it), only
 * the note index is rebuilt per column, which is cheap for one pattern.
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
