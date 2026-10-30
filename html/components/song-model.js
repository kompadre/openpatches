// Sequencer data model: Patterns, Tracks, Clips, Songs.
//
// A **Pattern** is a reusable bar or more of notes. It is monotimbral: the
// notes carry no voice, so the same pattern can be played by any voice.
// (`kind` is the hook for the multitimbral/drum patterns planned later.)
//
// A **Clip** is a pattern placed on a track. Its geometry is in **columns**
// (sixteenths), not bars, so a clip can start and end part-way through a
// bar; `clipCols()` is the one place that resolves it.
//
// A **Song** arranges patterns as **clips** on **tracks**. A track is bound
// to a voice-bank slot, which is also the synth channel and the MIDI output
// channel — that mapping is unchanged from the piano-roll era. A pattern can
// appear in many clips, in many songs; that is the point of the split.
//
// Pure data and localStorage. No DOM, no audio, no MIDI. patch-model.js owns
// patches/canvas/jobs; this file owns the sequencer side.

// 16 sixteenth notes to the bar. pianoroll.js has its own copy of this
// constant today; phase 3 makes it import this one.
export const COLS_PER_MEASURE = 16;
export const MAX_SLOTS = 8;      // voice bank size — slot IS the channel
export const MIN_BPM = 32;
export const MAX_BPM = 255;
export const DEFAULT_BPM = 120;
export const PATTERN_KINDS = ['mono'];
// A clip cannot start past, or run past, bar 4097. Generous: the point is
// to keep a hand-edited record from producing a grid megapixels wide.
const MAX_CLIP_COL = 4096 * COLS_PER_MEASURE;

const PATTERNS_KEY = 'openpatches_patterns';
const SONGS_KEY = 'openpatches_arrangements';
const MIGRATION_KEY = 'openpatches_seq_migrated';
const LEGACY_ROLL_KEY = 'openpatches_pianoroll';
const LEGACY_SONGS_KEY = 'openpatches_songs';

// Bumped when a new pass is needed. v1 converted the piano-roll blob and the
// songs saved at that moment; v2 picks up the ones the song bar wrote
// afterwards, since it kept using the old store until it was removed.
const MIGRATION_VERSION = 2;

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

// Pattern colours. Deliberately a different set from the voice-bank slot
// colours (voicebank.js PATCH_COLORS): a track is tinted with its voice, a
// clip is painted with its pattern, and the two must read as two things.
export const PATTERN_COLORS = [
    '#d84a6b', '#e0803a', '#c9a227', '#6fa83b', '#2fa58a', '#3b8fd1',
    '#6a5fd6', '#b05bc0', '#d05a9a', '#8c8c3a', '#3aa0b8', '#a0623a',
];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A stable default: the same id always gets the same colour. */
export function defaultPatternColor(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PATTERN_COLORS[h % PATTERN_COLORS.length];
}

// --- Factories ---
//
// Every factory is total: it takes anything (storage, a file, a hand-edited
// blob) and returns a well-formed record. Invalid pieces are dropped, not
// thrown over — stored data is not a contract we control.

/**
 * @param {object} partial
 * @returns {{id, name, kind, color, measures, notes: Array<{midi,start,dur}>, created}}
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
    const id = partial.id || uid('pat');
    return {
        id,
        name: nonEmptyName(partial.name, 'Pattern'),
        kind: PATTERN_KINDS.includes(partial.kind) ? partial.kind : 'mono',
        color: HEX_COLOR.test(partial.color) ? partial.color.toLowerCase() : defaultPatternColor(id),
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

/**
 * A clip is a pattern placed on a track, at `startCol` (`startMeasure` is
 * the old spelling, still read).
 *
 * Its length is either **its own** — `lengthCols`, what dragging the clip's
 * edge sets, free-form so the clip may end part-way through a repeat — or
 * **its pattern's**: `repeats` whole pattern lengths, which follow the
 * pattern as the pattern grows. Exactly one of the two is stored, so there
 * is never a stale second opinion; `clipCols()` resolves them, because the
 * length of a repeat is not knowable without the pattern and this factory
 * does not have one. Pass `lengthCols: null` to go back to following.
 */
export function createClip(partial = {}) {
    const startCol = partial.startCol != null
        ? clampInt(partial.startCol, 0, MAX_CLIP_COL, 0)
        : clampInt(partial.startMeasure, 0, 4096, 0) * COLS_PER_MEASURE;
    const clip = {
        id: partial.id || uid('clip'),
        trackId: partial.trackId || null,
        patternId: partial.patternId || null,
        startCol,
    };
    if (partial.lengthCols != null) clip.lengthCols = clampInt(partial.lengthCols, 1, MAX_CLIP_COL, COLS_PER_MEASURE);
    else clip.repeats = clampInt(partial.repeats, 1, 256, 1);
    return clip;
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
 * Where a clip sits, in columns: [startCol, endCol). Needs the pattern,
 * which is what a repeat's length is measured in. Returns null when the
 * pattern is missing (a dangling reference).
 */
export function clipCols(clip, pattern) {
    if (!clip || !pattern) return null;
    const len = clip.lengthCols != null ? clip.lengthCols : patternCols(pattern) * clip.repeats;
    return { startCol: clip.startCol, endCol: clip.startCol + len };
}

/** How many times a clip plays its pattern — fractional for a cut-short one. */
export function clipRepeats(clip, pattern) {
    const span = clipCols(clip, pattern);
    if (!span) return 0;
    return (span.endCol - span.startCol) / patternCols(pattern);
}

/** Song length in columns — the furthest clip end, 0 for an empty song. */
export function songLengthCols(song, getPattern) {
    let end = 0;
    for (const clip of song.clips) {
        const span = clipCols(clip, getPattern(clip.patternId));
        if (span && span.endCol > end) end = span.endCol;
    }
    return end;
}

/**
 * Song length in whole measures — the bar the furthest clip ends in, so a
 * clip finishing mid-bar still gets a whole bar of grid to sit on.
 */
export function songLength(song, getPattern) {
    return Math.ceil(songLengthCols(song, getPattern) / COLS_PER_MEASURE);
}

/**
 * The clip already occupying any column `clip` wants, on the same track.
 * One clip per track per column: tracks are monophonic timelines, so two
 * clips in the same place would mean two patterns on one voice.
 */
export function findClipOverlap(song, clip, getPattern, ignoreClipId) {
    const span = clipCols(clip, getPattern(clip.patternId));
    if (!span) return null;
    for (const other of song.clips) {
        if (other.id === clip.id || other.id === ignoreClipId) continue;
        if (other.trackId !== clip.trackId) continue;
        const otherSpan = clipCols(other, getPattern(other.patternId));
        if (!otherSpan) continue;
        if (span.startCol < otherSpan.endCol && otherSpan.startCol < span.endCol) return other;
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

/**
 * The caller's changes in the fields a clip actually stores. Needed because
 * the changes are spread over the existing record: `{startMeasure: 2}` on a
 * record that already has `startCol` would otherwise be read straight past,
 * and the move would silently do nothing.
 */
function canonicalChanges(changes) {
    const next = { ...changes };
    if (next.startMeasure != null) {
        if (next.startCol == null) next.startCol = clampInt(next.startMeasure, 0, 4096, 0) * COLS_PER_MEASURE;
        delete next.startMeasure;
    }
    // Asking for repeats is asking the clip to follow its pattern again, so
    // a length of its own has to go.
    if (next.repeats != null && next.lengthCols === undefined) next.lengthCols = null;
    return next;
}

/** Move/resize an existing clip, refusing an overlap. Returns the clip. */
export function updateClip(song, clipId, changes, getPattern) {
    const clip = song.clips.find(c => c.id === clipId);
    if (!clip) throw new Error('Clip not found');
    const next = createClip({ ...clip, ...canonicalChanges(changes), id: clip.id });
    if (!song.tracks.some(t => t.id === next.trackId)) throw new Error('Clip has no track');
    if (!getPattern(next.patternId)) throw new Error('Clip pattern is missing');
    if (findClipOverlap(song, next, getPattern, clipId)) throw new Error('Clip overlaps');
    // Assigned key by key, after clearing the two length spellings: exactly
    // one of them is ever stored, and a leftover would be a stale opinion.
    delete clip.lengthCols;
    delete clip.repeats;
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
        clips.push(createClip({ trackId: track.id, patternId: pattern.id, startCol: 0, repeats: 1 }));
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

/**
 * The old name-keyed song store, read straight from its key. patch-model.js
 * no longer exports it — this is the only code left that knows the shape.
 */
function readLegacySongs() {
    try {
        const map = JSON.parse(localStorage.getItem(LEGACY_SONGS_KEY) || '{}');
        if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
        return Object.keys(map)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
            .map(name => ({ name, data: map[name] && map[name].data }))
            .filter(rec => rec.data && typeof rec.data === 'object');
    } catch { return []; }
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

    for (const rec of readLegacySongs()) {
        const { song, patterns: pats } = songFromLegacyRoll(rec.data, rec.name);
        patterns.push(...pats);
        songs.push(song);
    }

    return { patterns, songs, currentSongId };
}

/**
 * v1 → v2. The song bar went on saving to the legacy store after the first
 * migration, so anything written since would be stranded when it was
 * removed. Matched by name: a legacy song whose name is already a song here
 * was converted by v1. Renaming a migrated song and then upgrading brings
 * the original back as a duplicate — a visible, recoverable annoyance,
 * which is the right side to err on when the alternative is losing it.
 */
export function buildLegacyCatchUp() {
    const taken = new Set(songStore.list().map(s => s.name));
    const patterns = [];
    const songs = [];
    for (const rec of readLegacySongs()) {
        if (taken.has(rec.name)) continue;
        const { song, patterns: pats } = songFromLegacyRoll(rec.data, rec.name);
        patterns.push(...pats);
        songs.push(song);
    }
    return { patterns, songs };
}

/** 0 = never run, else the version of the last completed pass. */
export function migratedVersion() {
    try {
        const raw = localStorage.getItem(MIGRATION_KEY);
        if (raw == null) return 0;
        const marker = JSON.parse(raw);
        return marker && Number.isFinite(marker.version) ? marker.version : 1;
    } catch { return 1; }
}

export function hasMigrated() {
    return migratedVersion() >= MIGRATION_VERSION;
}

/**
 * Run the migration once per version, at load. Idempotent: guarded by the
 * version marker, so a second call is a no-op and cannot duplicate patterns.
 * The legacy keys are read-only and deliberately **left in place**: they are
 * a few KB, they are the only copy of anything that went wrong here, and
 * deleting a user's songs to tidy a key namespace is a bad trade.
 *
 * @returns {{migrated: boolean, patterns: number, songs: number, currentSongId: string|null}}
 */
export function migrateIfNeeded() {
    const from = migratedVersion();
    if (from >= MIGRATION_VERSION) {
        return { migrated: false, patterns: 0, songs: 0, currentSongId: null };
    }
    // A first run converts everything; an upgrade only sweeps up the legacy
    // songs saved since, and must not touch the current song.
    const { patterns, songs, currentSongId } = from === 0
        ? buildMigration()
        : { ...buildLegacyCatchUp(), currentSongId: null };
    patternStore.bulkPut(patterns);
    songStore.bulkPut(songs);
    // Written last: if a quota error aborts the writes above, the next load
    // tries again rather than leaving a half-migrated library marked done.
    try {
        localStorage.setItem(MIGRATION_KEY, JSON.stringify({ at: Date.now(), version: MIGRATION_VERSION }));
    } catch (e) {
        console.warn('migration marker save failed:', e);
    }
    return { migrated: true, patterns: patterns.length, songs: songs.length, currentSongId };
}
