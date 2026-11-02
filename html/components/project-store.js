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
// Instead this autosaves, with an immediate flush on `visibilitychange ->
// hidden`. That event fires while the page is still alive, so the write
// actually lands, and it is the only one that fires when a mobile browser
// kills a backgrounded tab (`beforeunload` is skipped there, and in
// bfcache). `pagehide` is wired too, as belt-and-braces for desktop closes.
//
// ## The autosave policy
//
// A periodic tick, not a debounce: every `intervalMs` (30 s), and only when
// there is something to write. Three rules on top, all asked for:
//
//   - **Not while the transport is busy.** `canSave()` is injected by
//     whoever knows — the flush is skipped and retried on the next tick.
//     The cost being avoided is the synchronous JSON clone below: measured
//     at 1.6 ms for a small project and 4.3 ms for a large one (364 KB,
//     1000 patches). The audio runs on its own thread, so this is not a
//     dropout risk; what it would delay is the main thread's handling of a
//     tick message, i.e. note-scheduling jitter. Cheap to avoid, so avoid it.
//   - **Stopping a take flushes.** `flush({ force: true })` — see `force`
//     below. A finished take is exactly when the user expects it saved.
//   - **The lifecycle flush is forced**, overriding `canSave()`. A tab
//     killed mid-playback must not lose the session: "do not save while
//     playing" is a latency preference, and it loses to not losing work.
//
// `force` is therefore the distinction between "autosave, if now is a good
// moment" and "write this out, now, because the moment may not come again".

import { createProject, normalizeProject } from './project-model.js';

/** Autosave period. Only ticks that find the body dirty cost anything. */
export const DEFAULT_INTERVAL_MS = 30_000;

/**
 * The crash journal: the open body, written **synchronously** to
 * localStorage when the page goes away with unsaved edits.
 *
 * This exists because the obvious design does not work, and it was
 * measured rather than assumed. On `pagehide` the handlers *do* run — both
 * `visibilitychange: hidden` and `pagehide` fire on an ordinary reload —
 * and the IndexedDB transaction *is* opened inside the handler, and the
 * write still does **not** commit: the page is torn down first, and the
 * edits are gone. Reloading five seconds after typing a note lost the note.
 *
 * localStorage is the only store that survives, because it is synchronous.
 * So the last-gasp path writes the whole body there, and the next boot
 * prefers the journal over the IndexedDB body when it is newer, re-writing
 * it properly. IndexedDB stays the real home — the journal is a scratch
 * copy that exists for at most one page load, and is dropped the moment a
 * real write lands.
 */
const JOURNAL_KEY = 'openpatches_project_journal';

/**
 * The few bytes left behind when even the journal could not be written —
 * see `writeJournal`. Read once on the next boot so the user can be told
 * their last session's edits are gone, rather than discovering it.
 */
const LOST_KEY = 'openpatches_project_lost';

/**
 * Read and clear the "a save was lost" marker. Called once at startup by
 * whatever is going to report it; taking it means it is reported exactly
 * once.
 */
export function takeLostSaveMarker() {
    try {
        const raw = localStorage.getItem(LOST_KEY);
        if (!raw) return null;
        localStorage.removeItem(LOST_KEY);
        return JSON.parse(raw);
    } catch { return null; }
}

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
 * @param {number} [opts.intervalMs]   autosave period
 * @param {function} [opts.canSave]    () => boolean — "now is a good moment".
 *                                     Injected by whoever knows whether the
 *                                     transport is busy. Never consulted by a
 *                                     forced flush.
 * @param {function} [opts.onError]    flush failures (quota, a closed db)
 * @param {boolean} [opts.bindLifecycle]  attach the visibilitychange/pagehide
 *                                        flush; defaults to true in a browser
 */
export function createProjectStore(opts = {}) {
    const backend = opts.backend || createDefaultBackend();
    const intervalMs = opts.intervalMs == null ? DEFAULT_INTERVAL_MS : opts.intervalMs;
    const canSave = opts.canSave || (() => true);
    const onError = opts.onError || ((e) => console.warn('[project-store] flush failed:', e));

    let project = null;      // the open body — the source of truth while open
    let dirty = false;
    let timer = null;
    // How many writes are enqueued or running. `saving` is `pending > 0`,
    // and idle is reached when the last of them settles — **however it
    // settles**. Counting rather than asking "is the body still dirty?":
    // a failed write leaves it dirty, and a dirty body only means a *future*
    // tick will write, not that one is running now. Getting that wrong
    // wedges `saving` on forever and Play waits for a save that is not
    // happening.
    let pending = 0;
    let saving = false;
    // The last write failed and the body on disk is still stale. Surfaced
    // rather than only logged: this is the one state where the user can
    // actually do something (stay on the page, retry) and the only one
    // where leaving costs them work.
    let failed = false;
    // Writes are serialised through this so a slow save cannot be overtaken
    // by a faster one started later and leave the older body on disk.
    let inFlight = Promise.resolve();
    // Resolvers waiting for the store to go quiet — see whenIdle().
    let idleWaiters = [];
    const subscribers = new Set();

    function notify(reason) {
        for (const fn of [...subscribers]) {
            try { fn({ reason, project, saving, dirty, failed }); } catch (e) { console.warn('[project-store] subscriber failed:', e); }
        }
    }

    // --- The crash journal (see JOURNAL_KEY) ---

    function readJournal() {
        try {
            const raw = localStorage.getItem(JOURNAL_KEY);
            if (!raw) return null;
            const body = JSON.parse(raw);
            return body && body.id ? body : null;
        } catch { return null; }
    }

    /**
     * Synchronous, and called from an unload handler. Must not throw.
     *
     * localStorage has a quota (~5 MB for the whole origin, shared with
     * the patch library and the profile), so a large project can fail to
     * fit. Nothing can be shown at that point — the page is already going
     * — so the fallback is a handful of bytes saying *that* it happened.
     * The next boot reads that and tells the user, which is the only
     * honest option left: losing work silently is the one outcome this
     * whole mechanism exists to prevent.
     *
     * The stale journal is dropped rather than kept. It is older than what
     * we just failed to write, so restoring it would quietly resurrect the
     * wrong state and look like success.
     */
    function writeJournal(body) {
        try {
            localStorage.setItem(JOURNAL_KEY, JSON.stringify(body));
            return true;
        } catch (e) {
            try { localStorage.removeItem(JOURNAL_KEY); } catch { /* ignore */ }
            try {
                localStorage.setItem(LOST_KEY, JSON.stringify({
                    id: body.id, name: body.name, at: Date.now(),
                }));
            } catch { /* nothing left to try */ }
            onError(e);
            return false;
        }
    }

    /**
     * Drop the journal once a real write has carried it. Guarded on id and
     * time: a journal newer than what was written is still the only copy
     * of those edits, and one for another project is not ours to throw away.
     */
    function clearJournal(id, modified) {
        const journal = readJournal();
        if (!journal || journal.id !== id) return;
        if ((journal.modified || 0) > (modified || 0)) return;
        try { localStorage.removeItem(JOURNAL_KEY); } catch { /* ignore */ }
    }

    /** The last enqueued write has settled: let go of everyone waiting. */
    function settle() {
        pending--;
        if (pending > 0) return;
        saving = false;
        notify('save-end');
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
    }

    /**
     * Write the body out. Resolves when it has actually landed.
     *
     * `force` bypasses `canSave()`: an autosave tick is a suggestion, a
     * forced flush is "the moment may not come again" — closing, switching
     * project, or the end of a take.
     */
    function flush({ force = false } = {}) {
        if (!project || !dirty) return inFlight;
        if (!force && !canSave()) return inFlight;   // try again next tick
        const body = clone(project);
        dirty = false;
        pending++;
        if (!saving) { saving = true; notify('save-start'); }
        // With nothing already in flight, the write **starts in this task**
        // rather than a microtask later. That is invisible almost always
        // and decisive once: during `pagehide`, whether the IndexedDB
        // transaction was opened inside the event handler or just after it
        // is the difference between the last edits being committed and
        // being lost. Only chain when ordering actually requires it.
        failed = false;
        let write;
        if (pending === 1) {
            try { write = Promise.resolve(backend.save(body.id, body)); }
            catch (e) { write = Promise.reject(e); }
        } else {
            write = inFlight.then(() => backend.save(body.id, body));
        }
        inFlight = write
            .then(() => clearJournal(body.id, body.modified))
            .catch((e) => {
                // Put the flag back: the body on disk is still stale, and the
                // next tick (or flush) should try again rather than assume it
                // was written.
                dirty = true;
                failed = true;
                notify('save-failed');
                onError(e);
            })
            .then(settle);
        return inFlight;
    }

    /**
     * "The body changed." Bumps `modified`, starts the autosave ticker if it
     * is not already running, tells subscribers. Synchronous on purpose —
     * this is what keeps every mutator in the app synchronous.
     */
    function touch(reason = 'edit') {
        if (!project) return;
        project.modified = Date.now();
        dirty = true;
        startTicker();
        notify(reason);
    }

    // One repeating timer rather than one per edit: a tick that finds the
    // body clean costs nothing, and a burst of edits cannot stack up timers.
    function startTicker() {
        if (timer != null || intervalMs <= 0) return;
        timer = setInterval(() => flush(), intervalMs);
        if (timer && typeof timer.unref === 'function') timer.unref();   // node: do not hold the process open
    }

    function stopTicker() {
        if (timer != null) { clearInterval(timer); timer = null; }
    }

    const api = {
        /** The open body, or null. Mutate it, then `touch()`. */
        get() { return project; },
        getId() { return project ? project.id : null; },
        isDirty() { return dirty; },

        /** A write is in flight. What Play checks before it starts. */
        isSaving() { return saving; },

        /** The last write failed, so the stored body is behind the open one. */
        hasFailed() { return failed; },

        /**
         * Resolves once nothing is being written.
         *
         * This is the Play deferral: pressing Play the millisecond a save
         * begins must not start the transport mid-write, so the button goes
         * down, the transport waits here, and the take starts when the store
         * is quiet. Resolves immediately when it already is, so the common
         * case costs one microtask.
         */
        whenIdle() {
            if (!saving) return Promise.resolve();
            return new Promise((resolve) => idleWaiters.push(resolve));
        },

        /**
         * Load a project by id, flushing whatever was open first.
         *
         * A miss returns null and **leaves the open project open**: a stale
         * index row pointing at a body that is gone must not cost the user
         * the project they are working on.
         */
        async open(id) {
            await flush({ force: true });
            const stored = await backend.load(id);
            // Edits the page died holding. Newer than the stored body means
            // the last IndexedDB write never landed, so the journal is the
            // only copy — take it and write it out properly.
            const journal = readJournal();
            const recovered = journal && journal.id === id
                && (journal.modified || 0) > (stored ? stored.modified || 0 : -1)
                ? journal
                : null;
            const body = recovered || stored;
            if (!body) return null;
            project = createProject(body);
            dirty = !!recovered;
            notify('open');
            if (recovered) flush({ force: true });
            return project;
        },

        /**
         * Adopt a body that is already in hand — a new project, or one just
         * imported. Written through immediately: a project that exists only
         * in memory would not survive the tab being closed before the first
         * edit, and it is already in the index by then.
         */
        /**
         * Adopt a body that is already in hand — a new project, or one just
         * imported — **synchronously**, writing it out behind us.
         *
         * Safe to swap the body out from under the outgoing flush because
         * `flush()` takes its clone synchronously: by the time this returns,
         * the old project's bytes are already captured and only the write
         * itself is still pending.
         *
         * Sync because the editors read `get()` straight after: making the
         * UI wait a microtask for IndexedDB to acknowledge a project it
         * already has in memory buys nothing.
         */
        adoptNow(partial, { write = true } = {}) {
            flush({ force: true });              // clones the outgoing body now
            project = createProject(partial);
            dirty = write;
            notify('open');
            // `write: false` means "this body is already what is on disk" —
            // for a project just read back, or a test fixture standing in
            // for one. Skipping the write also leaves the store *idle*,
            // which matters: an adopt that leaves a write in flight makes
            // the very next play() defer behind it.
            if (write) flush({ force: true });
            return project;
        },

        /** `adoptNow`, awaited to the point the body is actually written. */
        async adopt(partial) {
            const adopted = api.adoptNow(partial);
            await inFlight;
            return adopted;
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
            await flush({ force: true });
            project = null;
            notify('close');
        },

        /** Drop a project's body. Clears the open one if that is the one. */
        async remove(id) {
            if (project && project.id === id) {
                stopTicker();
                project = null;
                dirty = false;
                notify('close');
            }
            await backend.remove(id);
        },

        /** Every stored body, for export-all and for the wipe. */
        listIds() { return backend.listIds(); },

        /**
         * A stored body, without opening it — what Duplicate and Export
         * need for a project that is not the one on screen.
         */
        read(id) {
            if (project && project.id === id) return Promise.resolve(clone(project));
            return backend.load(id);
        },

        /**
         * Drop every body. The project half of "delete everything" — the
         * profile and the WAV upload store are the other two, and all three
         * have to go together or the next load finds an index pointing at
         * bodies that are not there.
         */
        async clear() {
            stopTicker();
            project = null;
            dirty = false;
            try { localStorage.removeItem(JOURNAL_KEY); } catch { /* ignore */ }
            try { localStorage.removeItem(LOST_KEY); } catch { /* ignore */ }
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
    //
    // **Forced**, so it overrides `canSave()`. A tab killed mid-playback
    // must not lose the session — "do not save while playing" is a latency
    // preference, and it loses to not losing work.
    const bind = opts.bindLifecycle == null
        ? typeof document !== 'undefined'
        : opts.bindLifecycle;
    //
    // The journal goes first and synchronously: the IndexedDB write started
    // just below is the one that usually wins, but it is also the one that
    // is not guaranteed to commit, and on a plain reload it measurably does
    // not. Writing both costs a few milliseconds once, at the very moment
    // nobody is waiting.
    function lastGasp() {
        if (dirty && project) writeJournal(project);
        flush({ force: true });
    }

    if (bind && typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') lastGasp();
        });
        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', lastGasp);
        }
    }

    return api;
}
