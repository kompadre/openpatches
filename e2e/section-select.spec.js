// Section clips: Shift-drag a marquee over two lanes, Copy, and stamp the
// pair further down — in a real browser, with real layout.
import { test, expect, openApp, openSectionPane } from './fixtures.js';

test('marquee, Copy and stamp in the Section pane', async ({ page }) => {
    await openApp(page);
    await openSectionPane(page);
    for (let i = 0; i < 3; i++) await page.locator('.section-add-track').click();
    for (const i of [0, 1]) {
        await page.locator('.section-track-head').nth(i).click();
        await page.locator('.section-pattern-new').click();
    }
    const lanes = page.locator('.section-lane');
    const l0 = await lanes.nth(0).boundingBox();
    const l1 = await lanes.nth(1).boundingBox();
    const bar = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.section-grid')).getPropertyValue('--section-measure-h')));

    // From an empty spot in bar 3 of lane 1, up into the clips of bar 1.
    await page.keyboard.down('Shift');
    await page.mouse.move(l0.x + 5, l0.y + bar * 2 + 10);
    await page.mouse.down();
    await page.mouse.move(l1.x + 20, l1.y + 20, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect(page.locator('.section-clip.picked')).toHaveCount(2);

    await page.locator('.section-copy').click();
    await page.mouse.move(l1.x + 20, l1.y + bar * 3 + 10, { steps: 4 });
    await expect(page.locator('.section-stamp-ghost')).toHaveCount(2);
    await page.mouse.down();
    await page.mouse.up();

    await expect(page.locator('.section-clip')).toHaveCount(4);
    await expect(page.locator('.section-stamp-ghost')).toHaveCount(0);
    const placed = await page.evaluate(() => {
        const p = window.__opProject.get();
        const s = window.__opProject.getSection();
        const order = p.tracks.map(t => t.id);
        return s.clips.slice(2).map(c => [order.indexOf(c.trackId), c.startCol]);
    });
    expect(placed).toEqual([[1, 48], [2, 48]]);    // lanes 2–3, bar 4
});
