// Boot smoke: the app loads clean, renders its furniture, and comes back the
// same way after a reload. The console guard in fixtures.js does the heavy
// lifting — these assertions mostly pin down *what* must be on screen.

import { test, expect, openApp } from './fixtures.js';

test.describe('boot', () => {
    test('loads with no console errors and renders the shell', async ({ page }) => {
        await openApp(page);

        await expect(page).toHaveTitle('OpenPatches');

        // Menu bar and its top-level items.
        await expect(page.locator('#menu-bar')).toBeVisible();
        for (const menu of ['file', 'history', 'midi', 'help']) {
            await expect(page.locator(`.menu-item[data-menu="${menu}"]`)).toBeAttached();
        }

        // Toolbar tabs — the five panels the bottom dock switches between.
        const tabs = page.locator('#piano-dock .tab, #piano-dock [class*="tab-"]');
        expect(await tabs.count()).toBeGreaterThan(0);

        // Keyboard: C2-C6 is 49 keys. Assert the range rather than the exact
        // count so adding an octave doesn't fail an unrelated test.
        const keys = page.locator('.keyboard .key');
        expect(await keys.count()).toBeGreaterThanOrEqual(40);
        await expect(page.locator('.keyboard .key.black').first()).toBeVisible();

        // Status indicators exist before audio/MIDI are touched.
        await expect(page.locator('#audio-status')).toBeAttached();
    });

    test('cross-origin isolation is in force', async ({ page }) => {
        await openApp(page);

        // server.py's COOP/COEP headers are load-bearing: without them
        // SharedArrayBuffer is gone and the WASM synth cannot run. This is the
        // cheapest possible regression test for a server header change.
        const isolated = await page.evaluate(() => ({
            crossOriginIsolated: window.crossOriginIsolated,
            hasSAB: typeof SharedArrayBuffer === 'function',
        }));
        expect(isolated).toEqual({ crossOriginIsolated: true, hasSAB: true });
    });

    test('reload restores saved state without errors', async ({ page }) => {
        await openApp(page);

        // Seed something the app persists, then prove the restore path runs
        // clean. An empty-storage boot and a restoring boot are different code
        // paths in app.js and only the first is covered above.
        await page.evaluate(() => {
            localStorage.setItem('openpatches_canvas', JSON.stringify({ items: [] }));
        });

        await page.reload();
        await expect(page.locator('.keyboard .key').first()).toBeVisible();
        await expect(page).toHaveTitle('OpenPatches');
    });

    test('the tutorial opens on a virgin profile', async ({ page, context }) => {
        // Inverse of the fixture: clear the suppression keys and confirm the
        // first-run tour still fires. Guards against a seeding change silently
        // disabling onboarding for real users.
        await context.clearCookies();
        await page.addInitScript(() => {
            localStorage.removeItem('openpatches_tutorial');
        });
        // Dismiss the demo confirm() so only the tutorial is under test.
        page.on('dialog', (d) => d.dismiss());

        await page.goto('/index.html');
        await expect(page.locator('#tutorial-modal')).toBeVisible();
        await expect(page.locator('#tutorial-title')).not.toBeEmpty();
    });
});
