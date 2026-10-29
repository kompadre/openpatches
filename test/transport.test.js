// The transport: one owner of the clock.
//
// Before this the roll listened to the tick worker and the toolbar started
// it separately for recording — two owners of one clock. Everything about
// what sounds, when, and where the playhead is now comes from here.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createTransport, createSongSession, M;

before(async () => {
    installBrowserEnv();
    ({ createTransport } = await import('../html/synth/transport.js'));
    ({ createSongSession } = await import('../html/components/song-session.js'));
    M = await import('../html/components/song-model.js');
});

beforeEach(() => localStorage.clear());

function makeTickWorker() {
    const handlers = [];
    return {
        started: [], stopped: 0,
        postMessage() {},
        addEventListener(type, fn) { if (type === 'message') handlers.push(fn); },
        tick(col) { for (const fn of handlers) fn({ data: { type: 'tick', col } }); },
    };
}

const BANK = [{ name: 'A', voiceData: 'a' }, { name: 'B', voiceData: 'b' }, { name: 'C', voiceData: 'c' }];

/**
 * A session with `tracks` (slots) each carrying one clip of a pattern, and
 * a transport over it. `edit` picks which track the roll is "editing".
 */
function build(opts = {}) {
    const { tracks = [], mode = null, edit = 0 } = opts;   // mode: null = whatever was persisted
    const session = createSongSession();
    session.init();
    const made = [];
    session.update((song) => {
        for (const spec of tracks) {
            const pattern = M.patternStore.create({
                name: 'p' + spec.slot, measures: spec.measures || 1, notes: spec.notes || [],
            });
            const track = M.createTrack({ slot: spec.slot });
            song.tracks.push(track);
            const clip = M.addClip(song, {
                trackId: track.id, patternId: pattern.id,
                startMeasure: spec.at || 0, repeats: spec.repeats || 1,
            }, (id) => M.patternStore.get(id));
            made.push({ pattern, track, clip, slot: spec.slot });
        }
    }, 'test');

    const played = [];
    const positions = [];
    const stops = [];
    const logs = [];
    const tickWorker = makeTickWorker();
    let editIdx = edit;
    const transport = createTransport({
        session, tickWorker,
        startWorker: (w, bpm, col) => w.started.push({ bpm, col }),
        stopWorker: (w) => { w.stopped++; },
        playNote: (midi, durMs, voiceData, slot) => {
            if (opts.throwOnPlay) throw new Error('no audio');
            played.push({ midi, durMs, voiceData, slot });
        },
        getSlotData: (slot) => BANK[slot] || null,
        getPattern: (id) => made.find(m => m.pattern.id === id)?.pattern || M.patternStore.get(id),
        getEditTarget: () => {
            const m = made[editIdx];
            return m ? { trackId: m.track.id, clipId: m.clip.id, pattern: m.pattern, slot: m.slot } : null;
        },
        onStop: () => stops.push(1),
        log: (msg) => logs.push(msg),
    });
    if (mode && mode !== transport.getMode()) transport.setMode(mode);
    transport.subscribe(p => positions.push(p));
    return {
        transport, session, made, played, positions, stops, logs, tickWorker,
        setEdit: (i) => { editIdx = i; },
        last: () => positions[positions.length - 1],
    };
}

const note = (midi, start, dur = 1) => ({ midi, start, dur });

describe('modes', () => {
    test('song is the default — the arrangement, as the roll always did', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        assert.equal(h.transport.getMode(), 'song');
    });

    test('the choice is remembered', () => {
        const a = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        a.transport.setMode('pattern');
        assert.equal(build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] }).transport.getMode(), 'pattern');
    });

    test('song mode sounds every track; pattern mode only the edited one', () => {
        const h = build({
            tracks: [{ slot: 0, notes: [note(60, 0)] }, { slot: 1, notes: [note(48, 0)] }],
            edit: 0,
        });
        h.transport.play();
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played.map(p => [p.midi, p.slot]).sort(), [[48, 1], [60, 0]]);

        h.transport.setMode('pattern');
        h.transport.play();
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played.map(p => [p.midi, p.slot]), [[60, 0]], 'the other voice is silent');
    });

    test('pattern mode loops the pattern, not the song', () => {
        const h = build({
            tracks: [{ slot: 0, measures: 1, notes: [note(60, 0)] }, { slot: 1, measures: 1, notes: [note(48, 0)], at: 3 }],
            edit: 0, mode: 'pattern',
        });
        h.transport.play();
        assert.deepEqual(h.transport.getSequence().range, { startCol: 0, endCol: 16 });
        h.played.length = 0;
        h.tickWorker.tick(16);
        assert.deepEqual(h.played.map(p => p.midi), [60], 'wrapped back to the pattern start');
    });

    test('switching mode while running stops first — the ranges differ', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        h.transport.play();
        assert.equal(h.transport.isPlaying(), true);
        h.transport.setMode('pattern');
        assert.equal(h.transport.isPlaying(), false);
        assert.equal(h.tickWorker.stopped, 1);
        assert.equal(h.stops.length, 1, 'sounding notes released');
    });

    test('an unknown mode is ignored', () => {
        const h = build();
        assert.equal(h.transport.setMode('nonsense'), 'song');
    });
});

describe('play / stop', () => {
    test('play starts the worker and refuses an empty song', () => {
        const empty = build();
        assert.equal(empty.transport.play(), false);
        assert.equal(empty.tickWorker.started.length, 0);

        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        assert.equal(h.transport.play(), true);
        assert.deepEqual(h.tickWorker.started, [{ bpm: 120, col: 0 }]);
    });

    test('a song of empty patterns is still nothing to play', () => {
        const h = build({ tracks: [{ slot: 0, notes: [] }] });
        assert.equal(h.transport.play(), false);
    });

    test('stop releases sounding notes and reports the rest position', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        h.transport.play();
        h.transport.stop();
        assert.equal(h.transport.isPlaying(), false);
        assert.equal(h.stops.length, 1);
        assert.equal(h.last().col, -1);
        assert.equal(h.last().edit, null);
    });

    test('stop on an idle transport releases nothing', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        assert.equal(h.transport.stop(), false);
        assert.equal(h.stops.length, 0);
    });

    test('ticks are ignored once stopped', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        h.transport.play();
        h.transport.stop();
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played, []);
    });

    test('play while recording is refused — one clock, one job', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        h.transport.startRecording();
        assert.equal(h.transport.play(), false);
        assert.equal(h.transport.isRecording(), true);
    });

    test('durations come from the song tempo', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0, 4)] }] });
        h.session.update((song) => { song.bpm = 60; }, 'test');
        h.transport.play();
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.equal(h.played[0].durMs, 4 * (60000 / 60 / 4));
    });

    test('repeated play errors stop the transport rather than spinning', () => {
        const h = build({
            tracks: [{ slot: 0, notes: [note(60, 0), note(62, 0), note(64, 0)] }],
            throwOnPlay: true,
        });
        h.transport.play();
        assert.equal(h.transport.isPlaying(), true);
        h.tickWorker.tick(0);          // three throwing notes in one column
        assert.equal(h.transport.isPlaying(), false, 'gave up instead of erroring every tick');
        assert.equal(h.stops.length, 1, 'and released what was sounding');
    });
});

describe('position reporting', () => {
    test('every tick reports the song column and the pattern-local one', () => {
        const h = build({ tracks: [{ slot: 0, measures: 2, notes: [note(60, 0)], at: 1 }], edit: 0 });
        h.transport.play();
        h.positions.length = 0;
        h.tickWorker.tick(20);
        const p = h.last();
        assert.equal(p.col, 20);
        assert.equal(p.playing, true);
        assert.deepEqual(p.edit, { clipId: h.made[0].clip.id, patternCol: 4 }, 'bar 2 col 4 of a clip starting at bar 2');
    });

    test('no playhead where the edited pattern is not placed', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)], at: 2 }], edit: 0 });
        h.transport.play();
        h.tickWorker.tick(0);
        assert.equal(h.last().col, 0);
        assert.equal(h.last().edit, null, 'the clip starts at bar 3');
        h.tickWorker.tick(32);
        assert.deepEqual(h.last().edit, { clipId: h.made[0].clip.id, patternCol: 0 });
    });

    test('the seam is flagged exactly at the wrap', () => {
        const h = build({ tracks: [{ slot: 0, measures: 1, notes: [note(60, 0)] }] });
        h.transport.play();
        const seams = [];
        for (const raw of [0, 1, 15, 16, 17, 32]) {
            h.tickWorker.tick(raw);
            seams.push([raw, h.last().seam]);
        }
        assert.deepEqual(seams, [[0, false], [1, false], [15, false], [16, true], [17, false], [32, true]]);
    });

    test('a loop range confines the columns reported', () => {
        const h = build({ tracks: [{ slot: 0, measures: 1, notes: [note(60, 0)], repeats: 4 }] });
        h.session.update((song) => { song.loop = { start: 1, end: 2 }; }, 'test');
        h.transport.play();
        h.tickWorker.tick(0);
        assert.equal(h.last().col, 16);
        h.tickWorker.tick(16);
        assert.equal(h.last().col, 16, 'wrapped inside the loop');
    });

    test('a subscriber that throws does not stop the others', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        const origWarn = console.warn; console.warn = () => {};
        let reached = false;
        h.transport.subscribe(() => { throw new Error('boom'); });
        h.transport.subscribe(() => { reached = true; });
        try { h.transport.play(); } finally { console.warn = origWarn; }
        assert.equal(reached, true);
    });
});

describe('recording', () => {
    test('startRecording runs the clock and sounds the arrangement', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }, { slot: 1, notes: [note(48, 0)] }] });
        h.transport.startRecording();
        assert.equal(h.transport.isRecording(), true);
        assert.deepEqual(h.tickWorker.started, [{ bpm: 120, col: 0 }]);
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played.map(p => p.midi).sort(), [48, 60], 'the backing is audible while recording');
    });

    test('a note just played in is not echoed back on the same pass', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        const justRecorded = h.made[0].pattern.notes[0];
        justRecorded._recordedInSession = true;
        h.transport.startRecording();
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played, [], 'suppressed');
        delete justRecorded._recordedInSession;
        h.tickWorker.tick(16);
        assert.deepEqual(h.played.map(p => p.midi), [60], 'and plays once the flag is cleared at the seam');
    });

    test('the flag is only honoured while recording', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        h.made[0].pattern.notes[0]._recordedInSession = true;
        h.transport.play();
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played.map(p => p.midi), [60], 'plain playback ignores it');
    });

    test('stopRecording stops the clock and releases notes', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        h.transport.startRecording();
        assert.equal(h.transport.stopRecording(), true);
        assert.equal(h.transport.isRecording(), false);
        assert.equal(h.stops.length, 1);
        assert.equal(h.transport.stopRecording(), false, 'already stopped');
    });

    test('recording into an empty song still works — it is the first-use flow', () => {
        const h = build();
        h.transport.startRecording();
        assert.equal(h.transport.isRecording(), true);
        assert.deepEqual(h.transport.mapRecordColumn(5, 0), { fresh: true });
    });
});

describe('mapRecordColumn', () => {
    test('pattern mode wraps on the edited pattern', () => {
        const h = build({ tracks: [{ slot: 0, measures: 1, notes: [note(60, 0)] }], mode: 'pattern' });
        h.transport.play();
        assert.equal(h.transport.mapRecordColumn(3, 0).patternCol, 3);
        assert.equal(h.transport.mapRecordColumn(19, 0).patternCol, 3, 'second pass');
        assert.equal(h.transport.mapRecordColumn(-1, 0).patternCol, 15);
    });

    test('song mode maps through the clip under the playhead', () => {
        const h = build({ tracks: [{ slot: 0, measures: 2, notes: [note(60, 0)], at: 1 }] });
        h.transport.play();
        const m = h.transport.mapRecordColumn(20, 0);
        assert.equal(m.patternCol, 4);
        assert.equal(m.clipId, h.made[0].clip.id);
    });

    test('a voice with clips but none under the playhead records nothing, and says so once', () => {
        const h = build({ tracks: [{ slot: 0, measures: 1, notes: [note(60, 0)], at: 2, repeats: 1 },
                                   { slot: 1, measures: 1, notes: [note(48, 0)], at: 0, repeats: 4 }] });
        h.transport.play();
        assert.equal(h.transport.mapRecordColumn(0, 0), null, 'slot 0 is only at bar 3');
        assert.equal(h.transport.mapRecordColumn(4, 0), null);
        assert.equal(h.logs.filter(l => /not recorded/.test(l)).length, 1, 'warned once, not per note');
        assert.ok(h.transport.mapRecordColumn(32, 0), 'inside the clip it maps');
    });

    test('a voice with nothing placed is `fresh`, so the caller starts a clip', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        h.transport.play();
        assert.deepEqual(h.transport.mapRecordColumn(5, 2), { fresh: true }, 'voice 3 has no track');
    });
});
