// The piano roll as a pattern editor (phase 3).
//
// It edits one monotimbral Pattern — the one on the active voice slot's
// track. Notes carry no slot; the track does. Other tracks are drawn behind
// as read-only ghosts, and playback still sounds every track, through the
// phase-2 sequencer. Persistence is the pattern/song stores, and the old
// roll blob is migrated on first load.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

const COLS_PER_MEASURE = 16;
const ROW_H = 20;
const COL_W = 30;
const LABEL_W = 36;
const HEADER_H = 14;
const TOP_MIDI = 84;
const LEGACY_KEY = 'openpatches_pianoroll';

let createPianoroll, patternStore, songStore;

before(async () => {
    installBrowserEnv();
    ({ createPianoroll } = await import('../html/components/pianoroll.js'));
    ({ patternStore, songStore } = await import('../html/components/song-model.js'));
});

beforeEach(() => localStorage.clear());

const rowY = (midi) => HEADER_H + (TOP_MIDI - midi) * ROW_H + ROW_H / 2;
const colX = (col) => LABEL_W + col * COL_W;

function makeTickWorker() {
    const handlers = [];
    return {
        postMessage() {},
        addEventListener(type, fn) { if (type === 'message') handlers.push(fn); },
        tick(col) { for (const fn of handlers) fn({ data: { type: 'tick', col } }); },
    };
}

const BANK = [
    { name: 'Piano', color: '#aaa001', voiceData: 'piano-data' },
    { name: 'Bass', color: '#bbb002', voiceData: 'bass-data' },
    { name: 'Lead', color: '#ccc003', voiceData: 'lead-data' },
];

function build({ activeSlot = 0, legacy = null } = {}) {
    if (legacy) localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    const played = [];
    const tickWorker = makeTickWorker();
    const roll = createPianoroll({
        playNoteFn: (midi, durMs, voiceData, slot) => played.push({ midi, durMs, voiceData, slot }),
        onNotesChange: () => {},
        activeSlot,
        tickWorker,
        startWorker: () => {},
        stopWorker: () => {},
        getSlotData: (slot) => BANK[slot] || null,
    });
    const canvas = roll.element.querySelector('.pianoroll-canvas');
    return {
        roll, played, tickWorker, canvas,
        ctx: canvas.getContext('2d'),
        mouse: (type, x, y) => canvas.dispatch(type, { clientX: x, clientY: y, preventDefault() {} }),
        legend: () => roll.element.querySelectorAll('.pianoroll-legend-item'),
        // The transport buttons share one class and differ by label; the
        // more-menu holds mobile copies, so scope to the desktop row.
        btn: (label) => roll.element.querySelector('.pianoroll-controls')
            .querySelectorAll('.pianoroll-btn').find(b => b.textContent === label),
    };
}

/** Draw a note by dragging on the grid, the way a user does. */
function drawNote(h, midi, start, end = start) {
    h.mouse('mousedown', colX(start) + 5, rowY(midi));
    h.mouse('mouseup', colX(end) + 5, rowY(midi));
}

describe('notes belong to a track, not a slot', () => {
    test('a drawn note carries no slot', () => {
        const h = build();
        drawNote(h, 60, 0, 1);
        assert.deepEqual(h.roll.getNotes(), [{ midi: 60, start: 0, dur: 2 }]);
    });

    test('the track is created on the first note, not on slot selection', () => {
        const h = build();
        assert.deepEqual(h.roll.getTracks(), [], 'selecting a voice alone makes nothing');
        drawNote(h, 60, 0);
        assert.deepEqual(h.roll.getTracks().map(t => t.slot), [0]);
    });

    test('switching voice switches which pattern is edited', () => {
        const h = build();
        drawNote(h, 60, 0);
        h.roll.setActiveSlot(1);
        assert.deepEqual(h.roll.getNotes(), [], 'a fresh voice starts empty');
        drawNote(h, 48, 4);
        assert.deepEqual(h.roll.getNotes(), [{ midi: 48, start: 4, dur: 1 }]);

        h.roll.setActiveSlot(0);
        assert.deepEqual(h.roll.getNotes(), [{ midi: 60, start: 0, dur: 1 }], 'the first pattern is intact');
        assert.deepEqual(h.roll.getTracks().map(t => t.slot), [0, 1]);
    });

    test('each track gets its own stored pattern', () => {
        const h = build();
        drawNote(h, 60, 0);
        h.roll.setActiveSlot(2);
        drawNote(h, 72, 8);

        const ids = h.roll.getTracks().map(t => t.patternId);
        assert.equal(new Set(ids).size, 2, 'two distinct patterns');
        for (const id of ids) assert.ok(patternStore.get(id), 'each is persisted');
        const stored = patternStore.get(h.roll.getTracks().find(t => t.slot === 2).patternId);
        assert.deepEqual(stored.notes, [{ midi: 72, start: 8, dur: 1 }]);
    });
});

describe('ghost tracks', () => {
    test('only the edited track answers to the mouse', () => {
        const h = build();
        drawNote(h, 60, 0, 1);           // slot 0
        h.roll.setActiveSlot(1);
        // Click right on the slot-0 note: it must not be grabbed or deleted,
        // and a new note is created on the edited track instead.
        drawNote(h, 60, 0, 1);
        assert.deepEqual(h.roll.getNotes(), [{ midi: 60, start: 0, dur: 2 }], 'drawn on slot 1');
        h.roll.setActiveSlot(0);
        assert.deepEqual(h.roll.getNotes(), [{ midi: 60, start: 0, dur: 2 }], 'slot 0 untouched');
    });

    test('other tracks are still drawn, dimmed and without handles', () => {
        const h = build();
        drawNote(h, 60, 0);
        h.roll.setActiveSlot(1);
        drawNote(h, 48, 0);

        h.ctx._calls.length = 0;
        h.roll.draw();
        const fills = h.ctx._calls.filter(c => c.fn === 'fillRect');
        assert.ok(fills.some(c => c.fillStyle === '#aaa001'), 'the ghost track is painted');
        assert.ok(fills.some(c => c.fillStyle === '#bbb002'), 'the edited track is painted');
        // Handles are white overlays; a ghost gets none.
        const handles = fills.filter(c => c.fillStyle === 'rgba(255,255,255,0.5)');
        assert.equal(handles.length, 2, 'two handles, on the edited note only');
    });

    test('the legend marks the edited track', () => {
        const h = build();
        drawNote(h, 60, 0);
        h.roll.setActiveSlot(1);
        drawNote(h, 48, 0);

        const items = h.legend();
        assert.equal(items.length, 2);
        assert.deepEqual(items.map(i => i.classList.contains('active')), [false, true]);
    });
});

describe('playback sounds every track', () => {
    test('two tracks fire together, each on its own voice', () => {
        const h = build();
        drawNote(h, 60, 0);
        h.roll.setActiveSlot(1);
        drawNote(h, 48, 0);

        h.roll.startPlayback();
        h.played.length = 0;
        h.tickWorker.tick(0);

        assert.deepEqual(h.played.map(p => [p.midi, p.slot, p.voiceData]).sort(),
            [[48, 1, 'bass-data'], [60, 0, 'piano-data']]);
    });

    test('a note added mid-loop is heard on the next pass', () => {
        const h = build();
        drawNote(h, 60, 0);
        h.roll.startPlayback();
        drawNote(h, 67, 4);

        h.played.length = 0;
        h.tickWorker.tick(4);
        assert.deepEqual(h.played.map(p => p.midi), [67], 'the sequence was refreshed by the edit');
    });

    test('durations are converted with the tempo', () => {
        const h = build();
        drawNote(h, 60, 0, 3);           // dur 4
        h.roll.startPlayback();
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.equal(h.played[0].durMs, 4 * (60000 / 120 / 4));
    });

    test('an empty roll still refuses to start', () => {
        const h = build();
        h.roll.startPlayback();
        assert.equal(h.roll.isPlaying(), false);
    });
});

describe('measure buttons span every track', () => {
    function twoTracks() {
        const h = build();
        drawNote(h, 60, 0);
        h.roll.setActiveSlot(1);
        drawNote(h, 48, 0);
        return h;
    }

    test('+ Msr grows every pattern, so the grid stays one length', () => {
        const h = twoTracks();
        h.btn('+ Msr').dispatch('click');
        assert.equal(h.roll.totalCols(), 2 * COLS_PER_MEASURE);
        for (const t of h.roll.getTracks()) assert.equal(patternStore.get(t.patternId).measures, 2);
    });

    test('clone copies the last bar of every track, not just the edited one', () => {
        const h = twoTracks();
        h.btn('\u29C9 Clone').dispatch('click');
        assert.equal(h.roll.totalCols(), 32);
        assert.deepEqual(h.roll.getSong().notes.map(n => [n.slot, n.start]).sort(),
            [[0, 0], [0, 16], [1, 0], [1, 16]]);
    });

    test('− Msr drops the notes past the new end on every track', () => {
        const h = twoTracks();
        h.btn('+ Msr').dispatch('click');
        h.roll.setActiveSlot(0);
        drawNote(h, 62, 20);
        h.roll.setActiveSlot(1);
        drawNote(h, 50, 24);
        assert.equal(h.roll.getSong().notes.length, 4);

        h.btn('\u2715 Msr').dispatch('click');
        assert.equal(h.roll.totalCols(), 16);
        assert.deepEqual(h.roll.getSong().notes.map(n => n.midi).sort(), [48, 60]);
    });
});

describe('persistence and migration', () => {
    test('the roll restores its song on the next load', () => {
        const h = build();
        drawNote(h, 60, 0, 1);
        h.roll.setActiveSlot(2);
        drawNote(h, 72, 8);
        h.btn('+ Msr').dispatch('click');

        const again = build({ activeSlot: 0 });
        assert.equal(again.roll.totalCols(), 32);
        assert.deepEqual(again.roll.getTracks().map(t => t.slot), [0, 2]);
        assert.deepEqual(again.roll.getSong().notes.sort((a, b) => a.midi - b.midi),
            [{ midi: 60, start: 0, dur: 2, slot: 0 }, { midi: 72, start: 8, dur: 1, slot: 2 }]);
    });

    test('a legacy roll blob is migrated into tracks on first load', () => {
        const h = build({
            legacy: {
                measures: 2, bpm: 96, followPlayhead: true,
                notes: [
                    { midi: 60, start: 0, dur: 4, slot: 0 },
                    { midi: 36, start: 8, dur: 2, slot: 1 },
                ],
            },
        });
        assert.deepEqual(h.roll.getTracks().map(t => t.slot), [0, 1]);
        assert.equal(h.roll.getBpm(), 96);
        assert.equal(h.roll.totalCols(), 32);
        assert.equal(h.roll.isFollowing(), true, 'the view preference survives too');
        assert.deepEqual(h.roll.getNotes(), [{ midi: 60, start: 0, dur: 4 }], 'slot 0 is being edited');
        assert.equal(songStore.list().length, 1);
    });

    test('migration runs once — a second load does not duplicate the song', () => {
        build({ legacy: { measures: 1, bpm: 120, notes: [{ midi: 60, start: 0, dur: 1, slot: 0 }] } });
        const again = build();
        assert.equal(songStore.list().length, 1);
        assert.equal(patternStore.list().length, 1);
        assert.deepEqual(again.roll.getSong().notes, [{ midi: 60, start: 0, dur: 1, slot: 0 }]);
    });

    test('the legacy blob is left alone (this release can be rolled back)', () => {
        const legacy = { measures: 1, bpm: 120, notes: [{ midi: 60, start: 0, dur: 1, slot: 0 }] };
        const h = build({ legacy });
        drawNote(h, 67, 4);
        assert.deepEqual(JSON.parse(localStorage.getItem(LEGACY_KEY)), legacy);
    });

    test('Clear wipes every track, not just the edited one', () => {
        const h = build();
        drawNote(h, 60, 0);
        h.roll.setActiveSlot(1);
        drawNote(h, 48, 0);
        h.roll.element.querySelector('.pianoroll-clear-desktop').dispatch('click');
        assert.deepEqual(h.roll.getTracks(), []);
        assert.deepEqual(h.roll.getSong().notes, []);
    });
});

describe('the recorder writes into the right track', () => {
    test('addNote places on the named slot, which need not be the edited one', () => {
        const h = build();
        drawNote(h, 60, 0);                       // slot 0 exists and is active
        h.roll.addNote({ midi: 40, start: 2, dur: 1, slot: 1 });

        assert.deepEqual(h.roll.getNotes(), [{ midi: 60, start: 0, dur: 1 }], 'still editing slot 0');
        assert.deepEqual(h.roll.getSong().notes.find(n => n.midi === 40),
            { midi: 40, start: 2, dur: 1, slot: 1 });
    });

    test('undo removes a note from whichever track holds it', () => {
        const h = build();
        const note = h.roll.addNote({ midi: 40, start: 2, dur: 1, slot: 1 });
        h.roll.removeNote(note);
        assert.deepEqual(h.roll.getSong().notes, []);
    });
});
