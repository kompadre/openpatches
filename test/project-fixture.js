// A project session for tests that need one to build an editor against.
//
// Memory backend, no autosave ticker (`intervalMs: 0`), no page-lifecycle
// listeners, and `adoptNow` so the project is open the moment this returns
// — the editors read `session.get()` as they are constructed, so a session
// that is only ready a microtask later would make every `build()` async.
//
// Call `installBrowserEnv()` first: the session writes the profile index to
// localStorage.

import { createProjectStore, createMemoryBackend } from '../html/components/project-store.js';
import { createProjectSession } from '../html/components/project-session.js';
import { createTrack, addClip, COLS_PER_MEASURE } from '../html/components/project-model.js';

export function makeProjectSession(partial = {}) {
    const backend = createMemoryBackend();
    const store = createProjectStore({ backend, intervalMs: 0, bindLifecycle: false });
    const session = createProjectSession(store);
    // `write: false`: the fixture stands in for a project that is already
    // on disk, so the store starts idle. An adopt that left a write in
    // flight would make the first play() in a test defer behind it — which
    // is correct behaviour, and exactly what a test does not want to fight.
    session.adoptNow({ name: 'Test project', ...partial }, 'test', { write: false });
    // ...and make that true, synchronously, by seeding the backend
    // directly. Claiming "already saved" without the body actually being
    // there breaks any test that switches away and back.
    backend._raw.set(session.getId(), JSON.parse(JSON.stringify(session.get())));
    session.backend = backend;      // for tests that want to look at "disk"
    session.store = store;
    return session;
}

/**
 * Put one pattern on one track, placed at the top of the edited section —
 * what most of the roll's tests want, and what they used to get by writing
 * the legacy `openpatches_pianoroll` blob into localStorage before booting.
 * That blob is not read any more (Project is a clean break), so the state
 * has to be built rather than migrated.
 *
 * @returns {{track, pattern, clip}}
 */
export function seedPattern(session, { slot = 0, measures = 1, notes = [], bpm } = {}) {
    if (bpm != null) session.update((project) => { project.bpm = bpm; }, 'test');
    const pattern = session.createPattern({ name: 'Seed', measures, notes }, 'test');
    let track = null;
    let clip = null;
    session.update((project, section) => {
        track = createTrack({ name: 'Seed', slot });
        project.tracks.push(track);
        clip = addClip(project, section, {
            trackId: track.id, patternId: pattern.id, startCol: 0,
        });
    }, 'test');
    return { track, pattern, clip, cols: measures * COLS_PER_MEASURE };
}
