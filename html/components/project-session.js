// The open project, shared by every editor.
//
// Replaces song-session.js. Same job — one owner of the record, so no
// editor can overwrite another's saves — but a project is bigger than a
// song, so the session also owns **which section is being edited**. The UI
// edits exactly one at a time; the model carries many.
//
// Notifications carry a `source` so an editor can ignore its own echoes
// (the roll must not re-adopt the project in the middle of its own drag),
// and a `kind` saying what moved:
//
//   'project'  — the open project changed, or was replaced wholesale
//   'section'  — a different section is being edited
//   'pattern'  — one pattern's notes changed (the roll, mid-edit)
//   'tracks'   — the band changed: added, removed, renamed, re-patched
//   'saving'   — a write started or finished (for the save indicator)
//
// ## Persistence
//
// The session never writes storage itself. It mutates the in-memory body
// and calls `store.touch()`; project-store decides when that reaches
// IndexedDB (every 30 s, not while the transport is busy, forced at the
// moments that matter). That split is what keeps every mutator here
// synchronous — see project-store.js for why the body has to live in
// memory at all.
//
// The profile index is upserted on every touch, so the switcher's names
// and timestamps cannot drift from the bodies they describe.

import {
    createProject, createPattern, getSection, effectiveBpm,
    addPattern, removePattern, patternUsage,
} from './project-model.js';
import { profileStore } from './profile-store.js';

export function createProjectSession(store) {
    let sectionId = null;
    const subscribers = new Set();

    function notify(kind, detail = {}) {
        for (const fn of [...subscribers]) {
            try { fn({ kind, ...detail }); } catch (e) { console.warn('[project-session] subscriber failed:', e); }
        }
    }

    /**
     * The edited section, always a real one: a stale id (its section was
     * deleted, or a body arrived without it) falls back to the first rather
     * than leaving every caller to handle null.
     */
    function section() {
        const project = store.get();
        if (!project) return null;
        const found = sectionId && getSection(project, sectionId);
        if (found) return found;
        sectionId = project.sections[0].id;   // normalizeProject guarantees one
        return project.sections[0];
    }

    /** Mutate-then-announce. The one path that reaches storage. */
    function changed(kind, source, detail = {}) {
        const project = store.get();
        if (!project) return null;
        store.touch(kind);
        profileStore.upsert(project);
        notify(kind, { source, projectId: project.id, ...detail });
        return project;
    }

    // Writes started and finished by the store itself (an autosave tick, a
    // forced flush) are passed on, so an indicator can subscribe to the
    // session alone rather than to both.
    store.subscribe((e) => {
        if (e.reason === 'save-start' || e.reason === 'save-end') {
            notify('saving', { saving: e.saving });
        }
    });

    const api = {
        /**
         * Open the remembered project, else the most recent, else a new
         * empty one. Idempotent, and always leaves a project open — the app
         * has no state in which there is none.
         */
        async init() {
            if (store.get()) return store.get();
            // A backend that cannot be read at all — IndexedDB blocked in a
            // locked-down profile, a corrupt database — must not take the
            // app with it. Every read is allowed to fail; the last step
            // needs no backend to succeed, so there is always a project.
            const wanted = profileStore.current;
            if (wanted && await tryOpen(wanted)) return adopted('init');
            for (const entry of profileStore.list()) {
                if (await tryOpen(entry.id)) return adopted('init');
            }
            try {
                await store.adopt(createProject({ name: 'Untitled project' }));
            } catch (e) {
                console.warn('[project-session] starting without persistence:', e);
            }
            return adopted('init');
        },

        get() { return store.get(); },
        getId() { return store.get() ? store.get().id : null; },

        /** The section being edited, and the one the transport plays. */
        getSection() { return section(); },
        getSectionId() { return section() ? section().id : null; },

        /**
         * Switch section. Refuses an id this project does not have, so a
         * stale menu cannot blank the editor.
         */
        setSection(id, source) {
            const project = store.get();
            if (!project || !getSection(project, id)) return false;
            if (id === sectionId) return true;
            sectionId = id;
            notify('section', { source, projectId: project.id, sectionId });
            return true;
        },

        /** The tempo the edited section actually plays at. */
        getBpm() { return effectiveBpm(store.get(), section()); },

        // --- Patterns ---
        //
        // The library is the project's, so these replace what used to be a
        // global `patternStore`. Going through the session rather than
        // letting editors reach into `project.patterns` directly is what
        // keeps the notification (and so the other editor's redraw, and the
        // autosave) from being forgotten at a call site.

        /** A pattern by id, from the open project's library. */
        getPattern(id) {
            const project = store.get();
            return project ? project.patterns[id] || null : null;
        },

        /** Every pattern, by name — the order the palette shows them in. */
        listPatterns() {
            const project = store.get();
            if (!project) return [];
            return Object.values(project.patterns)
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        },

        createPattern(partial, source) {
            const project = store.get();
            if (!project) return null;
            const pattern = addPattern(project, partial);
            changed('pattern', source, { patternId: pattern.id });
            return pattern;
        },

        /**
         * Merge changes into a pattern. Re-runs the factory, so a shortened
         * `measures` drops the notes that fall outside — the same rule the
         * editor's own resize enforces.
         */
        updatePattern(id, changes, source) {
            const project = store.get();
            const existing = project && project.patterns[id];
            if (!existing) return null;
            const next = createPattern({ ...existing, ...changes, id });
            // Written back **into** the existing record rather than
            // replacing it. The pattern editor holds a reference to this
            // object *and* to its notes array (that binding is what lets
            // its drawing code be unaware of patterns at all), so swapping
            // the record would leave the roll editing an orphan that is no
            // longer in the project — the edits would keep showing on
            // screen and never reach the body.
            const notes = existing.notes;
            if (changes && changes.notes !== undefined) {
                notes.length = 0;
                for (const n of next.notes) notes.push(n);
            }
            // ...and when the caller did not touch the notes, the note
            // objects themselves are left exactly as they were. Undo finds
            // a note by identity, so re-making them through the factory
            // would quietly break it from the next save onward.
            Object.assign(existing, next, { notes });
            changed('pattern', source, { patternId: id });
            return existing;
        },

        /**
         * "I mutated this pattern in place; persist and announce it." What
         * the roll's own edits use — it owns the object already, so putting
         * it back through the factory would only risk replacing the very
         * objects it is holding references to.
         */
        touchPattern(id, source) {
            const project = store.get();
            if (!project || !project.patterns[id]) return null;
            changed('pattern', source, { patternId: id });
            return project.patterns[id];
        },

        /** Removes the pattern and every clip placing it, in every section. */
        removePattern(id, source) {
            const project = store.get();
            if (!project || !removePattern(project, id)) return false;
            changed('pattern', source, { patternId: id });
            return true;
        },

        /** Section ids that place this pattern — the delete confirmation. */
        patternUsage(id) {
            const project = store.get();
            return project ? patternUsage(project, id) : [];
        },

        list() { return profileStore.list(); },

        /**
         * Edit the project. The mutator gets the live body and the edited
         * section — most edits want both, and looking the section up in
         * every caller is how a stale one creeps in.
         */
        update(mutator, source, kind = 'project') {
            const project = store.get();
            if (!project) return null;
            mutator(project, section());
            return changed(kind, source);
        },

        /** Announce a pattern edit without claiming the arrangement moved. */
        notifyPattern(patternId, source) {
            changed('pattern', source, { patternId });
        },

        /** Announce a change to the band — tracks added, removed, re-patched. */
        notifyTracks(source) {
            changed('tracks', source);
        },

        async open(id, source) {
            const project = await store.open(id);
            if (!project) return null;
            return adopted(source);
        },

        /**
         * Open a project synchronously, writing it out behind us. The
         * editors read `get()` immediately after being built, so this is
         * what lets a switch (or an import) land without a frame of nothing.
         */
        adoptNow(body, source, opts) {
            store.adoptNow(createProject(body || { name: 'Untitled project' }), opts);
            return adopted(source);
        },

        /**
         * A new, empty project, open immediately. Synchronous on purpose:
         * the switch is a UI action, and making the editors wait on
         * IndexedDB to acknowledge a project that is already in memory
         * would show a frame of the old one. The write follows behind.
         */
        createNew(name, source) {
            store.adoptNow(createProject({
                name: profileStore.uniqueName(name || 'Untitled project'),
            }));
            return adopted(source);
        },

        /**
         * Adopt a body already in hand — a duplicate, or an import. Always a
         * **new** project: a fresh id, and a name no existing project is
         * using. Importing the same file twice therefore gives two
         * independent projects, and the one already on disk is never
         * touched; it is the incoming name that moves out of the way.
         */
        createFrom(body, source) {
            store.adoptNow(createProject({
                ...body,
                id: undefined,
                name: profileStore.uniqueName(body && body.name),
            }));
            const project = store.get();
            profileStore.addTags(project.tags);
            return adopted(source);
        },

        /**
         * Delete a project. The profile picks what becomes current (the most
         * recent of what is left); if that was the last one, a new empty
         * project is made, because the app is never without one.
         */
        async remove(id, source) {
            await store.remove(id);
            profileStore.remove(id);
            const next = profileStore.current;
            if (next && await store.open(next)) return adopted(source);
            await store.adopt(createProject({ name: 'Untitled project' }));
            return adopted(source);
        },

        /** Write now, whatever the autosave ticker thinks. */
        flush() { return store.flush({ force: true }); },
        isSaving() { return store.isSaving(); },
        isDirty() { return store.isDirty(); },
        /** Resolves when no write is in flight — what Play waits on. */
        whenIdle() { return store.whenIdle(); },

        subscribe(fn) {
            subscribers.add(fn);
            return () => subscribers.delete(fn);
        },
    };

    /** open(), but a backend that throws counts as "not there". */
    async function tryOpen(id) {
        try {
            return await store.open(id);
        } catch (e) {
            console.warn('[project-session] could not read project ' + id + ':', e);
            return null;
        }
    }

    /**
     * Shared tail of every "a different project is now open" path. Falls
     * back to a detached in-memory project if even `adopt` failed, so the
     * editors always have something to render.
     */
    function adopted(source) {
        if (!store.get()) return createProject({ name: 'Untitled project' });
        const project = store.get();
        sectionId = project.sections[0].id;
        profileStore.upsert(project);
        profileStore.setCurrent(project.id);
        notify('project', { source, projectId: project.id });
        return project;
    }

    return api;
}
