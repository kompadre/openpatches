// Collab model — the pure half of collaborative sessions (collab.js).
//
// A session has one **host**, whose project is the truth, and guests who
// mirror it. What travels is not operations but **parts**: the project cut
// into pieces small enough to resend whole when they change —
//
//   'patterns/<id>'  one pattern            (what editing touches most)
//   'patches/<id>'   one patch              (voice bytes; content-addressed)
//   '<key>'          any other top-level key: tracks, sections, bpm, fx,
//                    name, patchNames, canvas, jobs, tags
//
// `id`, `created`, `modified` and `schemaVersion` never travel as parts:
// they are the identity and bookkeeping of the body, not its content.
//
// Every part is carried as its JSON text. That is what the host diffs
// against (a part that serialises the same has not changed), what the
// guest keeps as its mirror, and what any transport can carry — a
// BroadcastChannel, a WebSocket relay, a WebRTC data channel.
//
// The editors hold pattern objects (the roll and the tracker mutate
// `pattern.notes` in place), so a guest applies a pattern **in place**:
// the same object, its fields replaced, its notes array refilled. The rest
// is replaced whole and the project re-normalised, as any arrival is.
//
// Pure: no DOM, no session, no transport.

import {
    createPattern, createTrack, createSection, normalizeProject,
} from './project-model.js';

/** Bumped when messages change shape; peers on another version are ignored. */
export const PROTOCOL = 1;

const MAPPED = ['patterns', 'patches'];
const SKIP = new Set(['id', 'created', 'modified', 'schemaVersion']);
const BENCH = new Set(['patches', 'patchNames', 'canvas', 'jobs']);

/** What a session event says may have changed: which parts to look at. */
export function hintFor(ev) {
    if (!ev) return { all: true };
    if (ev.kind === 'pattern' && ev.patternId) return { patterns: [ev.patternId] };
    if (ev.kind === 'patches') return { keys: [...BENCH] };
    return { all: true };
}

/** Merge two hints into one that covers both. */
export function joinHints(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.all || b.all) return { all: true };
    const patterns = [...new Set([...(a.patterns || []), ...(b.patterns || [])])];
    const keys = [...new Set([...(a.keys || []), ...(b.keys || [])])];
    return { patterns, keys };
}

/** Every part of `project`: Map key → JSON text. */
export function readParts(project) {
    const parts = new Map();
    for (const key of Object.keys(project)) {
        if (SKIP.has(key)) continue;
        if (MAPPED.includes(key)) {
            for (const id of Object.keys(project[key] || {})) {
                parts.set(key + '/' + id, JSON.stringify(project[key][id]));
            }
        } else {
            parts.set(key, JSON.stringify(project[key]));
        }
    }
    return parts;
}

/** The parts a hint covers, read now — and the key prefixes it covers. */
function readHinted(project, hint) {
    if (hint.all) return { parts: readParts(project), covers: () => true };
    const parts = new Map();
    const prefixes = [];
    const exact = new Set();
    for (const id of hint.patterns || []) {
        const key = 'patterns/' + id;
        exact.add(key);
        const p = project.patterns && project.patterns[id];
        if (p) parts.set(key, JSON.stringify(p));
    }
    for (const key of hint.keys || []) {
        if (SKIP.has(key)) continue;
        if (MAPPED.includes(key)) {
            prefixes.push(key + '/');
            for (const id of Object.keys(project[key] || {})) {
                parts.set(key + '/' + id, JSON.stringify(project[key][id]));
            }
        } else if (key in project) {
            exact.add(key);
            parts.set(key, JSON.stringify(project[key]));
        }
    }
    return { parts, covers: (k) => exact.has(k) || prefixes.some(p => k.startsWith(p)) };
}

/**
 * What changed since `known` (a parts map, updated in place to match):
 * an object key → JSON text, or null for a part that is gone. Empty when
 * nothing did. Only the parts `hint` covers are looked at.
 */
export function diffParts(known, project, hint = { all: true }) {
    const { parts, covers } = readHinted(project, hint);
    const changes = {};
    for (const [key, json] of parts) {
        if (known.get(key) !== json) { changes[key] = json; known.set(key, json); }
    }
    for (const key of [...known.keys()]) {
        if (covers(key) && !parts.has(key)) { changes[key] = null; known.delete(key); }
    }
    return changes;
}

/** Bring a parts map up to date with changes (the guest's mirror). */
export function recordChanges(known, changes) {
    for (const [key, json] of Object.entries(changes)) {
        if (json == null) known.delete(key); else known.set(key, json);
    }
}

/** Refill `target` with `src`'s fields, keeping the object and its notes array. */
function replaceInPlace(target, src) {
    for (const k of Object.keys(target)) if (!(k in src)) delete target[k];
    for (const [k, v] of Object.entries(src)) {
        if (k === 'notes' && Array.isArray(target.notes) && Array.isArray(v)) {
            target.notes.splice(0, target.notes.length, ...v);
        } else {
            target[k] = v;
        }
    }
}

function parse(json) {
    try { return JSON.parse(json); } catch { return undefined; }
}

/**
 * Apply changes to `project`, in place. Patterns keep their objects;
 * everything goes through the model's factories and the project is
 * re-normalised, so a malformed part cannot break the invariants.
 *
 * @returns {{ patterns: string[], structure: boolean, bench: boolean }}
 *   what moved: pattern ids, whether anything else in the arrangement did,
 *   whether the patch side (canvas, patches…) did
 */
export function applyParts(project, changes) {
    const out = { patterns: [], structure: false, bench: false };
    for (const [key, json] of Object.entries(changes || {})) {
        const slash = key.indexOf('/');
        const value = json == null ? null : parse(json);
        if (value === undefined) continue;
        if (slash > 0) {
            const map = key.slice(0, slash);
            const id = key.slice(slash + 1);
            if (!MAPPED.includes(map) || !id) continue;
            if (!project[map]) project[map] = {};
            if (map === 'patterns') {
                out.patterns.push(id);
                if (value == null) { delete project.patterns[id]; out.structure = true; continue; }
                const fresh = createPattern({ ...value, id });
                const have = project.patterns[id];
                if (have) replaceInPlace(have, fresh); else { project.patterns[id] = fresh; out.structure = true; }
            } else {
                out.bench = true;
                if (value == null) delete project[map][id]; else project[map][id] = value;
            }
            continue;
        }
        if (SKIP.has(key) || MAPPED.includes(key) || value == null) continue;
        if (key === 'tracks') project.tracks = (Array.isArray(value) ? value : []).map(createTrack);
        else if (key === 'sections') project.sections = (Array.isArray(value) ? value : []).map(createSection);
        else project[key] = value;
        if (BENCH.has(key)) out.bench = true; else out.structure = true;
    }
    if (out.structure) normalizeProject(project);
    return out;
}

/**
 * The parts in `known` that `project` no longer matches: what puts a
 * guest's copy back as the host has it (a change → the host's text, an
 * extra part → null).
 */
export function divergence(known, project) {
    const now = readParts(project);
    const changes = {};
    for (const [key, json] of known) if (now.get(key) !== json) changes[key] = json;
    for (const key of now.keys()) if (!known.has(key)) changes[key] = null;
    return changes;
}

// --- Messages ---
//
//   guest → host   { t: 'join', peer }        let me in; send me the project
//                  { t: 'resync', peer }      I missed something; send it all
//                  { t: 'leave', peer }
//   host → guests  { t: 'snapshot', to, v, body, sectionId, name }
//                                             the whole project (JSON text);
//                                             `to` a peer, or null for all
//                  { t: 'parts', v, changes } what changed; v counts up by 1
//                  { t: 'bye' }               the host stopped sharing
//
// Every message carries `p: PROTOCOL` and `room`.

const TYPES = new Set(['join', 'resync', 'leave', 'snapshot', 'parts', 'bye']);

export function message(room, t, fields = {}) {
    return { p: PROTOCOL, room, t, ...fields };
}

/** A message for `room`, well-formed, or null: what arrives is not trusted. */
export function readMessage(raw, room) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.p !== PROTOCOL || raw.room !== room || !TYPES.has(raw.t)) return null;
    if ((raw.t === 'join' || raw.t === 'resync' || raw.t === 'leave') && typeof raw.peer !== 'string') return null;
    if (raw.t === 'snapshot' && (typeof raw.body !== 'string' || !Number.isInteger(raw.v))) return null;
    if (raw.t === 'parts' && (!Number.isInteger(raw.v) || !raw.changes || typeof raw.changes !== 'object')) return null;
    return raw;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I

/** A room code: short, readable aloud, no look-alike characters. */
export function makeCode(random = Math.random, length = 6) {
    let s = '';
    for (let i = 0; i < length; i++) s += CODE_CHARS[Math.floor(random() * CODE_CHARS.length)];
    return s;
}

/** A typed code, tidied: upper case, spaces and dashes gone; null if not one. */
export function readCode(text) {
    const s = String(text == null ? '' : text).toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z0-9]{4,12}$/.test(s)) return null;
    return s;
}
