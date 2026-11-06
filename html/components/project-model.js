// Project data model: Tracks, Patterns, Clips, Sections, Projects.
//
// A **Project** is one piece of music, and the unit that gets exported. It
// has two dimensions:
//
//   - **Tracks** — the vertical one, project-level, so every section is
//     played by the same band. A track is a voice: a name, a **slot** (which
//     is also the synth channel and the MIDI output channel), the patch it
//     sounds, and its mixer strip.
//   - **Sections** — the horizontal one: an ordered sequence of smaller
//     pieces. Each arranges **Patterns** as **Clips** on the project's
//     tracks. ("Section" over "movement", which is ambiguous, and over
//     "part", which in a DAW usually means a per-track event container —
//     i.e. our clip — and would point at the wrong level entirely.)
//
// A **Pattern** is a reusable bar or more of notes, owned by the project and
// referenced by clips in any of its sections. It is monotimbral: the notes
// carry no voice, so any track can play it.
//
// A **Clip** is a pattern placed on a track at a column, inside one section.
//
// Tempo is the project's, with a per-section override that wins when it is
// not null — a section announces its tempo the way a movement announces
// Allegro. Gradual changes (rit./accel.) are a later automation feature, and
// `effectiveBpm()` is the seam they will grow from.
//
// ## Track is the voice bank slot
//
// In the pre-Project model these were two records that behaved as one: every
// lookup in the app was `tracks.find(t => t.slot === slot)`, so one track per
// slot was assumed everywhere while nothing enforced it. They had drifted
// into **two independent mute/solo systems for one strip** — the
// track gated whether notes were *scheduled*, the voice bank entry gated the
// channel's *volume*, neither showed the other, and they could disagree.
//
// Here they are one object with one `mute` and one `solo`, and `slot` is
// unique across the project's tracks (duplicates are dropped by the factory,
// rather than being silently resolved by whichever `find` ran first).
//
// Pure data. No DOM, no audio, no MIDI, no storage — project-store.js owns
// persistence and hands bodies to these factories; nothing here reads it.

export const COLS_PER_MEASURE = 16;
export const MAX_SLOTS = 8;      // slot IS the channel, so this is the track limit
export const MIN_BPM = 32;
export const MAX_BPM = 255;
export const DEFAULT_BPM = 120;
/** Channel volume, on the 0–127 scale the engine and the fader both use. */
export const MAX_VOLUME = 127;
export const DEFAULT_VOLUME = 100;
export const PATTERN_KINDS = ['mono'];

// A clip cannot start past, or run past, bar 4097. Generous: the point is to
// keep a hand-edited record from producing a grid megapixels wide.
const MAX_CLIP_COL = 4096 * COLS_PER_MEASURE;

/**
 * Bumped when the on-disk shape changes in a way an older reader would get
 * wrong. Written into every exported file and every stored body; phase 5's
 * import refuses what it does not understand rather than guessing.
 */
export const SCHEMA_VERSION = 1;

// --- Small helpers ---

function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function clampInt(v, min, max, fallback) {
    // `null` has to be caught explicitly: `Number(null)` is 0, which is
    // finite, so a null volume would read as *silence* and a null bpm as
    // the slowest tempo — both indistinguishable from a deliberate choice.
    // `undefined` already falls through as NaN; null must behave the same.
    if (v == null) return fallback;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function nonEmptyName(name, fallback) {
    const s = String(name == null ? '' : name).trim();
    return s || fallback;
}

/** A plain object, or an empty one — stored data is not a contract we control. */
function plainObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// Pattern colours. Deliberately a different set from the track/slot colours:
// a track is tinted with its voice, a clip is painted with its pattern, and
// the two must read as two things.
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
// Every factory is total: it takes anything (storage, an imported file, a
// hand-edited blob) and returns a well-formed record. Invalid pieces are
// dropped, not thrown over.

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
 * dropped; one that merely runs past the end is cut at the end, the same rule
 * the piano roll's resize handle enforces.
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

/**
 * A track: one voice of the project's band, and one strip of its mixer.
 *
 * `slot` is the synth channel and the MIDI output channel — the same number
 * the engine and the device see, which is why it is not merely an index.
 * `patchId` names the patch; `voiceData` carries the bytes so a project is
 * self-contained and still sounds when the patch record is gone (an import
 * of a project whose patch was never in this workspace relies on this).
 */
export function createTrack(partial = {}) {
    return {
        id: partial.id || uid('trk'),
        name: nonEmptyName(partial.name, 'Track'),
        slot: clampInt(partial.slot, 0, MAX_SLOTS - 1, 0),
        patchId: partial.patchId || null,
        voiceData: normalizeVoiceData(partial.voiceData),
        volume: clampInt(partial.volume, 0, MAX_VOLUME, DEFAULT_VOLUME),
        // One mute and one solo for the strip. Two records used to carry
        // these separately and could disagree; see the file header.
        mute: partial.mute === true,
        solo: partial.solo === true,
    };
}

/**
 * Voice bytes, in a shape a JSON body can hold.
 *
 * Four shapes reach here. A **base64 string**, which is how patch-model
 * stores `voice_data` and therefore the commonest of the lot — kept as it
 * is, because re-encoding it would only lose fidelity. The `Uint8Array`
 * the synth passes around, and the plain array that comes back out of
 * storage, both of which become arrays. And — the one worth the trouble —
 * `{"0":12,"1":34,...}`, which is what `JSON.stringify` makes of a typed
 * array. That last case is the quiet one: a caller who assigns
 * `track.voiceData = someUint8Array` directly, bypassing this factory, gets
 * a body that works perfectly in memory and loses its patch on the next
 * load. Accepting the object shape means the round trip survives careless
 * assignment instead of punishing it.
 *
 * Anything else becomes null rather than a half-record.
 */
function normalizeVoiceData(v) {
    if (typeof v === 'string') return v || null;
    if (ArrayBuffer.isView(v)) return Array.from(v);
    let src = v;
    if (!Array.isArray(src)) {
        if (!src || typeof src !== 'object') return null;
        // A stringified typed array: dense keys "0".."n-1" and nothing else.
        const keys = Object.keys(src);
        if (keys.length === 0) return null;
        if (!keys.every((k, i) => k === String(i))) return null;
        src = keys.map(k => src[k]);
    }
    if (src.length === 0) return null;
    const out = [];
    for (const b of src) {
        const n = Math.round(Number(b));
        if (!Number.isFinite(n) || n < 0 || n > 255) return null;
        out.push(n);
    }
    return out;
}

/**
 * A clip is a pattern placed on a track, at `startCol`.
 *
 * Its length is either **its own** — `lengthCols`, what dragging the clip's
 * edge sets, free-form so the clip may end part-way through a repeat — or
 * **its pattern's**: `repeats` whole pattern lengths, which follow the
 * pattern as the pattern grows. Exactly one of the two is stored, so there is
 * never a stale second opinion; `clipCols()` resolves them, because the
 * length of a repeat is not knowable without the pattern and this factory
 * does not have one. Pass `lengthCols: null` to go back to following.
 */
export function createClip(partial = {}) {
    const clip = {
        id: partial.id || uid('clip'),
        trackId: partial.trackId || null,
        patternId: partial.patternId || null,
        startCol: clampInt(partial.startCol, 0, MAX_CLIP_COL, 0),
    };
    if (partial.lengthCols != null) clip.lengthCols = clampInt(partial.lengthCols, 1, MAX_CLIP_COL, COLS_PER_MEASURE);
    else clip.repeats = clampInt(partial.repeats, 1, 256, 1);
    return clip;
}

/**
 * A section: one smaller piece, arranging clips on the project's tracks.
 *
 * `bpm` is **nullable on purpose** — null means "the project's tempo", a
 * number overrides it. That is the difference between a project whose tempo
 * is edited in one place and one where a section was deliberately marked
 * slower, and collapsing the two would lose the distinction. `bpmEnd`,
 * also nullable, is the tempo the section *arrives at*: set, the section
 * ramps linearly from its start tempo to it over its length (a rit. or an
 * accel.); null means it holds its tempo. See `bpmAt()`.
 *
 * Clips are validated for shape but not for their references: a section does
 * not know the project's tracks or patterns. `normalizeProject()` is where
 * orphans are dropped, because that is the first place both are in hand.
 */
export function createSection(partial = {}) {
    return {
        id: partial.id || uid('sec'),
        name: nonEmptyName(partial.name, 'Section'),
        bpm: partial.bpm == null ? null : clampInt(partial.bpm, MIN_BPM, MAX_BPM, DEFAULT_BPM),
        bpmEnd: partial.bpmEnd == null ? null : clampInt(partial.bpmEnd, MIN_BPM, MAX_BPM, DEFAULT_BPM),
        clips: (Array.isArray(partial.clips) ? partial.clips : []).map(createClip),
        loop: normalizeLoop(partial.loop),
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

/**
 * A project: the whole piece, and the unit of export.
 *
 * `patches`, `patchNames`, `canvas` and `jobs` are the patch side of the
 * workspace: project-owned, so switching project swaps the whole bench.
 * They are carried **verbatim** — patch-model.js owns their shapes, and
 * teaching two files one schema is how the two mute flags happened.
 *
 * Always goes through `normalizeProject()`, which is what enforces the
 * cross-record invariants (unique slots, no orphan clips) that no single
 * factory can see.
 */
export function createProject(partial = {}) {
    const p = plainObject(partial);
    return normalizeProject({
        schemaVersion: SCHEMA_VERSION,
        id: p.id || uid('prj'),
        name: nonEmptyName(p.name, 'Untitled project'),
        bpm: clampInt(p.bpm, MIN_BPM, MAX_BPM, DEFAULT_BPM),
        tracks: (Array.isArray(p.tracks) ? p.tracks : []).map(createTrack),
        sections: (Array.isArray(p.sections) ? p.sections : []).map(createSection),
        patterns: normalizePatterns(p.patterns),
        // Carried verbatim — see above.
        patches: plainObject(p.patches),
        patchNames: plainObject(p.patchNames),
        canvas: plainObject(p.canvas),
        jobs: plainObject(p.jobs),
        // The tags actually used in this project. The full vocabulary is the
        // profile's; an export carries only what it uses, and an import
        // unions them back in.
        tags: normalizeTags(p.tags),
        created: p.created || Date.now(),
        modified: p.modified || Date.now(),
    });
}

/** Patterns are a map keyed by id — they are referenced, not ordered. */
function normalizePatterns(raw) {
    const out = {};
    const src = plainObject(raw);
    for (const key of Object.keys(src)) {
        const pattern = createPattern(src[key]);
        out[pattern.id] = pattern;
    }
    return out;
}

function normalizeTags(raw) {
    const seen = new Set();
    for (const t of Array.isArray(raw) ? raw : []) {
        const s = String(t == null ? '' : t).trim();
        if (s) seen.add(s);
    }
    return [...seen].sort();
}

/**
 * The invariants that need the whole project in hand:
 *
 *   - **One track per slot.** The slot is the channel, so two tracks on one
 *     slot are two voices fighting over one output. Later duplicates are
 *     dropped rather than renumbered: renumbering would silently move a
 *     user's part to another instrument.
 *   - **At most MAX_SLOTS tracks**, for the same reason.
 *   - **Always at least one section.** The UI edits exactly one at a time
 *     (the model carries many), and a project with none has nothing to show.
 *   - **No orphan clips.** A clip whose track or pattern is gone cannot
 *     sound and has nowhere to be drawn.
 */
export function normalizeProject(project) {
    const bySlot = new Map();
    for (const track of project.tracks) {
        if (bySlot.size >= MAX_SLOTS) break;
        if (!bySlot.has(track.slot)) bySlot.set(track.slot, track);
    }
    project.tracks = [...bySlot.values()].sort((a, b) => a.slot - b.slot);

    const trackIds = new Set(project.tracks.map(t => t.id));
    for (const section of project.sections) {
        section.clips = section.clips.filter(
            c => c.patternId && trackIds.has(c.trackId)
                && Object.prototype.hasOwnProperty.call(project.patterns, c.patternId),
        );
    }
    if (project.sections.length === 0) project.sections = [createSection({ name: 'Section 1' })];
    return project;
}

// --- Tempo ---

/**
 * The tempo a section actually plays at: its own when it has one, the
 * project's otherwise. The single seam tempo automation will grow from, so
 * everything that needs a tempo should ask here rather than reading `bpm`.
 */
export function effectiveBpm(project, section) {
    if (section && section.bpm != null) return section.bpm;
    return project ? project.bpm : DEFAULT_BPM;
}

/**
 * The tempo at column `col` of a section: a straight line from its start
 * tempo (`effectiveBpm`) to `bpmEnd` over the section's length, so the
 * last column plays at `bpmEnd` and anything past the end holds it. A
 * section without `bpmEnd` — or without length — is its start tempo
 * throughout. Not rounded: the clock takes fractional BPM.
 */
export function bpmAt(project, section, col) {
    const start = effectiveBpm(project, section);
    if (!section || section.bpmEnd == null) return start;
    const len = sectionLengthCols(project, section);
    if (len <= 1) return start;
    const t = Math.max(0, Math.min(1, (col || 0) / (len - 1)));
    return start + (section.bpmEnd - start) * t;
}

// --- Lookups ---

export const getPattern = (project, id) => project.patterns[id] || null;
export const getTrack = (project, id) => project.tracks.find(t => t.id === id) || null;
export const getTrackBySlot = (project, slot) => project.tracks.find(t => t.slot === slot) || null;
export const getSection = (project, id) => project.sections.find(s => s.id === id) || null;

// --- Geometry ---

export function patternCols(pattern) {
    return (pattern ? pattern.measures : 1) * COLS_PER_MEASURE;
}

/**
 * Where a clip sits, in columns: [startCol, endCol). Needs the pattern, which
 * is what a repeat's length is measured in. Returns null when the pattern is
 * missing (a dangling reference).
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

/** Section length in columns — the furthest clip end, 0 when empty. */
export function sectionLengthCols(project, section) {
    let end = 0;
    for (const clip of section.clips) {
        const span = clipCols(clip, getPattern(project, clip.patternId));
        if (span && span.endCol > end) end = span.endCol;
    }
    return end;
}

/**
 * Section length in whole measures — the bar the furthest clip ends in, so a
 * clip finishing mid-bar still gets a whole bar of grid to sit on.
 */
export function sectionLength(project, section) {
    return Math.ceil(sectionLengthCols(project, section) / COLS_PER_MEASURE);
}

// --- Mutators ---
//
// These mutate and return; the caller persists (project-store.js debounces
// the write, so a mutator never needs to think about it).

/**
 * The clip already occupying any column `clip` wants, on the same track. One
 * clip per track per column: tracks are monophonic timelines, so two clips in
 * the same place would mean two patterns on one voice.
 */
export function findClipOverlap(project, section, clip, ignoreClipId) {
    const span = clipCols(clip, getPattern(project, clip.patternId));
    if (!span) return null;
    for (const other of section.clips) {
        if (other.id === clip.id || other.id === ignoreClipId) continue;
        if (other.trackId !== clip.trackId) continue;
        const otherSpan = clipCols(other, getPattern(project, other.patternId));
        if (!otherSpan) continue;
        if (span.startCol < otherSpan.endCol && otherSpan.startCol < span.endCol) return other;
    }
    return null;
}

/** Add a clip to a section, refusing an overlap. Returns the clip. */
export function addClip(project, section, partial) {
    const clip = createClip(partial);
    if (!clip.patternId) throw new Error('Clip has no pattern');
    if (!getTrack(project, clip.trackId)) throw new Error('Clip has no track');
    if (!getPattern(project, clip.patternId)) throw new Error('Clip pattern is missing');
    if (findClipOverlap(project, section, clip)) throw new Error('Clip overlaps');
    section.clips.push(clip);
    return clip;
}

/**
 * Asking for `repeats` is asking the clip to follow its pattern again, so a
 * length of its own has to go. Needed because the changes are spread over the
 * existing record, where a leftover `lengthCols` would win silently.
 */
function canonicalChanges(changes) {
    const next = { ...changes };
    if (next.repeats != null && next.lengthCols === undefined) next.lengthCols = null;
    return next;
}

/** Move/resize an existing clip, refusing an overlap. Returns the clip. */
export function updateClip(project, section, clipId, changes) {
    const clip = section.clips.find(c => c.id === clipId);
    if (!clip) throw new Error('Clip not found');
    const next = createClip({ ...clip, ...canonicalChanges(changes), id: clip.id });
    if (!getTrack(project, next.trackId)) throw new Error('Clip has no track');
    if (!getPattern(project, next.patternId)) throw new Error('Clip pattern is missing');
    if (findClipOverlap(project, section, next, clipId)) throw new Error('Clip overlaps');
    // Assigned key by key, after clearing both length spellings: exactly one
    // is ever stored, and a leftover would be a stale opinion.
    delete clip.lengthCols;
    delete clip.repeats;
    Object.assign(clip, next);
    return clip;
}

export function removeClip(section, clipId) {
    const i = section.clips.findIndex(c => c.id === clipId);
    if (i < 0) return false;
    section.clips.splice(i, 1);
    return true;
}

/**
 * Add a track on the first free slot, or on `partial.slot` when it is free.
 * Returns null when the project is full or the asked-for slot is taken —
 * a refusal the caller can report, rather than a silent reassignment.
 */
export function addTrack(project, partial = {}) {
    const taken = new Set(project.tracks.map(t => t.slot));
    let slot = partial.slot;
    if (slot == null) {
        slot = 0;
        while (slot < MAX_SLOTS && taken.has(slot)) slot++;
    }
    if (slot >= MAX_SLOTS || taken.has(slot)) return null;
    const track = createTrack({ ...partial, slot });
    project.tracks.push(track);
    project.tracks.sort((a, b) => a.slot - b.slot);
    return track;
}

/**
 * Move a track to another slot, **swapping** with whatever is there.
 *
 * The slot is the channel, the Mixer strip and the patch all at once, so
 * this is "play this part on that instrument". If the target is taken,
 * the two parts trade instruments — which loses nothing and is the same
 * rule the Mixer already applies when a voice is dropped on an occupied
 * strip.
 *
 * Assigning the slot directly is the trap this exists to close: two
 * tracks on one slot is two voices fighting over one channel, and
 * `normalizeProject()` resolves it by **dropping** one — along with its
 * clips, in every section.
 *
 * @returns {boolean} whether anything moved
 */
export function setTrackSlot(project, trackId, slot) {
    const next = clampInt(slot, 0, MAX_SLOTS - 1, NaN);
    if (!Number.isFinite(next)) return false;
    const track = getTrack(project, trackId);
    if (!track || track.slot === next) return false;
    const occupant = project.tracks.find(t => t.slot === next);
    if (occupant) occupant.slot = track.slot;
    track.slot = next;
    project.tracks.sort((a, b) => a.slot - b.slot);
    return true;
}

/**
 * Removing a track takes its clips **in every section** with it — they cannot
 * sound without it. Project-level tracks are exactly why this has to sweep
 * the whole project rather than one arrangement.
 */
export function removeTrack(project, trackId) {
    const i = project.tracks.findIndex(t => t.id === trackId);
    if (i < 0) return false;
    project.tracks.splice(i, 1);
    for (const section of project.sections) {
        section.clips = section.clips.filter(c => c.trackId !== trackId);
    }
    return true;
}

/** Add a pattern to the project's library. Returns the stored record. */
export function addPattern(project, partial = {}) {
    const pattern = createPattern(partial);
    project.patterns[pattern.id] = pattern;
    return pattern;
}

/**
 * Remove a pattern and every clip that placed it, in every section. Use
 * `patternUsage()` first if the user should be asked.
 */
export function removePattern(project, patternId) {
    if (!Object.prototype.hasOwnProperty.call(project.patterns, patternId)) return false;
    delete project.patterns[patternId];
    for (const section of project.sections) {
        section.clips = section.clips.filter(c => c.patternId !== patternId);
    }
    return true;
}

/** Ids of the sections that place a pattern — the delete confirmation. */
export function patternUsage(project, patternId) {
    return project.sections
        .filter(s => s.clips.some(c => c.patternId === patternId))
        .map(s => s.id);
}

export function addSection(project, partial = {}) {
    const section = createSection({
        name: `Section ${project.sections.length + 1}`,
        ...partial,
    });
    project.sections.push(section);
    return section;
}

/** Move a section `delta` places along the piece (−1 earlier, +1 later). */
export function moveSection(project, sectionId, delta) {
    const i = project.sections.findIndex(s => s.id === sectionId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= project.sections.length) return false;
    const [s] = project.sections.splice(i, 1);
    project.sections.splice(j, 0, s);
    return true;
}

/**
 * The piece: every section end to end, each starting on the bar after the
 * previous one ends (sections are whole bars long when played, as a section
 * alone is). Empty sections take no room. `startCol` is where each begins
 * in the piece; `total` is the piece's length.
 */
export function pieceLayout(project) {
    const parts = [];
    let at = 0;
    for (const section of project.sections) {
        const cols = Math.ceil(sectionLengthCols(project, section) / COLS_PER_MEASURE) * COLS_PER_MEASURE;
        parts.push({ section, startCol: at, endCol: at + cols });
        at += cols;
    }
    return { parts, total: at };
}

/** A project always has a section, so the last one cannot be removed. */
export function removeSection(project, sectionId) {
    if (project.sections.length <= 1) return false;
    const i = project.sections.findIndex(s => s.id === sectionId);
    if (i < 0) return false;
    project.sections.splice(i, 1);
    return true;
}

/**
 * Which tracks may sound: the soloed ones if any are soloed, otherwise the
 * unmuted ones. Solo wins over mute on the same track (soloing a muted track
 * is how you audition it). One list now, where there used to be this rule in
 * the sequencer and a second, separate one in the mixer's volume maths.
 */
export function audibleTracks(tracks) {
    const soloed = tracks.filter(t => t.solo);
    return soloed.length > 0 ? soloed : tracks.filter(t => !t.mute);
}

/**
 * The gain a track's channel should actually be given: its own volume, or
 * zero when something else is soloed or it is muted. The engine-facing half
 * of `audibleTracks()`, kept beside it so the two can never disagree.
 */
export function effectiveVolume(tracks, track) {
    return audibleTracks(tracks).includes(track) ? track.volume : 0;
}
