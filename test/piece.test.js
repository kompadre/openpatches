// The piece: `project.arrangement`, the order sections play in, apart from
// the library of sections (`project.sections`). A section can be placed any
// number of times — a chorus — or not at all. Model, sequencer, export and
// collab: everything that reads the play order.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as M from '../html/components/project-model.js';
import { createPieceSequence } from '../html/synth/section-sequencer.js';
import { exportProject, importProject } from '../html/components/project-io.js';
import { readAtoms, diffGroups, applyOps, checkInvariants } from '../html/components/collab-ops.js';

const {
    createProject, createPattern, createTrack, addClip, addSection, removeSection, duplicateSection,
    moveSection, placeSection, moveEntry, removeEntry, copyEntry, sectionUsage, pieceLayout,
    normalizeProject, SCHEMA_VERSION, SECTION_COLORS,
} = M;

/** Verse (1 bar, note 60) and Chorus (2 bars, note 72), placed once each. */
function song() {
    const p = createProject({ name: 'Song' });
    const v = createPattern({ name: 'V', measures: 1, notes: [{ midi: 60, start: 0, dur: 1 }] });
    const c = createPattern({ name: 'C', measures: 2, notes: [{ midi: 72, start: 0, dur: 1 }] });
    p.patterns[v.id] = v; p.patterns[c.id] = c;
    const t = createTrack({ slot: 0 }); p.tracks.push(t);
    const verse = p.sections[0];
    verse.name = 'Verse';
    addClip(p, verse, { trackId: t.id, patternId: v.id, startCol: 0 });
    const chorus = addSection(p, { name: 'Chorus' });
    addClip(p, chorus, { trackId: t.id, patternId: c.id, startCol: 0 });
    return { p, verse, chorus, t };
}

const order = (p) => pieceLayout(p).parts.map(x => x.section.name);

describe('the arrangement', () => {
    test('a new project has one section, placed once', () => {
        const p = createProject();
        assert.equal(p.arrangement.length, 1);
        assert.equal(p.arrangement[0].sectionId, p.sections[0].id);
        assert.match(p.arrangement[0].id, /^ent_/);
    });

    test('a schema-1 project (no arrangement) plays every section once, in order', () => {
        const old = { name: 'Old', sections: [{ id: 's1', name: 'A' }, { id: 's2', name: 'B' }, { id: 's3', name: 'C' }] };
        const p = createProject(old);
        assert.deepEqual(p.arrangement.map(e => e.sectionId), ['s1', 's2', 's3']);
    });

    test('an empty arrangement is kept: nothing placed is not "not migrated"', () => {
        const p = createProject({ sections: [{ id: 's1' }], arrangement: [] });
        assert.deepEqual(p.arrangement, []);
        assert.equal(pieceLayout(p).total, 0);
    });

    test('entries naming a missing section, or repeating an id, are dropped', () => {
        const p = createProject({
            sections: [{ id: 's1' }],
            arrangement: [{ id: 'e1', sectionId: 's1' }, { id: 'e2', sectionId: 'gone' }, { id: 'e1', sectionId: 's1' }, null],
        });
        assert.deepEqual(p.arrangement, [{ id: 'e1', sectionId: 's1' }]);
    });

    test('round-trips through JSON, as stored bodies do', () => {
        const { p, chorus } = song();
        placeSection(p, chorus.id);
        assert.deepEqual(createProject(JSON.parse(JSON.stringify(p))).arrangement, p.arrangement);
    });

    test('sections carry a colour, stable per id, and a given one is kept', () => {
        const a = M.createSection({ id: 'x' });
        assert.ok(SECTION_COLORS.includes(a.color));
        assert.equal(M.createSection({ id: 'x' }).color, a.color);
        assert.equal(M.createSection({ id: 'x', color: '#123456' }).color, '#123456');
        assert.equal(M.createSection({ id: 'x', color: 'red' }).color, a.color);
    });
});

describe('placing, moving, removing, copying', () => {
    test('addSection places at the end; { place: false } only adds to the library', () => {
        const { p } = song();
        const bridge = addSection(p, { name: 'Bridge' }, { place: false });
        assert.ok(p.sections.includes(bridge));
        assert.deepEqual(order(p), ['Verse', 'Chorus']);
        assert.deepEqual(sectionUsage(p, bridge.id), []);
    });

    test('a section placed twice plays twice, end to end', () => {
        const { p, verse, chorus } = song();
        placeSection(p, verse.id);
        placeSection(p, chorus.id);
        assert.deepEqual(order(p), ['Verse', 'Chorus', 'Verse', 'Chorus']);
        const L = pieceLayout(p);
        assert.deepEqual(L.parts.map(x => [x.startCol, x.endCol]), [[0, 16], [16, 48], [48, 64], [64, 96]]);
        assert.equal(sectionUsage(p, chorus.id).length, 2);
        // Two parts, one section object: editing it changes both.
        assert.equal(L.parts[1].section, L.parts[3].section);
        assert.notEqual(L.parts[1].entry.id, L.parts[3].entry.id);
    });

    test('placeSection inserts at an index, clamped; refuses a missing section', () => {
        const { p, verse, chorus } = song();
        placeSection(p, chorus.id, 0);
        assert.deepEqual(order(p), ['Chorus', 'Verse', 'Chorus']);
        placeSection(p, verse.id, 99);
        assert.deepEqual(order(p), ['Chorus', 'Verse', 'Chorus', 'Verse']);
        assert.equal(placeSection(p, 'ghost'), null);
    });

    test('moveEntry moves one placement, not every placement of its section', () => {
        const { p, verse } = song();
        const again = placeSection(p, verse.id);                       // V C V
        assert.equal(moveEntry(p, again.id, 1), true);                 // V V C
        assert.deepEqual(order(p), ['Verse', 'Verse', 'Chorus']);
        assert.equal(moveEntry(p, again.id, 1), false, 'already there');
        assert.equal(moveEntry(p, 'ghost', 0), false);
        assert.equal(moveEntry(p, again.id, -5), true, 'clamped to the start');
        assert.equal(p.arrangement[0].id, again.id);
    });

    test('removeEntry takes a placement out of the piece; the section stays', () => {
        const { p, chorus } = song();
        const e = sectionUsage(p, chorus.id)[0];
        assert.equal(removeEntry(p, e), true);
        assert.deepEqual(order(p), ['Verse']);
        assert.ok(p.sections.includes(chorus));
        assert.equal(removeEntry(p, e), false);
    });

    test('removeSection removes it from the library and from every place in the piece', () => {
        const { p, chorus } = song();
        placeSection(p, chorus.id, 0);
        assert.equal(removeSection(p, chorus.id), true);
        assert.deepEqual(order(p), ['Verse']);
    });

    test('copyEntry: one placement gets its own copy, the others keep the original', () => {
        const { p, verse, chorus } = song();
        const last = placeSection(p, chorus.id);                       // V C C
        const copy = copyEntry(p, last.id);
        assert.equal(copy.name, 'Chorus copy');
        assert.equal(last.sectionId, copy.id, 'the entry now plays the copy');
        assert.deepEqual(order(p), ['Verse', 'Chorus', 'Chorus copy']);
        assert.equal(p.sections.indexOf(copy), p.sections.indexOf(chorus) + 1, 'next to it in the library');
        assert.equal(copy.clips[0].patternId, chorus.clips[0].patternId, 'same patterns');
        assert.notEqual(copy.clips[0].id, chorus.clips[0].id, 'new clip records');
        copy.bpm = 140;
        assert.equal(chorus.bpm, null, 'separate from here on');
        assert.equal(copyEntry(p, 'ghost'), null);
        assert.ok(verse);
    });

    test('duplicateSection places the copy after the original\'s first placement', () => {
        const { p, verse } = song();
        placeSection(p, verse.id);                                     // V C V
        const copy = duplicateSection(p, verse.id);
        assert.deepEqual(order(p), ['Verse', 'Verse copy', 'Chorus', 'Verse']);
        // An unplaced original: the copy goes to the end.
        const lone = addSection(p, { name: 'Lone' }, { place: false });
        duplicateSection(p, lone.id);
        assert.equal(order(p).at(-1), 'Lone copy');
        assert.ok(copy);
    });

    test('moveSection (transitional ▲/▼) moves library and piece together when placed once', () => {
        const { p, verse, chorus } = song();
        assert.equal(moveSection(p, chorus.id, -1), true);
        assert.deepEqual(p.sections.map(s => s.id), [chorus.id, verse.id]);
        assert.deepEqual(order(p), ['Chorus', 'Verse']);
    });
});

describe('playing the piece', () => {
    test('a repeated section sounds each time, and localize says which placement', () => {
        const { p, chorus } = song();
        const again = placeSection(p, chorus.id);                      // V(16) C(32) C(32)
        const seq = createPieceSequence(p);
        assert.deepEqual(seq.range, { startCol: 0, endCol: 80 });
        assert.equal(seq.eventsAt(16)[0].midi, 72);
        assert.equal(seq.eventsAt(48)[0].midi, 72);
        const first = seq.localize(16), second = seq.localize(48);
        assert.equal(first.sectionId, chorus.id);
        assert.equal(second.sectionId, chorus.id);
        assert.notEqual(first.entryId, second.entryId);
        assert.equal(second.entryId, again.id);
        assert.equal(second.col, 0);
        assert.equal(seq.locate(48).entryId, again.id);
    });

    test('an unplaced section does not play', () => {
        const { p, chorus } = song();
        removeEntry(p, sectionUsage(p, chorus.id)[0]);
        const seq = createPieceSequence(p);
        assert.deepEqual(seq.range, { startCol: 0, endCol: 16 });
    });

    test('a reorder is heard', () => {
        const { p, chorus } = song();
        moveEntry(p, sectionUsage(p, chorus.id)[0], 0);
        assert.equal(createPieceSequence(p).eventsAt(0)[0].midi, 72);
    });
});

describe('export and import', () => {
    test('the file carries the arrangement and the new schema', () => {
        const { p, verse } = song();
        placeSection(p, verse.id);
        const doc = exportProject(p);
        assert.equal(doc.schemaVersion, SCHEMA_VERSION);
        assert.equal(SCHEMA_VERSION, 2);
        assert.deepEqual(doc.project.arrangement, p.arrangement);
        const back = importProject(JSON.parse(JSON.stringify(doc)));
        assert.deepEqual((back.project || back).arrangement.map(e => e.sectionId), p.arrangement.map(e => e.sectionId));
    });

    test('a schema-1 file still opens, and plays as it did', () => {
        const { p } = song();
        const doc = exportProject(p);
        doc.schemaVersion = 1;
        delete doc.project.arrangement;
        const back = importProject(JSON.parse(JSON.stringify(doc)));
        const body = back.project || back;
        assert.deepEqual(body.arrangement.map(e => e.sectionId), body.sections.map(s => s.id));
    });
});

describe('collab ops', () => {
    test('the arrangement is one atom, carried whole', () => {
        const { p } = song();
        const atoms = readAtoms(p);
        assert.equal(atoms.get('arrangement'), JSON.stringify(p.arrangement.map(e => ({ id: e.id, sectionId: e.sectionId }))));
    });

    test('a reuse travels as an arrangement op and applies', () => {
        const { p, chorus } = song();
        const before = JSON.parse(JSON.stringify(p));
        placeSection(p, chorus.id, 0);
        const groups = diffGroups(before, p);
        assert.equal(groups.length, 1);
        assert.deepEqual(groups[0].map(o => o.atom), ['arrangement']);
        applyOps(before, groups[0]);
        assert.deepEqual(before.arrangement, p.arrangement);
    });

    test('a new section travels with its placement, in one group', () => {
        const { p } = song();
        const before = JSON.parse(JSON.stringify(p));
        addSection(p, { name: 'Bridge' });
        const groups = diffGroups(before, p);
        assert.equal(groups.length, 1, 'stand or fall together');
        assert.ok(groups[0].some(o => o.atom === 'arrangement'));
        applyOps(before, groups[0]);
        assert.deepEqual(before.arrangement, p.arrangement);
        assert.deepEqual(checkInvariants(before), []);
    });

    test('a piece entry whose section is gone is an invariant violation', () => {
        const { p, chorus } = song();
        p.sections = p.sections.filter(s => s !== chorus);              // past the model's back
        const v = checkInvariants(p);
        assert.equal(v.length, 1);
        assert.ok(v[0].atoms.includes('arrangement'));
        normalizeProject(p);
        assert.deepEqual(checkInvariants(p), [], 'normalising drops it');
    });
});
