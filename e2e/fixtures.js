// Shared e2e fixtures.
//
// Two jobs:
//   1. Get the app to a usable first screen. A virgin profile opens the
//      tutorial modal over everything and then asks, via confirm(), whether to
//      load DEMO.syx — both block every other interaction, so the keys that
//      suppress them are seeded before any app code runs.
//   2. Fail a test on any console error or uncaught exception. That guard is
//      most of the reason this layer exists: the node harness can't see a
//      browser-only throw, and a silent one here used to only turn up by hand.

import { test as base, expect } from '@playwright/test';

// Keys read by html/components/tutorial.js and html/app.js on load.
const TUTORIAL_KEY = 'openpatches_tutorial';
const DEMO_OFFERED_KEY = 'openpatches_demo_offered';

/**
 * Console messages that are expected noise rather than a defect. Keep this
 * list short and specific — a broad pattern here hides the bugs the guard is
 * supposed to catch.
 */
const IGNORED_CONSOLE = [
    /favicon/i,                       // not served in every page context
    /\/api\/play/,                    // no backend under test: app falls back
    /DX7 synth unavailable/,          // same path, warned by app.js
];

function isIgnored(text) {
    return IGNORED_CONSOLE.some((re) => re.test(text));
}

export const test = base.extend({
    /**
     * A page with first-run prompts suppressed and a console guard attached.
     * `errors` is live — assert on it at the end of a test, or let the
     * auto-check below fail the test for you.
     */
    page: async ({ page }, use) => {
        await page.addInitScript(([tutorialKey, demoKey]) => {
            localStorage.setItem(tutorialKey, 'completed');
            localStorage.setItem(demoKey, '1');
        }, [TUTORIAL_KEY, DEMO_OFFERED_KEY]);

        const errors = [];
        page.on('pageerror', (err) => errors.push(`uncaught: ${err.message}`));
        page.on('console', (msg) => {
            if (msg.type() !== 'error') return;
            const text = msg.text();
            if (!isIgnored(text)) errors.push(`console.error: ${text}`);
        });
        page.on('requestfailed', (req) => {
            const url = req.url();
            // ERR_ABORTED is how Chromium reports a request handed off to the
            // downloader (and a navigation cancelling fetches) — not a failure.
            if (req.failure()?.errorText === 'net::ERR_ABORTED') return;
            if (!isIgnored(url)) {
                errors.push(`request failed: ${url} (${req.failure()?.errorText})`);
            }
        });

        // Hand the collector to the test so it can scope or inspect it.
        page.opErrors = errors;

        await use(page);

        expect(errors, 'browser reported errors during the test').toEqual([]);
    },
});

/**
 * Load the app and wait until app.js has built the UI. The keyboard is the
 * last thing the toolbar renders, so its presence means the module graph
 * resolved — a bare `goto` returns well before that.
 */
export async function openApp(page) {
    await page.goto('/index.html');
    await expect(page.locator('.keyboard .key').first()).toBeVisible();
    await expect(page.locator('#piano-dock')).toBeAttached();
}

/**
 * Open the Piano Roll tab. Its own Play/Stop pair is the desktop control —
 * `.kb-btn-play` on the keyboard is mobile-only and is not clickable at this
 * viewport, so UI-level transport and roll tests have to go through here.
 */
export async function openRollTab(page) {
    await page.locator('.dock-tab', { hasText: 'Piano Roll' }).click();
    await expect(page.locator('.pianoroll-play')).toBeVisible();
}

/**
 * Reveal the Mixer — where the voice bank lives on every viewport. A tab
 * switch on mobile; on desktop the tab *toggles* the Mixer item in the
 * bottom pane, so only click when the bank is not already on screen.
 */
export async function openMixerTab(page) {
    const bank = page.locator('.voicebank');
    if (!(await bank.isVisible())) await page.locator('.dock-tab-mixer').click();
    await expect(bank).toBeVisible();
}

/**
 * Open the Patches tab — the night sky, containers and patch rows. The
 * canvas used to be a permanent half of the desktop page and needed no
 * opening; it is a tab like any other now, so anything that clicks a patch
 * row has to come through here first.
 */
export async function openPatchesTab(page) {
    await page.locator('.dock-tab-canvas').click();
    await expect(page.locator('#night-sky')).toBeVisible();
}

/**
 * Reveal the Section editor. A tab switch on mobile; on desktop the Section
 * tab *toggles* the left pane, so only click when the editor is not already
 * on screen.
 */
export async function openSectionPane(page) {
    const editor = page.locator('.section-editor');
    if (!(await editor.isVisible())) await page.locator('.dock-tab-section').click();
    await expect(editor).toBeVisible();
}

export { expect };
