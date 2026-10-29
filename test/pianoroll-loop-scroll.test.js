// Regression: loop scroll-wrap must follow the current measure count.
//
// handlePlaybackTick used to wrap against a `gridWidth()` captured once at
// construction — before loadState() restored a multi-measure pattern, and never
// updated by the +/− Msr buttons. The playhead then wrapped a measure early.
//
// Follow-scroll is opt-in (off by default, see pianoroll-playhead.test.js),
// so these fixtures restore it switched on.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

const COLS_PER_MEASURE = 16;
const COL_W = 30;
const LABEL_W = 36;

let createPianoroll;

before(async () => {
    installBrowserEnv();
    ({ createPianoroll } = await import('../html/components/pianoroll.js'));
});

// Stands in for the real Web Worker: lets the test drive ticks by hand.
function makeTickWorker() {
    const handlers = [];
    return {
        posted: [],
        postMessage(m) { this.posted.push(m); },
        addEventListener(type, fn) { if (type === 'message') handlers.push(fn); },
        tick(col) { for (const fn of handlers) fn({ data: { type: 'tick', col } }); },
    };
}

function build({ measures = 1, notes = [] } = {}) {
    localStorage.setItem('openpatches_pianoroll', JSON.stringify({ measures, notes, bpm: 120, followPlayhead: true }));
    const tickWorker = makeTickWorker();
    const roll = createPianoroll({
        playNoteFn: () => {},
        onNotesChange: () => {},
        activeSlot: 0,
        tickWorker,
        stopWorker: () => {},
        getSlotData: () => null,
    });
    const scroll = roll.element.querySelector('.pianoroll-scroll');
    return { roll, tickWorker, scroll };
}

beforeEach(() => localStorage.clear());

describe('pianoroll loop scrolling', () => {
    test('restores the saved measure count', () => {
        const { roll } = build({ measures: 4, notes: [{ midi: 60, start: 0, dur: 1, slot: 0 }] });
        assert.equal(roll.totalCols(), 4 * COLS_PER_MEASURE);
    });

    test('does not wrap before the end of a restored 4-measure pattern', () => {
        const { roll, tickWorker, scroll } = build({
            measures: 4,
            notes: [{ midi: 60, start: 0, dur: 1, slot: 0 }],
        });
        roll.startPlayback();

        // Column 40 sits in measure 3 of 4 — well inside the pattern.
        // With the stale single-measure width this wrapped repeatedly to a tiny offset.
        tickWorker.tick(40);
        assert.equal(scroll.scrollLeft, LABEL_W + 40 * COL_W);
    });

    test('tracks the playhead across every column of the pattern', () => {
        const { roll, tickWorker, scroll } = build({
            measures: 3,
            notes: [{ midi: 60, start: 0, dur: 1, slot: 0 }],
        });
        roll.startPlayback();

        const total = 3 * COLS_PER_MEASURE;
        for (let col = 0; col < total; col++) {
            tickWorker.tick(col);
            assert.equal(
                scroll.scrollLeft,
                LABEL_W + col * COL_W,
                `playhead should sit at column ${col}, not a wrapped position`,
            );
        }
    });

    test('picks up measures added after construction', () => {
        const { roll, tickWorker, scroll } = build({
            measures: 1,
            notes: [{ midi: 60, start: 0, dur: 1, slot: 0 }],
        });
        // "+ Msr" twice → 3 measures.
        const addBtn = roll.element
            .querySelectorAll('.pianoroll-btn')
            .find(b => b.textContent === '+ Msr');
        assert.ok(addBtn, 'add-measure button should exist');
        addBtn.dispatch('click');
        addBtn.dispatch('click');
        assert.equal(roll.totalCols(), 3 * COLS_PER_MEASURE);

        roll.startPlayback();
        tickWorker.tick(33); // measure 3, only reachable after the two additions
        assert.equal(scroll.scrollLeft, LABEL_W + 33 * COL_W);
    });

    test('still wraps once the playhead passes the end of the pattern', () => {
        const { roll, tickWorker, scroll } = build({
            measures: 2,
            notes: [{ midi: 60, start: 0, dur: 1, slot: 0 }],
        });
        roll.startPlayback();

        const total = 2 * COLS_PER_MEASURE;
        // Column `total` is the first column of the next loop pass — it must fold
        // back onto column 0 rather than scrolling off the end of the canvas.
        tickWorker.tick(total);
        assert.equal(scroll.scrollLeft, LABEL_W);
    });
});
