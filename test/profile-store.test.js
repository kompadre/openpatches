// The profile: the project index, the current pointer, the tag vocabulary.
//
// Small and synchronous — the bodies are what needed IndexedDB. What is
// worth pinning is that the index cannot drift from the bodies (one row per
// id, upserted on every save), that removing the open project always leaves
// something sensible current, and the import collision rule: the *incoming*
// project is the one renamed.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let profileStore;

before(async () => {
    installBrowserEnv();
    ({ profileStore } = await import('../html/components/profile-store.js'));
});

beforeEach(() => localStorage.clear());

/** An index row, as upsert() takes it (a project body's shape). */
function entry(id, name, modified = Date.now()) {
    return { id, name, created: modified, modified };
}

describe('the index', () => {
    test('an empty profile is well formed', () => {
        assert.deepEqual(profileStore.list(), []);
        assert.equal(profileStore.current, null);
        assert.deepEqual(profileStore.tags(), []);
    });

    test('upsert adds, then updates in place', () => {
        profileStore.upsert(entry('a', 'First'));
        assert.equal(profileStore.list().length, 1);

        profileStore.upsert(entry('a', 'Renamed'));
        assert.equal(profileStore.list().length, 1, 'one row per id');
        assert.equal(profileStore.getEntry('a').name, 'Renamed');
    });

    test('listed most recently modified first — the order a switcher wants', () => {
        profileStore.upsert(entry('old', 'Old', 1000));
        profileStore.upsert(entry('new', 'New', 3000));
        profileStore.upsert(entry('mid', 'Mid', 2000));
        assert.deepEqual(profileStore.list().map(p => p.id), ['new', 'mid', 'old']);
    });

    test('survives a reload', () => {
        profileStore.upsert(entry('a', 'First'));
        profileStore.setCurrent('a');
        assert.equal(profileStore.current, 'a');
        assert.equal(profileStore.getEntry('a').name, 'First');
    });

    test('garbage in storage reads as an empty profile rather than throwing', () => {
        localStorage.setItem('openpatches_profile', 'not json{');
        assert.deepEqual(profileStore.list(), []);
    });

    test('a duplicate id in storage is collapsed, keeping the first', () => {
        localStorage.setItem('openpatches_profile', JSON.stringify({
            projects: [entry('a', 'Keeper'), entry('a', 'Shadow')],
        }));
        assert.equal(profileStore.list().length, 1);
        assert.equal(profileStore.getEntry('a').name, 'Keeper');
    });

    test('a row with no id is dropped — it could never be opened', () => {
        localStorage.setItem('openpatches_profile', JSON.stringify({
            projects: [{ name: 'Nameless' }, entry('a', 'Real')],
        }));
        assert.deepEqual(profileStore.list().map(p => p.id), ['a']);
    });
});

describe('the current pointer', () => {
    test('setCurrent refuses an id that is not in the index', () => {
        assert.equal(profileStore.setCurrent('ghost'), false);
        assert.equal(profileStore.current, null);
    });

    test('a current pointing at a project that is gone reads as null', () => {
        localStorage.setItem('openpatches_profile', JSON.stringify({
            projects: [], currentProjectId: 'ghost',
        }));
        assert.equal(profileStore.current, null);
    });

    test('removing the current project falls to the next most recent', () => {
        profileStore.upsert(entry('a', 'A', 1000));
        profileStore.upsert(entry('b', 'B', 2000));
        profileStore.upsert(entry('c', 'C', 3000));
        profileStore.setCurrent('a');

        profileStore.remove('a');
        assert.equal(profileStore.current, 'c', 'the most recent of what is left');
    });

    test('removing the last project leaves no current', () => {
        profileStore.upsert(entry('a', 'A'));
        profileStore.setCurrent('a');
        profileStore.remove('a');
        assert.equal(profileStore.current, null);
        assert.deepEqual(profileStore.list(), []);
    });

    test('removing a project that is not current leaves the pointer alone', () => {
        profileStore.upsert(entry('a', 'A'));
        profileStore.upsert(entry('b', 'B'));
        profileStore.setCurrent('a');
        profileStore.remove('b');
        assert.equal(profileStore.current, 'a');
    });

    test('remove reports whether it found anything', () => {
        assert.equal(profileStore.remove('ghost'), false);
    });
});

describe('uniqueName — the import collision rule', () => {
    test('a free name is returned as it is', () => {
        assert.equal(profileStore.uniqueName('Nocturne'), 'Nocturne');
    });

    test('a taken name gets a numeric suffix, counting up past each clash', () => {
        profileStore.upsert(entry('a', 'Nocturne'));
        assert.equal(profileStore.uniqueName('Nocturne'), 'Nocturne 2');

        profileStore.upsert(entry('b', 'Nocturne 2'));
        assert.equal(profileStore.uniqueName('Nocturne'), 'Nocturne 3');
    });

    test('the comparison ignores case — "nocturne" still collides', () => {
        profileStore.upsert(entry('a', 'Nocturne'));
        assert.equal(profileStore.uniqueName('nocturne'), 'nocturne 2');
    });

    test('a project does not collide with itself when renaming', () => {
        profileStore.upsert(entry('a', 'Nocturne'));
        assert.equal(profileStore.uniqueName('Nocturne', { ignoreId: 'a' }), 'Nocturne');
    });

    test('an empty name falls back rather than producing a blank row', () => {
        assert.equal(profileStore.uniqueName('   '), 'Untitled project');
    });
});

describe('the tag vocabulary', () => {
    test('tags are unioned in, deduped and sorted', () => {
        profileStore.addTags(['warm', 'bass']);
        profileStore.addTags(['pad', 'warm']);
        assert.deepEqual(profileStore.tags(), ['bass', 'pad', 'warm']);
    });

    test('a single tag works as well as a list', () => {
        profileStore.addTags('solo');
        assert.deepEqual(profileStore.tags(), ['solo']);
    });

    test('blanks are ignored', () => {
        profileStore.addTags(['  ', '', null, 'real']);
        assert.deepEqual(profileStore.tags(), ['real']);
    });

    test('adding nothing new does not rewrite storage', () => {
        profileStore.addTags(['warm']);
        const before = localStorage.getItem('openpatches_profile');
        profileStore.addTags(['warm']);
        assert.equal(localStorage.getItem('openpatches_profile'), before);
    });

    test('a tag can be dropped from the vocabulary', () => {
        profileStore.addTags(['warm', 'bass']);
        assert.equal(profileStore.removeTag('warm'), true);
        assert.deepEqual(profileStore.tags(), ['bass']);
        assert.equal(profileStore.removeTag('warm'), false);
    });
});

describe('clear', () => {
    test('takes the index, the pointer and the vocabulary together', () => {
        profileStore.upsert(entry('a', 'A'));
        profileStore.setCurrent('a');
        profileStore.addTags(['warm']);

        profileStore.clear();

        assert.deepEqual(profileStore.list(), []);
        assert.equal(profileStore.current, null);
        assert.deepEqual(profileStore.tags(), []);
    });
});
