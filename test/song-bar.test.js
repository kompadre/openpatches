// The song bar's state machine — typing ↔ loaded — and the round trip through
// the toolbar: saving captures notes, tempo, measures and the voice bank's
// slots; picking the song from the autocomplete puts all of it back.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let createSongBar;
let songStore;
let createToolbar;
let createPianoroll;

before(async () => {
    installBrowserEnv();
    installMidiStub();
    ({ songStore } = await import('../html/components/patch-model.js'));
    ({ createSongBar } = await import('../html/components/song-bar.js'));
    ({ createToolbar } = await import('../html/components/toolbar.js'));
    ({ createPianoroll } = await import('../html/components/pianoroll.js'));
});

beforeEach(() => {
    localStorage.clear();
    globalThis.confirm = () => true;
});

function buildBar(snapshot = { notes: [], bpm: 120, measures: 1 }) {
    const loaded = [];
    const logs = [];
    const bar = createSongBar({
        getSong: () => snapshot,
        loadSong: (d) => loaded.push(d),
        log: (m) => logs.push(m),
    });
    return {
        bar, loaded, logs,
        input: bar.querySelector('.song-input'),
        action: bar.querySelector('.song-action'),
        newBtn: bar.querySelector('.song-new'),
        status: bar.querySelector('.song-status'),
        items: () => bar.querySelectorAll('.song-suggest-item'),
        suggest: bar.querySelector('.song-suggest'),
    };
}

function type(ui, text) {
    ui.input.value = text;
    ui.input.dispatch('input');
}

function pick(ui, name) {
    const item = ui.items().find(i => i.textContent === name);
    assert.ok(item, `suggestion "${name}" should be listed`);
    item.dispatch('mousedown', { preventDefault() {} });
    item.dispatch('click');
}

describe('typing state', () => {
    test('starts empty with a disabled Save', () => {
        const ui = buildBar();
        assert.equal(ui.input.disabled, false);
        assert.equal(ui.action.textContent, 'Save');
        assert.equal(ui.action.title, 'Save song');
        assert.equal(ui.action.disabled, true, 'nothing to save yet');
        assert.equal(ui.newBtn.style.display, 'none');
    });

    test('a new name enables Save, and saving switches to the loaded state', () => {
        const ui = buildBar({ notes: [{ midi: 60, start: 0, dur: 1, slot: 0 }], bpm: 90, measures: 2 });
        type(ui, 'Intro');
        assert.equal(ui.action.disabled, false);
        ui.action.dispatch('click');

        assert.deepEqual(songStore.get('Intro').data.notes, [{ midi: 60, start: 0, dur: 1, slot: 0 }]);
        assert.equal(ui.input.disabled, true);
        assert.equal(ui.input.value, 'Intro');
        assert.equal(ui.action.textContent, 'Delete');
        assert.equal(ui.action.title, 'Delete song');
        assert.match(ui.status.textContent, /Saved/);
        assert.ok(ui.status.classList.contains('ok'));
        assert.equal(ui.bar._getLoadedName(), 'Intro');
    });

    test('Enter saves too', () => {
        const ui = buildBar();
        type(ui, 'Quick');
        ui.input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
        assert.equal(songStore.has('Quick'), true);
    });

    test('typing a name that is taken shows "Song exists" and does not overwrite', () => {
        songStore.create('Taken', { notes: [], bpm: 100, measures: 1 });
        const ui = buildBar({ notes: [], bpm: 200, measures: 1 });
        type(ui, 'Taken');
        assert.equal(ui.action.textContent, 'Save', 'typing the name is not the same as picking it');
        ui.action.dispatch('click');

        assert.equal(ui.status.textContent, 'Song exists');
        assert.ok(ui.status.classList.contains('error'));
        assert.equal(songStore.get('Taken').data.bpm, 100, 'original untouched');
        assert.equal(ui.input.disabled, false, 'still in the typing state');
        assert.equal(ui.bar._getLoadedName(), null);
        assert.equal(ui.loaded.length, 0, 'and nothing was loaded either');
    });

    test('a padded name collides the same way', () => {
        songStore.create('Taken', { notes: [] });
        const ui = buildBar();
        type(ui, '  Taken ');
        ui.action.dispatch('click');
        assert.equal(ui.status.textContent, 'Song exists');
    });

    test('the error clears as soon as the user types on', () => {
        songStore.create('Taken', { notes: [] });
        const ui = buildBar();
        type(ui, 'Taken');
        ui.action.dispatch('click');
        type(ui, 'Taken 2');
        assert.equal(ui.status.textContent, '');
    });
});

describe('autocomplete', () => {
    test('focus lists every song; typing filters case-insensitively', () => {
        for (const n of ['Bassline', 'Bridge', 'Outro']) songStore.create(n, { notes: [] });
        const ui = buildBar();
        ui.input.dispatch('focus');
        assert.deepEqual(ui.items().map(i => i.textContent), ['Bassline', 'Bridge', 'Outro']);
        type(ui, 'br');
        assert.deepEqual(ui.items().map(i => i.textContent), ['Bridge']);
        type(ui, 'zzz');
        assert.equal(ui.suggest.style.display, 'none', 'no matches, no empty box');
    });

    test('picking a song loads it and switches to the loaded state', () => {
        const data = { notes: [{ midi: 64, start: 2, dur: 1, slot: 1 }], bpm: 140, measures: 3 };
        songStore.create('Bridge', data);
        const ui = buildBar();
        ui.input.dispatch('focus');
        pick(ui, 'Bridge');

        assert.deepEqual(ui.loaded, [data]);
        assert.equal(ui.input.disabled, true);
        assert.equal(ui.input.value, 'Bridge');
        assert.equal(ui.action.textContent, 'Delete');
        assert.equal(ui.action.title, 'Delete song');
        assert.match(ui.status.textContent, /Loaded .*Bridge/);
        assert.ok(ui.logs.some(m => /Loaded song/.test(m)), 'the log panel gets a line too');
        assert.equal(ui.suggest.style.display, 'none');
    });

    test('blur hides the list, Escape hides it, and nothing is listed while loaded', () => {
        songStore.create('A', { notes: [] });
        const ui = buildBar();
        ui.input.dispatch('focus');
        assert.equal(ui.items().length, 1);
        ui.input.dispatch('blur');
        assert.equal(ui.items().length, 0);
        ui.input.dispatch('focus');
        ui.input.dispatch('keydown', { key: 'Escape', preventDefault() {} });
        assert.equal(ui.items().length, 0);

        ui.input.dispatch('focus');
        pick(ui, 'A');
        ui.input.dispatch('focus');
        assert.equal(ui.items().length, 0, 'the input is disabled; no dropdown');
    });

    test('a song deleted elsewhere between listing and picking is reported, not crashed on', () => {
        songStore.create('Gone', { notes: [] });
        const ui = buildBar();
        ui.input.dispatch('focus');
        const item = ui.items()[0];
        songStore.remove('Gone');
        item.dispatch('click');
        assert.equal(ui.status.textContent, 'Song not found');
        assert.equal(ui.loaded.length, 0);
        assert.equal(ui.input.disabled, false);
    });
});

describe('loaded state', () => {
    function loadedBar() {
        songStore.create('Hook', { notes: [], bpm: 120, measures: 1 });
        const ui = buildBar();
        ui.input.dispatch('focus');
        pick(ui, 'Hook');
        return ui;
    }

    test('Delete asks, removes the song, and hands the name back editable', () => {
        const ui = loadedBar();
        let asked = 0;
        globalThis.confirm = () => { asked++; return true; };
        ui.action.dispatch('click');

        assert.equal(asked, 1);
        assert.equal(songStore.has('Hook'), false);
        assert.equal(ui.input.disabled, false);
        assert.equal(ui.input.value, 'Hook', 'one click on Save undoes a slip');
        assert.equal(ui.action.textContent, 'Save');
        assert.equal(ui.action.disabled, false);
        assert.match(ui.status.textContent, /Deleted/);
    });

    test('a declined confirm changes nothing', () => {
        const ui = loadedBar();
        globalThis.confirm = () => false;
        ui.action.dispatch('click');
        assert.equal(songStore.has('Hook'), true);
        assert.equal(ui.input.disabled, true);
        assert.equal(ui.action.textContent, 'Delete');
    });

    test('✕ detaches: the name is dropped, the input is free again, the song is kept', () => {
        const ui = loadedBar();
        assert.equal(ui.newBtn.style.display, '');
        ui.newBtn.dispatch('click');
        assert.equal(ui.input.disabled, false);
        assert.equal(ui.input.value, '');
        assert.equal(ui.action.textContent, 'Save');
        assert.equal(ui.bar._getLoadedName(), null);
        assert.equal(songStore.has('Hook'), true);
        assert.equal(ui.loaded.length, 1, 'detaching does not reload anything');
    });

    test('after detaching, the same name is a collision again', () => {
        const ui = loadedBar();
        ui.newBtn.dispatch('click');
        type(ui, 'Hook');
        ui.action.dispatch('click');
        assert.equal(ui.status.textContent, 'Song exists');
    });
});

describe('piano roll getSong / loadSong', () => {
    function makeTickWorker() {
        const handlers = [];
        return {
            postMessage() {},
            addEventListener(type, fn) { if (type === 'message') handlers.push(fn); },
            tick(col) { for (const fn of handlers) fn({ data: { type: 'tick', col } }); },
        };
    }
    function build() {
        const stops = [];
        const roll = createPianoroll({
            playNoteFn: () => {},
            onNotesChange: () => {},
            activeSlot: 0,
            tickWorker: makeTickWorker(),
            startWorker: () => {},
            stopWorker: () => stops.push('stop'),
            getSlotData: () => null,
        });
        return { roll, stops };
    }

    test('round-trips notes, tempo and measures as plain data', () => {
        const { roll } = build();
        roll.addNote({ midi: 60, start: 0, dur: 2, slot: 0 });
        const snap = roll.getSong();
        assert.deepEqual(snap, { notes: [{ midi: 60, start: 0, dur: 2, slot: 0 }], bpm: 120, measures: 1 });
        snap.notes.push({ midi: 1, start: 1, dur: 1, slot: 0 });
        assert.equal(roll.getNotes().length, 1, 'getSong hands out a copy');

        roll.loadSong({ notes: [{ midi: 67, start: 20, dur: 4, slot: 3 }], bpm: 95, measures: 2 });
        assert.deepEqual(roll.getNotes(), [{ midi: 67, start: 20, dur: 4, slot: 3 }]);
        assert.equal(roll.getBpm(), 95);
        assert.equal(roll.totalCols(), 32);
        assert.deepEqual(JSON.parse(localStorage.getItem('openpatches_pianoroll')).notes,
            [{ midi: 67, start: 20, dur: 4, slot: 3 }], 'the roll persists the loaded state as its own');
    });

    test('stops playback before replacing the pattern', () => {
        const { roll, stops } = build();
        roll.addNote({ midi: 60, start: 0, dur: 1, slot: 0 });
        roll.startPlayback();
        roll.loadSong({ notes: [], bpm: 120, measures: 1 });
        assert.equal(roll.isPlaying(), false);
        assert.ok(stops.length >= 1);
    });

    test('tolerates junk: bad measures, out-of-range tempo, malformed notes', () => {
        const { roll } = build();
        roll.loadSong({ measures: 0, bpm: 9999, notes: [{ midi: 'x' }, null, { midi: 60, start: 0, dur: 1 }] });
        assert.equal(roll.totalCols(), 16);
        assert.equal(roll.getBpm(), 255);
        assert.deepEqual(roll.getNotes(), [{ midi: 60, start: 0, dur: 1, slot: 0 }]);
        roll.loadSong(undefined);
        assert.deepEqual(roll.getNotes(), []);
        assert.equal(roll.getBpm(), 120);
    });
});

describe('through the toolbar', () => {
    function buildDock() {
        const logs = [];
        const dock = createToolbar({
            appendLog: (m) => logs.push(m),
            playNoteFn: () => Promise.resolve(() => {}),
            stopNoteFn: () => {},
            tickWorker: { postMessage() {}, addEventListener() {} },
            startWorker: () => {},
            stopWorker: () => {},
        });
        return {
            dock, logs,
            roll: dock._pianoroll,
            bank: dock._voiceBank,
            input: dock.querySelector('.song-input'),
            action: dock.querySelector('.song-action'),
            items: () => dock.querySelectorAll('.song-suggest-item'),
        };
    }

    test('the bar sits above the roll and a song captures slots as well as notes', () => {
        const ui = buildDock();
        const panel = ui.dock.querySelector('.dock-panel-pianoroll');
        const kids = panel.children;
        assert.ok(kids.indexOf(ui.dock.querySelector('.song-bar')) < kids.indexOf(ui.dock.querySelector('.pianoroll-row')));

        ui.bank._addEntry('Piano', 'AAAA', 'p1');
        ui.bank._addEntry('Bass', Uint8Array.from([1, 2, 3]), 'p2');
        ui.roll.addNote({ midi: 60, start: 0, dur: 2, slot: 0 });
        ui.roll.addNote({ midi: 40, start: 4, dur: 2, slot: 1 });

        type(ui, 'Take 1');
        ui.action.dispatch('click');
        const saved = songStore.get('Take 1').data;
        assert.equal(saved.notes.length, 2);
        assert.deepEqual(saved.slots.map(s => s.name), ['Piano', 'Bass']);
        assert.deepEqual(saved.slots[1].voiceData, [1, 2, 3], 'typed array stored as a plain array');
        assert.equal(saved.slots[0].volume, 100);
    });

    test('loading puts notes, tempo, measures and the voice bank back', () => {
        songStore.create('Take 1', {
            notes: [{ midi: 60, start: 0, dur: 2, slot: 0 }, { midi: 40, start: 4, dur: 2, slot: 1 }],
            bpm: 128,
            measures: 2,
            slots: [
                { name: 'Piano', patchId: 'p1', volume: 90, voiceData: 'AAAA' },
                { name: 'Bass', patchId: 'p2', volume: 100, voiceData: [1, 2, 3] },
            ],
        });
        const ui = buildDock();
        ui.bank._addEntry('Something else', 'ZZZZ', 'p9');
        ui.roll.addNote({ midi: 72, start: 1, dur: 1, slot: 0 });

        ui.input.dispatch('focus');
        pick(ui, 'Take 1');

        assert.deepEqual(ui.roll.getNotes().map(n => n.midi), [60, 40]);
        assert.equal(ui.roll.getBpm(), 128);
        assert.equal(ui.roll.totalCols(), 32);
        const entries = ui.bank._getEntries();
        assert.deepEqual(entries.map(e => e.name), ['Piano', 'Bass']);
        assert.equal(entries[0].volume, 90);
        assert.deepEqual(entries[1].voiceData, [1, 2, 3]);
        assert.equal(entries[0].color, '#e94560', 'colors follow the slot index');
        assert.equal(ui.input.disabled, true);
        assert.equal(ui.action.textContent, 'Delete');
        assert.ok(ui.logs.some(m => /Loaded song/.test(m)));
    });

    test('loading stops a running take first', () => {
        songStore.create('S', { notes: [], bpm: 120, measures: 1, slots: [] });
        const ui = buildDock();
        const rec = ui.dock.querySelector('.pianoroll-record');
        rec.dispatch('click');
        assert.ok(rec.classList.contains('active'));
        ui.input.dispatch('focus');
        pick(ui, 'S');
        assert.equal(rec.classList.contains('active'), false, 'recording ended');
        assert.equal(ui.roll.isPlaying(), false);
    });
});
