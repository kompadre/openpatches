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

/** Three sections, S1 S2 S3 placed once each, Section 3 on screen. */
async function threeSections(page) {
    await openApp(page);
    await openSectionPane(page);
    await page.locator('.section-add').click();
    await page.locator('.section-add').click();
    await expect(page.locator('.section-piece-block-name')).toHaveText(['Section 1', 'Section 2', 'Section 3']);
}

async function drag(page, from, to, { alt = false } = {}) {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.move(a.x + a.width / 2 + 6, a.y + a.height / 2, { steps: 2 });
    await page.mouse.move(b.x + 3, b.y + b.height / 2, { steps: 4 });         // the left edge: before it
    await expect(page.locator('.section-piece-marker')).toBeVisible();
    if (alt) await expect(page.locator('.section-piece-strip.drag-copy')).toHaveCount(1);
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
}

test('dragging a block reorders the piece; the marker shows where it lands', async ({ page }) => {
    await threeSections(page);
    const blocks = page.locator('.section-piece-block');
    await drag(page, blocks.nth(2), blocks.nth(0));
    await expect(page.locator('.section-piece-block-name')).toHaveText(['Section 3', 'Section 1', 'Section 2']);
    await expect(page.locator('.section-piece-marker')).toHaveCount(0);
    await expect(blocks.nth(0)).toHaveClass(/picked/);
    // A plain click after a drag still picks.
    await blocks.nth(2).click();
    await expect(page.locator('.section-name')).toHaveValue('Section 2');
});

test('Alt-drag places the section again where it is dropped', async ({ page }) => {
    await threeSections(page);
    const blocks = page.locator('.section-piece-block');
    await drag(page, blocks.nth(0), blocks.nth(2), { alt: true });
    await expect(page.locator('.section-piece-block-name')).toHaveText(['Section 1', 'Section 2', 'Section 1', 'Section 3']);
    await expect(page.locator('.section-piece-usage')).toHaveText('2nd of 2');
    await expect(page.locator('.section-pick option').first()).toHaveText('Section 1 · ×2');
});

test('Escape cancels a drag', async ({ page }) => {
    await threeSections(page);
    const blocks = page.locator('.section-piece-block');
    const a = await blocks.nth(2).boundingBox();
    const b = await blocks.nth(0).boundingBox();
    await page.mouse.move(a.x + 5, a.y + 5);
    await page.mouse.down();
    await page.mouse.move(b.x + 3, b.y + 5, { steps: 4 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.locator('.section-piece-block-name')).toHaveText(['Section 1', 'Section 2', 'Section 3']);
    await expect(page.locator('.section-piece-marker')).toHaveCount(0);
});

test('the block menu: make a copy, remove from piece, remove section (asks)', async ({ page }) => {
    await threeSections(page);
    const blocks = page.locator('.section-piece-block');
    const menu = page.locator('.section-piece-menu');

    await blocks.nth(0).click();
    await page.locator('.section-place').click();                     // S1 S2 S3 S1
    await blocks.nth(3).click({ button: 'right' });
    await expect(menu).toBeVisible();
    await menu.locator('.section-piece-menu-copy').click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator('.section-piece-block-name')).toHaveText(['Section 1', 'Section 2', 'Section 3', 'Section 1 copy']);
    await expect(page.locator('.section-name')).toHaveValue('Section 1 copy');

    await blocks.nth(1).click({ button: 'right' });
    await menu.locator('.section-piece-menu-unplace').click();
    await expect(page.locator('.section-piece-block-name')).toHaveText(['Section 1', 'Section 3', 'Section 1 copy']);
    await expect(page.locator('.section-pick option', { hasText: 'Section 2' })).toHaveText('Section 2 · unused');

    // Remove section asks; dismissing keeps it, accepting removes every placement.
    await blocks.nth(0).click({ button: 'right' });
    page.once('dialog', d => d.dismiss());
    await menu.locator('.section-piece-menu-remove').click();
    await expect(page.locator('.section-piece-block')).toHaveCount(3);
    await blocks.nth(0).click({ button: 'right' });
    let message = '';
    page.once('dialog', d => { message = d.message(); d.accept(); });
    await menu.locator('.section-piece-menu-remove').click();
    await expect(page.locator('.section-piece-block-name')).toHaveText(['Section 3', 'Section 1 copy']);
    expect(message).toMatch(/Remove section "Section 1".*cannot be undone/);

    // Escape and a click elsewhere close it.
    await blocks.nth(0).click({ button: 'right' });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await blocks.nth(0).click({ button: 'right' });
    await page.locator('.section-grid').click({ position: { x: 5, y: 5 } });
    await expect(menu).toHaveCount(0);
});

test('keyboard: Alt+arrows move the focused block, Delete takes it out', async ({ page }) => {
    await threeSections(page);
    const blocks = page.locator('.section-piece-block');
    await blocks.nth(0).focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('.section-piece-block-name')).toHaveText(['Section 2', 'Section 1', 'Section 3']);
    await expect(blocks.nth(1)).toBeFocused();                         // focus survives the re-render
    await page.keyboard.press('Delete');
    await expect(page.locator('.section-piece-block-name')).toHaveText(['Section 2', 'Section 3']);
    await expect(page.locator('.section-name')).toHaveValue('Section 3');
    await expect(blocks.nth(1)).toBeFocused();
});

test('playback: the playing block is lit, double-click plays from a block, the folded header counts along', async ({ page }) => {
    await openApp(page);
    await openSectionPane(page);
    await page.locator('.section-add-track').click();
    await page.locator('.section-pattern-new').click();
    await page.evaluate(() => window.__opProject.update((p) => {
        for (const pat of Object.values(p.patterns)) pat.notes = [{ midi: 60, start: 0, dur: 1 }];
    }, 'e2e'));
    await page.locator('.section-place').click();                     // S1 S1
    await page.locator('.section-add').click();                       // S1 S1 S2 (empty: takes no room)
    await page.locator('.section-pick').selectOption({ label: 'Section 1 · ×2' });

    // Double-click the second block: the piece plays from bar 2, so the
    // second block lights first, not the first.
    await page.locator('.section-piece-block').nth(1).dblclick();
    await expect(page.locator('.transport-play')).toHaveText('▶ Play Piece');
    await expect(page.locator('.section-piece-block').nth(1)).toHaveClass(/playing/);
    await expect(page.locator('.section-piece-block').nth(0)).not.toHaveClass(/playing/);
    await expect(page.locator('.section-piece-playing')).toHaveText('▶ 2 of 3');
    // It loops round: the first block's turn comes.
    await expect(page.locator('.section-piece-block').nth(0)).toHaveClass(/playing/, { timeout: 5000 });

    await page.locator('.section-piece-toggle').click();
    await expect(page.locator('.section-piece-block')).toHaveCount(0);
    await expect(page.locator('.section-piece-playing')).toHaveText(/▶ [12] of 3/);
    await page.locator('.transport-stop').click();
    await expect(page.locator('.section-piece-playing')).toBeHidden();
});
