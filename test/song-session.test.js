// The song session: one current song shared by the pattern editor and the
// song editor. It owns persistence and tells subscribers what changed, with
// a `source` so an editor can skip its own echoes.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createSongSession, M, legacySongStore;

before(async () => {
    installBrowserEnv();
    ({ createSongSession } = await import('../html/components/song-session.js'));
    M = await import('../html/components/song-model.js');
    ({ songStore: legacySongStore } = await import('../html/components/patch-model.js'));
});

beforeEach(() => localStorage.clear());

describe('init', () => {
    test('a fresh install gets an empty current song, persisted and remembered', () => {
        const s = createSongSession();
        const song = s.init();
        assert.equal(song.name, 'Untitled song');
        assert.equal(M.songStore.get(song.id).id, song.id);
        assert.equal(localStorage.getItem('openpatches_current_song'), song.id);
        assert.equal(s.init(), song, 'idempotent');
    });

    test('runs the migration and lands on the migrated working roll', () => {
        localStorage.setItem('openpatches_pianoroll', JSON.stringify({
            measures: 1, bpm: 100, notes: [{ midi: 60, start: 0, dur: 1, slot: 2 }],
        }));
        legacySongStore.create('Old one', { measures: 1, bpm: 120, notes: [{ midi: 48, start: 0, dur: 1, slot: 0 }] });
        const song = createSongSession().init();
        assert.equal(song.bpm, 100);
        assert.deepEqual(song.tracks.map(t => t.slot), [2]);
        assert.equal(M.songStore.list().length, 2, 'the saved legacy song came along');
    });

    test('a second session resumes the remembered song', () => {
        const a = createSongSession(); a.init();
        const second = a.createNew('Two', 'test');
        const b = createSongSession();
        assert.equal(b.init().id, second.id);
    });

    test('a dangling pointer falls back to any stored song, then to a new one', () => {
        const kept = M.songStore.create({ name: 'Kept' });
        localStorage.setItem('openpatches_current_song', 'song_gone');
        assert.equal(createSongSession().init().id, kept.id);
    });
});

describe('update / notify', () => {
    test('update mutates in place, persists, and notifies with the source', () => {
        const s = createSongSession(); s.init();
        const events = [];
        const off = s.subscribe(ev => events.push(ev));
        s.update((song) => { song.bpm = 140; }, 'roll');
        assert.equal(s.get().bpm, 140);
        assert.equal(M.songStore.get(s.get().id).bpm, 140);
        assert.deepEqual(events, [{ kind: 'song', source: 'roll', songId: s.get().id }]);
        off();
        s.update((song) => { song.bpm = 90; }, 'roll');
        assert.equal(events.length, 1, 'unsubscribed');
    });

    test('a mutator that throws saves nothing and propagates', () => {
        const s = createSongSession(); s.init();
        const events = [];
        s.subscribe(ev => events.push(ev));
        assert.throws(() => s.update(() => { throw new Error('Clip overlaps'); }, 'song-editor'), /Clip overlaps/);
        assert.deepEqual(events, []);
    });

    test('notifyPattern announces without touching the song', () => {
        const s = createSongSession(); s.init();
        const before = JSON.stringify(M.songStore.get(s.get().id));
        const events = [];
        s.subscribe(ev => events.push(ev));
        s.notifyPattern('pat_1', 'roll');
        assert.deepEqual(events, [{ kind: 'pattern', source: 'roll', patternId: 'pat_1' }]);
        assert.equal(JSON.stringify(M.songStore.get(s.get().id)), before);
    });

    test('a failing subscriber does not stop the others', () => {
        const s = createSongSession(); s.init();
        const origWarn = console.warn; console.warn = () => {};
        let reached = false;
        s.subscribe(() => { throw new Error('boom'); });
        s.subscribe(() => { reached = true; });
        try { s.update(() => {}, 'x'); } finally { console.warn = origWarn; }
        assert.equal(reached, true);
    });
});

describe('open / createNew / createFrom / remove', () => {
    test('createNew switches to a fresh persisted song', () => {
        const s = createSongSession(); const first = s.init();
        const next = s.createNew('B', 'song-editor');
        assert.notEqual(next.id, first.id);
        assert.equal(s.get(), next);
        assert.equal(localStorage.getItem('openpatches_current_song'), next.id);
        assert.deepEqual(s.list().map(x => x.name).sort(), ['B', 'Untitled song']);
    });

    test('open switches by id and refuses an unknown one', () => {
        const s = createSongSession(); const first = s.init();
        s.createNew('B', 't');
        assert.equal(s.open(first.id, 't'), true);
        assert.equal(s.get().id, first.id);
        assert.equal(s.open('song_nope', 't'), false);
        assert.equal(s.get().id, first.id);
    });

    test('createFrom stores a copy under a new id', () => {
        const s = createSongSession(); s.init();
        const made = s.createFrom({ id: 'song_x', name: 'Copy', bpm: 77 }, 't');
        assert.notEqual(made.id, 'song_x');
        assert.equal(made.bpm, 77);
        assert.equal(M.songStore.get(made.id).name, 'Copy');
    });

    test('importLegacyRoll becomes a new song; the current one is kept', () => {
        const s = createSongSession(); const first = s.init();
        const made = s.importLegacyRoll({ measures: 1, bpm: 99, notes: [{ midi: 60, start: 0, dur: 1, slot: 4 }] }, 'Take', 'roll');
        assert.equal(made.name, 'Take');
        assert.deepEqual(made.tracks.map(t => t.slot), [4]);
        assert.ok(M.patternStore.get(made.clips[0].patternId), 'its pattern is stored');
        assert.ok(M.songStore.get(first.id), 'the previous song still exists');
        assert.equal(s.get().id, made.id);
    });

    test('removing the current song moves to another, or to a new empty one', () => {
        const s = createSongSession(); const first = s.init();
        const b = s.createNew('B', 't');
        assert.equal(s.remove(b.id, 't'), true);
        assert.equal(s.get().id, first.id, 'fell back to the remaining song');
        assert.equal(s.remove(first.id, 't'), true);
        assert.ok(s.get(), 'there is always a current song');
        assert.notEqual(s.get().id, first.id);
        assert.equal(M.songStore.list().length, 1);
        assert.equal(s.remove('song_nope', 't'), false);
    });

    test('removing another song keeps the current one and still notifies', () => {
        const s = createSongSession(); const first = s.init();
        const b = s.createNew('B', 't');
        s.open(first.id, 't');
        const events = [];
        s.subscribe(ev => events.push(ev.kind));
        s.remove(b.id, 't');
        assert.equal(s.get().id, first.id);
        assert.deepEqual(events, ['song']);
    });
});
