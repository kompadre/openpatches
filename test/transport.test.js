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

    test('song mode sounds every track; pattern mode the window of the edited one, with company', () => {
        const h = build({
            tracks: [
                { slot: 0, notes: [note(60, 0)] },
                { slot: 1, notes: [note(48, 0)] },          // alongside the edited pattern
                { slot: 2, notes: [note(52, 0)], at: 3 },   // elsewhere in the song
            ],
            edit: 0,
        });
        h.transport.play();
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played.map(p => [p.midi, p.slot]).sort(), [[48, 1], [60, 0]]);
        h.played.length = 0;
        h.tickWorker.tick(48);
        assert.deepEqual(h.played.map(p => p.midi), [52], 'song mode reaches bar 4');

        h.transport.setMode('pattern');
        h.transport.play();
        assert.deepEqual(h.transport.getSequence().range, { startCol: 0, endCol: 16 }, 'the placement, not the song');
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played.map(p => [p.midi, p.slot]).sort(), [[48, 1], [60, 0]],
            'the track placed alongside accompanies');
        h.played.length = 0;
        h.tickWorker.tick(48);
        assert.deepEqual(h.played.map(p => [p.midi, p.slot]).sort(), [[48, 1], [60, 0]],
            'raw tick 48 wraps into the window: bar 4 is never reached');
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

    test('play({mode}) is how the buttons name their scope — switched to and remembered', () => {
        const h = build({ tracks: [{ slot: 0, notes: [note(60, 0)] }] });
        assert.equal(h.transport.play({ mode: 'pattern' }), true);
        assert.equal(h.transport.getMode(), 'pattern');
        assert.equal(localStorage.getItem('openpatches_transport_mode'), 'pattern');
        h.transport.play({ mode: 'song' });
        assert.equal(h.transport.getMode(), 'song');
        assert.equal(h.transport.isPlaying(), true);
    });
});

// Pattern mode loops one *placement* of the edited pattern: a window of the
// song, so the other tracks accompany it. A pattern placed several times
// (several clips, or repeats) loops the placement nearest the song position.
describe('pattern mode placements', () => {
    // A second clip of track 0's pattern at `measure`, on the same track.
    function placeAgain(h, measure, repeats = 1) {
        const m = h.made[0];
        let id = null;
        h.session.update((song) => {
            id = M.addClip(song, { trackId: m.track.id, patternId: m.pattern.id, startMeasure: measure, repeats },
                (pid) => M.patternStore.get(pid)).id;
        }, 'test');
        return id;
    }

    test('the placement nearest the parked song position is the one looped', () => {
        const h = build({ tracks: [{ slot: 0, measures: 1, notes: [note(60, 0)] }], mode: 'pattern' });
        const second = placeAgain(h, 4);
        h.transport.setSongPosition(4 * 16 + 3);
        h.transport.play();
        assert.deepEqual(h.transport.getSequence().range, { startCol: 64, endCol: 80 });
        assert.equal(h.transport.getPlacement().clipId, second);
        h.transport.stop();
        h.transport.setSongPosition(10);
        h.transport.play();
        assert.deepEqual(h.transport.getSequence().range, { startCol: 0, endCol: 16 });
        assert.equal(h.transport.getPlacement().clipId, h.made[0].clip.id);
    });

    test('between two placements the closer edge wins; a tie goes to the earlier', () => {
        const h = build({ tracks: [{ slot: 0, measures: 1, notes: [note(60, 0)] }], mode: 'pattern' });
        placeAgain(h, 4);                       // 0..16 and 64..80
        h.transport.setSongPosition(50);        // 35 past the first's end, 14 before the second
        h.transport.play();
        assert.equal(h.transport.getSequence().range.startCol, 64);
        h.transport.stop();
        h.transport.setSongPosition(39);        // 24 past the first (15 is its last col), 25 before the second
        h.transport.play();
        assert.equal(h.transport.getSequence().range.startCol, 0);
    });

    test('each repeat is its own placement, one pattern long', () => {
        const h = build({ tracks: [{ slot: 0, measures: 1, notes: [note(60, 0)], repeats: 3 }], mode: 'pattern' });
        h.transport.setSongPosition(20);
        h.transport.play();
        assert.deepEqual(h.transport.getSequence().range, { startCol: 16, endCol: 32 });
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.equal(h.last().col, 16);
        assert.deepEqual(h.last().edit, { clipId: h.made[0].clip.id, patternCol: 0 }, 'placement-relative');
        h.tickWorker.tick(21);
        assert.deepEqual(h.last().edit, { clipId: h.made[0].clip.id, patternCol: 5 });
        assert.equal(h.last().songCol, 21, 'the Song tab still has a column to draw');
    });

    test('the last song column played is the anchor once the song is stopped', () => {
        const h = build({ tracks: [{ slot: 0, measures: 1, notes: [note(60, 0)], repeats: 6 }] });
        h.transport.play();
        h.tickWorker.tick(70);
        h.transport.stop();
        assert.equal(h.transport.getSongPosition(), 70);
        h.transport.play({ mode: 'pattern' });
        assert.deepEqual(h.transport.getSequence().range, { startCol: 64, endCol: 80 });
    });

    test('a pattern placed nowhere loops alone, with no song column', () => {
        const h = build({ tracks: [{ slot: 0, measures: 1, notes: [note(60, 0)] }], mode: 'pattern' });
        h.session.update((song) => { song.clips = []; }, 'test');
        h.transport.play();
        assert.equal(h.transport.getSequence().kind, 'pattern');
        assert.equal(h.transport.getPlacement(), null);
        h.tickWorker.tick(3);
        assert.equal(h.last().col, 3);
        assert.equal(h.last().songCol, -1);
        assert.deepEqual(h.last().edit, { clipId: h.made[0].clip.id, patternCol: 3 });
    });

    test('an empty pattern still plays when something inside its window has notes', () => {
        const h = build({
            tracks: [{ slot: 0, measures: 1, notes: [] }, { slot: 1, measures: 1, notes: [note(48, 0)] }],
            edit: 0, mode: 'pattern',
        });
        assert.equal(h.transport.play(), true, 'the backing alone is worth hearing');
        h.transport.stop();
        h.session.update((song) => { song.clips[1].startCol = 32; }, 'test');
        assert.equal(h.transport.play(), false, 'nothing inside the window');
    });
});

// Whether the rest of the song is heard inside the pattern window. It never
// changes the window: a take is one pattern long either way. (The user's
// report that sent this back: the two had been conflated into one toggle.)
describe('accompaniment', () => {
    function two(mode = 'pattern') {
        return build({
            tracks: [
                { slot: 0, measures: 1, notes: [note(60, 0)] },        // edited
                { slot: 1, measures: 1, notes: [note(48, 0)], repeats: 4 },
            ],
            edit: 0, mode,
        });
    }

    test('on by default, and remembered', () => {
        const h = two();
        assert.equal(h.transport.getAccompany(), true);
        h.transport.setAccompany(false);
        assert.equal(localStorage.getItem('openpatches_transport_accompany'), 'off');
        assert.equal(two().transport.getAccompany(), false, 'a fresh transport picks it up');
    });

    test('off: only the pattern being written sounds — the window is unchanged', () => {
        const h = two();
        h.transport.setAccompany(false);
        h.transport.play();
        assert.deepEqual(h.transport.getSequence().range, { startCol: 0, endCol: 16 },
            'still one pattern long');
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played.map(p => [p.midi, p.slot]), [[60, 0]]);

        h.transport.setAccompany(true);
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played.map(p => [p.midi, p.slot]).sort(), [[48, 1], [60, 0]],
            'switched mid-flight, without losing the loop');
        assert.deepEqual(h.transport.getSequence().range, { startCol: 0, endCol: 16 });
    });

    test('a take is one pattern long whether or not the song plays along', () => {
        for (const on of [true, false]) {
            localStorage.clear();
            const h = two('pattern');
            h.transport.setAccompany(on);
            h.transport.startRecording();
            assert.deepEqual(h.transport.getSequence().range, { startCol: 0, endCol: 16 }, `accompany=${on}`);
            h.tickWorker.tick(16);
            assert.equal(h.last().col, 0, `accompany=${on}: wrapped at the pattern end`);
            assert.equal(h.last().seam, true);
        }
    });

    test('with it off, an empty pattern has nothing to play even with a backing', () => {
        const h = build({
            tracks: [{ slot: 0, measures: 1, notes: [] }, { slot: 1, measures: 1, notes: [note(48, 0)] }],
            edit: 0, mode: 'pattern',
        });
        h.transport.setAccompany(false);
        assert.equal(h.transport.play(), false);
        h.transport.setAccompany(true);
        assert.equal(h.transport.play(), true);
    });

    test('song mode ignores it — the Song tab plays the arrangement', () => {
        const h = two('song');
        h.transport.setAccompany(false);
        h.transport.play();
        h.played.length = 0;
        h.tickWorker.tick(0);
        assert.deepEqual(h.played.map(p => [p.midi, p.slot]).sort(), [[48, 1], [60, 0]]);
    });

    test('the song position cannot be moved under a running transport', () => {
        const h = build({ tracks: [{ slot: 0, measures: 1, notes: [note(60, 0)] }] });
        h.transport.play();
        assert.equal(h.transport.setSongPosition(40), false);
        h.transport.stop();
        assert.equal(h.transport.setSongPosition(40), true);
        assert.equal(h.transport.getSongPosition(), 40);
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

    test('startRecording({mode}) names the scope like play — a roll take loops the placement, not the song', () => {
        const h = build({ tracks: [{ slot: 0, measures: 1, notes: [note(60, 0)], repeats: 4 }] });
        assert.equal(h.transport.getMode(), 'song');
        h.transport.startRecording({ mode: 'pattern' });
        assert.equal(h.transport.getMode(), 'pattern');
        assert.deepEqual(h.transport.getSequence().range, { startCol: 0, endCol: 16 });
        h.tickWorker.tick(16);
        assert.equal(h.last().col, 0, 'wrapped at the pattern end instead of running on to bar 4');
        assert.equal(h.last().seam, true);
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

    test('pattern mode with a placement maps through the song path — the take starts at the window', () => {
        const h = build({ tracks: [{ slot: 0, measures: 1, notes: [note(60, 0)], at: 2 }], mode: 'pattern' });
        h.transport.startRecording();
        assert.deepEqual(h.transport.getSequence().range, { startCol: 32, endCol: 48 });
        const m = h.transport.mapRecordColumn(3, 0);
        assert.equal(m.patternCol, 3);
        assert.equal(m.clipId, h.made[0].clip.id);
        assert.equal(h.transport.mapRecordColumn(19, 0).patternCol, 3, 'second pass');
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
