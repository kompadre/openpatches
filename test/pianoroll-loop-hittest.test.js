// Piano roll pointer handling at the loop boundary:
//  - with follow-scroll on, the grid is drawn twice; a click on the second
//    copy used to miss every note (hit-testing used the raw x) and so
//    created a duplicate on top of the one being clicked;
//  - dragging a note's right edge could run past the loop end, so the note
//    played into the next pass over its own repeat;
//  - touchcancel left a half-moved note where the finger was taken away.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

const COLS_PER_MEASURE = 16;
const ROW_H = 20;
const COL_W = 30;
const LABEL_W = 36;
const HEADER_H = 14;
const TOP_MIDI = 84;

let createPianoroll;

before(async () => {
    installBrowserEnv();
    ({ createPianoroll } = await import('../html/components/pianoroll.js'));
});

const rowY = (midi) => HEADER_H + (TOP_MIDI - midi) * ROW_H + ROW_H / 2;
const colX = (col) => LABEL_W + col * COL_W;
const gridW = (measures) => measures * COLS_PER_MEASURE * COL_W;

function build({ measures = 1, notes, followPlayhead = false } = {}) {
    localStorage.setItem('openpatches_pianoroll', JSON.stringify({ measures, notes, bpm: 120, followPlayhead }));
    const played = [];
    const roll = createPianoroll({
        playNoteFn: (midi) => played.push(midi),
        onNotesChange: () => {},
        activeSlot: 0,
        tickWorker: { postMessage() {}, addEventListener() {} },
        startWorker: () => {},
        stopWorker: () => {},
        getSlotData: () => null,
    });
    const canvas = roll.element.querySelector('.pianoroll-canvas');
    const mouse = (type, x, y) => canvas.dispatch(type, { clientX: x, clientY: y, preventDefault() {} });
    const touch = (type, x, y) => canvas.dispatch(type, {
        touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }], preventDefault() {},
    });
    return { roll, canvas, played, mouse, touch, notes: () => roll.getSong().notes };
}

beforeEach(() => localStorage.clear());

describe('loop-wrapped hit testing', () => {
    test('a click on the second grid copy finds the note instead of duplicating it', () => {
        const { roll, played, mouse, notes } = build({
            notes: [{ midi: 60, start: 2, dur: 2, slot: 0 }], followPlayhead: true,
        });
        roll.startPlayback();                       // looping + follow → double-wide
        const x = colX(3) + gridW(1) + 5;           // over the note, in copy #2
        mouse('mousedown', x, rowY(60));
        mouse('mouseup', x, rowY(60));
        assert.equal(notes().length, 1, 'no duplicate');
        assert.deepEqual(played, [60], 'treated as a click on the note (preview)');
    });

    test('a click on empty space in the second copy still creates a note at the folded column', () => {
        const { roll, mouse, notes } = build({
            notes: [{ midi: 60, start: 0, dur: 1, slot: 0 }], followPlayhead: true,
        });
        roll.startPlayback();
        const x = colX(5) + gridW(1) + 5;
        mouse('mousedown', x, rowY(62));
        mouse('mouseup', x, rowY(62));
        const added = notes().find(n => n.midi === 62);
        assert.ok(added);
        assert.equal(added.start, 5);
    });

    test('without follow (single copy) nothing changes', () => {
        const { played, mouse, notes } = build({ notes: [{ midi: 60, start: 2, dur: 2, slot: 0 }] });
        mouse('mousedown', colX(3) + 5, rowY(60));
        mouse('mouseup', colX(3) + 5, rowY(60));
        assert.equal(notes().length, 1);
        assert.deepEqual(played, [60]);
    });
});

describe('notes stop at the loop end', () => {
    test('mouse resize of the right edge is clamped', () => {
        const { mouse, notes } = build({ notes: [{ midi: 60, start: 12, dur: 2, slot: 0 }] });
        mouse('mousedown', colX(14), rowY(60));              // right edge
        mouse('mousemove', colX(14) + 10 * COL_W, rowY(60)); // way past col 16
        mouse('mouseup', colX(14) + 10 * COL_W, rowY(60));
        assert.equal(notes()[0].dur, 4, 'ends exactly at the loop end');
    });

    test('touch resize of the right edge is clamped too', () => {
        const { touch, notes } = build({ notes: [{ midi: 60, start: 12, dur: 2, slot: 0 }] });
        touch('touchstart', colX(14), rowY(60));
        touch('touchmove', colX(14) + 10 * COL_W, rowY(60));
        touch('touchend', colX(14) + 10 * COL_W, rowY(60));
        assert.equal(notes()[0].dur, 4);
    });

    test('shrinking still works and never goes below one column', () => {
        const { mouse, notes } = build({ notes: [{ midi: 60, start: 4, dur: 4, slot: 0 }] });
        mouse('mousedown', colX(8), rowY(60));
        mouse('mousemove', colX(8) - 10 * COL_W, rowY(60));
        mouse('mouseup', colX(8) - 10 * COL_W, rowY(60));
        assert.equal(notes()[0].dur, 1);
    });
});

describe('touchcancel', () => {
    test('a move in progress snaps back', () => {
        const { touch, notes } = build({ notes: [{ midi: 60, start: 2, dur: 2, slot: 0 }] });
        touch('touchstart', colX(3), rowY(60));
        touch('touchmove', colX(3) + 4 * COL_W, rowY(60));
        assert.equal(notes()[0].start, 6, 'moved while the finger is down');
        touch('touchcancel', colX(3) + 4 * COL_W, rowY(60));
        assert.equal(notes()[0].start, 2, 'restored');
        // and the next gesture starts clean: an end with nothing in flight is a no-op
        touch('touchend', colX(3), rowY(60));
        assert.equal(notes().length, 1);
    });

    test('a resize in progress snaps back', () => {
        const { touch, notes } = build({ notes: [{ midi: 60, start: 2, dur: 2, slot: 0 }] });
        touch('touchstart', colX(4), rowY(60));
        touch('touchmove', colX(4) + 3 * COL_W, rowY(60));
        assert.equal(notes()[0].dur, 5);
        touch('touchcancel', colX(4) + 3 * COL_W, rowY(60));
        assert.equal(notes()[0].dur, 2);
    });
});
