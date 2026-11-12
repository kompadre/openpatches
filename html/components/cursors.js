// Remote cursors and selections: where the others are, for the editors to
// draw as ghosts — and only as ghosts.
//
// **The local view never follows.** A remote cursor is drawn when it falls
// inside what is already on screen here: the tracker shows a peer's cell
// when that peer is in the tracker *on the same section*; the roll
// outlines a peer's selected notes when it is on the *same pattern*; the
// Section pane marks a peer's picked clips when they are in *this
// section*. A peer on another tab, section or pattern is simply not
// drawn; nothing scrolls, switches or opens because of them.
//
// Each editor reports its own position (`reportCursor`) whenever it
// draws; collab.js throttles that onto the wire and feeds what arrives
// back in (`setRemoteCursor`). Latest wins; nothing is refereed. Outside
// a session the registry is empty and the editors draw nothing extra.
//
// A `where` is one of
//   { editor: 'tracker', sectionId, slot, lane, col }
//   { editor: 'roll', patternId, notes: [[start, midi]…] }   (the selection)
//   { editor: 'section', sectionId, clipIds: [] }             (the picked clips)
// or null — the editor is not showing.

const remote = new Map();      // peer → { peer, alias, color, where }
const listeners = new Set();
const localListeners = new Set();
let mine = {};                 // editor → where, as last reported here

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const COLOR = /^#[0-9a-f]{6}$/i;

/** An editor says where it is. `where` null: it has nothing to show. */
export function reportCursor(editor, where) {
    const next = where ? { ...where, editor } : null;
    if (same(mine[editor] || null, next)) return;
    if (next) mine[editor] = next; else delete mine[editor];
    for (const fn of [...localListeners]) { try { fn(editor, next); } catch (e) { console.warn('[cursors] listener failed:', e); } }
}

/** What this editor last reported — for collab.js to send on (re)join. */
export function myCursors() { return { ...mine }; }

/** Hear this side's own reports (collab.js). */
export function onLocalCursor(fn) {
    localListeners.add(fn);
    return () => localListeners.delete(fn);
}

/** A peer's position arrived: `wheres` is editor → where (null to clear one). */
export function setRemoteCursor(peer, alias, color, wheres) {
    const have = remote.get(peer) || { peer, alias: String(alias || peer), color: COLOR.test(color || '') ? color : '#f0a030', where: {} };
    have.alias = String(alias || have.alias);
    if (COLOR.test(color || '')) have.color = color;
    let changed = !remote.has(peer);
    for (const [editor, where] of Object.entries(wheres || {})) {
        const clean = validWhere(editor, where);
        if (same(have.where[editor] || null, clean)) continue;
        if (clean) have.where[editor] = clean; else delete have.where[editor];
        changed = true;
    }
    remote.set(peer, have);
    if (changed) announce();
}

export function dropRemoteCursor(peer) {
    if (remote.delete(peer)) announce();
}

export function clearRemoteCursors() {
    if (!remote.size) return;
    remote.clear();
    announce();
}

function announce() {
    for (const fn of [...listeners]) { try { fn(); } catch (e) { console.warn('[cursors] listener failed:', e); } }
}

function validWhere(editor, w) {
    if (!w || typeof w !== 'object') return null;
    const int = (v) => Number.isInteger(v) && v >= 0;
    if (editor === 'tracker') {
        return typeof w.sectionId === 'string' && int(w.slot) && int(w.lane) && int(w.col)
            ? { editor, sectionId: w.sectionId, slot: w.slot, lane: w.lane, col: w.col } : null;
    }
    if (editor === 'roll') {
        if (typeof w.patternId !== 'string' || !Array.isArray(w.notes)) return null;
        const notes = w.notes.filter(n => Array.isArray(n) && int(n[0]) && int(n[1])).map(n => [n[0], n[1]]).slice(0, 512);
        return { editor, patternId: w.patternId, notes };
    }
    if (editor === 'section') {
        if (typeof w.sectionId !== 'string' || !Array.isArray(w.clipIds)) return null;
        return { editor, sectionId: w.sectionId, clipIds: w.clipIds.filter(id => typeof id === 'string').slice(0, 256) };
    }
    return null;
}

/**
 * The peers to draw in `editor`, with `where` matching `key`
 * (`{ sectionId }` or `{ patternId }`): `[{ peer, alias, color, where }]`.
 */
export function cursorsIn(editor, key = {}) {
    const out = [];
    for (const r of remote.values()) {
        const w = r.where[editor];
        if (!w) continue;
        if (key.sectionId && w.sectionId !== key.sectionId) continue;
        if (key.patternId && w.patternId !== key.patternId) continue;
        out.push({ peer: r.peer, alias: r.alias, color: r.color, where: w });
    }
    return out;
}

export function onCursors(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
