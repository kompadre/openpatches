// Pattern thumbnails: a beat × octave density map, not the notes verbatim.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { thumbCells, cellAlpha } from '../html/components/pattern-thumbs.js';

describe('thumbCells', () => {
    test('one row per beat, one column per octave the pattern spans', () => {
        const m = thumbCells({ measures: 2, notes: [{ midi: 48, start: 0, dur: 1 }, { midi: 72, start: 4, dur: 1 }] });
        assert.equal(m.beats, 8, 'two bars of four beats');
        assert.equal(m.lowOctave, 3, 'MIDI 48 is C3');
        assert.equal(m.octaves, 3, 'C3 to C5');
        assert.deepEqual(m.cells[0], [1, 0, 0]);
        assert.deepEqual(m.cells[1], [0, 0, 1]);
    });

    test('notes in the same beat and octave stack up: that cell is busier', () => {
        const m = thumbCells({ measures: 1, notes: [
            { midi: 60, start: 0, dur: 1 }, { midi: 64, start: 1, dur: 1 }, { midi: 67, start: 3, dur: 1 },   // beat 1, octave 4
            { midi: 62, start: 8, dur: 1 },                                                                  // beat 3
        ] });
        assert.deepEqual(m.cells.map(r => r[0]), [3, 0, 1, 0]);
        assert.equal(m.max, 3);
    });

    test('a held note marks every beat it sounds in', () => {
        const m = thumbCells({ measures: 1, notes: [{ midi: 60, start: 2, dur: 7 }] });   // columns 2–8: beats 1–3
        assert.deepEqual(m.cells.map(r => r[0]), [1, 1, 1, 0]);
    });

    test('notes past the pattern end are clipped, an empty pattern is empty', () => {
        assert.deepEqual(thumbCells({ measures: 1, notes: [{ midi: 60, start: 14, dur: 8 }] }).cells.map(r => r[0]), [0, 0, 0, 1]);
        const e = thumbCells({ measures: 1, notes: [] });
        assert.equal(e.max, 0);
        assert.equal(e.octaves, 0);
    });
});

test('cellAlpha: anything present shows, the busiest is solid', () => {
    assert.equal(cellAlpha(0, 4), 0);
    assert.ok(cellAlpha(1, 4) >= 0.3);
    assert.equal(cellAlpha(4, 4), 1);
    assert.ok(cellAlpha(2, 4) > cellAlpha(1, 4));
});
