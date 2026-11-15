// Phase 4: more than one section, played end to end, with a tempo ramp.
import { test, expect, openApp, openSectionPane, chooseScope } from './fixtures.js';

test('sections: add, pick, reorder; piece playback follows the playhead', async ({ page }) => {
    await openApp(page);
    await openSectionPane(page);
    await page.locator('.section-add-track').click();
    await page.locator('.section-pattern-new').click();
    await page.locator('.section-add').click();
    await expect(page.locator('.section-pick option')).toHaveText(['Section 1', 'Section 2']);
    await expect(page.locator('.section-piece-block')).toHaveCount(2);
    await expect(page.locator('.section-clip')).toHaveCount(0);
    await page.locator('.section-pattern-new').click();
    await page.evaluate(() => window.__opProject.update((p) => {
        for (const pat of Object.values(p.patterns)) pat.notes = [{ midi: 60, start: 0, dur: 1 }];
        p.sections[0].bpmEnd = 200;
    }, 'e2e'));
    // ◀ moves the picked block (Section 2's) earlier in the piece; the
    // select is the library and keeps its order.
    await page.locator('.section-move-up').click();
    await expect(page.locator('.section-piece-block-name')).toHaveText(['Section 2', 'Section 1']);
    await expect(page.locator('.section-pick option')).toHaveText(['Section 1', 'Section 2']);
    await expect(page.locator('.section-bpm-end')).toHaveValue('');       // Section 2's: none
    await page.locator('.section-pick').selectOption({ label: 'Section 1' });
    await expect(page.locator('.section-bpm-end')).toHaveValue('200');
    await page.screenshot({ path: '/tmp/probe-oak/p4.png', clip: { x: 30, y: 30, width: 390, height: 200 } });

    // Piece: 2 one-bar sections at 120 → ~1 s each. The pane follows.
    await chooseScope(page, 'piece');
    await expect(page.locator('.transport-play')).toHaveText('▶ Play Piece');
    await page.locator('.section-pick').selectOption({ label: 'Section 2' });
    await page.locator('.transport-play').click();
    await expect.poll(() => page.evaluate(() => window.__opProject.getSection().name), { timeout: 5000 }).toBe('Section 1');
    await expect.poll(() => page.evaluate(() => window.__opProject.getSection().name), { timeout: 5000 }).toBe('Section 2');
    const bpm = await page.evaluate(() => window.__opDock._pianoroll.getTransport().getEffectiveBpm());
    await page.locator('.transport-stop').click();
    expect(bpm).toBeGreaterThanOrEqual(120);
});

test('a section placed twice plays twice; − From piece leaves it in the list', async ({ page }) => {
    await openApp(page);
    await openSectionPane(page);
    await page.locator('.section-add-track').click();
    await page.locator('.section-pattern-new').click();
    await page.locator('.section-add').click();                       // S1 S2
    await page.locator('.section-pick').selectOption({ label: 'Section 1' });
    await page.locator('.section-place').click();                     // S1 S2 S1
    await expect(page.locator('.section-piece-block-name')).toHaveText(['Section 1', 'Section 2', 'Section 1']);
    await expect(page.locator('.section-pick option')).toHaveText(['Section 1 · ×2', 'Section 2']);
    await expect(page.locator('.section-piece-usage')).toHaveText('2nd of 2');
    const parts = await page.evaluate(async () => {
        const M = await import('/html/components/project-model.js');
        return M.pieceLayout(window.__opProject.get()).parts.map(p => p.section.name);
    });
    expect(parts).toEqual(['Section 1', 'Section 2', 'Section 1']);

    await page.locator('.section-piece-block').nth(1).click();          // Section 2
    await page.locator('.section-unplace').click();
    await expect(page.locator('.section-piece-block-name')).toHaveText(['Section 1', 'Section 1']);
    await expect(page.locator('.section-pick option')).toHaveText(['Section 1 · ×2', 'Section 2 · unused']);
    await expect(page.locator('.section-piece-usage')).toHaveText('not in the piece');
});

test('folded, the Piece header still names the section on screen', async ({ page }) => {
    await openApp(page);
    await openSectionPane(page);
    await page.locator('.section-add').click();
    await page.locator('.section-piece-toggle').click();
    await expect(page.locator('.section-piece-block')).toHaveCount(0);
    await expect(page.locator('.section-name')).toHaveValue('Section 2');
    await page.reload();
    await openSectionPane(page);
    await expect(page.locator('.section-piece-block')).toHaveCount(0);   // remembered
    await page.locator('.section-piece-toggle').click();
    await expect(page.locator('.section-piece-block')).toHaveCount(2);
});
