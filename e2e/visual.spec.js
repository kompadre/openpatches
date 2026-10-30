// Small visual regression net. Deliberately tiny: a handful of stable,
// DOM-built panels whose look nobody re-checks by hand after CSS work. No
// full-page shots — the night sky and the spectrograms animate — and every
// canvas inside a captured region is masked, so only styling can fail this.
//
// Baselines live in e2e/visual.spec.js-snapshots/ and are Linux-Chromium
// renders; regenerate with `npx playwright test e2e/visual.spec.js
// --update-snapshots` after an intentional style change, and eyeball the
// diff image in test-results/ before accepting an unintentional one.

import { test, expect, openApp, openRollTab } from './fixtures.js';

// Font rasterization wobbles a little across kernels/fontconfig; allow a
// small per-pixel tolerance rather than chasing antialiasing ghosts.
const SHOT = { maxDiffPixelRatio: 0.02, animations: 'disabled' };

test.describe('visual regression', () => {
    test.beforeEach(async ({ page }) => {
        await openApp(page);
    });

    test('menu bar', async ({ page }) => {
        await expect(page.locator('#menu-bar')).toHaveScreenshot('menu-bar.png', SHOT);
    });

    test('keyboard', async ({ page }) => {
        await expect(page.locator('.keyboard-wrapper')).toHaveScreenshot('keyboard.png', SHOT);
    });

    test('piano roll tab: transport row and voicebank', async ({ page }) => {
        await openRollTab(page);

        // The roll's chrome — tab strip, transport controls, voicebank
        // list — with the grid canvas itself masked out.
        await expect(page.locator('#piano-dock')).toHaveScreenshot('pianoroll-tab.png', {
            ...SHOT,
            mask: [page.locator('#piano-dock canvas')],
        });
    });

    test('MIDI settings modal', async ({ page }) => {
        // DOM-built from scratch on every open (midi-panel.js) and touched
        // by almost every MIDI feature — the panel most likely to be broken
        // by an unrelated style or markup change.
        await page.locator('.menu-item[data-menu="midi"] .menu-label').click();
        await page.locator('#menu-midi-devices').click();
        await expect(page.locator('.modal-dialog:visible')).toHaveScreenshot('midi-modal.png', SHOT);
    });
});
