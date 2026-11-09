// Patches dragged onto voices: a Mixer slot, a Section lane, or the
// Section's empty grid (a new track) — by a row's star (HTML5 drag) and by
// a floating patch's header (pointer drag).
import { test, expect, openApp, openPatchesTab, openSectionPane } from './fixtures.js';

async function seed(page) {
    return page.evaluate(async () => {
        const pm = await import('/html/components/patch-model.js');
        const cv = await import('/html/components/canvas.js');
        const mk = (name, fill) => {
            const p = pm.createPatch({ name, voice_data: btoa(String.fromCharCode(...new Uint8Array(128).fill(fill))) });
            pm.patchStore.put(p);
            return p;
        };
        const a = mk('ROWPATCH', 9), b = mk('LANEPATCH', 11), f = mk('FLOATER', 7);
        cv.addContainer('Box', { patchIds: [a.id, b.id], left: 420, top: 120 });
        // High enough to clear the keyboard strip under the Patches canvas.
        pm.canvasStore.putCanvasPatch(f.id, { left: 760, top: 300 });
        cv.refreshCanvas();
        return { a: a.id, b: b.id, f: f.id };
    });
}

/** HTML5 drag from a container row's star to a point. */
async function starDrag(page, rowText, to) {
    const star = page.locator('.sky-container .patch-row', { hasText: rowText }).locator('.patch-drag');
    const s = await star.boundingBox();
    await page.mouse.move(s.x + 4, s.y + 4);
    await page.mouse.down();
    await page.mouse.move(s.x + 30, s.y + 30, { steps: 5 });
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
}

const tracks = (page) => page.evaluate(() => window.__opProject.get().tracks.map(t => [t.slot, t.name]));
const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

test('a row onto an empty Mixer slot makes the track', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await openPatchesTab(page);
    await starDrag(page, 'ROWPATCH', centre(await page.locator('.voicebank-item').nth(1).boundingBox()));
    await expect(page.locator('.voicebank-item').nth(1)).toContainText('ROWPATCH');
    expect(await tracks(page)).toEqual([[1, 'ROWPATCH']]);
});

test('onto a Section lane it becomes that track\'s voice; onto empty grid, a new track — each time', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await openSectionPane(page);
    await openPatchesTab(page);
    await page.locator('.section-add-track').click();              // track on slot 0, no patch
    await starDrag(page, 'LANEPATCH', centre(await page.locator('.section-lane').first().boundingBox()));
    await expect.poll(() => tracks(page)).toEqual([[0, 'LANEPATCH']]);

    // A floating patch onto the grid's empty space, right of the lanes.
    const grid = await page.locator('.section-grid').boundingBox();
    const empty = { x: grid.x + grid.width - 30, y: grid.y + grid.height / 2 };
    const drop = async () => {
        const f = await page.locator('.patch-float').first().boundingBox();
        await page.mouse.move(f.x + 20, f.y + 8);
        await page.mouse.down();
        await page.mouse.move(empty.x, empty.y, { steps: 10 });
        await page.mouse.up();
    };
    await drop();
    await expect.poll(() => tracks(page)).toEqual([[0, 'LANEPATCH'], [1, 'FLOATER']]);
    await expect(page.locator('.section-lane')).toHaveCount(2);
    await drop();                                                    // the same voice again: a second track of it
    await expect.poll(() => tracks(page)).toEqual([[0, 'LANEPATCH'], [1, 'FLOATER'], [2, 'FLOATER']]);
    await expect(page.locator('.section-lane')).toHaveCount(3);
});
