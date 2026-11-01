// Project persistence: an in-memory body, a debounced flush, a pluggable
// backend.
//
// ## Why the body is in memory
//
// Project bodies live in IndexedDB, which is asynchronous — but every store
// in this app is synchronous (`localStorage.setItem` inside the mutator),
// across some thirty call sites, and the test harness has a localStorage
// stub and no IndexedDB at all. Making persistence genuinely async would
// turn every one of those call sites into an await.
//
// So the open project's body **is** the source of truth while it is open:
// loaded once, mutated synchronously by whoever wants to, and flushed back
// whole. Callers call `touch()` and carry on; nothing becomes async. That is
// also exactly the "load on open, dump on save" shape the design asked for.
//
// ## Why there is no "Save your changes?" on the way out
//
// There cannot be. A page cannot show its own `confirm()` during
// `beforeunload` — browsers suppress it and offer only their own generic
// dialog — and, more to the point, **an IndexedDB transaction opened during
// unload is not guaranteed to commit**: the page can be torn down first.
// Asking the question is unreliable and acting on the answer is worse.
//
// Instead this autosaves, as the rest of the app always has: a debounced
// flush, plus an immediate one on `visibilitychange -> hidden`. That event
// fires while the page is still alive, so the write actually lands, and it
// is the only one that fires when a mobile browser kills a backgrounded tab
// (`beforeunload` is skipped there, and in bfcache). The worst case is
// losing the last few hundred milliseconds, and there is nothing to confirm.
//
// `pagehide` is wired too, as a belt-and-braces for desktop closes — it
// often does get the write out, and when it does not, `hidden` already did.

import { createProject, normalizeProject } from './project-model.js';

export const DEFAULT_DEBOUNCE_MS = 500;

// --- Backends ---
//
// A backend is four async methods over opaque JSON bodies keyed by project
// id: `load(id)`, `save(id, body)`, `remove(id)`, `listIds()`. Swapping it is
// how the tests avoid needing an IndexedDB stub.

/** Everything in a Map. The tests' backend, and the fallback when IDB is absent. */
export function createMemoryBackend(seed = {}) {
    const bodies = new Map(Object.entries(seed).map(([k, v]) => [k, clone(v)]));
    return {
        async load(id) {
            const body = bodies.get(id);
            return body ? clone(body) : null;
        },
        async save(id, body) { bodies.set(id, clone(body)); },
        async remove(id) { bodies.delete(id); },
        async listIds() { return [...bodies.keys()]; },
        async clear() { bodies.clear(); },
        /** Test seam: what is actually on "disk", without going through load(). */
        _raw: bodies,
    };
}

const DB_NAME = 'openpatches_projects';
const DB_VERSION = 1;
const STORE_NAME = 'projects';

/**
 * IndexedDB, one object store keyed by project id. The open is lazy and
 * cached: constructing the backend must not fail in a context without
 * IndexedDB, because app.js builds it at import time.
 */
export function createIdbBackend() {
    let dbPromise = null;

    function db() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = (e) => {
                    const d = e.target.result;
                    if (!d.objectStoreNames.contains(STORE_NAME)) d.createObjectStore(STORE_NAME);
                };
                req.onsuccess = (e) => resolve(e.target.result);
                req.onerror = () => reject(req.error);
            });
        }
        return dbPromise;
    }

    function run(mode, fn) {
        return db().then(d => new Promise((resolve, reject) => {
            const tx = d.transaction(STORE_NAME, mode);
            const req = fn(tx.objectStore(STORE_NAME));
            if (req) {
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            } else {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            }
        }));
    }

    return {
        load: (id) => run('readonly', (s) => s.get(id)).then(v => v || null),
        save: (id, body) => run('readwrite', (s) => s.put(body, id)),
        remove: (id) => run('readwrite', (s) => s.delete(id)),
        listIds: () => run('readonly', (s) => s.getAllKeys()),
        clear: () => run('readwrite', (s) => s.clear()),
    };
}

/** IndexedDB where there is one, memory where there is not (node, tests). */
export function createDefaultBackend() {
    if (typeof indexedDB === 'undefined') return createMemoryBackend();
    return createIdbBackend();
}

// Structured JSON round-trip. Bodies are plain data by construction (see
// project-model.js), so this both deep-copies and proves it — a Uint8Array
// that sneaked in would come back as an object and fail a test loudly rather
// than quietly surviving in memory and vanishing on reload.
function clone(v) {
    return JSON.parse(JSON.stringify(v));
}

// --- The store ---

/**
 * @param {object} [opts]
 * @param {object} [opts.backend]      defaults to IndexedDB, or memory without it
 * @param {number} [opts.debounceMs]   idle time before a flush
 * @param {function} [opts.onError]    flush failures (quota, a closed db)
 * @param {boolean} [opts.bindLifecycle]  attach the visibilitychange/pagehide
 *                                        flush; defaults to true in a browser
 */
export function createProjectStore(opts = {}) {
    const backend = opts.backend || createDefaultBackend();
    const debounceMs = opts.debounceMs == null ? DEFAULT_DEBOUNCE_MS : opts.debounceMs;
    const onError = opts.onError || ((e) => console.warn('[project-store] flush failed:', e));

    let project = null;      // the open body — the source of truth while open
    let dirty = false;
    let timer = null;
    // A flush already in flight. Writes are serialised through it so a slow
    // save cannot be overtaken by a faster one started later and leave the
    // older body on disk.
    let inFlight = Promise.resolve();
    const subscribers = new Set();

    function notify(reason) {
        for (const fn of [...subscribers]) {
            try { fn({ reason, project }); } catch (e) { console.warn('[project-store] subscriber failed:', e); }
        }
    }

    /** Write the body out now. Resolves when it has actually landed. */
    function flush() {
        if (timer != null) { clearTimeout(timer); timer = null; }
        if (!project || !dirty) return inFlight;
        const body = clone(project);
        dirty = false;
        inFlight = inFlight
            .then(() => backend.save(body.id, body))
            .catch((e) => {
                // Put the flag back: the body on disk is still stale, and the
                // next touch (or flush) should try again rather than assume
                // it was written.
                dirty = true;
                onError(e);
            });
        return inFlight;
    }

    /**
     * "The body changed." Bumps `modified`, schedules a flush, tells
     * subscribers. Synchronous on purpose — this is what keeps every mutator
     * in the app synchronous.
     */
    function touch(reason = 'edit') {
        if (!project) return;
        project.modified = Date.now();
        dirty = true;
        if (timer == null) timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
        notify(reason);
    }

    const api = {
        /** The open body, or null. Mutate it, then `touch()`. */
        get() { return project; },
        getId() { return project ? project.id : null; },
        isDirty() { return dirty; },

        /**
         * Load a project by id, flushing whatever was open first.
         *
         * A miss returns null and **leaves the open project open**: a stale
         * index row pointing at a body that is gone must not cost the user
         * the project they are working on.
         */
        async open(id) {
            await flush();
            const body = await backend.load(id);
            if (!body) return null;
            project = createProject(body);
            dirty = false;
            notify('open');
            return project;
        },

        /**
         * Adopt a body that is already in hand — a new project, or one just
         * imported. Written through immediately: a project that exists only
         * in memory would not survive the tab being closed before the first
         * edit, and it is already in the index by then.
         */
        async adopt(partial) {
            await flush();
            project = createProject(partial);
            dirty = true;
            notify('open');
            await flush();
            return project;
        },

        /**
         * Re-run the cross-record invariants after a batch of edits (several
         * tracks removed, patterns dropped). Individual mutators in
         * project-model.js keep the project consistent on their own; this is
         * for callers that have been rummaging in the body directly.
         */
        renormalize() {
            if (!project) return null;
            normalizeProject(project);
            touch('renormalize');
            return project;
        },

        touch,
        flush,

        async close() {
            await flush();
            project = null;
            notify('close');
        },

        /** Drop a project's body. Clears the open one if that is the one. */
        async remove(id) {
            if (project && project.id === id) {
                if (timer != null) { clearTimeout(timer); timer = null; }
                project = null;
                dirty = false;
                notify('close');
            }
            await backend.remove(id);
        },

        /** Every stored body, for export-all and for the wipe. */
        listIds() { return backend.listIds(); },

        /**
         * Drop every body. The project half of "delete everything" — the
         * profile and the WAV upload store are the other two, and all three
         * have to go together or the next load finds an index pointing at
         * bodies that are not there.
         */
        async clear() {
            if (timer != null) { clearTimeout(timer); timer = null; }
            project = null;
            dirty = false;
            await backend.clear();
            notify('close');
        },

        subscribe(fn) {
            subscribers.add(fn);
            return () => subscribers.delete(fn);
        },
    };

    // See the header: `hidden` is the one that reliably fires, and it fires
    // early enough that the write commits.
    const bind = opts.bindLifecycle == null
        ? typeof document !== 'undefined'
        : opts.bindLifecycle;
    if (bind && typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush();
        });
        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', () => flush());
        }
    }

    return api;
}
