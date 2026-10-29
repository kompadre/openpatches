// Transport — the one owner of the clock.
//
// Before this, the piano roll listened to the tick worker, decided what to
// play and drew its own playhead, while the toolbar separately started the
// worker for recording. Two owners of one clock is how a Play during a take
// used to route ticks to the wrong handler. Now the worker is subscribed to
// here, exactly once, and everything else listens to this.
//
// Two modes:
//   song    — play the arrangement (what the Song tab's Play does).
//   pattern — loop the pattern being edited (the roll's Play and Record):
//             one placement of that pattern, from its start to its end, and
//             never longer — a take is always one pattern long. A pattern
//             placed several times loops the placement nearest the song
//             position (`songPos`: the last song column played, or where
//             the Song tab parked it by opening a clip). A pattern placed
//             nowhere loops alone.
//
// Orthogonal to the mode: **accompaniment** (persisted). It decides whether
// the rest of the song is heard inside the pattern window, or only the
// pattern being written. It never changes the window — that is the mode's
// job, and the reason the two are separate settings.
//
// Recording runs in either. The clock is the same; what differs is where a
// recorded column lands, which is `mapRecordColumn()`.

import {
    createSongSequence, createPatternSequence, msPerColumn,
    patternPlacements, nearestPlacement,
} from './sequencer.js';
import { COLS_PER_MEASURE, clipSpan } from '../components/song-model.js';

const MODE_KEY = 'openpatches_transport_mode';
const ACCOMPANY_KEY = 'openpatches_transport_accompany';
export const MODES = ['song', 'pattern'];
const MAX_CONSECUTIVE_ERRORS = 3;

function loadAccompany() {
    try {
        return localStorage.getItem(ACCOMPANY_KEY) !== 'off';   // default: play along
    } catch { return true; }
}

function loadMode() {
    try {
        const m = localStorage.getItem(MODE_KEY);
        return MODES.includes(m) ? m : 'song';
    } catch { return 'song'; }
}

/**
 * @param {object} opts
 * @param {object} opts.session        the shared song session
 * @param {function} opts.getPattern   id → the live pattern (the roll's copy)
 * @param {function} opts.getEditTarget () → { trackId, clipId, pattern, slot } | null
 * @param {function} opts.playNote     (midi, durMs, voiceData, slot)
 * @param {function} opts.getSlotData  slot → voice bank entry
 * @param {function} [opts.onStop]     release whatever is still sounding
 */
export function createTransport(opts) {
    const {
        session, tickWorker, startWorker, stopWorker,
        playNote, getSlotData, getEditTarget, getPattern, onStop,
    } = opts;
    const log = opts.log || (() => {});

    let mode = loadMode();
    let accompany = loadAccompany();   // hear the rest of the song inside the pattern window
    let playing = false;
    let recording = false;
    let sequence = null;
    let lastCol = -1;
    let songPos = 0;          // song column the pattern loop anchors to (see header)
    let placement = null;     // the placement pattern mode is looping, null when alone
    let consecutiveErrors = 0;
    let warnedOutsideClip = false;
    const subscribers = new Set();

    function editTarget() {
        return getEditTarget ? getEditTarget() : null;
    }

    function buildSequence() {
        placement = null;
        if (mode === 'pattern') {
            const t = editTarget();
            if (!t || !t.pattern) return createPatternSequence(null, 0);
            const song = session.get();
            const places = patternPlacements(song, t.pattern.id, getPattern);
            if (places.length === 0) return createPatternSequence(t.pattern, t.slot);
            placement = nearestPlacement(places, songPos);
            return createSongSequence(song, getPattern, {
                onlyTrackId: accompany ? null : t.trackId,
                range: { startCol: placement.startCol, endCol: placement.endCol },
            });
        }
        return createSongSequence(session.get(), getPattern);
    }

    /** Rebuild after any edit — the sequencer snapshots patterns on purpose. */
    function refresh() {
        sequence = buildSequence();
        return sequence;
    }

    function getBpm() {
        return session.get().bpm;
    }

    function notify(extra = {}) {
        const t = editTarget();
        const col = extra.col != null ? extra.col : lastCol;
        let edit = null;
        if (col >= 0 && sequence) {
            if (mode === 'pattern' && placement) {
                edit = { clipId: placement.clipId, patternCol: col - placement.startCol };
            } else if (mode === 'pattern') {
                edit = t ? { clipId: t.clipId, patternCol: col } : null;
            } else if (t) {
                const here = sequence.locate(col).tracks[t.trackId];
                // Only when the clip under the playhead is the one being
                // edited: the same track may carry several clips.
                if (here && here.clipId === t.clipId) {
                    edit = { clipId: here.clipId, patternCol: here.patternCol };
                }
            }
        }
        // `songCol` is the position on the song's timeline, for the Song
        // tab's playhead: the same as `col` whenever the sequence is the
        // song (both modes, except a lone pattern), -1 otherwise.
        const songCol = col >= 0 && sequence && sequence.kind === 'song' ? col : -1;
        const pos = { playing, recording, mode, col, songCol, edit, seam: false, rawCol: -1, ...extra };
        for (const fn of [...subscribers]) {
            try { fn(pos); } catch (e) { console.warn('[transport] subscriber failed:', e); }
        }
    }

    function startWorkerAt(startCol) {
        const bpm = getBpm();
        if (startWorker) startWorker(tickWorker, bpm, startCol);
        else if (tickWorker) tickWorker.postMessage({ type: 'start', bpm, startCol });
    }

    function stopTheWorker() {
        if (stopWorker) stopWorker(tickWorker);
        else if (tickWorker) tickWorker.postMessage({ type: 'stop' });
    }

    /** Sound everything that begins at `col`, each voice on its own slot. */
    function fire(col) {
        const ms = msPerColumn(getBpm());
        for (const ev of sequence.eventsAt(col)) {
            // A note just played in by the user must not be echoed back at
            // them on the same pass; the flag is cleared at the loop seam.
            if (recording && ev.note && ev.note._recordedInSession) continue;
            try {
                const entry = getSlotData(ev.slot);
                playNote(ev.midi, ev.dur * ms, entry ? entry.voiceData : null, ev.slot);
                consecutiveErrors = 0;
            } catch (e) {
                consecutiveErrors++;
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    log('[transport] stopping after repeated playback errors');
                    stop();
                    return false;
                }
            }
        }
        return true;
    }

    function onTick(rawCol) {
        if (!playing && !recording) return;
        if (!sequence || !sequence.range) return;
        const col = sequence.columnForTick(rawCol);
        // The seam is the wrap back to the first column of the range; the
        // recorder finalises notes held across it.
        const seam = rawCol > 0 && col === sequence.range.startCol;
        lastCol = col;
        if (sequence.kind === 'song') songPos = col;
        if (!fire(col)) return;
        notify({ col, rawCol, seam });
    }

    if (tickWorker && tickWorker.addEventListener) {
        tickWorker.addEventListener('message', (e) => {
            if (!e.data || e.data.type !== 'tick') return;
            onTick(e.data.col);
        });
    }

    function hasAnythingToPlay() {
        if (!sequence || !sequence.range) return false;
        if (mode === 'pattern' && sequence.kind === 'pattern') {
            const t = editTarget();
            return !!(t && t.pattern && t.pattern.notes.length > 0);
        }
        if (mode === 'pattern' && !accompany) {
            const t = editTarget();
            return !!(t && t.pattern && t.pattern.notes.length > 0);
        }
        if (mode === 'pattern') {
            // Anything with notes inside the window counts — the backing
            // alone is worth hearing while the pattern is still empty.
            const { startCol, endCol } = sequence.range;
            return session.get().clips.some(c => {
                const p = getPattern(c.patternId);
                const span = p && clipSpan(c, p);
                return !!span && p.notes.length > 0
                    && span.start * COLS_PER_MEASURE < endCol && span.end * COLS_PER_MEASURE > startCol;
            });
        }
        return session.get().clips.some(c => {
            const p = getPattern(c.patternId);
            return !!p && p.notes.length > 0;
        });
    }

    /**
     * Start. `mode` names the scope the button means — the Song tab's Play
     * is song, the roll's is pattern — and is switched to (and remembered)
     * first; without it the current mode plays.
     */
    function play({ mode: wanted } = {}) {
        if (recording) return false;      // the take owns the clock
        if (wanted) api.setMode(wanted);
        if (playing) stop();
        refresh();
        if (!hasAnythingToPlay()) return false;
        playing = true;
        lastCol = sequence.range.startCol;
        consecutiveErrors = 0;
        notify({ col: lastCol });
        startWorkerAt(0);
        return true;
    }

    function stop() {
        const wasRunning = playing || recording;
        playing = false;
        recording = false;
        lastCol = -1;
        warnedOutsideClip = false;
        stopTheWorker();
        notify({ col: -1 });
        // Stopping the clock only stops new note-ons; whatever is ringing
        // has to be cut explicitly.
        if (wasRunning && onStop) onStop();
        return wasRunning;
    }

    /** Start a take. `mode` names the scope, as for play(). */
    function startRecording({ mode: wanted } = {}) {
        if (wanted) api.setMode(wanted);
        if (playing) stop();
        refresh();
        if (!sequence.range) {
            // Nothing placed yet: a pattern-length loop so the take has a
            // grid to land on.
            log('[transport] recording into an empty song');
        }
        recording = true;
        lastCol = sequence.range ? sequence.range.startCol : 0;
        consecutiveErrors = 0;
        warnedOutsideClip = false;
        notify({ col: lastCol });
        startWorkerAt(0);
        return true;
    }

    function stopRecording() {
        if (!recording) return false;
        return stop();
    }

    const api = {
        getMode() { return mode; },
        /**
         * Park the song position while at rest — what pattern mode anchors
         * its choice of placement to. The Song tab calls it when a clip is
         * opened, so that clip is the one that loops.
         */
        setSongPosition(col) {
            if (playing || recording) return false;
            songPos = Math.max(0, Math.floor(col) || 0);
            if (mode === 'pattern') refresh();
            return true;
        },
        getSongPosition() { return songPos; },
        /**
         * Is the rest of the song heard inside the pattern window? Takes
         * effect immediately, mid-take included: it changes what sounds,
         * never the loop, so there is no position to lose.
         */
        getAccompany() { return accompany; },
        setAccompany(on) {
            accompany = !!on;
            try { localStorage.setItem(ACCOMPANY_KEY, accompany ? 'on' : 'off'); } catch { /* ignore */ }
            refresh();
            return accompany;
        },
        getPlacement() { return placement; },
        /**
         * Switch mode. Stops first: the two modes have different ranges, so
         * carrying a column across would land the playhead anywhere.
         */
        setMode(next) {
            if (!MODES.includes(next) || next === mode) return mode;
            if (playing || recording) stop();
            mode = next;
            try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
            refresh();
            notify({ col: -1 });
            return mode;
        },
        play, stop, refresh, getBpm,
        startRecording, stopRecording,
        isPlaying() { return playing; },
        isRecording() { return recording; },
        isRunning() { return playing || recording; },
        getSequence() { return sequence; },
        getColumn() { return lastCol; },
        hasAnythingToPlay() { return hasAnythingToPlay(); },

        subscribe(fn) {
            subscribers.add(fn);
            return () => subscribers.delete(fn);
        },

        /**
         * Where a recorded column lands in the pattern being written to.
         * `absCol` counts sixteenths since the take began, which is also the
         * song column (both start at the range's first column).
         *
         * Three answers:
         *   { patternCol, clipId }  — a clip is under the playhead here
         *   { fresh: true }         — this voice has nothing placed at all,
         *                             so the caller should start one (the
         *                             first-note-on-an-empty-song flow)
         *   null                    — the voice has clips but none here:
         *                             the note was heard, there is nowhere
         *                             to write it
         */
        mapRecordColumn(absCol, slot) {
            if (mode === 'pattern' && sequence && sequence.kind === 'pattern') {
                const t = editTarget();
                if (!t || !t.pattern) return { fresh: true };
                const len = t.pattern.measures * COLS_PER_MEASURE;
                return {
                    patternCol: ((absCol % len) + len) % len,
                    clipId: t.clipId,
                    patternId: t.pattern.id,
                };
            }
            const song = session.get();
            const track = song.tracks.find(t => t.slot === slot);
            const placed = track && song.clips.some(c => c.trackId === track.id);
            if (!placed) return { fresh: true };
            if (!sequence || !sequence.range) return { fresh: true };
            const col = sequence.columnForTick(absCol);
            const here = sequence.locate(col).tracks[track.id];
            if (!here) {
                if (!warnedOutsideClip) {
                    warnedOutsideClip = true;
                    log(`[record] nothing placed on voice ${slot + 1} here — notes are heard but not recorded`);
                }
                return null;
            }
            return { patternCol: here.patternCol, clipId: here.clipId, patternId: here.patternId };
        },
    };
    return api;
}
