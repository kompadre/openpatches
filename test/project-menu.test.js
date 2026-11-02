// The Projects dialog, and the session operations behind it.
//
// Project management lives in the File menu because a Project is the
// whole piece of music — far more than the Section editor's toolbar, where
// it used to sit. What is worth pinning here is that none of these actions
// can leave the app without an open project, and that a copy is always a
// genuinely new project rather than a second handle on the same one.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let openProjectsDialog, makeProjectSession, profileStore, env;

before(async () => {
    env = installBrowserEnv();
    ({ openProjectsDialog } = await import('../html/components/project-menu.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
    ({ profileStore } = await import('../html/components/profile-store.js'));
});

let session, logs, changes, answers;

beforeEach(() => {
    localStorage.clear();
    logs = [];
    changes = 0;
    answers = [];
    globalThis.confirm = () => true;
    globalThis.prompt = () => (answers.length ? answers.shift() : null);
    session = makeProjectSession({ name: 'Nocturne' });
});

function open() {
    openProjectsDialog({
        session,
        appendLog: (m) => logs.push(m),
        onChange: () => { changes++; },
    });
    const dialog = env.document.body.querySelectorAll('.modal-dialog').pop();
    const rows = () => dialog.querySelectorAll('.project-row');
    // The stub DOM keeps textContent per node rather than aggregating it
    // from children, so a row is identified by its name element.
    const nameOf = (row) => {
        const n = row.querySelector('.project-name');
        return n ? String(n.textContent) : '';
    };
    return {
        dialog,
        rows,
        nameOf,
        names: () => rows().map(nameOf),
        rowFor: (name) => rows().find(r => nameOf(r) === name),
        current: () => rows().filter(r => r.classList.contains('current')),
        click: (el) => el.dispatch('click', { stopPropagation() {} }),
    };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe('the list', () => {
    test('shows every project, marking the open one', () => {
        session.createNew('Second', 'test');
        const d = open();
        assert.deepEqual(d.names().sort(), ['Nocturne', 'Second']);
        assert.equal(d.current().length, 1);
        assert.equal(d.nameOf(d.current()[0]), 'Second');
    });

    test('the open project cannot be opened again', async () => {
        const d = open();
        const before = session.getId();
        d.click(d.rows()[0].querySelector('.project-open'));
        await tick();
        assert.equal(session.getId(), before);
        assert.equal(changes, 0, 'nothing happened, so nothing is announced');
    });

    test('opening another switches to it', async () => {
        const first = session.getId();
        session.createNew('Second', 'test');
        await session.flush();

        const d = open();
        d.click(d.rowFor('Nocturne').querySelector('.project-open'));
        await tick();

        assert.equal(session.getId(), first);
        assert.equal(changes, 1);
        assert.match(logs.join(' '), /Opened project: Nocturne/);
    });

    test('a row whose body is gone reports it instead of blanking the app', async () => {
        const first = session.getId();
        session.createNew('Second', 'test');
        await session.flush();
        await session.backend.remove(first);     // the index still lists it

        const d = open();
        d.click(d.rowFor('Nocturne').querySelector('.project-open'));
        await tick();

        assert.ok(session.get(), 'still has a project open');
        assert.match(logs.join(' '), /data is missing/);
    });
});

describe('new', () => {
    test('makes an empty project and opens it', () => {
        const before = session.getId();
        const d = open();
        d.click(d.dialog.querySelector('.project-new'));
        assert.notEqual(session.getId(), before);
        assert.deepEqual(session.get().tracks, []);
        assert.equal(changes, 1);
    });
});

describe('rename', () => {
    test('renames the open project', () => {
        answers = ['Prelude'];
        const d = open();
        d.click(d.rows()[0].querySelector('.project-rename'));
        assert.equal(session.get().name, 'Prelude');
    });

    test('cancelling changes nothing', () => {
        answers = [];                     // prompt returns null
        const d = open();
        d.click(d.rows()[0].querySelector('.project-rename'));
        assert.equal(session.get().name, 'Nocturne');
    });

    test('a name already taken gets a suffix rather than two identical rows', async () => {
        session.createNew('Prelude', 'test');
        answers = ['Prelude'];
        const d = open();
        d.click(d.current()[0].querySelector('.project-rename'));
        assert.equal(session.get().name, 'Prelude');

        // Now rename the *other* one to the same thing.
        // Renaming one that is not open has to open it first, so this
        // path is async where the current-project one is not.
        answers = ['Prelude'];
        const d2 = open();
        d2.click(d2.rowFor('Nocturne').querySelector('.project-rename'));
        await tick();
        assert.equal(session.get().name, 'Prelude 2');
    });
});

describe('duplicate', () => {
    test('copies the project and opens the copy', async () => {
        session.update((project) => { project.bpm = 96; }, 'test');
        await session.flush();
        const original = session.getId();

        const d = open();
        d.click(d.rows()[0].querySelector('.project-duplicate'));
        await tick();

        assert.notEqual(session.getId(), original, 'a new project, not a second handle');
        assert.equal(session.get().name, 'Nocturne copy');
        assert.equal(session.get().bpm, 96, 'and it carries the contents');
        assert.equal(profileStore.list().length, 2);
    });

    test('the original is untouched', async () => {
        const original = session.getId();
        const d = open();
        d.click(d.rows()[0].querySelector('.project-duplicate'));
        await tick();
        assert.equal(profileStore.getEntry(original).name, 'Nocturne');
    });

    test('copying twice gives two copies, not a collision', async () => {
        const d = open();
        d.click(d.rows()[0].querySelector('.project-duplicate'));
        await tick();
        const d2 = open();
        d2.click(d2.rowFor('Nocturne').querySelector('.project-duplicate'));
        await tick();
        assert.deepEqual(
            profileStore.list().map(p => p.name).sort(),
            ['Nocturne', 'Nocturne copy', 'Nocturne copy 2'],
        );
    });
});

describe('delete', () => {
    test('removes it and leaves another open', async () => {
        session.createNew('Second', 'test');
        await session.flush();
        const second = session.getId();

        const d = open();
        d.click(d.rowFor('Second').querySelector('.project-delete'));
        await tick();

        assert.equal(profileStore.has(second), false);
        assert.ok(session.get(), 'something is still open');
        assert.equal(session.get().name, 'Nocturne');
    });

    test('deleting the last one leaves a fresh empty project — never nothing', async () => {
        const only = session.getId();
        const d = open();
        d.click(d.rows()[0].querySelector('.project-delete'));
        await tick();

        assert.equal(profileStore.has(only), false);
        assert.ok(session.get());
        assert.equal(profileStore.list().length, 1, 'the replacement is indexed');
    });

    test('declining the confirmation keeps it', async () => {
        globalThis.confirm = () => false;
        const only = session.getId();
        const d = open();
        d.click(d.rows()[0].querySelector('.project-delete'));
        await tick();
        assert.equal(session.getId(), only);
    });
});

describe('renaming a section', () => {
    test('is a different thing from renaming the project', () => {
        session.renameSection('Chorus', 'test');
        assert.equal(session.getSection().name, 'Chorus');
        assert.equal(session.get().name, 'Nocturne', 'untouched');
    });

    test('an empty name is refused', () => {
        const before = session.getSection().name;
        session.renameSection('   ', 'test');
        assert.equal(session.getSection().name, before);
    });

    test('only the edited section is touched', async () => {
        const { addSection } = await import('../html/components/project-model.js');
        const other = addSection(session.get(), { name: 'Bridge' });
        session.renameSection('Verse', 'test');
        assert.equal(session.getSection().name, 'Verse');
        assert.equal(other.name, 'Bridge', 'the other one is left alone');
    });
});
