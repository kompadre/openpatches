// Collab ops — the project as **atoms**, and edits as compare-and-set ops
// on them (M2: guests edit; the host referees per atom).
//
// An atom is the smallest independently changeable thing in a project:
//
//   name · bpm · tags · fx/<field>                    the project
//   pattern/<id>                                      exists
//   pattern/<id>/{name,kind,color,measures,created}
//   pattern/<id>/note/<start>:<midi>                  value: dur
//   track/<id>                                        exists
//   track/<id>/{name,slot,patchId,voiceData,volume,mute,solo,compact,divider}
//   track/<id>/fx/<field>
//   section/<id>                                      exists
//   section/<id>/{name,bpm,bpmEnd,loop,created}
//   section/<id>/clip/<clipId>                        exists
//   section/<id>/clip/<clipId>/{trackId,patternId,startCol,repeats,lengthCols}
//   sections/order                                    the section ids, in order
//   patch/<id> · patchName/<id> · job/<id>            whole (the bench)
//   canvas/<patches|containers>/<id>                  exists
//   canvas/<patches|containers>/<id>/<field>
//   canvas/<key>                                      any other canvas key, whole
//
// Notes are keyed by start and pitch — no note ids. A pattern is atomised
// only once committed (the tracker's mergeDuplicates has run), so one key
// is one note; the sync debounces until then. The lane is not in the key:
// it is re-derived whenever a pattern is applied to.
//
// A value is **JSON text**; an absent atom is `null` (so a section's
// `bpm: null` — "the project's tempo" — is the text 'null', not absence).
// Objects are written with sorted keys, so equal values are equal text.
//
// An op is `{ atom, before, after }`: compare-and-set, `before` what the
// editor saw. Ops come in **groups**, accepted or rejected whole: an
// entity created or deleted with everything under it, a note moved (one
// pitch deleted and inserted in one pattern), a new pattern with the clip
// that places it, a section created or deleted with the order. Anything
// else is a group of one. (The clip rule runs both ways: a deleted
// pattern takes the clips that played it, as removePattern does.)
//
// Pure: no DOM, no session, no transport.

import {
    MAX_SLOTS, patternCols, clipCols, getPattern,
    createPattern, createTrack, createSection, createClip,
} from './project-model.js';
import { relane } from './tracker-model.js';

const PATTERN_FIELDS = ['name', 'kind', 'color', 'measures', 'created'];
const CANVAS_MAPS = ['patches', 'containers'];
const EXISTS = '1';

/** JSON text with sorted object keys; null for undefined (absent). */
export function stable(v) {
    if (v === undefined) return null;
    return JSON.stringify(sortKeys(v));
}

function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortKeys(v[k]);
    return out;
}

function parse(text) {
    try { return JSON.parse(text); } catch { return undefined; }
}

const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

// --- Reading ---

/** Every atom of `body`: Map atom → JSON text. */
export function readAtoms(body) {
    const atoms = new Map();
    const put = (atom, v) => { const s = stable(v); if (s != null) atoms.set(atom, s); };
    put('name', body.name);
    put('bpm', body.bpm);
    put('tags', body.tags);
    for (const [k, v] of Object.entries(body.fx || {})) put('fx/' + k, v);

    for (const [id, p] of Object.entries(body.patterns || {})) {
        const at = 'pattern/' + id;
        atoms.set(at, EXISTS);
        for (const f of PATTERN_FIELDS) put(at + '/' + f, p[f]);
        for (const n of p.notes || []) put(at + '/note/' + noteKey(n), n.dur);
    }
    for (const t of body.tracks || []) {
        const at = 'track/' + t.id;
        atoms.set(at, EXISTS);
        for (const [k, v] of Object.entries(t)) {
            if (k === 'id') continue;
            if (k === 'fx') for (const [f, fv] of Object.entries(v || {})) put(at + '/fx/' + f, fv);
            else put(at + '/' + k, v);
        }
    }
    for (const s of body.sections || []) {
        const at = 'section/' + s.id;
        atoms.set(at, EXISTS);
        for (const [k, v] of Object.entries(s)) {
            if (k === 'id' || k === 'clips') continue;
            put(at + '/' + k, v);
        }
        for (const c of s.clips || []) {
            const cat = at + '/clip/' + c.id;
            atoms.set(cat, EXISTS);
            for (const [k, v] of Object.entries(c)) if (k !== 'id') put(cat + '/' + k, v);
        }
    }
    put('sections/order', (body.sections || []).map(s => s.id));

    for (const [id, v] of Object.entries(body.patches || {})) put('patch/' + id, v);
    for (const [id, v] of Object.entries(body.patchNames || {})) put('patchName/' + id, v);
    for (const [id, v] of Object.entries(body.jobs || {})) put('job/' + id, v);
    for (const [k, v] of Object.entries(body.canvas || {})) {
        if (CANVAS_MAPS.includes(k) && v && typeof v === 'object') {
            for (const [id, item] of Object.entries(v)) {
                const at = 'canvas/' + k + '/' + id;
                atoms.set(at, EXISTS);
                for (const [f, fv] of Object.entries(item || {})) put(at + '/' + f, fv);
            }
        } else {
            put('canvas/' + k, v);
        }
    }
    return atoms;
}

export const noteKey = (n) => n.start + ':' + n.midi;

/**
 * What an atom names, or null when it names nothing: the kind and the
 * ids along its path.
 */
export function parseAtom(atom) {
    if (typeof atom !== 'string' || !atom) return null;
    const p = atom.split('/');
    if (p.some(s => !s)) return null;
    switch (p[0]) {
    case 'name': case 'bpm': case 'tags':
        return p.length === 1 ? { kind: 'top', field: p[0] } : null;
    case 'fx':
        return p.length === 2 ? { kind: 'fx', field: p[1] } : null;
    case 'pattern':
        if (p.length === 2) return { kind: 'pattern', id: p[1] };
        if (p.length === 3 && PATTERN_FIELDS.includes(p[2])) return { kind: 'patternField', id: p[1], field: p[2] };
        if (p.length === 4 && p[2] === 'note') {
            const m = /^(\d+):(\d+)$/.exec(p[3]);
            return m ? { kind: 'note', id: p[1], start: +m[1], midi: +m[2] } : null;
        }
        return null;
    case 'track':
        if (p.length === 2) return { kind: 'track', id: p[1] };
        if (p.length === 3 && p[2] !== 'id' && p[2] !== 'fx') return { kind: 'trackField', id: p[1], field: p[2] };
        if (p.length === 4 && p[2] === 'fx') return { kind: 'trackFx', id: p[1], field: p[3] };
        return null;
    case 'sections':
        return p.length === 2 && p[1] === 'order' ? { kind: 'order' } : null;
    case 'section':
        if (p.length === 2) return { kind: 'section', id: p[1] };
        if (p.length === 3 && p[2] !== 'id' && p[2] !== 'clips') return { kind: 'sectionField', id: p[1], field: p[2] };
        if (p.length === 4 && p[2] === 'clip') return { kind: 'clip', sectionId: p[1], id: p[3] };
        if (p.length === 5 && p[2] === 'clip' && p[4] !== 'id') return { kind: 'clipField', sectionId: p[1], id: p[3], field: p[4] };
        return null;
    case 'patch': case 'patchName': case 'job':
        return p.length === 2 ? { kind: p[0], id: p[1] } : null;
    case 'canvas':
        if (p.length === 2) return CANVAS_MAPS.includes(p[1]) ? null : { kind: 'canvasWhole', key: p[1] };
        if (!CANVAS_MAPS.includes(p[1])) return null;
        if (p.length === 3) return { kind: 'canvasItem', key: p[1], id: p[2] };
        if (p.length === 4) return { kind: 'canvasField', key: p[1], id: p[2], field: p[3] };
        return null;
    default:
        return null;
    }
}

/** The existence atom an atom lives under, or null for a free-standing one. */
export function ownerOf(atom) {
    const a = parseAtom(atom);
    if (!a) return null;
    switch (a.kind) {
    case 'patternField': case 'note': return 'pattern/' + a.id;
    case 'trackField': case 'trackFx': return 'track/' + a.id;
    case 'sectionField': case 'clip': return 'section/' + (a.sectionId || a.id);
    case 'clipField': return 'section/' + a.sectionId + '/clip/' + a.id;
    case 'canvasField': return 'canvas/' + a.key + '/' + a.id;
    default: return null;
    }
}

const findTrack = (body, id) => (body.tracks || []).find(t => t.id === id) || null;
const findSection = (body, id) => (body.sections || []).find(s => s.id === id) || null;
const findClip = (body, sid, id) => {
    const s = findSection(body, sid);
    return s ? (s.clips || []).find(c => c.id === id) || null : null;
};

/** One atom's value in `body` now: JSON text, or null when absent. */
export function readAtom(body, atom) {
    const a = parseAtom(atom);
    if (!a) return null;
    const pattern = () => (body.patterns && own(body.patterns, a.id)) ? body.patterns[a.id] : null;
    switch (a.kind) {
    case 'top': return stable(body[a.field]);
    case 'fx': return stable(body.fx && body.fx[a.field]);
    case 'pattern': return pattern() ? EXISTS : null;
    case 'patternField': { const p = pattern(); return p ? stable(p[a.field]) : null; }
    case 'note': {
        const p = pattern();
        if (!p) return null;
        const n = (p.notes || []).find(n => n.start === a.start && n.midi === a.midi);
        return n ? stable(n.dur) : null;
    }
    case 'track': return findTrack(body, a.id) ? EXISTS : null;
    case 'trackField': { const t = findTrack(body, a.id); return t ? stable(t[a.field]) : null; }
    case 'trackFx': { const t = findTrack(body, a.id); return t && t.fx ? stable(t.fx[a.field]) : null; }
    case 'section': return findSection(body, a.id) ? EXISTS : null;
    case 'sectionField': { const s = findSection(body, a.id); return s ? stable(s[a.field]) : null; }
    case 'order': return stable((body.sections || []).map(s => s.id));
    case 'clip': return findClip(body, a.sectionId, a.id) ? EXISTS : null;
    case 'clipField': { const c = findClip(body, a.sectionId, a.id); return c ? stable(c[a.field]) : null; }
    case 'patch': return stable(body.patches && body.patches[a.id]);
    case 'patchName': return stable(body.patchNames && body.patchNames[a.id]);
    case 'job': return stable(body.jobs && body.jobs[a.id]);
    case 'canvasWhole': return stable(body.canvas && body.canvas[a.key]);
    case 'canvasItem': {
        const m = body.canvas && body.canvas[a.key];
        return m && own(m, a.id) ? EXISTS : null;
    }
    case 'canvasField': {
        const m = body.canvas && body.canvas[a.key];
        return m && own(m, a.id) ? stable(m[a.id][a.field]) : null;
    }
    default: return null;
    }
}

// --- Diffing ---

/**
 * The ops that take `before` to `after` (bodies or atom maps), in atom
 * order. `before` of each op is what `before` held.
 */
export function diffAtoms(before, after) {
    const a = before instanceof Map ? before : readAtoms(before);
    const b = after instanceof Map ? after : readAtoms(after);
    const ops = [];
    for (const atom of new Set([...a.keys(), ...b.keys()])) {
        const x = a.has(atom) ? a.get(atom) : null;
        const y = b.has(atom) ? b.get(atom) : null;
        if (x !== y) ops.push({ atom, before: x, after: y });
    }
    ops.sort((p, q) => (p.atom < q.atom ? -1 : p.atom > q.atom ? 1 : 0));
    return ops;
}

/**
 * Ops cut into the groups that stand or fall together (see the header).
 * Groups keep the ops' order and come in the order of their first op.
 */
export function groupOps(ops) {
    const parent = ops.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    const union = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
    const at = new Map(ops.map((op, i) => [op.atom, i]));

    ops.forEach((op, i) => {
        // Under a created or deleted entity: with it. (Up the chain: a clip
        // field joins its clip, which joins a created section.)
        for (let o = ownerOf(op.atom); o; o = ownerOf(o)) {
            if (at.has(o)) union(i, at.get(o));
        }
    });

    // A section created or deleted carries the order with it.
    const order = at.get('sections/order');
    if (order != null) {
        ops.forEach((op, i) => { if (parseAtom(op.atom)?.kind === 'section') union(i, order); });
    }

    // A note moved: one pitch in one pattern both deleted and inserted.
    const moves = new Map();
    ops.forEach((op, i) => {
        const a = parseAtom(op.atom);
        if (!a || a.kind !== 'note' || (op.before == null) === (op.after == null)) return;
        const k = a.id + '#' + a.midi;
        if (!moves.has(k)) moves.set(k, { gone: [], came: [] });
        moves.get(k)[op.after == null ? 'gone' : 'came'].push(i);
    });
    for (const { gone, came } of moves.values()) {
        if (!gone.length || !came.length) continue;
        for (const i of [...gone, ...came]) union(i, gone[0]);
    }

    // A new pattern with the clip that places it; a deleted pattern with
    // the clips that played it.
    ops.forEach((op, i) => {
        const a = parseAtom(op.atom);
        if (!a || a.kind !== 'clipField' || a.field !== 'patternId') return;
        const clip = at.get('section/' + a.sectionId + '/clip/' + a.id);
        if (clip == null) return;
        const created = op.after != null && ops[clip].after != null;
        const deleted = op.after == null && ops[clip].after == null;
        if (!created && !deleted) return;
        const pat = at.get('pattern/' + parse(created ? op.after : op.before));
        if (pat != null && (created ? ops[pat].before == null : ops[pat].after == null)) union(i, pat);
    });

    const groups = new Map();
    ops.forEach((op, i) => {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(op);
    });
    return [...groups.values()];
}

/** before → after as groups: what an editor's commit sends. */
export function diffGroups(before, after) {
    return groupOps(diffAtoms(before, after));
}

// --- Applying ---

const DEPTH = { pattern: 0, track: 0, section: 0, canvasItem: 0, clip: 1 };

/** Make `target` hold `src`'s fields, keeping the object. */
function refill(target, src) {
    for (const k of Object.keys(target)) if (!(k in src)) delete target[k];
    Object.assign(target, src);
}

/**
 * Apply ops to `body`, in place, without checking `before` (that is the
 * referee's). Creations first, parents before children; then fields and
 * notes; then deletions. An op whose entity is missing is skipped.
 * Patterns keep their objects and their notes arrays (the editors hold
 * them); touched patterns have their notes sorted and lanes re-derived.
 * Touched tracks, sections and clips are passed through their factories,
 * so a malformed value comes out in range. Cross-record invariants are
 * NOT enforced here — see checkInvariants.
 *
 * @returns {{ patterns: string[], structure: boolean, bench: boolean, skipped: string[] }}
 */
export function applyOps(body, ops) {
    const out = { patterns: [], structure: false, bench: false, skipped: [] };
    const parsed = [];
    for (const op of ops || []) {
        const a = op && parseAtom(op.atom);
        if (!a || (op.after != null && typeof op.after !== 'string')) { if (op) out.skipped.push(op.atom); continue; }
        const value = op.after == null ? undefined : parse(op.after);
        if (op.after != null && value === undefined) { out.skipped.push(op.atom); continue; }
        parsed.push({ op, a, value });
    }
    const touchedPatterns = new Set();
    const touchedTracks = new Set();
    const touchedSections = new Set();
    const skip = (op) => out.skipped.push(op.atom);

    const isEntity = (k) => k in DEPTH;
    // 1. Creations, parents first.
    const creates = parsed.filter(x => isEntity(x.a.kind) && x.op.after != null)
        .sort((x, y) => DEPTH[x.a.kind] - DEPTH[y.a.kind]);
    for (const { op, a } of creates) {
        if (readAtom(body, op.atom) != null) continue;
        switch (a.kind) {
        case 'pattern':
            if (!body.patterns) body.patterns = {};
            body.patterns[a.id] = createPattern({ id: a.id });
            touchedPatterns.add(a.id); out.structure = true; break;
        case 'track':
            if (!body.tracks) body.tracks = [];
            body.tracks.push(createTrack({ id: a.id, slot: freeSlot(body) }));
            touchedTracks.add(a.id); out.structure = true; break;
        case 'section':
            if (!body.sections) body.sections = [];
            body.sections.push(createSection({ id: a.id }));
            touchedSections.add(a.id); out.structure = true; break;
        case 'clip': {
            const s = findSection(body, a.sectionId);
            if (!s) { skip(op); break; }
            s.clips.push(createClip({ id: a.id }));
            touchedSections.add(s.id); out.structure = true; break;
        }
        case 'canvasItem':
            if (!body.canvas) body.canvas = {};
            if (!body.canvas[a.key] || typeof body.canvas[a.key] !== 'object') body.canvas[a.key] = {};
            body.canvas[a.key][a.id] = { id: a.id };
            out.bench = true; break;
        }
    }

    // 2. Fields, notes, the order, the bench.
    const set = (obj, k, v) => { if (v === undefined) delete obj[k]; else obj[k] = v; };
    let order = null;
    for (const { op, a, value } of parsed) {
        if (isEntity(a.kind)) continue;
        switch (a.kind) {
        case 'top': set(body, a.field, value); out.structure = true; break;
        case 'fx':
            if (!body.fx) body.fx = {};
            set(body.fx, a.field, value); out.structure = true; break;
        case 'patternField': case 'note': {
            const p = body.patterns && own(body.patterns, a.id) ? body.patterns[a.id] : null;
            if (!p) { skip(op); break; }
            if (a.kind === 'patternField') set(p, a.field, value);
            else setNote(p, a.start, a.midi, value);
            touchedPatterns.add(a.id); break;
        }
        case 'trackField': case 'trackFx': {
            const t = findTrack(body, a.id);
            if (!t) { skip(op); break; }
            if (a.kind === 'trackField') set(t, a.field, value);
            else { if (!t.fx) t.fx = {}; set(t.fx, a.field, value); }
            touchedTracks.add(a.id); out.structure = true; break;
        }
        case 'sectionField': {
            const s = findSection(body, a.id);
            if (!s) { skip(op); break; }
            set(s, a.field, value === undefined ? null : value);
            touchedSections.add(a.id); out.structure = true; break;
        }
        case 'clipField': {
            const c = findClip(body, a.sectionId, a.id);
            if (!c) { skip(op); break; }
            set(c, a.field, value);
            touchedSections.add(a.sectionId); out.structure = true; break;
        }
        case 'order': order = Array.isArray(value) ? value : null; out.structure = true; break;
        case 'patch': case 'patchName': case 'job': {
            const map = { patch: 'patches', patchName: 'patchNames', job: 'jobs' }[a.kind];
            if (!body[map]) body[map] = {};
            set(body[map], a.id, value); out.bench = true; break;
        }
        case 'canvasWhole':
            if (!body.canvas) body.canvas = {};
            set(body.canvas, a.key, value); out.bench = true; break;
        case 'canvasField': {
            const m = body.canvas && body.canvas[a.key];
            if (!m || !own(m, a.id)) { skip(op); break; }
            set(m[a.id], a.field, value); out.bench = true; break;
        }
        }
    }

    // 3. Deletions.
    for (const { op, a } of parsed) {
        if (!isEntity(a.kind) || op.after != null) continue;
        switch (a.kind) {
        case 'pattern':
            if (body.patterns && own(body.patterns, a.id)) { delete body.patterns[a.id]; out.patterns.push(a.id); out.structure = true; }
            touchedPatterns.delete(a.id); break;
        case 'track': {
            const i = (body.tracks || []).findIndex(t => t.id === a.id);
            if (i >= 0) { body.tracks.splice(i, 1); out.structure = true; }
            touchedTracks.delete(a.id); break;
        }
        case 'section': {
            const i = (body.sections || []).findIndex(s => s.id === a.id);
            if (i >= 0) { body.sections.splice(i, 1); out.structure = true; }
            touchedSections.delete(a.id); break;
        }
        case 'clip': {
            const s = findSection(body, a.sectionId);
            const i = s ? s.clips.findIndex(c => c.id === a.id) : -1;
            if (i >= 0) { s.clips.splice(i, 1); out.structure = true; }
            break;
        }
        case 'canvasItem': {
            const m = body.canvas && body.canvas[a.key];
            if (m && own(m, a.id)) { delete m[a.id]; out.bench = true; }
            break;
        }
        }
    }

    if (order && body.sections) {
        const rank = new Map(order.map((id, i) => [id, i]));
        const at = new Map(body.sections.map((s, i) => [s, i]));
        // Named ones in the order's order; any it does not name keep their place after.
        body.sections.sort((x, y) =>
            (rank.has(x.id) ? rank.get(x.id) : order.length + at.get(x))
            - (rank.has(y.id) ? rank.get(y.id) : order.length + at.get(y)));
    }

    // Tidy what was touched: the factories bring values into range.
    for (const id of touchedPatterns) {
        const p = body.patterns[id];
        const fresh = createPattern({ ...p, notes: [] });
        for (const f of PATTERN_FIELDS) p[f] = fresh[f];
        p.notes.sort((x, y) => x.start - y.start || x.midi - y.midi);
        relane(p);
        out.patterns.push(id);
    }
    for (const t of body.tracks || []) if (touchedTracks.has(t.id)) refill(t, createTrack(t));
    for (const s of body.sections || []) {
        if (!touchedSections.has(s.id)) continue;
        const clips = s.clips;
        refill(s, createSection({ ...s, clips: [] }));
        s.clips = clips;
        for (const c of clips) refill(c, createClip(c));
    }
    out.patterns = [...new Set(out.patterns)];
    return out;
}

function freeSlot(body) {
    const used = new Set((body.tracks || []).map(t => t.slot));
    for (let s = 0; s < MAX_SLOTS; s++) if (!used.has(s)) return s;
    return 0;
}

function setNote(p, start, midi, dur) {
    if (!Array.isArray(p.notes)) p.notes = [];
    const same = (n) => n.start === start && n.midi === midi;
    if (dur === undefined) {
        for (let i = p.notes.length - 1; i >= 0; i--) if (same(p.notes[i])) p.notes.splice(i, 1);
        return;
    }
    const d = Math.max(1, Math.round(Number(dur)) || 1);
    const n = p.notes.find(same);
    if (n) n.dur = d; else p.notes.push({ midi, start, dur: d });
}

// --- Invariants ---

/**
 * What is wrong with `body` that no single op could see: two tracks on a
 * slot, too many tracks, a clip whose track or pattern is gone, two clips
 * on one track overlapping, a note outside its pattern. Each with the
 * atoms it involves — a group is implicated when one of its ops' atoms is
 * one of these or lies under one (see implicates).
 *
 * @returns {Array<{ reason: string, atoms: string[] }>}
 */
export function checkInvariants(body) {
    const out = [];
    const tracks = body.tracks || [];
    const bySlot = new Map();
    for (const t of tracks) {
        if (!bySlot.has(t.slot)) bySlot.set(t.slot, []);
        bySlot.get(t.slot).push(t);
    }
    for (const [slot, ts] of bySlot) {
        if (ts.length > 1) out.push({ reason: `two tracks on slot ${slot + 1}`, atoms: ts.map(t => 'track/' + t.id + '/slot') });
    }
    if (tracks.length > MAX_SLOTS) {
        out.push({ reason: `more than ${MAX_SLOTS} tracks`, atoms: tracks.slice(MAX_SLOTS).map(t => 'track/' + t.id) });
    }
    const trackIds = new Set(tracks.map(t => t.id));
    for (const s of body.sections || []) {
        const live = [];
        for (const c of s.clips || []) {
            const at = 'section/' + s.id + '/clip/' + c.id;
            if (!trackIds.has(c.trackId)) { out.push({ reason: 'a clip whose track is gone', atoms: [at, 'track/' + c.trackId] }); continue; }
            const p = getPattern(body, c.patternId);
            if (!p) { out.push({ reason: 'a clip whose pattern is gone', atoms: [at, 'pattern/' + c.patternId] }); continue; }
            live.push({ c, at, span: clipCols(c, p) });
        }
        for (let i = 0; i < live.length; i++) {
            for (let j = i + 1; j < live.length; j++) {
                const x = live[i], y = live[j];
                if (x.c.trackId !== y.c.trackId || !x.span || !y.span) continue;
                if (x.span.startCol < y.span.endCol && y.span.startCol < x.span.endCol) {
                    out.push({
                        reason: `two clips overlap in "${s.name}"`,
                        atoms: [x.at, y.at, 'pattern/' + x.c.patternId + '/measures', 'pattern/' + y.c.patternId + '/measures'],
                    });
                }
            }
        }
    }
    for (const [id, p] of Object.entries(body.patterns || {})) {
        const cols = patternCols(p);
        for (const n of p.notes || []) {
            if (n.start < 0 || n.start >= cols || n.start + n.dur > cols) {
                out.push({ reason: `a note outside "${p.name}"`, atoms: ['pattern/' + id + '/note/' + noteKey(n), 'pattern/' + id + '/measures'] });
            }
        }
    }
    return out;
}

/** Does a violation involve this group (one of its atoms, or under one)? */
export function implicates(violation, group) {
    return group.some(op => violation.atoms.some(v => op.atom === v || op.atom.startsWith(v + '/')));
}
