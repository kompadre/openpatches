// A recorded note that lands outside the roll's viewport scrolls the grid
// vertically to centre it; one already in view leaves the grid alone. The
// horizontal position is never touched here — while recording it belongs to
// the follow-scroll, or to the user.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

const ROW_H = 20;
const HEADER_H = 14;
const TOP_MIDI = 84;   // C6, row 0

let createPianoroll;

before(async () => {
    installBrowserEnv();
    ({ createPianoroll } = await import('../html/components/pianoroll.js'));
});

function makeTickWorker() {
    return { postMessage() {}, addEventListener() {} };
}

function build() {
    const roll = createPianoroll({
        playNoteFn: () => {},
        onNotesChange: () => {},
        activeSlot: 0,
        tickWorker: makeTickWorker(),
        stopWorker: () => {},
        getSlotData: () => ({ name: 'A', color: '#fff' }),
    });
    const scroll = roll.element.querySelector('.pianoroll-scroll');
    scroll.clientHeight = 200;          // ten rows visible
    scroll.scrollTop = 0;
    scroll.scrollLeft = 123;
    return { roll, scroll };
}

const rowY = (midi) => HEADER_H + (TOP_MIDI - midi) * ROW_H;

beforeEach(() => localStorage.clear());

describe('recording reveals off-screen notes', () => {
    test('a note below the viewport is centred vertically; scrollLeft is untouched', () => {
        const { roll, scroll } = build();
        roll.startRecording();
        roll.addNote({ midi: 48, start: 4, dur: 1 });   // C3, three screens down
        const y = rowY(48);
        assert.equal(scroll.scrollTop, y + ROW_H / 2 - scroll.clientHeight / 2);
        assert.equal(scroll.scrollLeft, 123);
    });

    test('a note already in view does not move the grid', () => {
        const { roll, scroll } = build();
        roll.startRecording();
        roll.addNote({ midi: 80, start: 0, dur: 1 });   // row 4 of 10
        assert.equal(scroll.scrollTop, 0);
    });

    test('a note just above the viewport scrolls back up, clamped at 0', () => {
        const { roll, scroll } = build();
        scroll.scrollTop = 160;                         // rows 8+ visible
        roll.startRecording();
        roll.addNote({ midi: 82, start: 0, dur: 1 });   // row 2
        assert.equal(scroll.scrollTop, Math.max(0, rowY(82) + ROW_H / 2 - 100));
    });

    test('stopped, a note is centred on both axes as before', () => {
        const { roll, scroll } = build();
        roll.addNote({ midi: 48, start: 4, dur: 1 });
        assert.notEqual(scroll.scrollLeft, 123, 'horizontal centring still happens when not recording');
    });
});
