// Sequencer data model: Patterns, Tracks, Clips, Songs.
//
// A **Pattern** is a reusable bar or more of notes. It is monotimbral: the
// notes carry no voice, so the same pattern can be played by any voice.
// (`kind` is the hook for the multitimbral/drum patterns planned later.)
//
// A **Song** arranges patterns as **clips** on **tracks**. A track is bound
// to a voice-bank slot, which is also the synth channel and the MIDI output
// channel — that mapping is unchanged from the piano-roll era. A pattern can
// appear in many clips, in many songs; that is the point of the split.
//
// Pure data and localStorage. No DOM, no audio, no MIDI. patch-model.js owns
// patches/canvas/jobs; this file owns the sequencer side.

import { songStore as legacySongStore } from './patch-model.js';

// 16 sixteenth notes to the bar. pianoroll.js has its own copy of this
// constant today; phase 3 makes it import this one.
export const COLS_PER_MEASURE = 16;
export const MAX_SLOTS = 8;      // voice bank size — slot IS the channel
export const MIN_BPM = 32;
export const MAX_BPM = 255;
export const DEFAULT_BPM = 120;
export const PATTERN_KINDS = ['mono'];

const PATTERNS_KEY = 'openpatches_patterns';
const SONGS_KEY = 'openpatches_arrangements';
const MIGRATION_KEY = 'openpatches_seq_migrated';
const LEGACY_ROLL_KEY = 'openpatches_pianoroll';

// --- Small helpers ---

function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function clampInt(v, min, max, fallback) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function nonEmptyName(name, fallback) {
    const s = String(name == null ? '' : name).trim();
    return s || fallback;
}

// --- Factories ---
//
// Every factory is total: it takes anything (storage, a file, a hand-edited
// blob) and returns a well-formed record. Invalid pieces are dropped, not
// thrown over — stored data is not a contract we control.

/**
 * @param {object} partial
 * @returns {{id, name, kind, measures, notes: Array<{midi,start,dur}>, created}}
 */
export function createPattern(partial = {}) {
    const measures = clampInt(partial.measures, 1, 256, 1);
    const cols = measures * COLS_PER_MEASURE;
    const notes = [];
    for (const n of Array.isArray(partial.notes) ? partial.notes : []) {
        const note = normalizeNote(n, cols);
        if (note) notes.push(note);
    }
    notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
    return {
        id: partial.id || uid('pat'),
        name: nonEmptyName(partial.name, 'Pattern'),
        kind: PATTERN_KINDS.includes(partial.kind) ? partial.kind : 'mono',
        measures,
        notes,
        created: partial.created || Date.now(),
    };
}

/**
 * A note that starts past the end of the pattern is unreachable, so it is
 * dropped; one that merely runs past the end is cut at the end, the same
 * rule the piano roll's resize handle enforces.
 */
function normalizeNote(n, cols) {
    if (!n || typeof n !== 'object') return null;
    const midi = Math.round(Number(n.midi));
    const start = Math.round(Number(n.start));
    if (!Number.isFinite(midi) || midi < 0 || midi > 127) return null;
    if (!Number.isFinite(start) || start < 0 || start >= cols) return null;
    const dur = clampInt(n.dur, 1, cols - start, 1);
    return { midi, start, dur };
}

export function createTrack(partial = {}) {
    return {
        id: partial.id || uid('trk'),
        name: nonEmptyName(partial.name, 'Track'),
        slot: clampInt(partial.slot, 0, MAX_SLOTS - 1, 0),
        mute: partial.mute === true,
        solo: partial.solo === true,
    };
}

export function createClip(partial = {}) {
    return {
        id: partial.id || uid('clip'),
        trackId: partial.trackId || null,
        patternId: partial.patternId || null,
        startMeasure: clampInt(partial.startMeasure, 0, 4096, 0),
        repeats: clampInt(partial.repeats, 1, 256, 1),
    };
}

export function createSong(partial = {}) {
    const tracks = (Array.isArray(partial.tracks) ? partial.tracks : []).map(createTrack);
    const known = new Set(tracks.map(t => t.id));
    // A clip whose track is gone has nowhere to sound; drop it rather than
    // keep an orphan the editor would have to render somewhere.
    const clips = (Array.isArray(partial.clips) ? partial.clips : [])
        .map(createClip)
        .filter(c => c.patternId && known.has(c.trackId));
    return {
        id: partial.id || uid('song'),
        name: nonEmptyName(partial.name, 'Song'),
        bpm: clampInt(partial.bpm, MIN_BPM, MAX_BPM, DEFAULT_BPM),
        tracks,
        clips,
        loop: normalizeLoop(partial.loop),
        // Carried over from the legacy snapshot songs so sounds still travel
        // with notes. Project (TODO.md) takes ownership of the voice bank and
        // this goes away.
        voiceBank: Array.isArray(partial.voiceBank) ? partial.voiceBank : null,
        created: partial.created || Date.now(),
    };
}

function normalizeLoop(loop) {
    if (!loop || typeof loop !== 'object') return null;
    const start = clampInt(loop.start, 0, 4096, NaN);
    const end = clampInt(loop.end, 0, 4096, NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return { start, end };
}

// --- Geometry ---

export function patternCols(pattern) {
    return (pattern ? pattern.measures : 1) * COLS_PER_MEASURE;
}

/**
 * Where a clip sits, in measures: [start, end). Needs the pattern because
 * the length of a clip is the pattern's length times its repeat count.
 * Returns null when the pattern is missing (a dangling reference).
 */
export function clipSpan(clip, pattern) {
    if (!clip || !pattern) return null;
    const len = pattern.measures * clip.repeats;
    return { start: clip.startMeasure, end: clip.startMeasure + len };
}

/** Song length in measures — the furthest clip end, 0 for an empty song. */
export function songLength(song, getPattern) {
    let end = 0;
    for (const clip of song.clips) {
        const span = clipSpan(clip, getPattern(clip.patternId));
        if (span && span.end > end) end = span.end;
    }
    return end;
}

/**
 * The clip already occupying any measure `clip` wants, on the same track.
 * One clip per track per measure: tracks are monophonic timelines, so two
 * clips in the same place would mean two patterns on one voice.
 */
export function findClipOverlap(song, clip, getPattern, ignoreClipId) {
    const span = clipSpan(clip, getPattern(clip.patternId));
    if (!span) return null;
    for (const other of song.clips) {
        if (other.id === clip.id || other.id === ignoreClipId) continue;
        if (other.trackId !== clip.trackId) continue;
        const otherSpan = clipSpan(other, getPattern(other.patternId));
        if (!otherSpan) continue;
        if (span.start < otherSpan.end && otherSpan.start < span.end) return other;
    }
    return null;
}

/**
 * Add a clip, refusing an overlap with 'Clip overlaps' (the UI shows store
 * errors verbatim, as the legacy song bar did with 'Song exists'). Mutates
 * and returns the song; the caller persists it.
 */
export function addClip(song, partial, getPattern) {
    const clip = createClip(partial);
    if (!clip.patternId) throw new Error('Clip has no pattern');
    if (!song.tracks.some(t => t.id === clip.trackId)) throw new Error('Clip has no track');
    if (!getPattern(clip.patternId)) throw new Error('Clip pattern is missing');
    if (findClipOverlap(song, clip, getPattern)) throw new Error('Clip overlaps');
    song.clips.push(clip);
    return clip;
}

/** Move/resize an existing clip, refusing an overlap. Returns the clip. */
export function updateClip(song, clipId, changes, getPattern) {
    const clip = song.clips.find(c => c.id === clipId);
    if (!clip) throw new Error('Clip not found');
    const next = createClip({ ...clip, ...changes, id: clip.id });
    if (!song.tracks.some(t => t.id === next.trackId)) throw new Error('Clip has no track');
    if (!getPattern(next.patternId)) throw new Error('Clip pattern is missing');
    if (findClipOverlap(song, next, getPattern, clipId)) throw new Error('Clip overlaps');
    Object.assign(clip, next);
    return clip;
}

export function removeClip(song, clipId) {
    const i = song.clips.findIndex(c => c.id === clipId);
    if (i < 0) return false;
    song.clips.splice(i, 1);
    return true;
}

/** Removing a track takes its clips with it — they cannot sound without it. */
export function removeTrack(song, trackId) {
    const i = song.tracks.findIndex(t => t.id === trackId);
    if (i < 0) return false;
    song.tracks.splice(i, 1);
    song.clips = song.clips.filter(c => c.trackId !== trackId);
    return true;
}

// --- Storage ---

function loadMap(key) {
    try {
        const map = JSON.parse(localStorage.getItem(key) || '{}');
        return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    } catch { return {}; }
}

function saveMap(key, map, label) {
    try {
        localStorage.setItem(key, JSON.stringify(map));
    } catch (e) {
        console.warn(label + ' save failed:', e);
    }
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/**
 * Patterns and songs are keyed by id, not by name: the editors can rename
 * freely and two patterns may legitimately share a name. (The legacy song
 * store was name-keyed, which is why it had to refuse collisions.)
 */
function makeStore(key, factory, label) {
    return {
        list() {
            return Object.values(loadMap(key)).map(factory).sort(byName);
        },
        get(id) {
            const rec = loadMap(key)[id];
            return rec ? factory(rec) : null;
        },
        has(id) {
            return Object.prototype.hasOwnProperty.call(loadMap(key), id);
        },
        /** Normalize, store, return the stored record. */
        put(record) {
            const rec = factory(record);
            const map = loadMap(key);
            map[rec.id] = rec;
            saveMap(key, map, label);
            return rec;
        },
        create(partial) {
            // A fresh id even if the caller passed one — create() never
            // overwrites; put() is the way to update.
            return this.put(factory({ ...partial, id: undefined }));
        },
        remove(id) {
            const map = loadMap(key);
            if (!Object.prototype.hasOwnProperty.call(map, id)) return false;
            delete map[id];
            saveMap(key, map, label);
            return true;
        },
        bulkPut(records) {
            const map = loadMap(key);
            const out = [];
            for (const r of records) {
                const rec = factory(r);
                map[rec.id] = rec;
                out.push(rec);
            }
            saveMap(key, map, label);
            return out;
        },
        clear() {
            localStorage.removeItem(key);
        },
    };
}

export const patternStore = makeStore(PATTERNS_KEY, createPattern, 'patternStore');
export const songStore = makeStore(SONGS_KEY, createSong, 'songStore');

/** Ids of the songs that reference a pattern — the delete confirmation. */
export function patternUsage(patternId) {
    return songStore.list()
        .filter(song => song.clips.some(c => c.patternId === patternId))
        .map(song => song.id);
}

/** Read a pattern from the store; the shape the geometry helpers want. */
export const getStoredPattern = (id) => patternStore.get(id);

// --- Migration ---
//
// The piano roll stored one flat note list whose per-note `slot` was the
// voice. That is exactly a song of single-measure-aligned clips: group the
// notes by slot, and each group becomes one pattern on one track.

/**
 * Split a legacy note list into one note array per slot, keyed by slot,
 * in ascending slot order. Notes lose their `slot` — the track carries it.
 */
export function splitNotesBySlot(notes) {
    const bySlot = new Map();
    for (const n of Array.isArray(notes) ? notes : []) {
        if (!n || typeof n !== 'object') continue;
        const slot = clampInt(n.slot, 0, MAX_SLOTS - 1, 0);
        if (!bySlot.has(slot)) bySlot.set(slot, []);
        bySlot.get(slot).push({ midi: n.midi, start: n.start, dur: n.dur });
    }
    return new Map([...bySlot.entries()].sort((a, b) => a[0] - b[0]));
}

/**
 * Convert one legacy roll ({notes, bpm, measures, slots}) into a song plus
 * the patterns it references. Every pattern starts at measure 0 — the roll
 * was one looping bar set, all slots sounding together.
 *
 * @returns {{song, patterns}} neither is stored; the caller decides.
 */
export function songFromLegacyRoll(roll, name, opts = {}) {
    const data = roll || {};
    const measures = clampInt(data.measures, 1, 256, 1);
    const slotName = opts.slotName || ((slot) => `Slot ${slot + 1}`);
    const patterns = [];
    const tracks = [];
    const clips = [];

    for (const [slot, notes] of splitNotesBySlot(data.notes)) {
        const pattern = createPattern({
            name: `${name} — ${slotName(slot)}`,
            measures,
            notes,
        });
        // An empty group cannot happen (slots come from the notes), but a
        // group whose notes were all invalid can.
        if (pattern.notes.length === 0) continue;
        const track = createTrack({ name: slotName(slot), slot });
        patterns.push(pattern);
        tracks.push(track);
        clips.push(createClip({ trackId: track.id, patternId: pattern.id, startMeasure: 0, repeats: 1 }));
    }

    const song = createSong({
        name,
        bpm: data.bpm,
        tracks,
        clips,
        voiceBank: Array.isArray(data.slots) ? data.slots : null,
    });
    return { song, patterns };
}

function readLegacyRoll() {
    try {
        const raw = localStorage.getItem(LEGACY_ROLL_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        return data && typeof data === 'object' ? data : null;
    } catch { return null; }
}

/**
 * Convert the working roll and every saved legacy song into patterns and
 * songs. Pure: reads the legacy stores, writes nothing.
 *
 * @returns {{patterns: Array, songs: Array, currentSongId: string|null}}
 *   `currentSongId` is the song made from the working roll, if there was one.
 */
export function buildMigration() {
    const patterns = [];
    const songs = [];
    let currentSongId = null;

    const roll = readLegacyRoll();
    const hasRollNotes = roll && Array.isArray(roll.notes) && roll.notes.length > 0;
    if (hasRollNotes) {
        const { song, patterns: pats } = songFromLegacyRoll(roll, 'Untitled song');
        if (song.clips.length > 0) {
            patterns.push(...pats);
            songs.push(song);
            currentSongId = song.id;
        }
    }

    for (const name of legacySongStore.list()) {
        const rec = legacySongStore.get(name);
        if (!rec) continue;
        const { song, patterns: pats } = songFromLegacyRoll(rec.data, name);
        patterns.push(...pats);
        songs.push(song);
    }

    return { patterns, songs, currentSongId };
}

export function hasMigrated() {
    return localStorage.getItem(MIGRATION_KEY) != null;
}

/**
 * Run the migration once, the first time the sequencer loads. Idempotent:
 * guarded by a version key, so a second call is a no-op and cannot duplicate
 * patterns. The legacy keys are deliberately left in place — this release can
 * be rolled back, and phase 6 removes them.
 *
 * @returns {{migrated: boolean, patterns: number, songs: number, currentSongId: string|null}}
 */
export function migrateIfNeeded() {
    if (hasMigrated()) {
        return { migrated: false, patterns: 0, songs: 0, currentSongId: null };
    }
    const { patterns, songs, currentSongId } = buildMigration();
    patternStore.bulkPut(patterns);
    songStore.bulkPut(songs);
    // Written last: if a quota error aborts the writes above, the next load
    // tries again rather than leaving a half-migrated library marked done.
    try {
        localStorage.setItem(MIGRATION_KEY, JSON.stringify({ at: Date.now(), version: 1 }));
    } catch (e) {
        console.warn('migration marker save failed:', e);
    }
    return { migrated: true, patterns: patterns.length, songs: songs.length, currentSongId };
}
