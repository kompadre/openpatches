// A floating patch dragged from the canvas onto a Mixer slot is assigned there.
import { test, expect, openApp, openMixerTab, openPatchesTab } from './fixtures.js';

test('drag a canvas patch onto a Mixer slot', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => {
        const pm = await import('/html/components/patch-model.js');
        const cv = await import('/html/components/canvas.js');
        const bytes = btoa(String.fromCharCode(...new Uint8Array(128).fill(7)));
        const patch = pm.createPatch({ name: 'DROPME', voice_data: bytes });
        pm.patchStore.put(patch);
        pm.canvasStore.putCanvasPatch(patch.id, { left: 300, top: 200 });
        cv.refreshCanvas();
    });
    await openPatchesTab(page);
    await openMixerTab(page);
    const from = await page.locator('.patch-float').first().boundingBox();
    const slot = await page.locator('.voicebank-item').nth(1).boundingBox();
    await page.mouse.move(from.x + 20, from.y + 8);
    await page.mouse.down();
    await page.mouse.move(slot.x + slot.width / 2, slot.y + slot.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('.voicebank-item').nth(1)).toContainText('DROPME');
    const left = await page.locator('.patch-float').first().evaluate(el => el.style.left);
    expect(left).toBe('300px');          // the patch went home
});
