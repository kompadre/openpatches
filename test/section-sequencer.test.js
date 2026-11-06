// The section sequencer: a Section of a Project compiled into "what starts
// at column N, on which slot".
//
// Pure, so no browser env. The behaviours worth pinning are the ones a tick
// depends on: patterns are snapshotted but mute/solo is live, a clip cut
// short takes its notes with it, and the loop range is whole bars even when
// the clips are not.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    createSectionSequence, createPatternSequence, patternPlacements,
    nearestPlacement, playbackRange, wrapToRange, audibleTrackIds, msPerColumn,
} from '../html/synth/section-sequencer.js';
import {
    createProject, addTrack, addPattern, addClip, addSection, COLS_PER_MEASURE,
} from '../html/components/project-model.js';

/** A project with `tracks` tracks and one 1-bar pattern of a single note. */
function build({ tracks = 2, measures = 1, notes } = {}) {
    const project = createProject({ name: 'Piece' });
    for (let i = 0; i < tracks; i++) addTrack(project, { name: `T${i + 1}` });
    const pattern = addPattern(project, {
        name: 'A',
        measures,
        notes: notes || [{ midi: 60, start: 0, dur: 4 }],
    });
    return { project, pattern, section: project.sections[0] };
}

function place(project, section, trackIdx, pattern, startCol, extra = {}) {
    return addClip(project, section, {
        trackId: project.tracks[trackIdx].id,
        patternId: pattern.id,
        startCol,
        ...extra,
    });
}

describe('compiling a section', () => {
    test('a note sounds at the clip start, on the track\'s slot', () => {
        const { project, pattern, section } = build();
        place(project, section, 1, pattern, 16);
        const seq = createSectionSequence(project, section);

        assert.deepEqual(seq.eventsAt(0), []);
        const events = seq.eventsAt(16);
        assert.equal(events.length, 1);
        assert.equal(events[0].midi, 60);
        assert.equal(events[0].slot, 1, 'the slot is the channel');
        assert.equal(events[0].trackId, project.tracks[1].id);
    });

    test('the sequence is a section, and its length is the furthest clip end', () => {
        const { project, pattern, section } = build();
        place(project, section, 0, pattern, 0);
        place(project, section, 1, pattern, 48);
        const seq = createSectionSequence(project, section);
        assert.equal(seq.kind, 'section');
        assert.equal(seq.length, 64);
    });

    test('an empty section has no range, so the transport refuses to start', () => {
        const { project, section } = build();
        assert.equal(createSectionSequence(project, section).range, null);
    });

    test('a clip cut short takes its notes with it', () => {
        const { project, pattern, section } = build({
            notes: [{ midi: 60, start: 0, dur: 16 }],
        });
        place(project, section, 0, pattern, 0, { lengthCols: 4 });
        const seq = createSectionSequence(project, section);
        assert.equal(seq.eventsAt(0)[0].dur, 4, 'cut at the clip end, not the note end');
    });

    test('a repeated clip sounds its pattern once per repeat', () => {
        const { project, pattern, section } = build();
        place(project, section, 0, pattern, 0, { repeats: 3 });
        const seq = createSectionSequence(project, section);
        for (const col of [0, 16, 32]) {
            assert.equal(seq.eventsAt(col).length, 1, `repeat at ${col}`);
        }
        assert.deepEqual(seq.eventsAt(48), []);
    });

    test('the range runs to the end of the bar, not the end of the clip', () => {
        // A clip cut to one beat would otherwise loop the section every beat.
        const { project, pattern, section } = build();
        place(project, section, 0, pattern, 0, { lengthCols: 4 });
        const seq = createSectionSequence(project, section);
        assert.equal(seq.range.endCol, COLS_PER_MEASURE);
    });

    test('a loop range overrides the section length', () => {
        const { project, pattern, section } = build();
        place(project, section, 0, pattern, 0, { repeats: 4 });
        section.loop = { start: 1, end: 3 };
        const seq = createSectionSequence(project, section);
        assert.deepEqual(seq.range, { startCol: 16, endCol: 48 });
    });

    test('an explicit range beats both — that is pattern mode', () => {
        const { project, pattern, section } = build();
        place(project, section, 0, pattern, 0, { repeats: 4 });
        const seq = createSectionSequence(project, section, {
            range: { startCol: 32, endCol: 48 },
        });
        assert.deepEqual(seq.range, { startCol: 32, endCol: 48 });
        assert.equal(seq.columnForTick(0), 32);
        assert.equal(seq.columnForTick(16), 32, 'wrapped');
    });

    test('onlyTrackId silences the rest — the roll recording alone', () => {
        const { project, pattern, section } = build();
        place(project, section, 0, pattern, 0);
        place(project, section, 1, pattern, 0);
        const seq = createSectionSequence(project, section, {
            onlyTrackId: project.tracks[0].id,
        });
        const events = seq.eventsAt(0);
        assert.equal(events.length, 1);
        assert.equal(events[0].trackId, project.tracks[0].id);
    });
});

describe('snapshot vs live', () => {
    test('patterns are snapshotted — a tick must never read a store', () => {
        const { project, pattern, section } = build();
        place(project, section, 0, pattern, 0);
        const seq = createSectionSequence(project, section);

        pattern.notes.push({ midi: 72, start: 8, dur: 1 });
        assert.deepEqual(seq.eventsAt(8), [], 'the edit needs a rebuild');
        assert.equal(createSectionSequence(project, section).eventsAt(8).length, 1);
    });

    test('mute is live — toggling it lands on the next column, no rebuild', () => {
        const { project, pattern, section } = build();
        place(project, section, 0, pattern, 0);
        const seq = createSectionSequence(project, section);
        assert.equal(seq.eventsAt(0).length, 1);

        project.tracks[0].mute = true;
        assert.deepEqual(seq.eventsAt(0), [], 'silenced without recompiling');

        project.tracks[0].mute = false;
        assert.equal(seq.eventsAt(0).length, 1);
    });

    test('solo is live too, and silences the others', () => {
        const { project, pattern, section } = build();
        place(project, section, 0, pattern, 0);
        place(project, section, 1, pattern, 0);
        const seq = createSectionSequence(project, section);
        assert.equal(seq.eventsAt(0).length, 2);

        project.tracks[1].solo = true;
        const events = seq.eventsAt(0);
        assert.equal(events.length, 1);
        assert.equal(events[0].trackId, project.tracks[1].id);
    });

    test('audibleTrackIds is the same rule the mixer uses', () => {
        const { project } = build({ tracks: 3 });
        project.tracks[0].mute = true;
        assert.deepEqual(
            [...audibleTrackIds(project.tracks)],
            [project.tracks[1].id, project.tracks[2].id],
        );
    });
});

describe('the playhead', () => {
    test('locate reports the pattern-local column per track', () => {
        const { project, pattern, section } = build({ measures: 2 });
        place(project, section, 1, pattern, 8);
        const seq = createSectionSequence(project, section);

        const at = seq.locate(12);
        assert.equal(at.measure, 0);
        assert.equal(at.colInMeasure, 12);
        assert.equal(at.tracks[project.tracks[1].id].patternCol, 4);
        assert.equal(at.tracks[project.tracks[0].id], undefined, 'no clip there');
    });

    test('a muted track still gets a playhead — it moves, it just does not sound', () => {
        const { project, pattern, section } = build();
        place(project, section, 0, pattern, 0);
        project.tracks[0].mute = true;
        const seq = createSectionSequence(project, section);
        assert.ok(seq.locate(0).tracks[project.tracks[0].id]);
        assert.deepEqual(seq.eventsAt(0), []);
    });
});

describe('placements', () => {
    test('one entry per repeat, sorted by start', () => {
        const { project, pattern, section } = build();
        place(project, section, 0, pattern, 32);
        place(project, section, 1, pattern, 0, { repeats: 2 });

        const places = patternPlacements(project, section, pattern.id);
        assert.deepEqual(places.map(p => p.startCol), [0, 16, 32]);
    });

    test('a clip ending mid-repeat gives a short last placement', () => {
        const { project, pattern, section } = build();
        place(project, section, 0, pattern, 0, { lengthCols: 24 });
        const places = patternPlacements(project, section, pattern.id);
        assert.deepEqual(places.map(p => [p.startCol, p.endCol]), [[0, 16], [16, 24]]);
    });

    test('a pattern placed nowhere has no placements', () => {
        const { project, section } = build();
        const unused = addPattern(project, { name: 'Unused' });
        assert.deepEqual(patternPlacements(project, section, unused.id), []);
        assert.deepEqual(patternPlacements(project, section, 'ghost'), []);
    });

    test('placements are per section, not per project', () => {
        const { project, pattern, section } = build();
        place(project, section, 0, pattern, 0);
        const other = addSection(project);
        assert.equal(patternPlacements(project, section, pattern.id).length, 1);
        assert.deepEqual(patternPlacements(project, other, pattern.id), []);
    });

    test('nearestPlacement: inside wins, then the closest edge, ties earliest', () => {
        const places = [
            { startCol: 0, endCol: 16 },
            { startCol: 32, endCol: 48 },
        ];
        assert.equal(nearestPlacement(places, 8).startCol, 0, 'inside');
        assert.equal(nearestPlacement(places, 40).startCol, 32, 'inside the second');
        assert.equal(nearestPlacement(places, 30).startCol, 32, 'closer to the second');
        assert.equal(nearestPlacement(places, 64).startCol, 32, 'past the end');
        assert.equal(nearestPlacement(places, -1).startCol, 0, 'no position yet');
        assert.equal(nearestPlacement([], 0), null);
    });
});

describe('ranges and wrapping', () => {
    test('playbackRange prefers the loop, falls back to the length', () => {
        assert.deepEqual(playbackRange({ loop: { start: 1, end: 3 } }, 999),
            { startCol: 16, endCol: 48 });
        assert.deepEqual(playbackRange({ loop: null }, 32), { startCol: 0, endCol: 32 });
        assert.equal(playbackRange({ loop: null }, 0), null, 'nothing to play');
    });

    test('wrapToRange keeps the worker count inside the loop', () => {
        const range = { startCol: 16, endCol: 32 };
        assert.equal(wrapToRange(0, range), 16);
        assert.equal(wrapToRange(15, range), 31);
        assert.equal(wrapToRange(16, range), 16, 'wrapped round');
        assert.equal(wrapToRange(33, range), 17);
    });
});

describe('a lone pattern', () => {
    test('loops one pattern on one slot', () => {
        const pattern = {
            id: 'p1', measures: 1,
            notes: [{ midi: 60, start: 0, dur: 2 }, { midi: 64, start: 8, dur: 2 }],
        };
        const seq = createPatternSequence(pattern, 3);
        assert.equal(seq.kind, 'pattern');
        assert.deepEqual(seq.range, { startCol: 0, endCol: 16 });
        assert.equal(seq.eventsAt(0)[0].slot, 3);
        assert.equal(seq.eventsAt(8)[0].midi, 64);
        assert.equal(seq.columnForTick(20), 4, 'wrapped');
    });

    test('the pattern is read live — the editor is mutating it', () => {
        const pattern = { id: 'p1', measures: 1, notes: [] };
        const seq = createPatternSequence(pattern, 0);
        pattern.notes.push({ midi: 60, start: 4, dur: 1 });
        assert.equal(seq.eventsAt(4).length, 1, 'no rebuild needed');

        pattern.measures = 2;
        assert.equal(seq.range.endCol, 32, 'the length follows too');
    });

    test('no pattern is an empty sequence, not a crash', () => {
        const seq = createPatternSequence(null, 0);
        assert.equal(seq.range, null);
        assert.deepEqual(seq.eventsAt(0), []);
    });
});

describe('msPerColumn', () => {
    test('a sixteenth at 120 BPM is 125 ms', () => {
        assert.equal(msPerColumn(120), 125);
        assert.equal(msPerColumn(60), 250);
    });
});

describe('the piece sequence', () => {
    test('plays the sections in order, each in its own columns, and names where it is', async () => {
        const M = await import('../html/components/project-model.js');
        const { createPieceSequence } = await import('../html/synth/section-sequencer.js');
        const p = M.createProject({ name: 'P' });
        const a = M.createPattern({ name: 'A', measures: 1, notes: [{ midi: 60, start: 0, dur: 1 }] });
        const b = M.createPattern({ name: 'B', measures: 1, notes: [{ midi: 72, start: 4, dur: 1 }] });
        p.patterns[a.id] = a; p.patterns[b.id] = b;
        const t = M.createTrack({ slot: 0 }); p.tracks.push(t);
        M.addClip(p, p.sections[0], { trackId: t.id, patternId: a.id, startCol: 0 });
        p.sections[0].loop = { start: 0, end: 1 };                 // a section's loop is ignored by the piece
        const s2 = M.addSection(p, { name: 'Two' });
        M.addClip(p, s2, { trackId: t.id, patternId: b.id, startCol: 16 });   // bar 2 of section 2 → piece bar 3
        const seq = createPieceSequence(p);
        assert.equal(seq.kind, 'piece');
        assert.deepEqual(seq.range, { startCol: 0, endCol: 48 });
        assert.deepEqual(seq.eventsAt(0).map(e => e.midi), [60]);
        assert.deepEqual(seq.eventsAt(16), [], 'section 2, bar 1: nothing');
        assert.deepEqual(seq.eventsAt(36).map(e => e.midi), [72], 'section 2, bar 2, beat 2');
        assert.deepEqual([seq.localize(0).sectionId, seq.localize(40).sectionId], [p.sections[0].id, s2.id]);
        assert.equal(seq.localize(40).col, 24);
        assert.equal(seq.locate(36).tracks[t.id].patternCol, 4);
        assert.equal(seq.columnForTick(49), 1, 'wraps round the whole piece');
    });

    test('an empty project has nothing to play', async () => {
        const M = await import('../html/components/project-model.js');
        const { createPieceSequence } = await import('../html/synth/section-sequencer.js');
        assert.equal(createPieceSequence(M.createProject({ name: 'P' })).range, null);
    });
});
