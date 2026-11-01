// The profile: the layer above projects, and the one thing that is never
// exported.
//
// It holds what belongs to *this person on this machine* rather than to a
// piece of music:
//
//   - the **project index** — id, name and timestamps for every project, so
//     a switcher can be drawn without loading a single body out of
//     IndexedDB (bodies are big; the index is one small localStorage read);
//   - which project is **open**;
//   - the **tag vocabulary** — the full set of tags the user has ever
//     coined. A project exports only the tags it actually uses, and an
//     import unions those back in here. Tags are just a vocabulary with no
//     further meaning, so unioning is always safe.
//
// Not here, deliberately: MIDI port selection and output latency, which are
// properties of the machine and live in midi-manager's own key; and the UI
// prefs, which already have theirs. They are profile-level by nature and
// moving them would be churn for its own sake.
//
// localStorage, synchronous, small. The *bodies* are what needed IndexedDB.

const PROFILE_KEY = 'openpatches_profile';

export const PROFILE_VERSION = 1;

function nonEmptyName(name, fallback) {
    const s = String(name == null ? '' : name).trim();
    return s || fallback;
}

function emptyProfile() {
    return { version: PROFILE_VERSION, projects: [], currentProjectId: null, tags: [] };
}

/** One index row. Everything a switcher needs and nothing that needs a body. */
function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object' || !raw.id) return null;
    return {
        id: String(raw.id),
        name: nonEmptyName(raw.name, 'Untitled project'),
        created: Number(raw.created) || Date.now(),
        modified: Number(raw.modified) || Number(raw.created) || Date.now(),
    };
}

function normalizeProfile(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    const projects = [];
    const seen = new Set();
    for (const row of Array.isArray(p.projects) ? p.projects : []) {
        const entry = normalizeEntry(row);
        // A duplicate id would make the switcher show one project twice and
        // the second row's name would be the one that sticks.
        if (entry && !seen.has(entry.id)) { seen.add(entry.id); projects.push(entry); }
    }
    const tags = new Set();
    for (const t of Array.isArray(p.tags) ? p.tags : []) {
        const s = String(t == null ? '' : t).trim();
        if (s) tags.add(s);
    }
    const current = p.currentProjectId && seen.has(String(p.currentProjectId))
        ? String(p.currentProjectId)
        : null;
    return {
        version: PROFILE_VERSION,
        projects,
        currentProjectId: current,
        tags: [...tags].sort(),
    };
}

function load() {
    try {
        return normalizeProfile(JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'));
    } catch { return emptyProfile(); }
}

function save(profile) {
    try {
        localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch (e) {
        console.warn('[profile] save failed:', e);
    }
    return profile;
}

/**
 * Most recently touched first — the order a switcher wants, and the order
 * `init()` falls back through.
 */
const byRecent = (a, b) => b.modified - a.modified;

export const profileStore = {
    get() { return load(); },

    /** The index, most recently modified first. */
    list() { return load().projects.slice().sort(byRecent); },

    get current() { return load().currentProjectId; },

    getEntry(id) { return load().projects.find(p => p.id === id) || null; },

    has(id) { return load().projects.some(p => p.id === id); },

    /**
     * Add or update an index row from a project body. Called on every save,
     * so the index cannot drift from the names in the bodies.
     */
    upsert(project) {
        const profile = load();
        const entry = normalizeEntry({
            id: project.id,
            name: project.name,
            created: project.created,
            modified: project.modified || Date.now(),
        });
        if (!entry) return null;
        const i = profile.projects.findIndex(p => p.id === entry.id);
        if (i < 0) profile.projects.push(entry);
        else profile.projects[i] = entry;
        save(profile);
        return entry;
    },

    remove(id) {
        const profile = load();
        const i = profile.projects.findIndex(p => p.id === id);
        if (i < 0) return false;
        profile.projects.splice(i, 1);
        if (profile.currentProjectId === id) {
            // Fall to the next most recent rather than to nothing: the app
            // always has a project open, and picking here keeps that choice
            // out of every caller.
            const next = profile.projects.slice().sort(byRecent)[0];
            profile.currentProjectId = next ? next.id : null;
        }
        save(profile);
        return true;
    },

    setCurrent(id) {
        const profile = load();
        if (id != null && !profile.projects.some(p => p.id === id)) return false;
        profile.currentProjectId = id == null ? null : String(id);
        save(profile);
        return true;
    },

    /**
     * A name no existing project is using, by appending " 2", " 3"… — what
     * an import does on a collision. The **incoming** project is the one
     * renamed; the one already on disk is never touched.
     */
    uniqueName(wanted, { ignoreId = null } = {}) {
        const base = nonEmptyName(wanted, 'Untitled project');
        const taken = new Set(
            load().projects
                .filter(p => p.id !== ignoreId)
                .map(p => p.name.toLowerCase()),
        );
        if (!taken.has(base.toLowerCase())) return base;
        for (let n = 2; ; n++) {
            const candidate = `${base} ${n}`;
            if (!taken.has(candidate.toLowerCase())) return candidate;
        }
    },

    // --- Tag vocabulary ---

    tags() { return load().tags; },

    /** Union tags in — what an import does with the tags a project used. */
    addTags(tags) {
        const profile = load();
        const set = new Set(profile.tags);
        const before = set.size;
        for (const t of Array.isArray(tags) ? tags : [tags]) {
            const s = String(t == null ? '' : t).trim();
            if (s) set.add(s);
        }
        if (set.size === before) return profile.tags;
        profile.tags = [...set].sort();
        save(profile);
        return profile.tags;
    },

    removeTag(tag) {
        const profile = load();
        const i = profile.tags.indexOf(tag);
        if (i < 0) return false;
        profile.tags.splice(i, 1);
        save(profile);
        return true;
    },

    /**
     * The profile half of "delete everything". The project bodies and the
     * WAV upload store are the other two; all three go together or the next
     * load finds an index pointing at bodies that are not there.
     */
    clear() {
        try { localStorage.removeItem(PROFILE_KEY); } catch { /* ignore */ }
    },
};
