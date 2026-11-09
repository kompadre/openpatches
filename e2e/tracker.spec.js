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
