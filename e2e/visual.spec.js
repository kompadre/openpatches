// Small visual regression net. Deliberately tiny: a handful of stable,
// DOM-built panels whose look nobody re-checks by hand after CSS work. No
// full-page shots — the night sky and the spectrograms animate — and every
// canvas inside a captured region is masked, so only styling can fail this.
//
// Baselines live in e2e/visual.spec.js-snapshots/ and are Linux-Chromium
// renders; regenerate with `npx playwright test e2e/visual.spec.js
// --update-snapshots` after an intentional style change, and eyeball the
// diff image in test-results/ before accepting an unintentional one.

import { test, expect, openApp, openRollTab, openMixerTab } from './fixtures.js';

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

    test('piano roll tab: transport row and keyboard', async ({ page }) => {
        await openRollTab(page);

        // The roll's chrome — tab strip, transport controls, keyboard —
        // with the grid canvas itself masked out. (The voice bank moved to
        // the Mixer tab, below.)
        await expect(page.locator('#piano-dock')).toHaveScreenshot('pianoroll-tab.png', {
            ...SHOT,
            mask: [page.locator('#piano-dock canvas')],
        });
    });

    test('mixer tab: channel strips, mute and solo', async ({ page }) => {
        // Seeded through the bank's own write path with fixed names and
        // bytes, so the strips are identical on every run.
        await page.evaluate(() => {
            const vb = window.__opDock._voiceBank;
            const voice = (fill) => btoa(String.fromCharCode(...new Uint8Array(128).fill(fill)));
            vb._assignToSlot(0, { name: 'BRASS', voiceData: voice(1) });
            vb._assignToSlot(1, { name: 'STRINGS', voiceData: voice(2) });
            vb._assignToSlot(3, { name: 'BASS', voiceData: voice(3) });
            vb._toggleMute(1);
            vb._toggleSolo(3);
        });
        await openMixerTab(page);

        // Every strip state in one frame: plain, muted, soloed, empty.
        // The pane's viewport, not the bank: the bank is as wide as all
        // eight strips and scrolls inside it, so its own box would include
        // the clipped part — pixels belonging to the neighbouring panes.
        await expect(page.locator('.bpane-content-mixer').locator('xpath=..'))
            .toHaveScreenshot('mixer-tab.png', SHOT);
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
