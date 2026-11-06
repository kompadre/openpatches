// Import from another project into the open one (File → Import into This
// Project…). Unlike Import Project, nothing new is created: the user picks
// which **patches** and **patterns** of the file come in, and they join the
// open project. Pure — this plans; app.js applies through the stores.
//
// - A patch is identified by its id, which patch-model derives from its
//   bytes (and name): one already here is skipped, not doubled.
// - A pattern always comes in as a **new** pattern (fresh id), because the
//   one here with the same id, if any, may since have been edited. A name
//   already taken gets " (2)", " (3)"… Imported patterns are placed
//   nowhere: they appear in the library, ready to be dragged in.
// - Tracks, sections and clips do not come: they are an arrangement of
//   *that* project's band, and grafting it onto this one is a different
//   feature.

/** What the file offers, and whether each patch is already here. */
export function importCandidates(source, target) {
    const have = (target && target.patches) || {};
    const patches = Object.values((source && source.patches) || {})
        .filter(p => p && p.id && p.voice_data)
        .map(p => ({ id: p.id, name: p.name || 'Untitled', present: Object.prototype.hasOwnProperty.call(have, p.id) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const patterns = Object.values((source && source.patterns) || {})
        .filter(p => p && p.id)
        .map(p => ({ id: p.id, name: p.name, notes: (p.notes || []).length, measures: p.measures }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return { patches, patterns };
}

/** `name`, or `name (2)`, `name (3)`… — the first not in `taken`. */
export function freeName(name, taken) {
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) {
        const n = `${name} (${i})`;
        if (!taken.has(n)) return n;
    }
}

/**
 * The records to add, for the chosen ids. Patches already present are
 * left out; patterns lose their id (the session mints one) and get a free
 * name. Returns plain data for the caller to hand to the stores.
 */
export function planImport(source, target, { patchIds = [], patternIds = [] } = {}) {
    const have = (target && target.patches) || {};
    const wantPatches = new Set(patchIds);
    const patches = Object.values((source && source.patches) || {})
        .filter(p => p && wantPatches.has(p.id) && !Object.prototype.hasOwnProperty.call(have, p.id))
        .map(p => JSON.parse(JSON.stringify(p)));
    const names = {};
    for (const p of patches) {
        const n = source.patchNames && source.patchNames[p.id];
        if (n != null) names[p.id] = n;
    }
    const taken = new Set(Object.values((target && target.patterns) || {}).map(p => p.name));
    const wantPatterns = new Set(patternIds);
    const patterns = [];
    for (const p of Object.values((source && source.patterns) || {})) {
        if (!p || !wantPatterns.has(p.id)) continue;
        const name = freeName(p.name, taken);
        taken.add(name);
        const { id, created, ...rest } = JSON.parse(JSON.stringify(p));
        patterns.push({ ...rest, name });
    }
    return { patches, patchNames: names, patterns };
}
