// Step record: Rec with the clock stopped.
//
// A key held for a full second puts a note of the chosen step length (the
// picker only on screen while stepping; default a sixteenth) at the step
// cursor and grows it by one more step length per further second; a tap
// shorter than a second is a rest that jumps the cursor to the next beat.
// The last key-up of a step moves the cursor on; the cursor can also be
// seeked by dragging the playhead's header marker. Rec while the clock runs
// is still a live take, and Play while a step record is armed becomes one.
// Notes go into the pattern on screen, not through the take's slot mapping.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let createToolbar, makeProjectSession, M;
let midi;
let session = null;

before(async () => {
    installBrowserEnv();
    installMidiStub();
    midi = await import('../html/synth/midi-manager.js');
    ({ createToolbar } = await import('../html/components/toolbar.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
    M = await import('../html/components/project-model.js');
});

function makeTickWorker() {
    const handlers = [];
    return {
        postMessage() {},
        addEventListener(type, fn) { if (type === 'message') handlers.push(fn); },
        tick(col) { for (const fn of handlers) fn({ data: { type: 'tick', col } }); },
    };
}

// The step record reads performance.now(); the tests set it by hand, and
// drive the growth timer themselves.
let clock = 0;
let timers = [];
before(() => {
    performance.now = () => clock;
    globalThis.setInterval = (fn) => { timers.push(fn); return timers.length; };
    globalThis.clearInterval = (id) => { timers[id - 1] = null; };
});
const tickTimers = () => { for (const fn of timers) if (fn) fn(); };

let started;

function build() {
    started = [];
    const tickWorker = makeTickWorker();
    session = makeProjectSession();
    const dock = createToolbar({
        session,
        playNoteFn: () => Promise.resolve(() => {}),
        stopNoteFn: () => {},
        tickWorker,
        startWorker: (w, bpm, col) => started.push({ bpm, col }),
        stopWorker: () => {},
    });
    const controls = dock.querySelector('.pianoroll-controls');
    const keys = dock.querySelectorAll('.key');          // keys[0] is C2 (36)
    const ev = { button: 0, preventDefault() {} };
    const roll = dock._pianoroll;
    const h = {
        dock,
        tickWorker,
        roll,
        session: dock._session,
        transport: roll.getTransport(),
        rec: controls.querySelector('.pianoroll-record'),
        recMobile: dock.querySelector('.kb-btn-record'),
        undo: dock.querySelector('.kb-btn-undo'),
        scroll: dock.querySelector('.pianoroll-scroll'),
        down(midi) { keys[midi - 36].dispatch('mousedown', ev); },
        up(midi) { keys[midi - 36].dispatch('mouseup', ev); },
        /** Hold `midi` for `ms`, with the growth timer running meanwhile. */
        async hold(midi, ms) {
            h.down(midi);
            await flush();
            clock += ms;
            tickTimers();
            h.up(midi);
        },
        notes: () => roll.getNotes().map(n => ({ midi: n.midi, start: n.start, dur: n.dur })),
    };
    return h;
}

const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => {
    localStorage.clear();
    midi._reset();
    clock = 10000;
    timers = [];
});

describe('arming', () => {
    test('Rec with the clock stopped arms a step record, not a take', () => {
        const { rec, recMobile, roll, transport } = build();
        rec.dispatch('click');
        assert.deepEqual(started, [], 'no clock');
        assert.equal(transport.isRunning(), false);
        assert.equal(transport.getMode(), 'pattern', 'the pattern window, like a take');
        assert.ok(rec.classList.contains('active'));
        assert.ok(rec.classList.contains('step'), 'lit but marked as a step record');
        assert.match(rec.textContent, /Stop/);
        assert.equal(recMobile.textContent, 'Stop ■');
        assert.equal(roll.getStepCursor(), 0, 'the cursor starts at the top of the pattern');
    });

    test('Rec again disarms it and clears the cursor', () => {
        const { rec, roll } = build();
        rec.dispatch('click');
        rec.dispatch('click');
        assert.equal(rec.classList.contains('active'), false);
        assert.equal(rec.classList.contains('step'), false);
        assert.equal(roll.getStepCursor(), -1);
        assert.deepEqual(started, []);
    });

    test('Rec while playing is still a live take', () => {
        const { rec, roll, transport } = build();
        roll.addNote({ midi: 60, start: 0, dur: 1, slot: 0 });
        roll.startPlayback();
        assert.equal(transport.isPlaying(), true);
        rec.dispatch('click');
        assert.equal(transport.isRecording(), true);
        assert.equal(rec.classList.contains('step'), false);
        assert.equal(roll.getStepCursor(), -1);
    });
});

describe('notes', () => {
    test('a key held a full second is a sixteenth at the cursor; the cursor moves on by one', async () => {
        const h = build();
        h.rec.dispatch('click');
        h.down(60);
        await flush();
        assert.deepEqual(h.notes(), [], 'nothing on the grid before the first second');
        clock += 1000;
        tickTimers();
        assert.deepEqual(h.notes(), [{ midi: 60, start: 0, dur: 1 }], 'the first second puts it on the grid');
        assert.equal(h.roll.getStepCursor(), 0, 'the cursor waits for the key to come up');
        clock += 400;
        h.up(60);
        assert.deepEqual(h.notes(), [{ midi: 60, start: 0, dur: 1 }]);
        assert.equal(h.roll.getStepCursor(), 1);
        assert.equal(h.roll.getNotes()[0]._recordedInSession, undefined, 'no echo guard: it must sound on a take\'s first pass');
    });

    test('every further second grows it by a sixteenth, on the grid while still held', async () => {
        const h = build();
        h.rec.dispatch('click');
        h.down(60);
        await flush();
        clock += 1999; tickTimers();
        assert.equal(h.notes()[0].dur, 1);
        clock += 1; tickTimers();
        assert.equal(h.notes()[0].dur, 2, 'two full seconds: two sixteenths');
        clock += 1000;
        h.up(60);
        assert.equal(h.notes()[0].dur, 3, 'the release itself counts the time');
        assert.equal(h.roll.getStepCursor(), 3);
    });

    test('a chord: each note keeps its own hold, the cursor skips the longest', async () => {
        const h = build();
        h.rec.dispatch('click');
        h.down(60); h.down(64); h.down(67);
        await flush();
        clock += 1200; tickTimers();
        assert.equal(h.notes().length, 3);
        assert.ok(h.notes().every(n => n.start === 0), 'all at the cursor');
        h.up(64);
        assert.equal(h.roll.getStepCursor(), 0, 'still a key down: the step is not over');
        clock += 2000;                      // 3.2 s for the other two
        h.up(60);
        h.up(67);
        const byMidi = Object.fromEntries(h.notes().map(n => [n.midi, n.dur]));
        assert.deepEqual(byMidi, { 60: 3, 64: 1, 67: 3 });
        assert.equal(h.roll.getStepCursor(), 3);
    });

    test('the next step lands where the cursor is', async () => {
        const h = build();
        h.rec.dispatch('click');
        await h.hold(60, 2000);                      // dur 2 → cursor 2
        await h.hold(62, 1000);
        assert.deepEqual(h.notes().find(x => x.midi === 62), { midi: 62, start: 2, dur: 1 });
        assert.equal(h.roll.getStepCursor(), 3);
    });

    test('a note never grows past the pattern end, and the cursor wraps', async () => {
        const h = build();
        h.rec.dispatch('click');
        assert.equal(h.roll.totalCols(), 16);
        await h.hold(60, 60000);
        assert.equal(h.notes()[0].dur, 16);
        assert.equal(h.roll.getStepCursor(), 0, 'wrapped to the top');
        await h.hold(62, 1000);
        assert.equal(h.notes().find(x => x.midi === 62).start, 0);
    });

    test('Undo removes the last step note', async () => {
        const h = build();
        h.rec.dispatch('click');
        await h.hold(60, 1000);
        await h.hold(62, 1000);
        h.undo.dispatch('click');
        assert.deepEqual(h.notes().map(n => n.midi), [60]);
    });

    test('MIDI input steps too, timed by the message stamps', async () => {
        const stub = installMidiStub();
        const h = build();
        await midi.requestMidi();
        midi.setSelectedInput('in0');
        h.rec.dispatch('click');
        stub.inputs[0].receive([0x90, 60, 100], 5000);
        await flush();
        stub.inputs[0].receive([0x80, 60, 0], 8100);
        assert.deepEqual(h.notes(), [{ midi: 60, start: 0, dur: 3 }]);
        assert.equal(h.roll.getStepCursor(), 3);
    });
});

describe('rests', () => {
    test('a tap shorter than a second jumps the cursor to the next beat', async () => {
        const h = build();
        h.rec.dispatch('click');
        await h.hold(60, 300);
        assert.deepEqual(h.notes(), [], 'no note');
        assert.equal(h.roll.getStepCursor(), 4, 'on a beat already: a full beat on');
        await h.hold(62, 1000);
        assert.deepEqual(h.notes(), [{ midi: 62, start: 4, dur: 1 }]);
    });

    test('off the beat, a tap closes out the beat in progress', async () => {
        const h = build();
        h.rec.dispatch('click');
        await h.hold(62, 1000);             // a sixteenth → cursor 1
        await h.hold(60, 200);              // rest: to the next beat
        assert.equal(h.roll.getStepCursor(), 4);
        await h.hold(62, 1000);             // → 5
        await h.hold(60, 200);
        assert.equal(h.roll.getStepCursor(), 8);
    });

    test('a rest at the last beat wraps to the top of the pattern', async () => {
        const h = build();
        h.rec.dispatch('click');
        for (let i = 0; i < 3; i++) await h.hold(60, 200);   // 4, 8, 12
        assert.equal(h.roll.getStepCursor(), 12);
        await h.hold(60, 200);
        assert.equal(h.roll.getStepCursor(), 0, 'wrapped');
    });
});

describe('step length', () => {
    const select = (h) => h.dock.querySelector('.pianoroll-step-len');

    test('the picker is only on screen while a step record is armed', () => {
        const h = build();
        assert.equal(select(h).style.display, 'none');
        h.rec.dispatch('click');
        assert.equal(select(h).style.display, '');
        h.rec.dispatch('click');
        assert.equal(select(h).style.display, 'none');
    });

    test('a step places a note of the chosen length and the cursor skips past it', async () => {
        const h = build();
        h.rec.dispatch('click');
        select(h).value = '4';              // a quarter
        await h.hold(60, 1000);
        assert.deepEqual(h.notes(), [{ midi: 60, start: 0, dur: 4 }]);
        assert.equal(h.roll.getStepCursor(), 4);
    });

    test('every further held second grows the note by one more step length', async () => {
        const h = build();
        h.rec.dispatch('click');
        select(h).value = '2';              // an eighth
        await h.hold(60, 3000);
        assert.deepEqual(h.notes(), [{ midi: 60, start: 0, dur: 6 }], 'three seconds, three eighths');
        assert.equal(h.roll.getStepCursor(), 6);
    });

    test('a long step is clamped to the pattern end', async () => {
        const h = build();
        h.rec.dispatch('click');
        select(h).value = '16';
        await h.hold(60, 1000);             // a whole note in a 16-col pattern
        await h.hold(62, 1000);             // wrapped: another, clamped from col 0
        assert.deepEqual(h.notes().map(n => [n.midi, n.start, n.dur]), [[60, 0, 16], [62, 0, 16]]);
    });

    test('the choice is persisted', () => {
        const h = build();
        select(h).value = '8';
        select(h).dispatch('change');
        assert.equal(localStorage.getItem('openpatches_step_len'), '8');
    });
});

describe('seeking the cursor', () => {
    test('a header drag reported by the roll moves the next step', async () => {
        const h = build();
        h.rec.dispatch('click');
        h.roll.seekStep(9);
        await h.hold(60, 1000);
        assert.deepEqual(h.notes(), [{ midi: 60, start: 9, dur: 1 }]);
        assert.equal(h.roll.getStepCursor(), 10);
    });

    test('a rest after a seek still lands on a beat boundary', async () => {
        const h = build();
        h.rec.dispatch('click');
        h.roll.seekStep(5);
        await h.hold(60, 200);
        assert.equal(h.roll.getStepCursor(), 8);
    });
});

describe('the mobile step nudge buttons', () => {
    const nudge = (h) => {
        const [back, fwd] = h.dock.querySelectorAll('.kb-btn-step-nudge');
        return { back, fwd };
    };
    const select = (h) => h.dock.querySelector('.pianoroll-step-len');

    test('they sit in the mobile row and are live only while a step record is armed', () => {
        const h = build();
        const { back, fwd } = nudge(h);
        assert.ok(h.dock.querySelector('.kb-controls').contains(back), 'in the mobile row');
        assert.equal(back.disabled, true);
        assert.equal(fwd.disabled, true);
        h.rec.dispatch('click');
        assert.equal(back.disabled, false);
        assert.equal(fwd.disabled, false);
        h.rec.dispatch('click');
        assert.equal(back.disabled, true, 'disarmed again');
    });

    test('a press moves the cursor one step length, and the next step lands there', async () => {
        const h = build();
        const { back, fwd } = nudge(h);
        h.rec.dispatch('click');
        select(h).value = '4';
        fwd.dispatch('click');
        fwd.dispatch('click');
        assert.equal(h.roll.getStepCursor(), 8);
        back.dispatch('click');
        assert.equal(h.roll.getStepCursor(), 4);
        await h.hold(60, 1000);
        assert.deepEqual(h.notes(), [{ midi: 60, start: 4, dur: 4 }]);
    });

    test('the cursor wraps at both ends of the pattern', () => {
        const h = build();
        const { back, fwd } = nudge(h);
        h.rec.dispatch('click');
        select(h).value = '4';
        back.dispatch('click');
        assert.equal(h.roll.getStepCursor(), 12, 'back from the top wraps to the last beat');
        fwd.dispatch('click');
        assert.equal(h.roll.getStepCursor(), 0, 'forward from the last beat wraps to the top');
    });

    test('ignored while a key is down, and while not step recording', async () => {
        const h = build();
        const { fwd } = nudge(h);
        fwd.dispatch('click');                  // disabled in a browser; the handler guards too
        h.rec.dispatch('click');
        assert.equal(h.roll.getStepCursor(), 0);
        h.down(60);
        await flush();
        fwd.dispatch('click');
        assert.equal(h.roll.getStepCursor(), 0, 'the step in progress keeps its column');
        clock += 1000;
        tickTimers();
        h.up(60);
        assert.deepEqual(h.notes(), [{ midi: 60, start: 0, dur: 1 }]);
    });
});

describe('where the notes go', () => {
    test('into the pattern on screen, even when the record slot points elsewhere', async () => {
        const h = build();
        // Two tracks. The roll is opened on slot 1's clip (the Section tab's
        // "open" on a track whose voice slot holds no patch does exactly
        // this), while the record slot stays at 0.
        const lead = session.createPattern({ name: 'Lead', measures: 2, notes: [] }, 'test');
        const bass = session.createPattern({ name: 'Bass', measures: 2, notes: [{ midi: 40, start: 0, dur: 4 }] }, 'test');
        let leadClip;
        h.session.update((project, section) => {
            const t0 = M.createTrack({ slot: 0 }); const t1 = M.createTrack({ slot: 1 });
            project.tracks.push(t0, t1);
            M.addClip(project, section, { trackId: t0.id, patternId: bass.id, startCol: 0, repeats: 4 });
            leadClip = M.addClip(project, section, { trackId: t1.id, patternId: lead.id, startCol: 4 * 16 }).id;
        }, 'test');
        h.roll.openClip(leadClip);
        assert.equal(h.roll.getEditTarget().slot, 1);
        h.rec.dispatch('click');
        await h.hold(64, 1000);
        assert.deepEqual(session.getPattern(lead.id).notes.map(n => [n.midi, n.start, n.dur]), [[64, 0, 1]], 'in the pattern on screen');
        assert.equal(session.getPattern(bass.id).notes.length, 1, 'and not in the record slot\'s');
    });

    test('with nothing on screen, the note starts a track on the record slot', async () => {
        const h = build();
        assert.equal(h.roll.getEditTarget(), null);
        h.rec.dispatch('click');
        await h.hold(60, 1000);
        assert.deepEqual(h.notes(), [{ midi: 60, start: 0, dur: 1 }]);
        assert.equal(h.session.get().tracks.length, 1);
    });

    test('the roll centres on the note\'s row, and keeps the cursor in view', async () => {
        const h = build();
        h.scroll.clientHeight = 100; h.scroll.clientWidth = 300;
        h.scroll.scrollTop = 0; h.scroll.scrollLeft = 0;
        h.rec.dispatch('click');
        await h.hold(84, 1000);             // C6, the top row: already in view
        assert.ok(h.scroll.scrollTop >= 0);
        const topAfterC6 = h.scroll.scrollTop;
        await h.hold(60, 1000);             // C4, further down
        assert.ok(h.scroll.scrollTop > topAfterC6, 'centred on the lower row even though it was already visible');
        // Walk the cursor past the right edge of a 300px viewport (COL_W 30):
        for (let i = 0; i < 9; i++) await h.hold(60, 1000);
        assert.ok(h.scroll.scrollLeft > 0, 'scrolled sideways once the cursor left the view');
    });
});

describe('handing over to the clock', () => {
    test('Play while armed starts a live take — even on an empty section', () => {
        const { rec, roll, transport } = build();
        rec.dispatch('click');
        roll.startPlayback();
        assert.equal(transport.isRecording(), true, 'a take, not playback');
        assert.equal(started.length, 1, 'the clock runs now');
        assert.equal(rec.classList.contains('active'), true);
        assert.equal(rec.classList.contains('step'), false);
        assert.equal(roll.getStepCursor(), -1, 'the playhead takes over');
    });

    test('the mobile Play does the same', () => {
        const { dock, rec, transport } = build();
        rec.dispatch('click');
        const play = dock.querySelector('.kb-btn-play');
        play.dispatch('click');
        assert.equal(transport.isRecording(), true);
        assert.equal(play.textContent, 'Stop ■');
    });

    test('the clock starting elsewhere ends the step record', async () => {
        const h = build();
        h.rec.dispatch('click');
        await h.hold(60, 1000);
        assert.equal(h.transport.play({ mode: 'section' }), true);
        assert.equal(h.rec.classList.contains('active'), false);
        assert.equal(h.roll.getStepCursor(), -1);
    });

    test('Stop Rec with a key still down keeps the note at its length so far', async () => {
        const h = build();
        h.rec.dispatch('click');
        h.down(60); await flush(); clock += 2100; tickTimers();
        h.rec.dispatch('click');
        assert.equal(h.notes()[0].dur, 2);
        assert.equal(h.roll.getStepCursor(), -1);
    });
});
