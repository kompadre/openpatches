// Pianoroll mouse interaction. The unit suite drives the roll through its
// API; nobody has ever machine-checked the canvas hit math — pixel → row/col,
// the resize margins, the double-click window — because the stub has no
// layout and no pointer. This file is that check, and it runs at DPR 2 to
// catch math that only holds when CSS pixels and device pixels agree.
//
// Geometry (constants at the top of html/components/pianoroll.js):
//   x = LABEL_W + col * COL_W        LABEL_W 36, COL_W 30
//   y = HEADER_H + row * ROW_H       HEADER_H 14, ROW_H 20
//   row 0 is C6 (midi 84), descending — row = 84 - midi.
//
// Three facts of life these tests are written around, all learned the hard
// way in a real browser:
//   1. The roll lives in a ~180px scrolled pane and raw page.mouse events do
//      not auto-scroll, so every note stays in the top rows (midi ≥ 77).
//   2. Drawing the first note makes renderLegend() grow the legend, which
//      shifts the canvas up a row. The bounding box is therefore re-measured
//      before every gesture, never cached across one.
//   3. The roll treats a second mousedown within 350 ms of the last, on the
//      same row within one column, as a double-click (= delete). Distinct
//      gestures that would fall in that window are separated by settle().

import { test, expect, openApp, openRollTab } from './fixtures.js';

const LABEL_W = 36, COL_W = 30, HEADER_H = 14, ROW_H = 20, TOP_MIDI = 84;

// Centre of a cell, in canvas CSS pixels.
function cellX(col) { return LABEL_W + col * COL_W + COL_W / 2; }
function cellY(midi) { return HEADER_H + (TOP_MIDI - midi) * ROW_H + ROW_H / 2; }

async function canvasOrigin(page) {
    const box = await page.locator('.pianoroll-canvas').boundingBox();
    expect(box).not.toBeNull();
    return box;
}

/** Outlive the roll's 350 ms double-click window between gestures. */
function settle(page) {
    return page.waitForTimeout(400);
}

/** Press-move-release in canvas coordinates, with enough steps to beat MOVE_THRESHOLD. */
async function drag(page, from, to) {
    const box = await canvasOrigin(page);
    await page.mouse.move(box.x + from.x, box.y + from.y);
    await page.mouse.down();
    await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 8 });
    await page.mouse.up();
}

function getNotes(page) {
    return page.evaluate(() =>
        window.__opDock._pianoroll.getNotes().map(({ midi, start, dur }) => ({ midi, start, dur })));
}

// The whole point: run the pointer math where CSS and device pixels differ.
test.use({ deviceScaleFactor: 2 });

test.describe('pianoroll mouse interaction', () => {
    test.beforeEach(async ({ page }) => {
        await openApp(page);
        await openRollTab(page);
    });

    test('dragging across cells draws a note', async ({ page }) => {
        await drag(page, { x: cellX(2), y: cellY(80) }, { x: cellX(5), y: cellY(80) });
        expect(await getNotes(page)).toEqual([{ midi: 80, start: 2, dur: 4 }]);
    });

    test('a bare click draws a one-column note', async ({ page }) => {
        const box = await canvasOrigin(page);
        await page.mouse.click(box.x + cellX(0), box.y + cellY(82));
        expect(await getNotes(page)).toEqual([{ midi: 82, start: 0, dur: 1 }]);
    });

    test('dragging a note body moves it in both axes', async ({ page }) => {
        await drag(page, { x: cellX(2), y: cellY(78) }, { x: cellX(4), y: cellY(78) });
        await settle(page);

        // Grab the middle of the note, drop it two columns right and two
        // rows up. Crossing rows is the part worth paying for: a one-off
        // error in pixelToRow moves the note to the wrong pitch.
        await drag(page, { x: cellX(3), y: cellY(78) }, { x: cellX(5), y: cellY(80) });
        expect(await getNotes(page)).toEqual([{ midi: 80, start: 4, dur: 3 }]);
    });

    test('dragging the edges resizes from either end', async ({ page }) => {
        await drag(page, { x: cellX(2), y: cellY(78) }, { x: cellX(4), y: cellY(78) });
        await settle(page);

        // The edge is at the column boundary, not a cell centre; the hit
        // test gives RESIZE_MARGIN around it, so aim exactly at it.
        const edgeX = LABEL_W + 5 * COL_W;
        await drag(page, { x: edgeX, y: cellY(78) }, { x: edgeX + 2 * COL_W, y: cellY(78) });
        expect(await getNotes(page)).toEqual([{ midi: 78, start: 2, dur: 5 }]);
        await settle(page);

        // And the left edge shortens from the front.
        const startX = LABEL_W + 2 * COL_W;
        await drag(page, { x: startX, y: cellY(78) }, { x: startX + COL_W, y: cellY(78) });
        expect(await getNotes(page)).toEqual([{ midi: 78, start: 3, dur: 4 }]);
    });

    test('double-click deletes the note under the cursor', async ({ page }) => {
        await drag(page, { x: cellX(2), y: cellY(80) }, { x: cellX(4), y: cellY(80) });
        await settle(page);
        await drag(page, { x: cellX(8), y: cellY(77) }, { x: cellX(9), y: cellY(77) });
        expect(await getNotes(page)).toHaveLength(2);
        await settle(page);

        const box = await canvasOrigin(page);
        await page.mouse.dblclick(box.x + cellX(3), box.y + cellY(80));

        // Only the note under the cursor goes.
        expect(await getNotes(page)).toEqual([{ midi: 77, start: 8, dur: 2 }]);
    });

    test('a drag that ends on another row draws nothing', async ({ page }) => {
        // mouseup only commits when the drag stayed on its row — a diagonal
        // scribble must not leave a surprise note behind.
        await drag(page, { x: cellX(2), y: cellY(80) }, { x: cellX(6), y: cellY(77) });
        expect(await getNotes(page)).toEqual([]);
    });
});

test.describe('step record UI', () => {
    test.beforeEach(async ({ page }) => {
        await openApp(page);
        await openRollTab(page);
    });

    test('the step-length picker appears with the step record and is honoured', async ({ page }) => {
        const picker = page.locator('.pianoroll-step-len');
        await expect(picker).toBeHidden();

        await page.locator('.pianoroll-record').click();
        await expect(picker).toBeVisible();
        await picker.selectOption('4');

        // Stepping itself is covered by the unit suite; the browser-only
        // part is the picker's visibility and that the choice persists.
        await page.locator('.pianoroll-record').click();
        await expect(picker).toBeHidden();
        await page.reload();
        await expect(page.locator('.keyboard .key').first()).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem('openpatches_step_len'))).toBe('4');
    });

    test('dragging the header marker moves the step cursor', async ({ page }) => {
        await page.locator('.pianoroll-record').click();
        expect(await page.evaluate(() => window.__opDock._pianoroll.getStepCursor())).toBe(0);

        // Drag along the header strip from column 0 to column 9.
        await drag(page, { x: cellX(0), y: HEADER_H / 2 }, { x: cellX(9), y: HEADER_H / 2 });
        expect(await page.evaluate(() => window.__opDock._pianoroll.getStepCursor())).toBe(9);

        // And no note was drawn by the gesture.
        expect(await getNotes(page)).toEqual([]);
    });

    test('a header click outside a step record does not seek or draw', async ({ page }) => {
        await page.mouse.click((await canvasOrigin(page)).x + cellX(5), (await canvasOrigin(page)).y + HEADER_H / 2);
        expect(await page.evaluate(() => window.__opDock._pianoroll.getStepCursor())).toBe(-1);
        expect(await getNotes(page)).toEqual([]);
    });
});
