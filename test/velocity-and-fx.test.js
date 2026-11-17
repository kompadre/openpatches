// Velocity on notes and effects commands on sections — the model side of
// the Tracker's new columns (TODO.md › Tracker: velocity and effects
// columns), and velocity carried through to playback.
//
// Pure model + collab + sequencer; the view's editing is in
// tracker-view.test.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    createPattern, createSection, addTrack, addPattern, addClip, createProject,
    sectionFx, fxAt, setSectionFx, DEFAULT_VELOCITY,
} from '../html/components/project-model.js';
import { setVelocity, copyBlock, pasteBlock } from '../html/components/tracker-model.js';
import { readAtoms, readAtom, applyOps, noteKey, stable } from '../html/components/collab-ops.js';
import { createSectionSequence } from '../html/synth/section-sequencer.js';

describe('velocity on the note', () => {
    test('normalizeNote keeps a velocity in range, clamps one out of it, and omits the default', () => {
        const p = createPattern({ notes: [
            { midi: 60, start: 0, dur: 2, vel: 90 },
            { midi: 62, start: 2, dur: 2, vel: 900 },
            { midi: 64, start: 4, dur: 2, vel: -3 },
            { midi: 65, start: 6, dur: 2 },
        ] });
        assert.equal(p.notes[0].vel, 90);
        assert.equal(p.notes[1].vel, 127, 'clamped high');
        assert.equal(p.notes[2].vel, 1, 'clamped low');
        assert.equal('vel' in p.notes[3], false, 'the default is not stored');
    });

    test('setVelocity sets, clamps and clears; it refuses a cell with no note start', () => {
        const p = createPattern({ notes: [{ midi: 60, start: 0, dur: 4 }] });
        assert.equal(setVelocity(p, 0, 0, 80).vel, 80);
        assert.equal(setVelocity(p, 0, 0, 500).vel, 127);
        assert.equal('vel' in setVelocity(p, 0, 0, null), false, 'cleared back to the default');
        assert.equal(setVelocity(p, 2, 0, 80), null, 'the note sounds at 2 but does not start there');
        assert.equal(setVelocity(p, 0, 1, 80), null, 'no note in that lane');
    });

    test('copy and paste carry the velocity with the note', () => {
        const p = createPattern({ notes: [{ midi: 60, start: 0, dur: 2, vel: 33 }, { midi: 62, start: 2, dur: 2 }] });
        const block = copyBlock(p, 0, 3, 0, 0);
        pasteBlock(p, 4, 0, block);
        const pasted = p.notes.filter(n => n.start >= 4);
        assert.equal(pasted.find(n => n.midi === 60).vel, 33);
        assert.equal('vel' in pasted.find(n => n.midi === 62), false);
    });
});

describe('velocity over collab', () => {
    test('the note atom is bare dur without a velocity, {dur, vel} with one', () => {
        const p = createPattern({ id: 'pat1', notes: [
            { midi: 60, start: 0, dur: 2 },
            { midi: 62, start: 2, dur: 3, vel: 55 },
        ] });
        const body = { patterns: { pat1: p } };
        const atoms = readAtoms(body);
        assert.equal(atoms.get('pattern/pat1/note/' + noteKey(p.notes[0])), '2');
        assert.equal(atoms.get('pattern/pat1/note/' + noteKey(p.notes[1])), stable({ dur: 3, vel: 55 }));
        assert.equal(readAtom(body, 'pattern/pat1/note/2:62'), stable({ dur: 3, vel: 55 }));
    });

    test('applying a note op sets, updates and clears the velocity', () => {
        const body = { patterns: { pat1: createPattern({ id: 'pat1' }) } };
        applyOps(body, [{ atom: 'pattern/pat1/note/0:60', before: null, after: stable({ dur: 2, vel: 70 }) }]);
        assert.deepEqual(body.patterns.pat1.notes[0], { midi: 60, start: 0, dur: 2, vel: 70 });
        applyOps(body, [{ atom: 'pattern/pat1/note/0:60', before: null, after: '4' }]);
        assert.deepEqual(body.patterns.pat1.notes[0], { midi: 60, start: 0, dur: 4 },
            'a bare dur clears the velocity: the atom is the whole note value');
        applyOps(body, [{ atom: 'pattern/pat1/note/0:60', before: null, after: stable({ dur: 4, vel: 9999 }) }]);
        assert.equal('vel' in body.patterns.pat1.notes[0], false, 'a malformed velocity is dropped, not stored');
    });
});

describe('section effects', () => {
    test('createSection always carries fx, normalised: sorted, one per row, letters and args in range', () => {
        const s = createSection({ fx: {
            t1: [
                { row: 10, cmd: 'B', arg: 4 },
                { row: 2, cmd: 'J', arg: 5000 },
                { row: 10, cmd: 'F', arg: 1 },      // same row: the later one wins
                { row: 3, cmd: 'bad', arg: 1 },     // not a single letter: dropped
            ],
            t2: 'nonsense',
        } });
        assert.deepEqual(s.fx, { t1: [{ row: 2, cmd: 'J', arg: 999 }, { row: 10, cmd: 'F', arg: 1 }] });
        assert.deepEqual(createSection({}).fx, {}, 'present even when empty');
    });

    test('setSectionFx puts, replaces and clears a row; sectionFx and fxAt read it back', () => {
        const s = createSection({});
        setSectionFx(s, 't1', 8, { cmd: 'B', arg: 10 });
        setSectionFx(s, 't1', 2, { cmd: 'J', arg: 0 });
        assert.deepEqual(sectionFx(s, 't1').map(e => e.row), [2, 8], 'sorted by row');
        assert.deepEqual(fxAt(s, 't1', 8), { row: 8, cmd: 'B', arg: 10 });
        setSectionFx(s, 't1', 8, { cmd: 'B', arg: 12 });
        assert.equal(fxAt(s, 't1', 8).arg, 12);
        setSectionFx(s, 't1', 8, null);
        assert.equal(fxAt(s, 't1', 8), null);
        setSectionFx(s, 't1', 2, null);
        assert.deepEqual(s.fx, {}, 'an emptied track leaves no residue');
    });

    test('fx travels over collab as a section field and survives the factory pass', () => {
        const s = createSection({ id: 'sec1' });
        setSectionFx(s, 't1', 4, { cmd: 'B', arg: 10 });
        const atoms = readAtoms({ sections: [s] });
        const text = atoms.get('section/sec1/fx');
        assert.equal(text, stable({ t1: [{ row: 4, cmd: 'B', arg: 10 }] }));
        const body = { sections: [createSection({ id: 'sec1' })] };
        applyOps(body, [{ atom: 'section/sec1/fx', before: null, after: text }]);
        assert.deepEqual(body.sections[0].fx, { t1: [{ row: 4, cmd: 'B', arg: 10 }] },
            'applied, and not deleted by the section factory refill');
    });
});

describe('humanize on the track', () => {
    test('humanizeOf clamps to 0–1 and is null when off; createTrack stores it only when on', async () => {
        const { humanizeOf, createTrack } = await import('../html/components/project-model.js');
        assert.deepEqual(humanizeOf({ timing: 2, velocity: -1 }), { timing: 1, velocity: 0 });
        assert.equal(humanizeOf({ timing: 0, velocity: 0 }), null);
        assert.equal(humanizeOf('nonsense'), null);
        assert.equal('humanize' in createTrack({}), false);
        assert.deepEqual(createTrack({ humanize: { timing: 0.5, velocity: 0.25 } }).humanize, { timing: 0.5, velocity: 0.25 });
    });
});

describe('velocity reaches playback', () => {
    test('eventsAt carries the note velocity; notes without one carry none (the player defaults)', () => {
        const project = createProject({ name: 'P' });
        addTrack(project, { name: 'T1' });
        const section = project.sections[0];
        const pattern = addPattern(project, { name: 'A', measures: 1, notes: [
            { midi: 60, start: 0, dur: 4, vel: 42 },
            { midi: 64, start: 4, dur: 4 },
        ] });
        addClip(project, section, { trackId: project.tracks[0].id, patternId: pattern.id, startCol: 0 });
        const seq = createSectionSequence(project, section);
        assert.equal(seq.eventsAt(0)[0].vel, 42);
        assert.equal(seq.eventsAt(4)[0].vel, undefined);
        assert.equal(DEFAULT_VELOCITY, 100, 'the chain defaults to 100 where vel is absent');
    });
});
