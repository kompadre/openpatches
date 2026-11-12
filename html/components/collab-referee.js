// Collab referee — the host's judge of edits (M2-2).
//
// An **edit** is what one editor committed, cut into groups of ops
// (collab-ops.js):
//
//   { id, peer, alias, module, base, start, end, groups: [[op…]…] }
//
// `base` is the host version the editor's mirror was at; `start` and
// `end` are host-clock times (ms): when the edit began — the first
// keystroke, the press — and when it was committed. `module` is the
// editor (`tracker`, `roll`, `section`, `mixer`…).
//
// **No clocks are synchronised** (transport is local to each peer). A
// guest sends `elapsed` — how long the edit was open, measured on its own
// monotonic clock — and the host stamps the times on arrival: `end` =
// arrival, `start` = arrival − elapsed (`stampEdit`). Offsets cancel; the
// error is the one-way latency, the same for every edit on that link. A
// recording is one long edit sent when it is consolidated; the 2-minute
// cap below keeps its long `elapsed` from winning everything.
//
// The referee keeps, per atom, its **last accepted writer**
// `{ edit, peer, alias, module, start, end, version, after }`, and judges
// each op by compare-and-set against the body:
//
//   current = before   → apply
//   current = after    → agreement; accepted, nothing to do
//   else               → a **conflict**, if the atom's last writer landed
//                        after `base` (versions decide whether — never
//                        time). Nobody did? The editor's picture was off
//                        for some other reason, nobody competes: apply.
//
// A conflict is ranked: **edit beats delete** regardless of time (a value
// over a removal); otherwise **earliest start wins**, then earliest end,
// then peer id — where a start older than `cap` (2 min) before its end
// counts as `end − cap`, so a forgotten open edit cannot win for ever. The
// incoming edit losing one op loses the **whole group**; winning, it
// displaces the earlier writer, who gets an **overridden** row.
//
// Deleting an entity is remembered with a **tomb**: the group that took
// it, so an edit under it that beats the delete brings the entity back.
// Conversely a delete loses to any edit under the entity that landed
// after the delete's base.
//
// What survives is applied to a scratch copy and the **invariants**
// checked; a group implicated in a violation is rejected with the reason
// and the rest re-checked. Acceptance is per group, never all-or-nothing.
//
// Pure: no DOM, no session, no transport. The host owns the body and the
// version; the referee mutates the body it is given.

import { readAtom, parseAtom, ownerOf, applyOps, checkInvariants, implicates } from './collab-ops.js';

export const PRIORITY_CAP = 2 * 60 * 1000;

const ENTITY = new Set(['pattern', 'track', 'section', 'clip', 'canvasItem']);
const isEntity = (atom) => { const a = parseAtom(atom); return !!a && ENTITY.has(a.kind); };

/** The start an edit competes with: no older than `cap` before its end. */
export function effectiveStart(x, cap = PRIORITY_CAP) {
    const end = Number.isFinite(x.end) ? x.end : 0;
    const start = Number.isFinite(x.start) ? Math.min(x.start, end) : end;
    return Math.max(start, end - cap);
}

/**
 * Who wins a conflict: negative when `a` does, positive when `b` does.
 * `a` and `b`: `{ start, end, peer, after }`. A deletion (after == null)
 * loses to a value regardless of time.
 */
export function rank(a, b, cap = PRIORITY_CAP) {
    const da = a.after == null, db = b.after == null;
    if (da !== db) return da ? 1 : -1;
    const sa = effectiveStart(a, cap), sb = effectiveStart(b, cap);
    if (sa !== sb) return sa - sb;
    if (a.end !== b.end) return a.end - b.end;
    const pa = String(a.peer || ''), pb = String(b.peer || '');
    return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/**
 * A guest's edit as it arrived, made into one the referee can judge:
 * validated (null when malformed — what arrives is not trusted) and
 * stamped in host time. `arrivedAt` is the host's clock now.
 *
 * raw: { id, peer, alias?, module?, base, elapsed, groups }
 */
export function stampEdit(raw, arrivedAt) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || typeof raw.peer !== 'string') return null;
    if (!Number.isInteger(raw.base) || raw.base < 0 || !Number.isFinite(arrivedAt)) return null;
    if (!Array.isArray(raw.groups) || !raw.groups.every(validGroup)) return null;
    const elapsed = Number.isFinite(raw.elapsed) ? Math.max(0, raw.elapsed) : 0;
    return {
        id: raw.id,
        peer: raw.peer,
        alias: typeof raw.alias === 'string' ? raw.alias : raw.peer,
        module: typeof raw.module === 'string' ? raw.module : '',
        base: raw.base,
        start: arrivedAt - elapsed,
        end: arrivedAt,
        groups: raw.groups,
    };
}

const textOrNull = (v) => v === null || typeof v === 'string';
const validGroup = (g) => Array.isArray(g) && g.length > 0 && g.every(op =>
    op && typeof op === 'object' && typeof op.atom === 'string' && textOrNull(op.before) && textOrNull(op.after));

const side = (edit, op) => ({
    edit: edit.id, peer: edit.peer, alias: edit.alias, module: edit.module,
    start: edit.start, end: edit.end, after: op.after,
});

/**
 * @param {{ version?: number, cap?: number }} opts
 *   version: the host's version now (counts up by one per edit that
 *   changed something); cap: how long a start keeps its priority.
 */
export function createReferee({ version = 0, cap = PRIORITY_CAP } = {}) {
    /** @type {Map<string, object>} atom → last accepted writer */
    const records = new Map();

    const deletedAncestor = (atom, base) => {
        // Top down: the first ancestor removed after `base` and still gone.
        const chain = [];
        for (let o = ownerOf(atom); o; o = ownerOf(o)) chain.unshift(o);
        return chain.filter(o => {
            const r = records.get(o);
            return r && r.after == null && r.version > base && r.tomb;
        });
    };

    const editedUnder = (atom, base) => {
        const prefix = atom + '/';
        for (const [k, r] of records) {
            if (k.startsWith(prefix) && r.version > base && r.after != null) return r;
        }
        return null;
    };

    /**
     * Judge `edit` against `body` and apply what stands.
     * @returns {{
     *   version: number,
     *   accepted: Array<{ group: op[], agreed: boolean }>,
     *   rejected: Array<{ group: op[], kind: 'conflict'|'invariant', reason: string,
     *                     conflicts: Array<{ atom, mine, theirs }> }>,
     *   overridden: Array<{ atom, mine: object, theirs: object }>,  // mine = the displaced writer
     *   applied: op[],                                             // what changed the body
     *   result: object|null,                                       // applyOps' report
     * }}
     */
    function judge(edit, body) {
        const base = Number.isInteger(edit.base) ? Math.min(edit.base, version) : version;
        const out = { version, accepted: [], rejected: [], overridden: [], applied: [], result: null };
        const candidates = [];      // { group, ops (to apply, revivals first), displaced: [{atom, record}], agreed }

        for (const group of edit.groups || []) {
            const ops = [], displaced = [], conflicts = [];
            let lost = false, agreed = true;
            for (const op of group) {
                const mine = side(edit, op);
                // 1. Under an entity someone removed after I last looked?
                const tombs = deletedAncestor(op.atom, base);
                if (tombs.length) {
                    if (op.after == null) continue;     // deleting inside a deletion: agreement
                    for (const o of tombs) {
                        const r = records.get(o);
                        if (readAtom(body, o) != null) continue;
                        ops.push(...r.tomb.map(t => ({ atom: t.atom, before: t.after, after: t.before })));
                        displaced.push({ atom: o, record: r });
                    }
                    ops.push(op); agreed = false;
                    continue;
                }
                // 2. Deleting an entity someone edited under after I last looked?
                if (op.after == null && isEntity(op.atom)) {
                    const r = editedUnder(op.atom, base);
                    if (r) { lost = true; conflicts.push({ atom: op.atom, mine, theirs: r }); continue; }
                }
                // 3. Compare and set.
                const current = readAtom(body, op.atom);
                if (current === op.after) continue;
                agreed = false;
                if (current === op.before) { ops.push(op); continue; }
                const r = records.get(op.atom);
                if (!r || r.version <= base) { ops.push(op); continue; }   // nobody competes
                conflicts.push({ atom: op.atom, mine, theirs: r });
                if (rank(mine, r, cap) < 0) { ops.push(op); displaced.push({ atom: op.atom, record: r }); }
                else lost = true;
            }
            if (lost) {
                out.rejected.push({ group, kind: 'conflict', reason: conflictReason(conflicts, edit, cap), conflicts });
            } else {
                candidates.push({ group, ops, displaced, agreed: agreed && ops.length === 0, conflicts });
            }
        }

        // Invariants: everything that stands, on a scratch copy; reject the implicated and look again.
        let standing = candidates.filter(c => c.ops.length);
        for (let guard = 0; standing.length && guard <= candidates.length; guard++) {
            const scratch = JSON.parse(JSON.stringify(body));
            applyOps(scratch, standing.flatMap(c => c.ops));
            const before = checkInvariants(body);
            const after = checkInvariants(scratch).filter(v => !before.some(b => b.reason === v.reason && same(b.atoms, v.atoms)));
            const bad = new Set();
            for (const v of after) {
                for (const c of standing) if (implicates(v, c.ops)) { bad.add(c); c.reason = v.reason; }
            }
            if (!bad.size) break;
            for (const c of bad) out.rejected.push({ group: c.group, kind: 'invariant', reason: c.reason, conflicts: [] });
            standing = standing.filter(c => !bad.has(c));
        }

        const applied = standing.flatMap(c => c.ops);
        for (const c of candidates) {
            if (c.ops.length && !standing.includes(c)) continue;
            out.accepted.push({ group: c.group, agreed: c.agreed });
        }
        if (!applied.length) return out;

        version += 1;
        out.version = version;
        out.result = applyOps(body, applied);
        out.applied = applied;
        for (const c of standing) {
            for (const d of c.displaced) {
                out.overridden.push({ atom: d.atom, mine: d.record, theirs: side(edit, { after: readAtom(body, d.atom) }) });
            }
            for (const op of c.ops) {
                const rec = { ...side(edit, op), version };
                // A group that removes an entity is its tomb: what brings it
                // back — the whole group, so a pattern returns with its clips.
                if (op.after == null && isEntity(op.atom)) rec.tomb = c.group;
                records.set(op.atom, rec);
            }
        }
        return out;
    }

    return {
        judge,
        get version() { return version; },
        set version(v) { version = v; },
        /** The last accepted writer of an atom, or null. */
        writerOf: (atom) => records.get(atom) || null,
        /** Forget writers older than `version - keep` versions: bounded memory. */
        prune(keep = 1000) {
            for (const [k, r] of records) if (r.version < version - keep) records.delete(k);
        },
    };
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function conflictReason(conflicts, edit, cap) {
    const c = conflicts.find(x => rank(x.mine, x.theirs, cap) > 0) || conflicts[0];
    if (!c) return 'conflict';
    const who = c.theirs.alias || c.theirs.peer || 'someone';
    if (c.mine.after == null && c.theirs.after != null) return `${who} edited it — an edit beats a delete`;
    if (effectiveStart(c.theirs, cap) !== effectiveStart(c.mine, cap)) {
        return effectiveStart(c.mine, cap) > c.mine.start
            ? `${who} started first (yours was open for over ${Math.round(cap / 60000)} min)`
            : `${who} started first`;
    }
    if (c.theirs.end !== c.mine.end) return `${who} finished first`;
    return `${who} won the tie`;
}
