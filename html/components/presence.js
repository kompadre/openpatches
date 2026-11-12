// Presence: who else is editing what, for the editors to show in place.
//
// collab.js writes it (`setPresence`) from the session's presence list;
// the Section editor, the Tracker and the Mixer read it while they render
// (`presenceOn`) and re-render when it changes (`onPresence`). That keeps
// the editors free of collab: outside a session the list is empty and
// nothing is drawn.
//
// An entry is `{ peer, alias, color, scope }`, scope being `{patternId}`,
// `{trackId}`, `{sectionId}` or `{}` — what a beginEdit named. Transport is
// not presence: nobody's playhead travels.

let list = [];
const listeners = new Set();

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function setPresence(next) {
    const clean = (Array.isArray(next) ? next : []).filter(e => e && e.scope).map(e => ({
        peer: String(e.peer || ''), alias: String(e.alias || e.peer || 'someone'),
        color: /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#f0a030', scope: e.scope,
    }));
    if (same(clean, list)) return;
    list = clean;
    for (const fn of [...listeners]) { try { fn(list); } catch (err) { console.warn('[presence] listener failed:', err); } }
}

export function getPresence() { return list; }

/** Who is on any of these: `{ patternIds?: [], trackId?, sectionId? }`. */
export function presenceOn({ patternIds = [], trackId = null, sectionId = null } = {}) {
    return list.filter(e => (e.scope.patternId && patternIds.includes(e.scope.patternId))
        || (trackId && e.scope.trackId === trackId)
        || (sectionId && e.scope.sectionId === sectionId));
}

/** Mark an element: an outline in the first person's colour, every alias on hover. */
export function markPresence(el, people) {
    if (!el || !people.length) return;
    el.classList.add('peer-editing');
    el.style.setProperty('--peer-color', people[0].color);
    el.dataset.peers = people.map(p => p.alias).join(', ');
    const note = people.map(p => p.alias).join(', ') + (people.length === 1 ? ' is' : ' are') + ' editing this';
    el.title = el.title ? el.title + '\n' + note : note;
}

export function onPresence(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
