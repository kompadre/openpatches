// The current song, shared by every editor.
//
// The pattern editor (pianoroll.js) and the song editor (song-editor.js)
// work on the same Song record: one edits a pattern that is placed in it,
// the other arranges its clips and tracks. Neither may own the record, or
// the other's saves would overwrite it — so this session owns it, persists
// it, and tells everyone when it changed.
//
// Notifications carry a `source` so an editor can ignore its own echoes
// (the roll must not re-adopt the song in the middle of its own drag).
// Patterns are persisted by whoever edits them, through patternStore; the
// session only announces that one changed (`notifyPattern`) so the song
// editor can redraw clip widths.

import {
    createSong, patternStore, songStore, migrateIfNeeded,
} from './song-model.js';

const CURRENT_SONG_KEY = 'openpatches_current_song';

export function createSongSession() {
    let song = null;
    const subscribers = new Set();

    function notify(kind, detail = {}) {
        for (const fn of [...subscribers]) {
            try { fn({ kind, ...detail }); } catch (e) { console.warn('[song-session] subscriber failed:', e); }
        }
    }

    function persist() {
        songStore.put(song);
        try { localStorage.setItem(CURRENT_SONG_KEY, song.id); } catch { /* ignore */ }
    }

    function adopt(next, source) {
        song = next;
        persist();
        notify('song', { source, songId: song.id });
    }

    return {
        /**
         * Run the one-shot migration, then pick up where the user left off:
         * the remembered song, else the first stored one, else a new empty
         * song. Idempotent — editors created without a prepared session
         * call it themselves.
         */
        init() {
            if (song) return song;
            const migration = migrateIfNeeded();
            let id = null;
            try { id = localStorage.getItem(CURRENT_SONG_KEY); } catch { /* ignore */ }
            if (migration.migrated && migration.currentSongId) id = migration.currentSongId;
            song = (id && songStore.get(id)) || songStore.list()[0] || null;
            if (!song) song = createSong({ name: 'Untitled song' });
            persist();
            return song;
        },

        /** The live record. Mutate it only through update(). */
        get() { return song; },

        list() { return songStore.list(); },

        getPattern(id) { return patternStore.get(id); },

        subscribe(fn) {
            subscribers.add(fn);
            return () => subscribers.delete(fn);
        },

        /**
         * Change the song in place and persist. `mutator` may throw (the
         * model refuses overlaps that way); nothing is saved or announced
         * then, and the error propagates for the UI to show.
         */
        update(mutator, source) {
            mutator(song);
            persist();
            notify('song', { source, songId: song.id });
        },

        /** A pattern's content or length changed — clips drawn from it may need redrawing. */
        notifyPattern(patternId, source) {
            notify('pattern', { source, patternId });
        },

        open(id, source) {
            const next = songStore.get(id);
            if (!next) return false;
            adopt(next, source);
            return true;
        },

        createNew(name, source) {
            adopt(createSong({ name: name || 'Untitled song' }), source);
            return song;
        },

        /** Store a fully-formed song as a new record and switch to it. */
        createFrom(record, source) {
            adopt(createSong({ ...record, id: undefined }), source);
            return song;
        },

        /**
         * Delete a song. Deleting the current one moves to another, or to a
         * fresh empty song — there is always a current song.
         */
        remove(id, source) {
            const wasCurrent = song && song.id === id;
            if (!songStore.remove(id)) return false;
            if (wasCurrent) {
                const next = songStore.list()[0] || null;
                adopt(next || createSong({ name: 'Untitled song' }), source);
            } else {
                notify('song', { source, songId: song.id });
            }
            return true;
        },
    };
}
