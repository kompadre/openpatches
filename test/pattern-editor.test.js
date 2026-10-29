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

describe('measure buttons act on the edited pattern', () => {
    // Patterns have their own lengths — the same pattern may sit in several
    // songs — so + Msr / Clone / − Msr change the one being edited and the
    // grid follows whichever pattern is under the cursor.
    function twoTracks() {
        const h = build();
        drawNote(h, 60, 0);
        h.roll.setActiveSlot(1);
        drawNote(h, 48, 0);
        return h;
    }

    test('+ Msr grows the edited pattern only; switching voice shows the other length', () => {
        const h = twoTracks();                       // editing slot 1
        h.btn('+ Msr').dispatch('click');
        assert.equal(h.roll.totalCols(), 2 * COLS_PER_MEASURE);
        const [t0, t1] = h.roll.getTracks();
        assert.equal(patternStore.get(t1.patternId).measures, 2);
        assert.equal(patternStore.get(t0.patternId).measures, 1, 'the other pattern keeps its length');
        h.roll.setActiveSlot(0);
        assert.equal(h.roll.totalCols(), COLS_PER_MEASURE, 'the grid follows the edited pattern');
    });

    test('clone copies the edited pattern\'s last bar', () => {
        const h = twoTracks();
        h.btn('\u29C9 Clone').dispatch('click');
        assert.equal(h.roll.totalCols(), 32);
        assert.deepEqual(h.roll.getNotes().map(n => n.start), [0, 16]);
        assert.deepEqual(h.roll.getSong().notes.filter(n => n.slot === 0).map(n => n.start), [0], 'slot 0 untouched');
    });

    test('− Msr drops the notes past the new end of the edited pattern', () => {
        const h = twoTracks();
        h.btn('+ Msr').dispatch('click');
        drawNote(h, 50, 24);
        assert.equal(h.roll.getNotes().length, 2);
        h.btn('\u2715 Msr').dispatch('click');
        assert.equal(h.roll.totalCols(), 16);
        assert.deepEqual(h.roll.getNotes().map(n => n.midi), [48]);
    });

    test('with no pattern under the cursor, + Msr only sizes the grid', () => {
        const h = build();
        h.btn('+ Msr').dispatch('click');
        assert.equal(h.roll.totalCols(), 32);
        assert.deepEqual(h.roll.getTracks(), [], 'no track was invented');
        drawNote(h, 60, 20);
        assert.equal(patternStore.get(h.roll.getTracks()[0].patternId).measures, 2, 'the new pattern takes the grid length');
    });
});

describe('persistence and migration', () => {
    test('the roll restores its song on the next load', () => {
        const h = build();
        drawNote(h, 60, 0, 1);
        h.roll.setActiveSlot(2);
        drawNote(h, 72, 8);
        h.btn('+ Msr').dispatch('click');

        const again = build({ activeSlot: 2 });
        assert.equal(again.roll.totalCols(), 32, 'slot 2\'s pattern was lengthened');
        assert.deepEqual(again.roll.getTracks().map(t => t.slot), [0, 2]);
        again.roll.setActiveSlot(0);
        assert.equal(again.roll.totalCols(), 16, 'slot 0\'s pattern was not');
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


describe('the roll follows the shared session', () => {
    test('a clip placed by the song editor shows up as a ghost, and opens on request', async () => {
        const { createSongSession } = await import('../html/components/song-session.js');
        const { addClip, createTrack } = await import('../html/components/song-model.js');
        const session = createSongSession();
        session.init();
        const played = [];
        const roll = createPianoroll({
            session,
            playNoteFn: (midi, d, v, slot) => played.push([midi, slot]),
            onNotesChange: () => {}, activeSlot: 0,
            tickWorker: makeTickWorker(), startWorker: () => {}, stopWorker: () => {},
            getSlotData: (slot) => BANK[slot] || null,
        });
        // Another editor adds a track on slot 1 with a pattern at measure 0.
        const p = patternStore.create({ name: 'Riff', notes: [{ midi: 40, start: 2, dur: 1 }] });
        session.update((song) => {
            const t = createTrack({ name: 'T', slot: 1 });
            song.tracks.push(t);
            addClip(song, { trackId: t.id, patternId: p.id, startMeasure: 0 }, (id) => patternStore.get(id));
        }, 'song-editor');

        assert.deepEqual(roll.getTracks().map(t => t.slot), [1], 'the roll picked it up');
        assert.deepEqual(roll.getNotes(), [], 'but slot 0 is still the one being edited');

        const clipId = roll.getTracks()[0].clipId;
        assert.equal(roll.openClip(clipId), true);
        assert.deepEqual(roll.getNotes(), [{ midi: 40, start: 2, dur: 1 }]);
        assert.equal(roll.openClip('clip_nope'), false);
    });

    test('a pattern renamed elsewhere is not overwritten by the roll\'s next save', async () => {
        const { createSongSession } = await import('../html/components/song-session.js');
        const session = createSongSession();
        session.init();
        const h = { roll: null };
        h.roll = createPianoroll({
            session, playNoteFn: () => {}, onNotesChange: () => {}, activeSlot: 0,
            tickWorker: makeTickWorker(), startWorker: () => {}, stopWorker: () => {},
            getSlotData: (slot) => BANK[slot] || null,
        });
        const canvas = h.roll.element.querySelector('.pianoroll-canvas');
        const mouse = (type, x, y) => canvas.dispatch(type, { clientX: x, clientY: y, preventDefault() {} });
        mouse('mousedown', colX(0) + 5, rowY(60)); mouse('mouseup', colX(0) + 5, rowY(60));
        const id = h.roll.getTracks()[0].patternId;

        patternStore.put({ ...patternStore.get(id), name: 'Renamed' });
        session.notifyPattern(id, 'song-editor');
        mouse('mousedown', colX(4) + 5, rowY(62)); mouse('mouseup', colX(4) + 5, rowY(62));

        const stored = patternStore.get(id);
        assert.equal(stored.name, 'Renamed');
        assert.equal(stored.notes.length, 2, 'and the new note was saved');
    });
});

describe('transport integration (phase 5)', () => {
    test('a tick sounds each note once — one clock, not two', () => {
        const h = build();
        drawNote(h, 60, 0);
        h.roll.setActiveSlot(1);
        drawNote(h, 48, 0);
        h.roll.startPlayback();
        h.played.length = 0;
        h.tickWorker.tick(0);
        // The roll used to own the worker subscription as well; if both it
        // and the transport fired, every note would double.
        assert.deepEqual(h.played.map(p => [p.midi, p.slot]).sort(), [[48, 1], [60, 0]]);
    });

    test('Play from the roll loops the pattern where it sits, with the other tracks along', () => {
        const h = build();
        drawNote(h, 60, 0);                       // slot 0, bar 1
        h.roll.setActiveSlot(1);
        drawNote(h, 48, 0);                       // slot 1, bar 1 — the edited one
        assert.equal(h.roll.element.querySelector('.pianoroll-mode'), null, 'no scope toggle: the roll is pattern scope');

        h.roll.startPlayback();
        assert.equal(h.roll.getMode(), 'pattern', 'Play here is always the pattern loop');
        assert.deepEqual(h.roll.getTransport().getSequence().range, { startCol: 0, endCol: 16 });
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played.map(p => p.midi).sort(), [48, 60], 'slot 0 sits in the window: it accompanies');
        h.roll.stopPlayback();

        // Move slot 0's clip out of the window: now only the edited voice.
        h.roll.getSession().update((s) => { s.clips[0].startMeasure = 3; }, 'test');
        h.roll.startPlayback();
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played.map(p => p.midi), [48]);
        h.roll.stopPlayback();

        // Left in song mode by the Song tab's Play, the roll's Play and
        // Record both bring it back to the pattern window.
        h.roll.setMode('song');
        h.roll.startPlayback();
        assert.equal(h.roll.getMode(), 'pattern');
        h.roll.stopPlayback();
        h.roll.setMode('song');
        h.roll.startRecording();
        assert.equal(h.roll.getMode(), 'pattern', 'a take from the roll is the pattern loop too');
        assert.deepEqual(h.roll.getTransport().getSequence().range, { startCol: 0, endCol: 16 });
        h.roll.stopRecording();
    });

    test('the accompaniment button mutes the other tracks without shortening the loop', () => {
        const h = build();
        drawNote(h, 60, 0);                       // slot 0, bar 1
        h.roll.setActiveSlot(1);
        drawNote(h, 48, 0);                       // slot 1 — the edited one
        const btn = h.roll.element.querySelector('.pianoroll-accompany');
        assert.match(btn.textContent, /With song/);

        btn.dispatch('click');
        assert.match(btn.textContent, /Pattern only/);
        assert.ok(btn.classList.contains('active'));
        h.roll.startRecording();
        assert.deepEqual(h.roll.getTransport().getSequence().range, { startCol: 0, endCol: 16 },
            'a take is one pattern long either way');
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played.map(p => p.midi), [48], 'slot 0 is silent now');

        btn.dispatch('click');
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played.map(p => p.midi).sort(), [48, 60], 'and back, mid-take');
        h.roll.stopRecording();
    });

    test('the loop is the clip\'s own window, so the playhead is there from the first tick', () => {
        const h = build();
        drawNote(h, 60, 0);                       // slot 0, bar 1
        h.roll.getSession().update((s) => { s.clips[0].startMeasure = 1; }, 'test');   // now bar 2
        h.roll.startPlayback();
        assert.deepEqual(h.roll.getTransport().getSequence().range, { startCol: 16, endCol: 32 });
        h.ctx._calls.length = 0;
        h.tickWorker.tick(0);
        assert.ok(h.ctx._calls.some(c => c.fn === 'fillRect' && c.fillStyle === '#ff3b3b'),
            'raw tick 0 is the window start: the playhead is on the pattern at once');
    });

    test('Stop releases sounding notes exactly once', () => {
        const released = [];
        localStorage.clear();
        const roll = createPianoroll({
            playNoteFn: () => {}, onNotesChange: () => {}, activeSlot: 0,
            tickWorker: makeTickWorker(), startWorker: () => {}, stopWorker: () => {},
            getSlotData: (slot) => BANK[slot] || null,
            onStopPlayback: () => released.push(1),
        });
        roll.addNote({ midi: 60, start: 0, dur: 1, slot: 0 });
        roll.startPlayback();
        roll.stopPlayback();
        assert.deepEqual(released, [1]);
        roll.stopPlayback();
        assert.deepEqual(released, [1], 'a second Stop releases nothing');
    });
});

describe('renaming the edited pattern from the roll', () => {
    const field = (h) => h.legend().find(i => i.classList.contains('active'))
        .querySelector('.pianoroll-legend-pattern');

    test('the active legend entry carries the pattern name; ghosts do not', () => {
        const h = build();
        drawNote(h, 60, 0);
        h.roll.setActiveSlot(1);
        drawNote(h, 48, 0);
        const items = h.legend();
        assert.equal(items[0].querySelector('.pianoroll-legend-pattern'), null, 'ghost track: no field');
        assert.equal(field(h).textContent, patternStore.list().find(p => p.name === 'Bass').name);
    });

    test('click, type, blur → the store and the legend both have the new name', () => {
        const h = build();
        drawNote(h, 60, 0);
        const f = field(h);
        f.dispatch('click', { stopPropagation() {} });
        assert.equal(f.contentEditable, 'true');
        f.textContent = 'Intro riff';
        f.dispatch('blur');
        const stored = patternStore.list();
        assert.equal(stored.length, 1);
        assert.equal(stored[0].name, 'Intro riff');
        assert.equal(field(h).textContent, 'Intro riff', 'legend re-rendered from the renamed pattern');
    });

    test('Escape restores the old name and nothing is written', () => {
        const h = build();
        drawNote(h, 60, 0);
        const f = field(h);
        f.dispatch('click', { stopPropagation() {} });
        f.textContent = 'oops';
        f.dispatch('keydown', { key: 'Escape', stopPropagation() {}, preventDefault() {} });
        assert.equal(f.textContent, 'Piano');
        assert.equal(f.contentEditable, 'false');
        f.dispatch('blur');
        assert.equal(patternStore.list()[0].name, 'Piano');
    });
});
