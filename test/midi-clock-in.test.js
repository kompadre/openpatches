// MIDI clock in: an external device runs, we follow.
//
// With "sync to external clock" on, Play and Record only arm; the device's
// Start runs us, its Stop pauses us (still armed), our Stop disarms. Six
// clocks make a column, as on the way out, and note durations come from
// the device's measured tempo. Song Position is ignored by decision.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let midi, createTransport, makeProjectSession, createSectionEditor, createToolbar, M;
let stub;

const CLOCK = 0xF8, START = 0xFA, CONTINUE = 0xFB, STOP = 0xFC;

before(async () => {
    installBrowserEnv();
    installMidiStub();
    midi = await import('../html/synth/midi-manager.js');
    ({ createTransport } = await import('../html/synth/transport.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
    ({ createSectionEditor } = await import('../html/components/section-editor.js'));
    ({ createToolbar } = await import('../html/components/toolbar.js'));
    M = await import('../html/components/project-model.js');
});

let clock = 0;
before(() => { performance.now = () => clock; });

beforeEach(() => {
    localStorage.clear();
    midi._reset();
    clock = 10000;
});

/** MIDI enabled with an input selected and sync switched on. */
async function slaved({ sync = true } = {}) {
    stub = installMidiStub();
    await midi.requestMidi();
    midi.setSelectedInput('in0');
    midi.setSelectedOutput('out0');
    if (sync) midi.setSyncToClock(true);
    return stub.inputs[0];
}

const MS = 60000 / 120 / 24;         // one clock at 120 BPM: 20.833 ms

/** The device sends `n` clocks, 120 BPM apart, advancing our clock with them. */
function clocks(port, n, ms = MS) {
    for (let i = 0; i < n; i++) { clock += ms; port.receive([CLOCK], clock); }
}
const send = (port, status) => port.receive([status], clock);

describe('parsing', () => {
    test('off by default; realtime is then ignored, by us and by the note handler', async () => {
        const port = await slaved({ sync: false });
        const events = [];
        midi.subscribeClockIn(e => events.push(e.type));
        const notes = [];
        midi.setOnMidiMessage(e => notes.push(e.data[0]));
        send(port, START); clocks(port, 6); send(port, STOP);
        assert.deepEqual(events, []);
        assert.equal(midi.getExternalBpm(), null);
        assert.deepEqual(notes, [], 'realtime never reaches the note handler');
    });

    test('on: Start, a column every sixth clock counted from it, Stop', async () => {
        const port = await slaved();
        const events = [];
        midi.subscribeClockIn(e => events.push(e.type === 'column' ? e.rawCol : e.type));
        send(port, START);
        clocks(port, 13);                       // columns at clocks 1, 7, 13
        send(port, STOP);
        assert.deepEqual(events, ['start', 0, 1, 2, 'stop']);
    });

    test('clocks while stopped count for the tempo but not as columns', async () => {
        const port = await slaved();
        const events = [];
        midi.subscribeClockIn(e => events.push(e.type));
        clocks(port, 24);
        assert.deepEqual(events, []);
        assert.ok(Math.abs(midi.getExternalBpm() - 120) < 0.01, 'tempo known before Start');
    });

    test('Continue keeps counting where Stop left it; Start restarts from zero', async () => {
        const port = await slaved();
        const cols = [];
        midi.subscribeClockIn(e => { if (e.type === 'column') cols.push(e.rawCol); });
        send(port, START); clocks(port, 7);     // 0, 1
        send(port, STOP);
        send(port, CONTINUE); clocks(port, 6);  // 2
        send(port, START); clocks(port, 1);     // 0
        assert.deepEqual(cols, [0, 1, 2, 0]);
    });

    test('the tempo is the mean of the last quarter note of clocks, and a silence resets it', async () => {
        const port = await slaved();
        clocks(port, 30, 60000 / 90 / 24);
        assert.ok(Math.abs(midi.getExternalBpm() - 90) < 0.01);
        clocks(port, 24, MS);                   // a full window at 120
        assert.ok(Math.abs(midi.getExternalBpm() - 120) < 0.01, 'the old tempo has washed out');
        clock += 5000;
        port.receive([CLOCK], clock);
        assert.equal(midi.getExternalBpm(), null, 'after a long gap the estimate starts over');
    });

    test('remembered, and announced to subscribers when switched', async () => {
        await slaved();
        assert.match(localStorage.getItem('openpatches_midi'), /"syncToClock":true/);
        const events = [];
        midi.subscribeClockIn(e => events.push(e));
        midi.setSyncToClock(false);
        assert.deepEqual(events, [{ type: 'sync', on: false }]);
        midi._reset();
        assert.equal(midi.getSyncToClock(), false);
    });

    // Master and slave are one choice. They used to be two independent
    // settings, and a slave that was also asked to send clock kept the
    // setting while isClockOutEnabled() quietly refused to act on it — so
    // "Send MIDI clock" could sit ticked, sending nothing, with no way to
    // tell from the panel. Switching either on now switches the other off.
    test('asking a slave to send clock makes it the master instead', async () => {
        await slaved();
        midi.setSendClock(true);
        assert.equal(midi.getSyncToClock(), false, 'it stopped following');
        assert.equal(midi.getSendClock(), true);
        assert.equal(midi.isClockOutEnabled(), true, 'and the clock actually goes out');
        assert.equal(midi.clockStart(0), true);
    });

    test('becoming a slave gives up sending clock', async () => {
        const port = await slaved({ sync: false });
        midi.setSendClock(true);
        midi.setSyncToClock(true);
        assert.equal(midi.getSendClock(), false, 'master was switched off');
        assert.equal(midi.isClockOutEnabled(), false);
        assert.ok(port);
    });

    // The guard inside isClockOutEnabled() is now unreachable through the
    // setters, and stays as the invariant it always was.
    test('a slave never emits clock even if both flags are somehow set', async () => {
        await slaved();
        assert.equal(midi.isClockOutEnabled(), false);
        assert.equal(midi.clockStart(0), false);
    });

    // Storage written by the build where the two were independent.
    test('both remembered on: sync wins, because it was the one doing something', () => {
        localStorage.setItem('openpatches_midi',
            JSON.stringify({ sendClock: true, syncToClock: true }));
        midi._reset();
        assert.equal(midi.getSyncToClock(), true);
        assert.equal(midi.getSendClock(), false);
    });

    test('switching to slave while clocking a device stops that device', async () => {
        const port = await slaved({ sync: false });
        midi.setSendClock(true);
        midi.clockStart(0);
        midi.setSyncToClock(true);
        assert.equal(midi.isClockRunning(), false);
        assert.equal(stub.outputs[0].sent.map(([d]) => d[0]).pop(), STOP);
    });
});

describe('the transport follows', () => {
    function build({ notes = [{ midi: 60, start: 0, dur: 4 }], empty = false } = {}) {
        const session = makeProjectSession();
        let clipId = null;
        const pattern = session.createPattern({ name: 'A', measures: 1, notes }, 'test');
        if (!empty) {
            session.update((project, section) => {
                const t = M.createTrack({ slot: 0 });
                project.tracks.push(t);
                clipId = M.addClip(project, section, { trackId: t.id, patternId: pattern.id, startCol: 0 }).id;
            }, 'test');
        }
        const handlers = [];
        const started = [];
        const tickWorker = {
            postMessage() {}, addEventListener(t, fn) { if (t === 'message') handlers.push(fn); },
            tick(col) { for (const fn of handlers) fn({ data: { type: 'tick', col } }); },
        };
        const played = [];
        const stops = [];
        const positions = [];
        const transport = createTransport({
            session, tickWorker, startWorker: () => started.push(1), stopWorker: () => {},
            playNote: (m, durMs) => played.push([m, durMs]), getSlotData: () => null,
            getPattern: (id) => session.getPattern(id),
            getEditTarget: () => (empty ? null : { trackId: session.get().tracks[0].id, clipId, pattern, slot: 0 }),
            onStop: () => stops.push(1),
        });
        transport.subscribe(p => positions.push(p));
        return { transport, tickWorker, started, played, stops, positions, session, last: () => positions[positions.length - 1] };
    }

    test('Play arms: no worker, nothing sounds, the position says waiting', async () => {
        await slaved();
        const h = build();
        assert.equal(h.transport.play({ mode: 'section' }), true);
        assert.deepEqual(h.started, [], 'the worker is not started');
        assert.equal(h.transport.isPlaying(), false);
        assert.equal(h.transport.isWaiting(), true);
        assert.equal(h.transport.isRunning(), true, 'Stop is what ends it');
        assert.equal(h.last().waiting, true);
        assert.equal(h.last().col, 0, 'parked at the start');
        h.tickWorker.tick(0);
        assert.deepEqual(h.played, [], 'a stray worker tick is ignored');
    });

    test('the device\'s Start runs us; its clocks are our columns', async () => {
        const port = await slaved();
        const h = build();
        h.transport.play({ mode: 'section' });
        send(port, START);
        assert.equal(h.transport.isPlaying(), true);
        assert.equal(h.transport.isWaiting(), false);
        clocks(port, 1);                        // column 0
        assert.deepEqual(h.played.map(p => p[0]), [60]);
        assert.equal(h.last().col, 0);
        clocks(port, 6);                        // column 1
        assert.equal(h.last().col, 1);
    });

    test('note lengths use the device\'s tempo once it is known', async () => {
        const port = await slaved();
        const h = build();
        h.transport.play({ mode: 'section' });
        send(port, START);
        clocks(port, 1);
        assert.equal(h.played[0][1], 4 * 125, 'first column: tempo unknown, so the section\'s 120');
        clocks(port, 16 * 6, 60000 / 60 / 24);  // a bar at 60 BPM, back to column 0
        const lastDur = h.played[h.played.length - 1][1];
        assert.ok(Math.abs(lastDur - 4 * 250) < 1, `at 60 BPM a column is 250 ms, got ${lastDur}`);
        assert.ok(Math.abs(h.last().bpm - 60) < 0.01, 'and the position carries it');
    });

    test('the device\'s Stop pauses us but leaves us armed; Continue resumes, Start restarts', async () => {
        const port = await slaved();
        const h = build();
        h.transport.play({ mode: 'section' });
        send(port, START); clocks(port, 13);    // columns 0, 1, 2
        send(port, STOP);
        assert.equal(h.transport.isPlaying(), false);
        assert.equal(h.transport.isWaiting(), true, 'still armed');
        assert.equal(h.stops.length, 1, 'notes released');
        assert.equal(h.last().col, 2, 'the playhead stays where it was stopped');
        send(port, CONTINUE); clocks(port, 6);  // the device\'s column 3
        assert.equal(h.last().col, 3, 'resumed in step');
        send(port, START); clocks(port, 1);
        assert.equal(h.last().col, 0, 'a Start is from the top');
    });

    test('our Stop disarms', async () => {
        const port = await slaved();
        const h = build();
        h.transport.play({ mode: 'section' });
        assert.equal(h.transport.stop(), true, 'there was something to stop');
        assert.equal(h.transport.isRunning(), false);
        send(port, START); clocks(port, 6);
        assert.deepEqual(h.played, [], 'no longer listening');
    });

    test('switching sync off while armed stops us; switching it on mid-play ends the take', async () => {
        await slaved();
        const h = build();
        h.transport.play({ mode: 'section' });
        midi.setSyncToClock(false);
        assert.equal(h.transport.isRunning(), false);
        h.transport.play({ mode: 'section' });
        assert.equal(h.started.length, 1, 'master again: the worker runs');
        midi.setSyncToClock(true);
        assert.equal(h.transport.isRunning(), false);
    });

    test('Record arms as a take, and runs on Start even into an empty section', async () => {
        const port = await slaved();
        const h = build({ empty: true });
        assert.equal(h.transport.startRecording({ mode: 'pattern' }), true);
        assert.equal(h.transport.isRecording(), false);
        assert.equal(h.transport.isWaiting(), true);
        send(port, START);
        assert.equal(h.transport.isRecording(), true);
    });

    test('a slave never clocks the bus back', async () => {
        const port = await slaved();
        midi.setSendClock(true);
        const h = build();
        h.transport.play({ mode: 'section' });
        send(port, START); clocks(port, 12);
        assert.deepEqual(stub.outputs[0].sent.filter(([d]) => d[0] === CLOCK), []);
    });

    test('Play while already armed re-arms rather than stacking', async () => {
        const port = await slaved();
        const h = build();
        h.transport.play({ mode: 'section' });
        h.transport.play({ mode: 'section' });
        send(port, START); clocks(port, 1);
        assert.equal(h.played.length, 1);
    });
});

describe('what the buttons show', () => {
    test('the transport bar\'s Play pulses while waiting, and Stop is live', async () => {
        await slaved();
        const session = makeProjectSession();
        const pattern = session.createPattern({ name: 'A', measures: 1, notes: [{ midi: 60, start: 0, dur: 1 }] });
        session.update((project, section) => {
            const t = M.createTrack({ slot: 0 });
            project.tracks.push(t);
            M.addClip(project, section, { trackId: t.id, patternId: pattern.id, startCol: 0 });
        }, 'test');
        const transport = createTransport({
            session, tickWorker: { postMessage() {}, addEventListener() {} }, startWorker: () => {}, stopWorker: () => {},
            playNote: () => {}, getSlotData: () => null, getPattern: (id) => session.getPattern(id), getEditTarget: () => null,
        });
        const { createTransportBar } = await import('../html/components/transport-bar.js');
        const bar = createTransportBar({ transport, session });
        const play = () => bar.element.querySelector('.transport-play');
        const stop = () => bar.element.querySelector('.transport-stop');
        const click = (el) => el.dispatch('click', { stopPropagation() {} });
        click(play());
        assert.equal(play().classList.contains('waiting'), true);
        assert.equal(play().disabled, true);
        assert.equal(stop().disabled, false);
        assert.match(play().title, /Waiting for the external MIDI clock/);
        click(stop());
        assert.equal(play().classList.contains('waiting'), false);
        assert.equal(play().disabled, false);
    });

    test('the settings checkbox shows the setting and writes it through', async () => {
        await slaved({ sync: false });
        const panel = await import('../html/components/midi-panel.js');
        document.body.children.length = 0;
        panel.openMidiSettings({ appendLog: () => {} });
        const box = document.body.querySelector('.midi-sync-clock');
        assert.ok(box);
        assert.equal(box.checked, false);
        box.checked = true;
        box.dispatch('change');
        assert.equal(midi.getSyncToClock(), true);
    });
});

describe('recording under an external clock', () => {
    test('a key is placed relative to the device\'s Start, at its tempo — not relative to pressing Rec', async () => {
        const port = await slaved();
        const dock = createToolbar({
            session: makeProjectSession(),
            playNoteFn: () => Promise.resolve(() => {}), stopNoteFn: () => {},
            tickWorker: { postMessage() {}, addEventListener() {} }, startWorker: () => {}, stopWorker: () => {},
        });
        const roll = dock._pianoroll;
        const transport = roll.getTransport();
        const keys = dock.querySelectorAll('.key');
        const ev = { button: 0, preventDefault() {} };
        // Rec on a stopped transport is a step record; Play first arms for
        // playback, and Rec then turns the arm into a take.
        roll.addNote({ midi: 48, start: 0, dur: 1, slot: 0 });
        roll.startPlayback();
        dock.querySelector('.transport-record').dispatch('click');
        assert.equal(transport.isWaiting(), true, 'armed for a take');
        clock += 3000;                                 // the device takes its time
        clocks(port, 24, 60000 / 60 / 24);             // and runs at 60 BPM
        send(port, START);
        clocks(port, 1);                               // column 0
        keys[24].dispatch('mousedown', ev);            // C4 at the top
        await new Promise(r => setImmediate(r));
        clock += 250;                                  // one column at 60 BPM
        keys[24].dispatch('mouseup', ev);
        const n = roll.getNotes().find(x => x.midi === 60);
        assert.ok(n, 'recorded');
        assert.equal(n.start, 0, 'at the column the device started, not three seconds in');
        assert.equal(n.dur, 1, 'a column at the device\'s 60 BPM, not two at the section\'s 120');
    });
});
