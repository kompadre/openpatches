// The tracker's pure layer: lanes derived from overlapping notes (stable,
// with stealing past four), the section laid out as rows, and the
// tracker-style edit operations — which must map exactly onto the piano
// roll's {midi, start, dur} so switching views never changes data.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    createPattern, createTrack, createClip, createProject, MAX_LANES,
} from '../html/components/project-model.js';
import {
    noteName, deriveLanes, applyLanes, relane, trackLaneCount, expandTrack, locate,
    putNote, putOff, clearCell,
} from '../html/components/tracker-model.js';

const N = (midi, start, dur, lane) => (lane == null ? { midi, start, dur } : { midi, start, dur, lane });
const lanesOf = (notes) => { const d = deriveLanes(notes); return notes.map(n => d.lane.get(n)); };
const pat = (notes, measures = 1) => createPattern({ id: 'p1', notes, measures });
const view = (p) => p.notes.map(n => [n.midi, n.start, n.dur, n.lane || 0]);

describe('noteName', () => {
    test('tracker spelling, middle C is C-4', () => {
        assert.equal(noteName(60), 'C-4');
        assert.equal(noteName(61), 'C#4');
        assert.equal(noteName(69), 'A-4');
        assert.equal(noteName(0), 'C--1');
        assert.equal(noteName(200), '???');
    });
});

describe('deriveLanes', () => {
    test('a melody needs one lane', () => {
        const notes = [N(60, 0, 4), N(62, 4, 4), N(64, 8, 4)];
        assert.deepEqual(lanesOf(notes), [0, 0, 0]);
        assert.equal(deriveLanes(notes).needed, 1);
    });

    test('a chord spreads low to high', () => {
        const notes = [N(67, 0, 8), N(60, 0, 8), N(64, 0, 8)];
        assert.deepEqual(lanesOf(notes), [2, 0, 1]);
        assert.equal(deriveLanes(notes).needed, 3);
    });

    test('a lane is reused once its note has ended', () => {
        const notes = [N(60, 0, 4), N(64, 2, 4), N(67, 4, 4)];
        assert.deepEqual(lanesOf(notes), [0, 1, 0]);
    });

    test('a stored lane is honoured while free — notes do not hop', () => {
        const notes = [N(60, 0, 8, 2), N(64, 0, 8)];
        assert.deepEqual(lanesOf(notes), [2, 0]);
    });

    test('a stored lane that is taken gives way to the earlier note', () => {
        const notes = [N(60, 0, 8, 1), N(64, 2, 8, 1)];
        assert.deepEqual(lanesOf(notes), [1, 0]);
    });

    test('past four, the oldest sounding note is stolen and marked', () => {
        const notes = [N(60, 0, 16), N(62, 1, 16), N(64, 2, 16), N(65, 3, 16), N(67, 4, 4)];
        const d = deriveLanes(notes);
        assert.equal(d.lane.get(notes[4]), 0, 'takes the oldest one\'s lane');
        assert.equal(d.stolenAt.get(notes[0]), 4, 'cut where the new note starts');
        assert.equal(d.stolenAt.size, 1);
        assert.equal(d.needed, MAX_LANES);
        assert.equal(notes[0].dur, 16, 'the model keeps the full length');
    });

    test('applyLanes stores lanes, omitting 0, and reports changes', () => {
        const notes = [N(60, 0, 8), N(64, 0, 8)];
        assert.equal(applyLanes(notes, deriveLanes(notes)), 1);
        assert.equal('lane' in notes[0], false, 'lane 0 is not written');
        assert.equal(notes[1].lane, 1);
        assert.equal(applyLanes(notes, deriveLanes(notes)), 0, 'stable');
    });

    test('relane drops a lane that is no longer needed', () => {
        const p = pat([N(60, 0, 4, 3)]);
        assert.equal(p.notes[0].lane, 3);
        relane(p);
        assert.equal(p.notes[0].lane, 3, 'still free, so still honoured');
        const q = pat([N(60, 0, 4, 2), N(62, 0, 4, 2)]);
        relane(q);
        assert.deepEqual(q.notes.map(n => n.lane || 0).sort(), [0, 2]);
    });
});

describe('the project model keeps lanes, packed', () => {
    test('note.lane survives normalisation, 0 and junk are dropped', () => {
        const p = createPattern({ notes: [N(60, 0, 1, 2), N(62, 1, 1, 0), N(64, 2, 1, 9), N(65, 3, 1, 'x')] });
        assert.deepEqual(p.notes.map(n => n.lane), [2, undefined, undefined, undefined]);
        assert.deepEqual(Object.keys(p.notes[1]), ['midi', 'start', 'dur']);
    });

    test('track.lanes is stored only when more than one', () => {
        assert.equal('lanes' in createTrack({}), false);
        assert.equal('lanes' in createTrack({ lanes: 1 }), false);
        assert.equal(createTrack({ lanes: 3 }).lanes, 3);
        assert.equal(createTrack({ lanes: 9 }).lanes, MAX_LANES);
    });

    test('a round trip through createProject keeps both', () => {
        const project = createProject({
            tracks: [{ id: 't', slot: 0, lanes: 2 }],
            patterns: { p: { id: 'p', notes: [N(60, 0, 4, 1)] } },
        });
        assert.equal(project.tracks[0].lanes, 2);
        assert.equal(project.patterns.p.notes[0].lane, 1);
    });
});

describe('expandTrack: the section as rows', () => {
    function setup(notes, clipOpts = {}, measures = 1) {
        const pattern = createPattern({ id: 'p', name: 'Riff', notes, measures });
        const track = createTrack({ id: 't', slot: 0 });
        const clip = createClip({ id: 'c', trackId: 't', patternId: 'p', startCol: 16, ...clipOpts });
        const project = { tracks: [track], patterns: { p: pattern } };
        const section = { clips: [clip] };
        return { project, section, track, pattern, clip };
    }

    test('clip blocks and notes at absolute columns', () => {
        const { project, section, track } = setup([N(60, 0, 4)]);
        const r = expandTrack(project, section, track);
        assert.deepEqual(r.blocks.map(b => [b.startCol, b.endCol, b.pattern.name]), [[16, 32, 'Riff']]);
        assert.deepEqual(r.events.map(e => [e.col, e.end, e.off]), [[16, 20, true]]);
        assert.equal(r.lanes, 1);
    });

    test('repeats show every pass of the pattern', () => {
        const { project, section, track } = setup([N(60, 2, 2)], { repeats: 3 });
        assert.deepEqual(expandTrack(project, section, track).events.map(e => e.col), [18, 34, 50]);
    });

    test('a cut-short clip cuts its notes, without an OFF', () => {
        const { project, section, track } = setup([N(60, 4, 8)], { lengthCols: 8 });
        const [e] = expandTrack(project, section, track).events;
        assert.deepEqual([e.col, e.end, e.off], [20, 24, false]);
    });

    test('no OFF at the pattern end, nor before a legato note', () => {
        const { project, section, track } = setup([N(60, 0, 4), N(62, 4, 12)]);
        assert.deepEqual(expandTrack(project, section, track).events.map(e => e.off), [false, false]);
    });

    test('a stolen note is marked, cut at the steal, and has no OFF', () => {
        const { project, section, track } = setup([
            N(60, 0, 16), N(62, 1, 16), N(64, 2, 16), N(65, 3, 16), N(67, 4, 2),
        ]);
        const r = expandTrack(project, section, track);
        const stolen = r.events.filter(e => e.stolen);
        assert.equal(stolen.length, 1);
        assert.deepEqual([stolen[0].midi, stolen[0].end, stolen[0].off], [60, 20, false]);
        assert.equal(r.lanes, MAX_LANES);
    });

    test('the lane count is the stored one, widened to the notes', () => {
        const { project, section, track } = setup([N(60, 0, 4), N(64, 0, 4)]);
        assert.equal(trackLaneCount(project, section, track), 2);
        track.lanes = 3;
        assert.equal(trackLaneCount(project, section, track), 3, 'room to type into');
    });

    test('locate maps a row into the clip\'s pattern, repeats included', () => {
        const { project, section, track } = setup([], { repeats: 2 });
        assert.equal(locate(project, section, track, 15), null);
        assert.equal(locate(project, section, track, 20).patternCol, 4);
        assert.equal(locate(project, section, track, 36).patternCol, 4, 'second pass');
        assert.equal(locate(project, section, track, 48), null);
    });
});

describe('editing, tracker-style', () => {
    test('a note over silence holds until the next note in the lane', () => {
        const p = pat([N(60, 8, 4)]);
        putNote(p, 2, 0, 64);
        assert.deepEqual(view(p), [[64, 2, 6, 0], [60, 8, 4, 0]]);
    });

    test('a note over silence at the end holds to the pattern end', () => {
        const p = pat([]);
        putNote(p, 12, 0, 64);
        assert.deepEqual(view(p), [[64, 12, 4, 0]]);
    });

    test('a note inside a held one cuts it and inherits its OFF', () => {
        const p = pat([N(60, 0, 10)]);
        putNote(p, 4, 0, 67);
        assert.deepEqual(view(p), [[60, 0, 4, 0], [67, 4, 6, 0]]);
    });

    test('typing over a note changes its pitch only', () => {
        const p = pat([N(60, 0, 10)]);
        putNote(p, 0, 0, 72);
        assert.deepEqual(view(p), [[72, 0, 10, 0]]);
    });

    test('a note in another lane leaves the first lane alone, and stores its lane', () => {
        const p = pat([N(60, 0, 16)]);
        putNote(p, 4, 1, 64);
        assert.deepEqual(view(p), [[60, 0, 16, 0], [64, 4, 12, 1]]);
    });

    test('OFF cuts the sounding note; over silence it is refused', () => {
        const p = pat([N(60, 0, 16)]);
        assert.equal(putOff(p, 6, 0), true);
        assert.deepEqual(view(p), [[60, 0, 6, 0]]);
        assert.equal(putOff(p, 10, 0), false);
        assert.deepEqual(view(p), [[60, 0, 6, 0]]);
    });

    test('OFF on a note start removes that note', () => {
        const p = pat([N(60, 0, 4), N(62, 4, 4)]);
        putOff(p, 4, 0);
        assert.deepEqual(view(p), [[60, 0, 4, 0]]);
    });

    test('clearing a note gives its time back to the note it cut', () => {
        const p = pat([N(60, 0, 10)]);
        putNote(p, 4, 0, 67);
        assert.equal(clearCell(p, 4, 0), 'note');
        assert.deepEqual(view(p), [[60, 0, 10, 0]], 'exactly the original');
    });

    test('clearing an OFF lets the note hold on to the next one', () => {
        const p = pat([N(60, 0, 4), N(62, 8, 4)]);
        assert.equal(clearCell(p, 4, 0), 'off');
        assert.deepEqual(view(p), [[60, 0, 8, 0], [62, 8, 4, 0]]);
    });

    test('clearing an empty cell does nothing', () => {
        const p = pat([N(60, 0, 4)]);
        assert.equal(clearCell(p, 8, 0), null);
        assert.equal(clearCell(p, 0, 1), null, 'another lane');
        assert.deepEqual(view(p), [[60, 0, 4, 0]]);
    });

    test('edits freeze the view first, so a chord keeps its lanes', () => {
        const p = pat([N(60, 0, 8), N(64, 0, 8), N(67, 0, 8)]);
        putOff(p, 4, 1);
        assert.deepEqual(view(p), [[60, 0, 8, 0], [64, 0, 4, 1], [67, 0, 8, 2]]);
    });
});
