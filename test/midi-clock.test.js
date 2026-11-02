// MIDI clock out: our transport driving an external sequencer.
//
// Beat clock is 24 ticks to the quarter note and a column is a sixteenth,
// so every column the transport reaches becomes six timestamped clocks.
// The timing is the point here — a device reads the gaps between clocks as
// the tempo, so jitter and out-of-order stamps are the failure modes.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let midi, createTransport, makeProjectSession, M;
let stub;

const CLOCK = 0xF8, START = 0xFA, CONTINUE = 0xFB, STOP = 0xFC, SPP = 0xF2;

before(async () => {
    installBrowserEnv();
    installMidiStub();
    midi = await import('../html/synth/midi-manager.js');
    ({ createTransport } = await import('../html/synth/transport.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
    M = await import('../html/components/project-model.js');
});

// performance.now() is pinned so the stamps are exact arithmetic.
let clock = 0;
before(() => { performance.now = () => clock; });

beforeEach(() => {
    localStorage.clear();
    midi._reset();
    clock = 10000;
});

/** MIDI enabled with an output selected, and the clock switched on. */
async function wired({ sendClock = true } = {}) {
    stub = installMidiStub();
    await midi.requestMidi();
    midi.setSelectedOutput('out0');
    if (sendClock) midi.setSendClock(true);
    return stub.outputs[0];
}

/** Everything sent to the port, as [status, ...data, timestamp]. */
const sent = (port) => port.sent.map(([data, ts]) => [...data, ts]);
const statuses = (port) => port.sent.map(([data]) => data[0]);
const clocksOf = (port) => port.sent.filter(([d]) => d[0] === CLOCK).map(([, ts]) => ts);
const LATENCY = 317;          // DEFAULT_OUTPUT_LATENCY_MS

describe('the switch', () => {
    test('off by default, and off means nothing on the wire', async () => {
        const port = await wired({ sendClock: false });
        assert.equal(midi.getSendClock(), false);
        assert.equal(midi.isClockOutEnabled(), false);
        midi.clockStart(0);
        midi.clockColumn(0, 120);
        midi.clockStop();
        assert.deepEqual(port.sent, []);
    });

    test('on, with a device, is what enables it — and it is remembered', async () => {
        await wired();
        assert.equal(midi.getSendClock(), true);
        assert.equal(midi.isClockOutEnabled(), true);
        assert.match(localStorage.getItem('openpatches_midi'), /"sendClock":true/);
        midi._reset();
        assert.equal(midi.getSendClock(), true, 'read back on the next load');
    });

    test('switched on with nowhere to send it stays quiet', () => {
        midi.setSendClock(true);
        assert.equal(midi.getSendClock(), true);
        assert.equal(midi.isClockOutEnabled(), false, 'no output port');
        assert.equal(midi.clockStart(0), false);
        assert.equal(midi.clockColumn(0, 120), 0);
    });

    test('switching it off mid-play stops the device rather than abandoning it', async () => {
        const port = await wired();
        midi.clockStart(0);
        assert.equal(midi.isClockRunning(), true);
        midi.setSendClock(false);
        assert.equal(midi.isClockRunning(), false);
        assert.deepEqual(statuses(port), [START, STOP]);
    });
});

describe('start, stop and position', () => {
    test('from the top it is a bare Start', async () => {
        const port = await wired();
        assert.equal(midi.clockStart(0), true);
        assert.deepEqual(sent(port), [[START, clock + LATENCY]]);
    });

    test('from anywhere else it is a Song Position and a Continue', async () => {
        const port = await wired();
        // Column 300 — a 14-bit value split low-7 first, so 300 = 44 + 2×128.
        midi.clockStart(300);
        assert.deepEqual(sent(port), [
            [SPP, 44, 2, clock + LATENCY],
            [CONTINUE, clock + LATENCY],
        ]);
    });

    test('a Song Position counts sixteenths, which is exactly our columns', async () => {
        const port = await wired();
        midi.clockStart(16);                       // bar 2
        assert.deepEqual(sent(port)[0], [SPP, 16, 0, clock + LATENCY]);
    });

    test('Stop goes out once, and only if it was running', async () => {
        const port = await wired();
        assert.equal(midi.clockStop(), false, 'not running: nothing to stop');
        midi.clockStart(0);
        assert.equal(midi.clockStop(), true);
        assert.equal(midi.clockStop(), false);
        assert.deepEqual(statuses(port), [START, STOP]);
    });

    test('panic stops the device — it is what a closing tab calls', async () => {
        const port = await wired();
        midi.clockStart(0);
        port.sent.length = 0;
        midi.panic();
        assert.equal(statuses(port)[0], STOP, 'before the note-off sweep');
        assert.equal(midi.isClockRunning(), false);
    });
});

describe('the ticks', () => {
    test('six to the column, evenly spaced, at 24 to the quarter', async () => {
        const port = await wired();
        midi.clockStart(0);
        port.sent.length = 0;
        assert.equal(midi.clockColumn(0, 120), 6);
        const ms = 60000 / 120 / 24;               // 20.833…
        assert.deepEqual(clocksOf(port), [0, 1, 2, 3, 4, 5].map(i => clock + i * ms + LATENCY));
    });

    test('a column is six clocks and a quarter note is twenty-four', async () => {
        const port = await wired();
        midi.clockStart(0);
        for (let c = 0; c < 4; c++) midi.clockColumn(c, 120);
        assert.equal(clocksOf(port).length, 24, 'four sixteenths = one quarter');
    });

    test('spacing is even across columns, however late a tick arrives', async () => {
        const port = await wired();
        midi.clockStart(0);
        midi.clockColumn(0, 120);
        clock += 180;                              // the next tick is 55 ms late
        midi.clockColumn(1, 120);
        const gaps = clocksOf(port).slice(1).map((t, i) => t - clocksOf(port)[i]);
        const ms = 60000 / 120 / 24;
        for (const g of gaps) assert.ok(Math.abs(g - ms) < 1e-9, `even gap, got ${g}`);
    });

    test('and never runs backwards when a tick arrives early', async () => {
        const port = await wired();
        midi.clockStart(0);
        midi.clockColumn(0, 120);
        clock -= 50;                               // impossibly early
        midi.clockColumn(1, 120);
        const ts = clocksOf(port);
        for (let i = 1; i < ts.length; i++) assert.ok(ts[i] > ts[i - 1], 'stamps stay in order');
    });

    test('a tempo change re-anchors, so the new spacing starts from that column', async () => {
        const port = await wired();
        midi.clockStart(0);
        midi.clockColumn(0, 120);
        port.sent.length = 0;
        clock += 125;
        midi.clockColumn(1, 60);                   // half speed
        const ms = 60000 / 60 / 24;
        assert.deepEqual(clocksOf(port), [0, 1, 2, 3, 4, 5].map(i => clock + i * ms + LATENCY));
    });

    test('nothing goes out before Start or after Stop', async () => {
        const port = await wired();
        assert.equal(midi.clockColumn(0, 120), 0, 'not started');
        midi.clockStart(0);
        assert.equal(midi.clockColumn(0, 120), 6);
        midi.clockStop();
        assert.equal(midi.clockColumn(1, 120), 0, 'stopped');
    });

    test('the clocks carry the output latency, like every note', async () => {
        const port = await wired();
        midi.setOutputLatency(0);
        midi.clockStart(0);
        assert.deepEqual(clocksOf(port), []);
        midi.clockColumn(0, 120);
        assert.equal(clocksOf(port)[0], clock, 'no latency, no shift');
    });
});

describe('the settings control', () => {
    let panel;
    before(async () => { panel = await import('../html/components/midi-panel.js'); });

    async function openPanel() {
        document.body.children.length = 0;
        panel.openMidiSettings({ appendLog: () => {} });
        return document.body.querySelector('.midi-send-clock');
    }

    test('a checkbox that shows the setting and writes it through', async () => {
        await wired({ sendClock: false });
        const box = await openPanel();
        assert.ok(box, 'the panel offers it');
        assert.equal(box.checked, false);

        box.checked = true;
        box.dispatch('change');
        assert.equal(midi.getSendClock(), true);

        box.checked = false;
        box.dispatch('change');
        assert.equal(midi.getSendClock(), false);
    });

    test('it opens ticked when the setting was remembered', async () => {
        await wired();
        assert.equal((await openPanel()).checked, true);
    });
});

describe('driven by the transport', () => {
    function build({ sendClock = true } = {}) {
        const session = makeProjectSession();
        const pattern = session.createPattern({ name: 'A', measures: 2, notes: [{ midi: 60, start: 0, dur: 1 }] });
        let clipId = null;
        session.update((project, section) => {
            const t = M.createTrack({ slot: 0 });
            project.tracks.push(t);
            clipId = M.addClip(project, section, { trackId: t.id, patternId: pattern.id, startCol: 0 }).id;
        }, 'test');
        const handlers = [];
        const tickWorker = {
            postMessage() {}, addEventListener(t, fn) { if (t === 'message') handlers.push(fn); },
            tick(col) { for (const fn of handlers) fn({ data: { type: 'tick', col } }); },
        };
        const transport = createTransport({
            session, tickWorker, startWorker: () => {}, stopWorker: () => {},
            playNote: () => {}, getSlotData: () => null,
            getPattern: (id) => session.getPattern(id),
            getEditTarget: () => ({ trackId: session.get().tracks[0].id, clipId, pattern, slot: 0 }),
        });
        return { transport, tickWorker, session };
    }

    test('Play starts the device, each tick clocks it, Stop stops it', async () => {
        const port = await wired();
        const h = build();
        assert.equal(h.transport.play({ mode: 'song' }), true);
        assert.deepEqual(statuses(port), [START]);
        h.tickWorker.tick(0);
        h.tickWorker.tick(1);
        assert.equal(clocksOf(port).length, 12);
        h.transport.stop();
        assert.equal(statuses(port).pop(), STOP);
    });

    test('recording clocks the device too — a take is the same clock', async () => {
        const port = await wired();
        const h = build();
        h.transport.startRecording({ mode: 'pattern' });
        assert.deepEqual(statuses(port), [START]);
        h.tickWorker.tick(0);
        assert.equal(clocksOf(port).length, 6);
    });

    test('a loop seam does not disturb the spacing — rawCol keeps counting', async () => {
        const port = await wired();
        const h = build();
        h.transport.play({ mode: 'song' });
        port.sent.length = 0;
        const total = 32;                          // the song is two bars
        for (let c = 0; c < total + 2; c++) { h.tickWorker.tick(c); clock += 125; }
        const ts = clocksOf(port);
        assert.equal(ts.length, (total + 2) * 6);
        const ms = 60000 / 120 / 24;
        for (let i = 1; i < ts.length; i++) {
            assert.ok(Math.abs((ts[i] - ts[i - 1]) - ms) < 1e-9, `even across the wrap at ${i}`);
        }
    });

    test('with the clock off the transport runs exactly as before', async () => {
        const port = await wired({ sendClock: false });
        const h = build();
        h.transport.play({ mode: 'song' });
        h.tickWorker.tick(0);
        h.transport.stop();
        assert.deepEqual(port.sent, []);
    });

    test('playing from a loop start tells the device where that is', async () => {
        const port = await wired();
        const h = build();
        h.session.update((project, section) => { section.loop = { start: 1, end: 2 }; }, 'test');
        h.transport.play({ mode: 'song' });
        assert.deepEqual(sent(port)[0], [SPP, 16, 0, clock + LATENCY], 'bar 2 is column 16');
        assert.equal(statuses(port)[1], CONTINUE);
    });
});
