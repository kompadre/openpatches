// The tracker's pure layer: lanes derived from overlapping notes (stable,
// growing to what the busiest chord needs — nothing is stolen), the
// section laid out as rows, compact cells, and the tracker-style edit
// operations — which must map exactly onto the piano roll's
// {midi, start, dur} so switching views never changes data.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    createPattern, createTrack, createClip, createProject, MAX_LANES,
} from '../html/components/project-model.js';
import {
    noteName, deriveLanes, applyLanes, relane, trackLaneCount, expandTrack, compactCells, locate,
    putNote, putOff, clearCell, growBlocker, measuresFor, moveNote, clearRange, fillRange, moveBlock, copyBlock, pasteBlock, blockNotes, removeNotes,
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

    test('past four, lanes keep growing — nothing is stolen', () => {
        const notes = [N(60, 0, 16), N(62, 1, 16), N(64, 2, 16), N(65, 3, 16), N(67, 4, 4)];
        const d = deriveLanes(notes);
        assert.equal(d.lane.get(notes[4]), 4, 'a fifth sub-lane, derived on the fly');
        assert.equal(d.needed, 5);
        assert.equal(notes[0].dur, 16, 'every note keeps its full length');
    });

    test('a lane past the storable cap is not written, and derives the same again', () => {
        const notes = [N(60, 0, 16), N(62, 0, 16), N(64, 0, 16), N(65, 0, 16), N(67, 0, 16)];
        const d = deriveLanes(notes);
        applyLanes(notes, d);
        assert.equal('lane' in notes[4], false, 'lane 4 cannot be stored');
        assert.equal(deriveLanes(notes).lane.get(notes[4]), MAX_LANES, 'but it re-derives there');
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

    test('track.compact is stored only when true', () => {
        assert.equal('compact' in createTrack({}), false);
        assert.equal('compact' in createTrack({ compact: false }), false);
        assert.equal('compact' in createTrack({ compact: 'yes' }), false, 'only a real true');
        assert.equal(createTrack({ compact: true }).compact, true);
    });

    test('a round trip through createProject keeps both', () => {
        const project = createProject({
            tracks: [{ id: 't', slot: 0, compact: true }],
            patterns: { p: { id: 'p', notes: [N(60, 0, 4, 1)] } },
        });
        assert.equal(project.tracks[0].compact, true);
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

    test('a five-note moment expands to five sub-lanes', () => {
        const { project, section, track } = setup([
            N(60, 0, 16), N(62, 1, 16), N(64, 2, 16), N(65, 3, 16), N(67, 4, 2),
        ]);
        const r = expandTrack(project, section, track);
        assert.equal(r.lanes, 5, 'everything is housed; nothing stolen');
        // The clip (cols 16–32) cuts the long notes at its end; the short
        // one keeps its own. No other cut exists any more.
        assert.deepEqual(r.events.map(e => e.end), [32, 32, 32, 32, 22]);
    });

    test('the lane count follows the notes, and compact folds it to one', () => {
        const { project, section, track } = setup([N(60, 0, 4), N(64, 0, 4)]);
        assert.equal(trackLaneCount(project, section, track), 2);
        track.compact = true;
        assert.equal(trackLaneCount(project, section, track), 1);
    });

    test('compactCells: a chord is one cell, OFFs land unless a note explains them', () => {
        const { project, section, track } = setup([N(60, 0, 4), N(64, 0, 4), N(62, 4, 4)]);
        const cells = compactCells(expandTrack(project, section, track).events);
        const at = (col) => cells.get(col) || { starts: [], offs: [] };
        assert.deepEqual(at(16).starts.map(e => e.midi), [60, 64], 'the chord, lane order');
        assert.equal(at(20).starts.length, 1, 'the next note…');
        assert.deepEqual(at(20).offs.map(e => e.midi), [64],
            '…swallows the OFF in its own lane; the other lane\'s OFF still shows');
        assert.deepEqual(at(24).offs.map(e => e.midi), [62]);
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

describe('commit-time helpers', () => {
    test('relane fresh packs lanes down; plain relane keeps them', () => {
        const p = pat([N(60, 0, 4, 2), N(62, 8, 4, 3)]);
        relane(p);
        assert.deepEqual(p.notes.map(n => n.lane || 0), [2, 3], 'honoured while free');
        assert.equal(relane(p, { fresh: true }), 2);
        assert.deepEqual(p.notes.map(n => n.lane || 0), [0, 0], 'a melody needs one lane');
    });

    test('relane fresh orders a chord low to high', () => {
        const p = pat([N(67, 0, 4), N(60, 0, 4, 1)]);
        relane(p, { fresh: true });
        assert.deepEqual(p.notes.map(n => [n.midi, n.lane || 0]), [[60, 0], [67, 1]]);
    });

    test('measuresFor', () => {
        assert.equal(measuresFor(0), 1);
        assert.equal(measuresFor(15), 1);
        assert.equal(measuresFor(16), 2);
        assert.equal(measuresFor(40), 3);
    });

    test('moveNote keeps the lane and trims to fit; refuses outside', () => {
        const p = pat([N(60, 2, 8, 1)]);
        assert.equal(moveNote(p, p.notes[0], 12), true);
        assert.deepEqual(view(p), [[60, 12, 4, 1]]);
        assert.equal(moveNote(p, p.notes[0], 16), false);
        assert.equal(moveNote(p, p.notes[0], -1), false);
    });

    test('growBlocker: room below grows, a neighbour clip blocks, cut clips do not grow', () => {
        const project = createProject({
            tracks: [{ id: 't', slot: 0 }],
            patterns: { p: { id: 'p', name: 'Riff' }, q: { id: 'q', name: 'Next' } },
            sections: [{ id: 's', name: 'A', clips: [
                { id: 'c1', trackId: 't', patternId: 'p', startCol: 0, repeats: 1 },
                { id: 'c2', trackId: 't', patternId: 'q', startCol: 32, repeats: 1 },
            ] }],
        });
        assert.equal(growBlocker(project, 'p', 2), null, 'bar 2 is free');
        assert.match(growBlocker(project, 'p', 3), /run into the next clip in "A"/);
        project.sections[0].clips[0] = { id: 'c1', trackId: 't', patternId: 'p', startCol: 0, lengthCols: 16 };
        assert.equal(growBlocker(project, 'p', 8), null, 'a clip cut to a length keeps it');
    });
});

describe('fillRange / clearRange (the selection)', () => {
    const sorted = (p) => view(p).sort((a, b) => a[3] - b[3] || a[1] - b[1]);

    test('Step 4 over 12 rows: the note, three empty, the note, three empty, …', () => {
        const p = pat([]);
        fillRange(p, 0, 11, 0, 48, 4);          // C3
        assert.deepEqual(sorted(p), [[48, 0, 4, 0], [48, 4, 4, 0], [48, 8, 8, 0]],
            'each sustains to the next; the last to the end of the empty pattern');
    });

    test('the block is emptied first: notes inside it go, one sounding in is cut at the top', () => {
        const p = pat([N(60, 0, 4), N(62, 4, 2), N(64, 7, 1), N(67, 12, 4)]);
        fillRange(p, 2, 9, 0, 72, 4);
        assert.deepEqual(sorted(p), [[60, 0, 2, 0], [72, 2, 4, 0], [72, 6, 6, 0], [67, 12, 4, 0]],
            'the last fill sustains to the next note after the block');
    });

    test('other lanes are untouched; each lane of the block fills on its own', () => {
        const p = pat([N(60, 0, 16), N(64, 0, 16, 1)]);
        fillRange(p, 4, 7, 1, 50, 2);
        assert.deepEqual(sorted(p), [[60, 0, 16, 0], [64, 0, 4, 1], [50, 4, 2, 1], [50, 6, 10, 1]]);
    });

    test('Step 0 fills every row', () => {
        const p = pat([]);
        fillRange(p, 0, 2, 0, 60, 0);
        assert.deepEqual(sorted(p), [[60, 0, 1, 0], [60, 1, 1, 0], [60, 2, 14, 0]]);
    });

    test('OFF fill silences the block from its top', () => {
        const p = pat([N(60, 0, 16)]);
        fillRange(p, 4, 7, 0, null, 2);
        assert.deepEqual(sorted(p), [[60, 0, 4, 0]]);
    });

    test('clearing: what sounded in sustains through to the next event after the block', () => {
        const p = pat([N(60, 0, 4), N(62, 4, 2), N(67, 12, 4)]);   // an OFF at 6
        assert.equal(clearRange(p, 3, 8, 0), true);
        assert.deepEqual(sorted(p), [[60, 0, 12, 0], [67, 12, 4, 0]]);
    });

    test('clearing keeps an OFF that lay past the block', () => {
        const p = pat([N(60, 0, 4), N(62, 4, 6)]);                 // OFF at 10, outside 3..8
        clearRange(p, 3, 8, 0);
        assert.deepEqual(sorted(p), [[60, 0, 10, 0]]);
    });

    test('clearing leaves an OFF before the block, and a note sounding past it, alone', () => {
        const a = pat([N(60, 0, 2)]);
        assert.equal(clearRange(a, 4, 8, 0), false);
        assert.deepEqual(sorted(a), [[60, 0, 2, 0]]);
        const b = pat([N(60, 0, 12)]);
        assert.equal(clearRange(b, 4, 8, 0), false);
        assert.deepEqual(sorted(b), [[60, 0, 12, 0]]);
    });
});

describe('moveBlock (moving the selection)', () => {
    const sorted = (p) => view(p).sort((a, b) => a[3] - b[3] || a[1] - b[1]);

    test('notes starting in the block travel down with their lengths', () => {
        const p = pat([N(60, 0, 2), N(62, 2, 2), N(67, 12, 4)]);
        assert.equal(moveBlock(p, 0, 3, 0, 0, 4, 0), true);
        assert.deepEqual(sorted(p), [[60, 4, 2, 0], [62, 6, 2, 0], [67, 12, 4, 0]]);
    });

    test('the destination is overwritten; a note sounding into it is cut at its top', () => {
        const p = pat([N(60, 0, 2), N(50, 4, 3), N(52, 7, 1)]);   // one lane; block 0–1 → 6–7
        moveBlock(p, 0, 1, 0, 0, 6, 0);
        assert.deepEqual(sorted(p), [[50, 4, 2, 0], [60, 6, 2, 0]], '52 overwritten, 50 cut at row 6');
    });

    test('a moved note stops at the next note in its lane, and at the pattern end', () => {
        const a = pat([N(60, 0, 8), N(67, 10, 2)]);
        moveBlock(a, 0, 0, 0, 0, 4, 0);
        assert.deepEqual(sorted(a), [[60, 4, 6, 0], [67, 10, 2, 0]]);
        const b = pat([N(60, 0, 8)]);
        moveBlock(b, 0, 3, 0, 0, 12, 0);
        assert.deepEqual(sorted(b), [[60, 12, 4, 0]]);
    });

    test('across lanes: lane 0 into lane 1, the other lanes untouched', () => {
        const p = pat([N(60, 0, 4), N(64, 0, 16, 1)]);
        moveBlock(p, 0, 3, 0, 0, 8, 1);
        // 64 in lane 1 is cut at row 8 where the block lands; 60 lands there.
        assert.deepEqual(sorted(p), [[64, 0, 8, 1], [60, 8, 4, 1]]);
    });

    test('a note sounding into the vacated cells keeps its length; no move, no change', () => {
        const p = pat([N(60, 0, 8), N(62, 4, 2)]);
        moveBlock(p, 4, 5, 0, 0, 0, 0);
        assert.deepEqual(sorted(p), [[60, 0, 8, 0], [62, 4, 2, 0]]);
    });
});

describe('copyBlock / pasteBlock (the copy stamp)', () => {
    const sorted = (p) => view(p).sort((a, b) => a[3] - b[3] || a[1] - b[1]);

    test('a copy is the block\'s notes relative to its corner, and a snapshot', () => {
        const p = pat([N(60, 0, 2), N(62, 2, 2), N(64, 2, 4), N(67, 12, 4)]);   // 64 in lane 1
        const st = copyBlock(p, 0, 3, 0, 1);
        assert.deepEqual(st.rows, 4);
        assert.deepEqual(st.lanes, 2);
        assert.deepEqual(st.items.map(i => [i.dCol, i.dLane, i.midi, i.dur]).sort(),
            [[0, 0, 60, 2], [2, 0, 62, 2], [2, 1, 64, 4]]);
        p.notes[0].midi = 10;
        assert.equal(st.items.find(i => i.dCol === 0).midi, 60, 'later edits do not reach it');
    });

    test('pasting writes copies with their lengths and leaves the original', () => {
        const p = pat([N(60, 0, 2), N(62, 2, 2)]);
        pasteBlock(p, 8, 0, copyBlock(p, 0, 3, 0, 0));
        assert.deepEqual(sorted(p), [[60, 0, 2, 0], [62, 2, 2, 0], [60, 8, 2, 0], [62, 10, 2, 0]]);
    });

    test('the destination is overwritten and a note sounding into it cut; copies stop at the next note', () => {
        const p = pat([N(60, 0, 4), N(50, 6, 3), N(52, 9, 1), N(67, 13, 3)]);   // one lane
        pasteBlock(p, 8, 0, copyBlock(p, 0, 3, 0, 0));    // 60 (4 long) → rows 8–11
        assert.deepEqual(sorted(p), [[60, 0, 4, 0], [50, 6, 2, 0], [60, 8, 4, 0], [67, 13, 3, 0]]);
        const q = pat([N(60, 0, 8), N(67, 10, 2)]);
        pasteBlock(q, 6, 0, copyBlock(q, 0, 0, 0, 0));
        assert.deepEqual(sorted(q), [[60, 0, 6, 0], [60, 6, 4, 0], [67, 10, 2, 0]]);
    });

    test('into another pattern and another lane; past the end, copies are dropped', () => {
        const src = pat([N(60, 0, 2), N(62, 3, 1)]);
        const dst = createPattern({ id: 'p2', notes: [N(48, 0, 16)], measures: 1 });
        const made = pasteBlock(dst, 14, 1, copyBlock(src, 0, 3, 0, 0));
        assert.equal(made.length, 1, '62 would land on row 17: dropped');
        assert.deepEqual(sorted(dst), [[48, 0, 16, 0], [60, 14, 2, 1]]);
    });
});

describe('blockNotes / removeNotes (the cut)', () => {
    test('a block\'s notes are the pattern\'s own objects, by lane and start', () => {
        const p = pat([N(60, 0, 2), N(62, 2, 2), N(64, 2, 4), N(67, 12, 4)]);   // 64 in lane 1
        const got = blockNotes(p, 0, 3, 0, 0);
        assert.deepEqual(got.map(n => n.midi), [60, 62]);
        assert.ok(got.every(n => p.notes.includes(n)), 'the same objects, not copies');
    });

    test('removeNotes takes them out in place and skips ones already gone', () => {
        const p = pat([N(60, 0, 2), N(62, 2, 2), N(67, 12, 4)]);
        const arr = p.notes;
        const got = blockNotes(p, 0, 3, 0, 0);
        p.notes.splice(p.notes.indexOf(got[1]), 1);        // 62 went some other way
        assert.equal(removeNotes(p, got), 1);
        assert.equal(p.notes, arr, 'the same array: the roll holds it');
        assert.deepEqual(view(p), [[67, 12, 4, 0]]);
    });
});
