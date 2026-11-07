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
