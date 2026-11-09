// The Tracker tab: lives after Pattern, renders the section row by row,
// syncs the active voice, and outlines its viewport in the Section pane.

import { test, expect, openApp } from './fixtures.js';

async function seed(page) {
    await page.evaluate(async () => {
        const M = await import('/html/components/project-model.js');
        const pattern = window.__opProject.createPattern({
            name: 'Riff',
            notes: [
                { midi: 60, start: 0, dur: 4 },
                { midi: 64, start: 0, dur: 4 },   // a chord: two sub-lanes
                { midi: 67, start: 8, dur: 4 },
            ],
        }, 'e2e');
        window.__opProject.update((project, section) => {
            const track = M.createTrack({ name: 'Keys', slot: 0 });
            project.tracks.push(track);
            M.addClip(project, section, { trackId: track.id, patternId: pattern.id, startCol: 0 });
        }, 'e2e');
    });
}

test('the tab sits after Pattern, and the grid shows the seeded track', async ({ page }) => {
    await openApp(page);
    await seed(page);

    const tabs = await page.locator('.dock-tabs .dock-tab').evaluateAll((els) =>
        els.map((e) => [...e.classList].find((c) => c.startsWith('dock-tab-'))));
    expect(tabs.indexOf('dock-tab-tracker')).toBe(tabs.indexOf('dock-tab-pianoroll') + 1);

    await page.locator('.dock-tab-tracker').click();
    await expect(page.locator('.tracker-container')).toBeVisible();
    await expect(page.locator('.tracker-head-name')).toHaveText('1 Keys');

    // The chord needs two sub-lanes, so the head spans two lanes' width.
    const w = await page.locator('.tracker-head').evaluate((el) => el.getBoundingClientRect().width);
    expect(w).toBeGreaterThan(80);
});

test('compact folds the track to one column and is stored on the project', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.locator('.dock-tab-tracker').click();

    await page.locator('.tracker-mode').click();
    await expect(page.locator('.tracker-mode')).toHaveText('▣');
    expect(await page.evaluate(() => window.__opProject.get().tracks[0].compact)).toBe(true);
    const w = await page.locator('.tracker-head').evaluate((el) => el.getBoundingClientRect().width);
    expect(w).toBeLessThan(80);
});

test('the Section pane outlines the tracker viewport while the tab is open', async ({ page }) => {
    await openApp(page);
    await seed(page);

    const band = page.locator('.section-tracker-viewport');
    await page.locator('.dock-tab-tracker').click();
    await expect(band).toBeVisible();
    const h = await band.evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThan(10);

    await page.locator('.dock-tab-canvas').click();
    await expect(band).toBeHidden();
});

test('clicking a column makes that voice active in the Mixer', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.locator('.dock-tab-tracker').click();
    await page.locator('.tracker-head-name').click();
    // The bank's active entry follows; its strip is marked.
    const active = await page.evaluate(() => {
        const vb = window.__opDock._voiceBank;
        const entries = vb._getEntries();
        return entries.indexOf(vb._getActive());
    });
    expect(active).toBe(0);
});

test('typing FT2 keys writes notes; the roll and the Section learn after the commit', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.locator('.dock-tab-tracker').click();

    const canvas = page.locator('.tracker-canvas');
    const box = await canvas.boundingBox();
    // Row 4 of lane 0 (ruler is 36px, rows 16px).
    await canvas.click({ position: { x: 40, y: 4 * 16 + 8 } });
    await page.keyboard.press('KeyQ');      // C-5
    await page.keyboard.press('Digit1');    // OFF on row 5
    // Outside the one-bar clip: refused with a message.
    await canvas.click({ position: { x: 40, y: 20 * 16 + 8 } });
    await page.keyboard.press('KeyZ');
    await expect(page.locator('.tracker-status')).toContainText('No pattern here');

    await page.evaluate(() => window.__opDock._tracker.flush());
    const notes = await page.evaluate(() => {
        const p = Object.values(window.__opProject.get().patterns)[0];
        return p.notes.map((n) => [n.midi, n.start, n.dur]);
    });
    expect(notes).toContainEqual([72, 4, 1]);
    expect(box.width).toBeGreaterThan(0);
});

test('typing does not leak to the page shortcuts (Delete keeps the Section clip)', async ({ page }) => {
    await openApp(page);
    await seed(page);
    // Select the clip in Section: from there, Delete would remove it.
    await page.locator('.section-clip').first().click();
    await expect(page.locator('.section-clip.selected')).toHaveCount(1);
    await page.locator('.dock-tab-tracker').click();
    await page.locator('.tracker-canvas').click({ position: { x: 40, y: 8 } });
    await page.keyboard.press('Delete');
    expect(await page.evaluate(() => window.__opProject.getSection().clips.length)).toBe(1);
    // ...and the tracker took the key: the C-4 at row 0 is cleared.
    await page.evaluate(() => window.__opDock._tracker.flush());
    // (Row 0 holds a chord: lane 0's C-4 goes, lane 1's E-4 stays.)
    const notes = await page.evaluate(() =>
        Object.values(window.__opProject.get().patterns)[0].notes.map((n) => [n.midi, n.start]));
    expect(notes).not.toContainEqual([60, 0]);
    expect(notes).toContainEqual([64, 0]);
});

test('clicking the grid does not scroll it (focus would tuck rows under the heads)', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.locator('.dock-tab-tracker').click();
    await page.locator('.tracker-canvas').click({ position: { x: 40, y: 3 * 16 + 8 } });
    expect(await page.locator('.tracker-scroll').evaluate((el) => el.scrollTop)).toBe(0);
});

test('✎ → Edit opens the clip in the Pattern editor', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.locator('.dock-tab-tracker').click();

    // The ✎ sits in the gap right of the track, on the clip's first row.
    const { left, width } = await page.locator('.tracker-head').evaluate((el) =>
        ({ left: parseFloat(el.style.left), width: parseFloat(el.style.width) }));
    await page.locator('.tracker-canvas').click({ position: { x: left + width + 4, y: 4 } });
    await page.locator('.tracker-popover-edit').click();

    await expect(page.locator('.dock-tab-pianoroll')).toHaveClass(/active/);
    await expect(page.locator('.tracker-popover')).toHaveCount(0);
});

test('the keyboard is a strip of its own: on screen under the Tracker, and playable', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.locator('.dock-tab-tracker').click();
    const strip = page.locator('.dock-centre .dock-keyboard');
    await expect(strip.locator('.keyboard .key').first()).toBeVisible();
    expect(await page.locator('.dock-panel-pianoroll .keyboard').count()).toBe(0);
    // Between the tracker and the bottom pane.
    const grid = await page.locator('.dock-panel-tracker').boundingBox();
    const kb = await strip.boundingBox();
    const pane = await page.locator('.bpane').boundingBox();
    expect(kb.y).toBeGreaterThanOrEqual(grid.y + grid.height - 1);
    expect(kb.y + kb.height).toBeLessThanOrEqual(pane.y + 1);
    await strip.locator('.key[title="C4"]').click();
});

test('double-clicking empty space in a track makes a pattern there', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.locator('.dock-tab-tracker').click();
    const before = await page.evaluate(() => Object.keys(window.__opProject.get().patterns).length);
    // Row 20 of lane 0: below the one-bar Riff (ruler 36px, rows 16px).
    await page.locator('.tracker-canvas').dblclick({ position: { x: 40, y: 20 * 16 + 8 } });
    await expect.poll(() => page.evaluate(() => Object.keys(window.__opProject.get().patterns).length)).toBe(before + 1);
    const clip = await page.evaluate(() => window.__opProject.getSection().clips.find((c) => c.startCol === 20));
    expect(clip).toBeTruthy();
    // ...and it can be typed into straight away.
    await page.keyboard.press('KeyZ');
    await page.evaluate(() => window.__opDock._tracker.flush());
    const notes = await page.evaluate((id) => window.__opProject.getPattern(id).notes.map((n) => [n.midi, n.start]), clip.patternId);
    expect(notes).toEqual([[60, 0]]);   // Z at octave 4: C-4
});

test('a pattern dragged from the Section library onto a track is placed at that row', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => window.__opProject.createPattern({ name: 'Lib', measures: 1 }, 'e2e'));
    await page.locator('.dock-tab-tracker').click();

    const item = page.locator('.section-library-item', { hasText: 'Lib' });
    await expect(item).toBeVisible();
    const from = await item.boundingBox();
    const grid = await page.locator('.tracker-canvas').boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y - 40, { steps: 5 });
    // Row 18, lane 0: just below the one-bar Riff, and on screen (the grid
    // shares the height with the keyboard strip — a drop must be visible).
    await page.mouse.move(grid.x + 40, grid.y + 18 * 16 + 8, { steps: 10 });
    await page.mouse.up();

    const placed = await page.evaluate(() => {
        const id = Object.values(window.__opProject.get().patterns).find((p) => p.name === 'Lib').id;
        return window.__opProject.getSection().clips.filter((c) => c.patternId === id).map((c) => c.startCol);
    });
    expect(placed).toEqual([18]);
    await expect(page.locator('.section-library-ghost')).toHaveCount(0);
});

test('drag-select 12 rows, Step 4, press C3 on the on-screen keyboard: C3, three empty, …', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.locator('.dock-tab-tracker').click();
    await page.locator('.tracker-step').selectOption('4');

    // Lane 0 of Riff, from row 11 up to row 0 (row 11 is no note's start,
    // so the drag selects rather than moving a note).
    const canvas = page.locator('.tracker-canvas');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + 40, box.y + 11 * 16 + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 8, { steps: 6 });   // straight away: a selection
    await page.mouse.up();
    await expect(page.locator('.tracker-status')).toContainText('12 cells selected');
    await page.screenshot({ path: '/tmp/op-shots/tracker-sel.png', clip: { x: box.x - 40, y: box.y - 60, width: 420, height: 320 } });

    await page.locator('.dock-keyboard .key[title="C3"]').click();
    await page.evaluate(() => window.__opDock._tracker.flush());
    const lane0 = await page.evaluate(() => {
        const p = Object.values(window.__opProject.get().patterns)[0];
        return p.notes.filter((n) => n.midi !== 64).map((n) => [n.midi, n.start, n.dur]).sort((a, b) => a[1] - b[1]);
    });
    expect(lane0).toEqual([[48, 0, 4], [48, 4, 4], [48, 8, 8]]);
    // The chord's other lane is outside the block and keeps its E-4.
    const e4 = await page.evaluate(() => Object.values(window.__opProject.get().patterns)[0].notes.filter((n) => n.midi === 64).length);
    expect(e4).toBe(1);
    await page.screenshot({ path: '/tmp/op-shots/tracker-filled.png', clip: { x: box.x - 40, y: box.y - 60, width: 420, height: 320 } });
});

test('a quick drag from a note selects; held for a second it moves the note', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.locator('.dock-tab-tracker').click();
    const box = await page.locator('.tracker-canvas').boundingBox();
    const g4 = () => page.evaluate(() => Object.values(window.__opProject.get().patterns)[0].notes.find((n) => n.midi === 67).start);
    // G-4 starts on row 8 of lane 0.
    const at = (row) => ({ x: box.x + 40, y: box.y + row * 16 + 8 });

    await page.mouse.move(at(8).x, at(8).y);
    await page.mouse.down();
    await page.mouse.move(at(10).x, at(10).y, { steps: 4 });
    await page.mouse.up();
    expect(await g4()).toBe(8);
    await expect(page.locator('.tracker-status')).toContainText('3 cells selected');
    await page.mouse.click(at(14).x, at(14).y);          // drop the selection

    await page.mouse.move(at(8).x, at(8).y);
    await page.mouse.down();
    await page.waitForTimeout(1100);
    await expect(page.locator('.tracker-status')).toContainText('Drag G-4 up or down');
    await page.mouse.move(at(10).x, at(10).y, { steps: 4 });
    await page.mouse.up();
    await page.evaluate(() => window.__opDock._tracker.flush());
    expect(await g4()).toBe(10);
});

test('held inside a selection, a drag moves the block', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.locator('.dock-tab-tracker').click();
    const box = await page.locator('.tracker-canvas').boundingBox();
    const at = (row) => ({ x: box.x + 40, y: box.y + row * 16 + 8 });
    const lane0 = () => page.evaluate(() => Object.values(window.__opProject.get().patterns)[0].notes
        .filter((n) => n.midi !== 64).map((n) => [n.midi, n.start]).sort((a, b) => a[1] - b[1]));

    // Select rows 0–3 of lane 0 (C-4), then hold inside and drag down 2.
    await page.mouse.move(at(0).x, at(0).y);
    await page.mouse.down();
    await page.mouse.move(at(3).x, at(3).y, { steps: 3 });
    await page.mouse.up();
    await page.mouse.move(at(1).x, at(1).y);
    await page.mouse.down();
    await page.waitForTimeout(1100);
    await expect(page.locator('.tracker-status')).toContainText('Move the selection');
    await page.mouse.move(at(3).x, at(3).y, { steps: 4 });
    await page.screenshot({ path: '/tmp/op-shots/tracker-blockmove.png', clip: { x: box.x - 40, y: box.y - 60, width: 420, height: 320 } });
    await page.mouse.up();
    await page.evaluate(() => window.__opDock._tracker.flush());
    expect(await lane0()).toEqual([[60, 2], [67, 8]]);
});

test('Copy: the shadow follows the pointer, a click puts the copy down', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.locator('.dock-tab-tracker').click();
    const box = await page.locator('.tracker-canvas').boundingBox();
    const at = (row) => ({ x: box.x + 40, y: box.y + row * 16 + 8 });
    const lane0 = () => page.evaluate(() => Object.values(window.__opProject.get().patterns)[0].notes
        .filter((n) => n.midi !== 64).map((n) => [n.midi, n.start]).sort((a, b) => a[1] - b[1]));

    // Riff lane 0: C-4 at 0, G-4 at 8. Select rows 0–3 and copy.
    await expect(page.locator('.tracker-copy')).toBeDisabled();
    await page.mouse.move(at(0).x, at(0).y);
    await page.mouse.down();
    await page.mouse.move(at(3).x, at(3).y, { steps: 3 });
    await page.mouse.up();
    await page.locator('.tracker-copy').click();
    await expect(page.locator('.tracker-copy')).toHaveClass(/active/);

    await page.mouse.move(at(12).x, at(12).y, { steps: 3 });
    await page.screenshot({ path: '/tmp/op-shots/tracker-stamp.png', clip: { x: box.x - 40, y: box.y - 60, width: 420, height: 320 } });
    await page.mouse.click(at(12).x, at(12).y);
    await page.evaluate(() => window.__opDock._tracker.flush());
    expect(await lane0()).toEqual([[60, 0], [67, 8], [60, 12]]);
    await expect(page.locator('.tracker-copy')).not.toHaveClass(/active/);

    // Ctrl+C on the grid arms it again (the copy is the selection now).
    await page.keyboard.press('Control+c');
    await expect(page.locator('.tracker-copy')).toHaveClass(/active/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.tracker-copy')).not.toHaveClass(/active/);
});

test('keyboard only: select, Ctrl+C, arrows, Enter — and Escape drops everything', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.locator('.dock-tab-tracker').click();
    const lane0 = () => page.evaluate(() => Object.values(window.__opProject.get().patterns)[0].notes
        .filter((n) => n.midi !== 64).map((n) => [n.midi, n.start]).sort((a, b) => a[1] - b[1]));

    // Put the cursor on row 0 of lane 0 and do the rest with keys.
    const box = await page.locator('.tracker-canvas').boundingBox();
    await page.mouse.click(box.x + 40, box.y + 8);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Control+c');
    await expect(page.locator('.tracker-copy')).toHaveClass(/active/);
    await expect(page.locator('.tracker-status')).toContainText('Arrows move the copy');
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.__opDock._tracker.flush());
    expect(await lane0()).toEqual([[60, 0], [67, 8], [60, 12]]);

    // Ctrl+C again on the new selection, then Escape: stamp and selection gone.
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Escape');
    await expect(page.locator('.tracker-copy')).not.toHaveClass(/active/);
    expect(await page.evaluate(() => window.__opDock._tracker.getSelection())).toBe(null);
});
