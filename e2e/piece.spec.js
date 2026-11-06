// Phase 4: more than one section, played end to end, with a tempo ramp.
import { test, expect, openApp, openSectionPane, chooseScope } from './fixtures.js';

test('sections: add, pick, reorder; piece playback follows the playhead', async ({ page }) => {
    await openApp(page);
    await openSectionPane(page);
    await page.locator('.section-add-track').click();
    await page.locator('.section-pattern-new').click();
    await page.locator('.section-add').click();
    await expect(page.locator('.section-pick option')).toHaveText(['1. Section 1', '2. Section 2']);
    await expect(page.locator('.section-clip')).toHaveCount(0);
    await page.locator('.section-pattern-new').click();
    await page.evaluate(() => window.__opProject.update((p) => {
        for (const pat of Object.values(p.patterns)) pat.notes = [{ midi: 60, start: 0, dur: 1 }];
        p.sections[0].bpmEnd = 200;
    }, 'e2e'));
    await page.locator('.section-move-up').click();
    await expect(page.locator('.section-pick option')).toHaveText(['1. Section 2', '2. Section 1']);
    await expect(page.locator('.section-bpm-end')).toHaveValue('');       // Section 2's: none
    await page.locator('.section-pick').selectOption({ label: '2. Section 1' });
    await expect(page.locator('.section-bpm-end')).toHaveValue('200');
    await page.screenshot({ path: '/tmp/probe-oak/p4.png', clip: { x: 30, y: 30, width: 390, height: 200 } });

    // Piece: 2 one-bar sections at 120 → ~1 s each. The pane follows.
    await chooseScope(page, 'piece');
    await expect(page.locator('.transport-play')).toHaveText('▶ Play Piece');
    await page.locator('.section-pick').selectOption({ label: '1. Section 2' });
    await page.locator('.transport-play').click();
    await expect.poll(() => page.evaluate(() => window.__opProject.getSection().name), { timeout: 5000 }).toBe('Section 1');
    await expect.poll(() => page.evaluate(() => window.__opProject.getSection().name), { timeout: 5000 }).toBe('Section 2');
    const bpm = await page.evaluate(() => window.__opDock._pianoroll.getTransport().getEffectiveBpm());
    await page.locator('.transport-stop').click();
    expect(bpm).toBeGreaterThanOrEqual(120);
});
