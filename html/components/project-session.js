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

import { createProject, getSection, effectiveBpm } from './project-model.js';
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
            const wanted = profileStore.current;
            if (wanted && await store.open(wanted)) return adopted('init');
            for (const entry of profileStore.list()) {
                if (await store.open(entry.id)) return adopted('init');
            }
            await store.adopt(createProject({ name: 'Untitled project' }));
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

        /** A pattern by id, from the open project's library. */
        getPattern(id) {
            const project = store.get();
            return project ? project.patterns[id] || null : null;
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

        async createNew(name, source) {
            await store.adopt(createProject({
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
        async createFrom(body, source) {
            await store.adopt(createProject({
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

    /** Shared tail of every "a different project is now open" path. */
    function adopted(source) {
        const project = store.get();
        sectionId = project.sections[0].id;
        profileStore.upsert(project);
        profileStore.setCurrent(project.id);
        notify('project', { source, projectId: project.id });
        return project;
    }

    return api;
}
