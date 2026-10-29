// Playback view: follow-scroll is opt-in and the playhead is a red line.
//
// Every tick used to redraw a double-wide canvas, reassign canvas.width and
// write scrollLeft — enough to lag badly on slower machines. With follow
// off (the default) the canvas stays single-width, the scroll is left to
// the user, and a high-contrast playhead is what shows where playback is.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

const COLS_PER_MEASURE = 16;
const COL_W = 30;
const LABEL_W = 36;
const PLAYHEAD_COLOR = '#ff3b3b';

let createPianoroll;

before(async () => {
    installBrowserEnv();
    ({ createPianoroll } = await import('../html/components/pianoroll.js'));
});

function makeTickWorker() {
    const handlers = [];
    return {
        postMessage() {},
        addEventListener(type, fn) { if (type === 'message') handlers.push(fn); },
        tick(col) { for (const fn of handlers) fn({ data: { type: 'tick', col } }); },
    };
}

function build({ measures = 1, notes = [{ midi: 60, start: 0, dur: 1, slot: 0 }], saved = {} } = {}) {
    localStorage.setItem('openpatches_pianoroll', JSON.stringify({ measures, notes, bpm: 120, ...saved }));
    const tickWorker = makeTickWorker();
    const roll = createPianoroll({
        playNoteFn: () => {},
        onNotesChange: () => {},
        activeSlot: 0,
        tickWorker,
        startWorker: () => {},
        stopWorker: () => {},
        getSlotData: () => null,
    });
    const scroll = roll.element.querySelector('.pianoroll-scroll');
    const canvas = roll.element.querySelector('.pianoroll-canvas');
    const followBtns = roll.element.querySelectorAll('.pianoroll-follow');
    return { roll, tickWorker, scroll, canvas, ctx: canvas.getContext('2d'), followBtns };
}

const singleWidth = (measures) => LABEL_W + measures * COLS_PER_MEASURE * COL_W;
const playheadRects = (ctx) => ctx._calls.filter(c =>
    c.fn === 'fillRect' && c.fillStyle === PLAYHEAD_COLOR && c.args[2] === 2);

beforeEach(() => localStorage.clear());

describe('follow-scroll is off by default', () => {
    test('ticks never touch the scroll position', () => {
        const { roll, tickWorker, scroll } = build({ measures: 2 });
        assert.equal(roll.isFollowing(), false);
        scroll.scrollLeft = 123;
        roll.startPlayback();
        assert.equal(scroll.scrollLeft, 123, 'Play must not yank the view to the start');
        for (const col of [0, 5, 17, 31, 32]) tickWorker.tick(col);
        assert.equal(scroll.scrollLeft, 123);
    });

    test('the canvas stays single-width while playing', () => {
        const { roll, tickWorker, canvas } = build({ measures: 2 });
        roll.startPlayback();
        tickWorker.tick(3);
        assert.equal(canvas.width, singleWidth(2), 'no second copy of the grid to draw');
    });

    test('the recorder-side scrollToCol is a no-op too', () => {
        const { roll, scroll } = build();
        roll.startRecording();
        scroll.scrollLeft = 77;
        roll.scrollToCol(9);
        assert.equal(scroll.scrollLeft, 77);
    });
});

describe('follow-scroll switched on', () => {
    test('restores the old behaviour: double-wide canvas, scroll tracks and wraps', () => {
        const { roll, tickWorker, scroll, canvas } = build({ measures: 2 });
        roll.setFollowPlayhead(true);
        roll.startPlayback();
        assert.equal(scroll.scrollLeft, LABEL_W, 'Play rewinds the view');
        assert.equal(canvas.width, LABEL_W + 2 * COLS_PER_MEASURE * COL_W * 2);
        tickWorker.tick(20);
        assert.equal(scroll.scrollLeft, LABEL_W + 20 * COL_W);
        tickWorker.tick(32);
        assert.equal(scroll.scrollLeft, LABEL_W, 'folds back at the loop seam');
    });

    test('the button toggles it and the choice is persisted', () => {
        const { roll, followBtns } = build();
        assert.equal(followBtns.length, 2, 'desktop button plus the mobile more-menu copy');
        followBtns[0].dispatch('click');
        assert.equal(roll.isFollowing(), true);
        assert.ok(followBtns.every(b => b.classList.contains('active')), 'both copies light up');
        // Follow-scroll is a view preference, not part of a song, so it
        // lives in its own key now rather than the old roll blob.
        assert.equal(JSON.parse(localStorage.getItem('openpatches_roll_prefs')).followPlayhead, true);

        const again = build({ saved: { followPlayhead: true } });
        assert.equal(again.roll.isFollowing(), true, 'restored on the next load');
        assert.ok(again.followBtns.every(b => b.classList.contains('active')));
    });

    test('anything but an explicit true in storage means off', () => {
        for (const v of ['yes', 1, 'true', null]) {
            const { roll } = build({ saved: { followPlayhead: v } });
            assert.equal(roll.isFollowing(), false, `followPlayhead=${JSON.stringify(v)}`);
        }
    });

    test('switching it off mid-loop pulls the view back into the first copy', () => {
        const { roll, tickWorker, scroll, canvas } = build({ measures: 1 });
        roll.setFollowPlayhead(true);
        roll.startPlayback();
        tickWorker.tick(15);
        // Park the view in the second copy, as the seamless wrap does.
        scroll.scrollLeft = LABEL_W + 16 * COL_W + 90;
        roll.setFollowPlayhead(false);
        assert.ok(scroll.scrollLeft < singleWidth(1), 'not left pointing at a grid that no longer exists');
        assert.equal(canvas.width, singleWidth(1));
    });
});

describe('the playhead', () => {
    test('is a 2px red line at the leading edge of the current column', () => {
        const { roll, tickWorker, ctx } = build({ measures: 2 });
        roll.startPlayback();
        ctx._calls.length = 0;
        tickWorker.tick(7);
        const rects = playheadRects(ctx);
        assert.equal(rects.length, 1);
        assert.equal(rects[0].args[0], LABEL_W + 7 * COL_W - 1);
        assert.equal(rects[0].args[1], 0, 'runs from the very top, through the header');
    });

    test('is drawn once per grid copy when following', () => {
        const { roll, tickWorker, ctx } = build({ measures: 1 });
        roll.setFollowPlayhead(true);
        roll.startPlayback();
        ctx._calls.length = 0;
        tickWorker.tick(3);
        const xs = playheadRects(ctx).map(r => r.args[0]).sort((a, b) => a - b);
        assert.deepEqual(xs, [LABEL_W + 3 * COL_W - 1, LABEL_W + 16 * COL_W + 3 * COL_W - 1]);
    });

    test('disappears when playback stops', () => {
        const { roll, tickWorker, ctx } = build();
        roll.startPlayback();
        tickWorker.tick(2);
        ctx._calls.length = 0;
        roll.stopPlayback();
        assert.equal(playheadRects(ctx).length, 0);
    });

    test('the recorder shows it as well', () => {
        const { roll, ctx, tickWorker } = build();
        roll.startRecording();
        ctx._calls.length = 0;
        tickWorker.tick(5);
        assert.equal(playheadRects(ctx)[0].args[0], LABEL_W + 5 * COL_W - 1);
    });
});

describe('per-tick cost', () => {
    test('canvas.width is only assigned when it actually changes', () => {
        const { roll, tickWorker, canvas } = build({ measures: 2 });
        let sets = 0;
        let w = canvas.width;
        Object.defineProperty(canvas, 'width', {
            get: () => w,
            set: (v) => { sets++; w = v; },
            configurable: true,
        });
        roll.startPlayback();
        for (let col = 0; col < 10; col++) tickWorker.tick(col);
        assert.equal(sets, 0, 'reassigning canvas.width resets the context and reallocates it');

        roll.setFollowPlayhead(true);
        assert.equal(sets, 1, 'and it is still assigned when the width really changes');
    });

    test('Play is disabled while recording, since it would be a silent no-op', () => {
        const { roll } = build();
        const playBtn = roll.element.querySelector('.pianoroll-play');
        roll.startRecording();
        assert.equal(playBtn.disabled, true);
        roll.startPlayback();
        assert.equal(roll.isPlaying(), false, 'the recorder owns the worker');
        roll.stopRecording();
        assert.equal(playBtn.disabled, false);
    });
});
