// Phase 3: clips show their notes as dots, the library places patterns by
// drag, and the Pattern tab switches patterns itself.
import { test, expect, openApp, openSectionPane, openRollTab } from './fixtures.js';

test('library drag, clip dots, and the roll\'s Pattern select', async ({ page }) => {
    await openApp(page);
    await openSectionPane(page);
    for (let i = 0; i < 2; i++) await page.locator('.section-add-track').click();
    await page.locator('.section-track-head').nth(0).click();
    await page.locator('.section-pattern-new').click();
    await page.evaluate(() => {
        const id = Object.keys(window.__opProject.get().patterns)[0];
        window.__opProject.update((p) => { p.patterns[id].notes = [{ midi: 60, start: 0, dur: 1 }]; }, 'e2e');
    });
    // The clip carries a dot map once its pattern has notes.
    await expect.poll(() => page.locator('.section-clip').first().evaluate(el => el.style.backgroundImage))
        .toMatch(/^url\("?data:image\/png/);

    // Drag the library item onto lane 2, bar 3.
    const item = await page.locator('.section-library-item').first().boundingBox();
    const lane = await page.locator('.section-lane').nth(1).boundingBox();
    const bar = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.section-grid')).getPropertyValue('--section-measure-h')));
    await page.mouse.move(item.x + 10, item.y + 10);
    await page.mouse.down();
    await page.mouse.move(lane.x + 10, lane.y + bar * 2 + 5, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.section-clip')).toHaveCount(2);
    await expect(page.locator('.section-library-uses').first()).toHaveText('×2');

    // A second pattern, then switch back to the first from the roll.
    await page.locator('.section-track-head').nth(1).click();
    await page.locator('.section-pattern-new').click();
    await openRollTab(page);
    await expect(page.locator('.dock-tab-pianoroll')).toHaveText(/Pattern/);
    const sel = page.locator('.pianoroll-pattern');
    await expect(sel.locator('option')).toHaveText(['Pattern 1', 'Pattern 2']);
    await sel.selectOption({ label: 'Pattern 1' });
    expect(await page.evaluate(() => window.__opDock._pianoroll.getNotes().map(n => n.midi))).toEqual([60]);
});
