// project-session: the one owner of the open project, and of which section
// is being edited.
//
// What matters here is that the session cannot leave the app in a state it
// has no UI for — there is always a project open and always a real section
// edited — and that the profile index never drifts from the bodies.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createProjectSession, createProjectStore, createMemoryBackend, profileStore;
let createProject, addSection, addTrack, addPattern;

before(async () => {
    installBrowserEnv();
    ({ createProjectSession } = await import('../html/components/project-session.js'));
    ({ createProjectStore, createMemoryBackend } = await import('../html/components/project-store.js'));
    ({ profileStore } = await import('../html/components/profile-store.js'));
    ({ createProject, addSection, addTrack, addPattern } = await import('../html/components/project-model.js'));
});

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

let backend, store, session;

beforeEach(async () => {
    localStorage.clear();
    backend = createMemoryBackend();
    store = createProjectStore({ backend, intervalMs: 10, bindLifecycle: false });
    session = createProjectSession(store);
});

describe('init', () => {
    test('with nothing stored, a new empty project is opened', async () => {
        const project = await session.init();
        assert.ok(project);
        assert.equal(project.name, 'Untitled project');
        assert.equal(profileStore.current, project.id, 'and remembered');
        assert.equal(profileStore.list().length, 1, 'and indexed');
    });

    test('is idempotent', async () => {
        const first = await session.init();
        assert.equal(await session.init(), first);
    });

    test('reopens the remembered project', async () => {
        const first = await session.init();
        await session.update((p) => { p.name = 'Nocturne'; }, 'test');
        await session.flush();

        const other = createProjectSession(
            createProjectStore({ backend, intervalMs: 10, bindLifecycle: false }),
        );
        const reopened = await other.init();
        assert.equal(reopened.id, first.id);
        assert.equal(reopened.name, 'Nocturne');
    });

    test('a remembered project whose body is gone falls through to the next', async () => {
        const first = await session.init();
        await session.createNew('Second', 'test');
        const second = session.getId();
        // The body vanishes under the index — a wipe that half-finished.
        await backend.remove(second);

        const other = createProjectSession(
            createProjectStore({ backend, intervalMs: 10, bindLifecycle: false }),
        );
        const opened = await other.init();
        assert.equal(opened.id, first.id, 'fell back rather than failing');
    });

    test('an index pointing at nothing at all still yields a project', async () => {
        profileStore.upsert({ id: 'ghost', name: 'Ghost', created: 1, modified: 1 });
        profileStore.setCurrent('ghost');
        const project = await session.init();
        assert.ok(project);
        assert.notEqual(project.id, 'ghost');
    });
});

describe('the edited section', () => {
    test('defaults to the first', async () => {
        const project = await session.init();
        assert.equal(session.getSectionId(), project.sections[0].id);
    });

    test('switching announces it, and switching to the same one does not', async () => {
        const project = await session.init();
        const second = addSection(project);
        const seen = [];
        session.subscribe((e) => { if (e.kind === 'section') seen.push(e.sectionId); });

        assert.equal(session.setSection(second.id, 'test'), true);
        assert.equal(session.getSectionId(), second.id);
        assert.equal(session.setSection(second.id, 'test'), true);
        assert.deepEqual(seen, [second.id], 'announced once');
    });

    test('a section this project does not have is refused', async () => {
        const project = await session.init();
        assert.equal(session.setSection('ghost', 'test'), false);
        assert.equal(session.getSectionId(), project.sections[0].id);
    });

    test('an edited section that is deleted falls back to the first', async () => {
        const project = await session.init();
        const second = addSection(project);
        session.setSection(second.id, 'test');

        project.sections.splice(1, 1);        // deleted under us
        assert.equal(session.getSectionId(), project.sections[0].id);
        assert.ok(session.getSection(), 'never null');
    });

    test('opening another project resets to its first section', async () => {
        const project = await session.init();
        const second = addSection(project);
        session.setSection(second.id, 'test');
        const firstId = project.id;

        await session.createNew('Other', 'test');
        await session.open(firstId, 'test');
        assert.equal(session.getSectionId(), session.get().sections[0].id);
    });
});

describe('tempo', () => {
    test('the section tempo wins over the project tempo', async () => {
        const project = await session.init();
        project.bpm = 140;
        assert.equal(session.getBpm(), 140);

        session.getSection().bpm = 72;
        assert.equal(session.getBpm(), 72);
    });
});

describe('update and notification', () => {
    test('the mutator gets the project and the edited section', async () => {
        await session.init();
        let seenSection = null;
        session.update((p, s) => { p.name = 'Edited'; seenSection = s; }, 'test');
        assert.equal(session.get().name, 'Edited');
        assert.equal(seenSection, session.getSection());
    });

    test('an edit marks the store dirty and reaches storage on the tick', async () => {
        await session.init();
        session.update((p) => { p.bpm = 155; }, 'test');
        assert.equal(session.isDirty(), true);
        await tick(30);
        assert.equal((await backend.load(session.getId())).bpm, 155);
    });

    test('the source rides along so an editor can ignore its own echo', async () => {
        await session.init();
        const seen = [];
        session.subscribe((e) => seen.push([e.kind, e.source]));
        session.update(() => {}, 'roll');
        session.notifyPattern('pat1', 'roll');
        session.notifyTracks('mixer');
        assert.deepEqual(seen, [
            ['project', 'roll'], ['pattern', 'roll'], ['tracks', 'mixer'],
        ]);
    });

    test('a pattern notification carries the pattern id', async () => {
        await session.init();
        let detail = null;
        session.subscribe((e) => { if (e.kind === 'pattern') detail = e; });
        session.notifyPattern('pat7', 'roll');
        assert.equal(detail.patternId, 'pat7');
    });

    test('a throwing subscriber does not stop the others', async () => {
        await session.init();
        const seen = [];
        session.subscribe(() => { throw new Error('boom'); });
        session.subscribe(() => seen.push('ok'));
        session.update(() => {}, 'test');
        assert.deepEqual(seen, ['ok']);
    });

    test("the store's own save events are passed on for the indicator", async () => {
        await session.init();
        const seen = [];
        session.subscribe((e) => { if (e.kind === 'saving') seen.push(e.saving); });
        session.update((p) => { p.bpm = 130; }, 'test');
        await session.flush();
        assert.deepEqual(seen, [true, false]);
    });
});

describe('the profile index cannot drift', () => {
    test('a rename reaches the index without a save', async () => {
        await session.init();
        session.update((p) => { p.name = 'Nocturne'; }, 'test');
        assert.equal(profileStore.getEntry(session.getId()).name, 'Nocturne');
    });

    test('every project that has been opened is in the index', async () => {
        await session.init();
        await session.createNew('Second', 'test');
        await session.createNew('Third', 'test');
        assert.deepEqual(
            profileStore.list().map(p => p.name).sort(),
            ['Second', 'Third', 'Untitled project'],
        );
    });
});

describe('createNew and createFrom', () => {
    test('a new project gets a name nothing else is using', async () => {
        await session.init();
        await session.createNew('Nocturne', 'test');
        await session.createNew('Nocturne', 'test');
        assert.equal(session.get().name, 'Nocturne 2');
    });

    test('createFrom always makes a NEW project — the same file twice gives two', async () => {
        await session.init();
        const body = createProject({ name: 'Imported', bpm: 99 });

        await session.createFrom(body, 'import');
        const first = session.getId();
        assert.equal(session.get().name, 'Imported');
        assert.equal(session.get().bpm, 99);

        await session.createFrom(body, 'import');
        assert.notEqual(session.getId(), first, 'a fresh id, not an overwrite');
        assert.equal(session.get().name, 'Imported 2', 'the incoming one is renamed');
        assert.equal(profileStore.getEntry(first).name, 'Imported', 'the existing one is untouched');
    });

    test('an import unions its tags into the vocabulary', async () => {
        await session.init();
        profileStore.addTags(['warm']);
        await session.createFrom(createProject({ name: 'X', tags: ['bass', 'warm'] }), 'import');
        assert.deepEqual(profileStore.tags(), ['bass', 'warm']);
    });

    test('an imported body is normalised on the way in', async () => {
        await session.init();
        await session.createFrom({
            name: 'Hand edited',
            tracks: [{ id: 'a', slot: 0 }, { id: 'b', slot: 0 }],
            sections: [],
        }, 'import');
        assert.equal(session.get().tracks.length, 1, 'one track per slot');
        assert.equal(session.get().sections.length, 1, 'always a section');
    });
});

describe('remove', () => {
    test('removing the open project opens the next most recent', async () => {
        await session.init();
        const first = session.getId();
        await session.createNew('Second', 'test');
        const second = session.getId();

        await session.remove(second, 'test');
        assert.equal(session.getId(), first);
        assert.equal(profileStore.has(second), false);
        assert.deepEqual(await backend.listIds(), [first]);
    });

    test('removing the last project leaves a fresh empty one — never nothing', async () => {
        await session.init();
        const only = session.getId();
        await session.remove(only, 'test');
        assert.ok(session.get(), 'the app is never without a project');
        assert.notEqual(session.getId(), only);
        assert.equal(profileStore.list().length, 1);
    });
});

describe('patterns', () => {
    test('getPattern reads the open project library', async () => {
        const project = await session.init();
        const pattern = addPattern(project, { name: 'A' });
        assert.equal(session.getPattern(pattern.id), pattern);
        assert.equal(session.getPattern('ghost'), null);
    });

    test('patterns belong to the project, so they do not follow a switch', async () => {
        const project = await session.init();
        const pattern = addPattern(project, { name: 'A' });
        addTrack(project, {});
        await session.flush();

        await session.createNew('Other', 'test');
        assert.equal(session.getPattern(pattern.id), null);
        assert.deepEqual(session.get().tracks, []);
    });
});
