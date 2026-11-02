// Persistence across real page loads. The unit suite covers the stores
// against a fake localStorage inside one process; what it cannot do is tear
// the world down and boot app.js again on top of what was written. These
// tests do exactly that — including the crash journal, which only exists
// because a real page teardown was measured to drop the IndexedDB write.

import { test, expect, openApp, openRollTab } from './fixtures.js';

const LEGACY_ROLL_KEY = 'openpatches_pianoroll';

function getNotes(page) {
    return page.evaluate(() =>
        window.__opDock._pianoroll.getNotes().map(({ midi, start, dur }) => ({ midi, start, dur })));
}

test.describe('persistence', () => {
    test('notes and tempo survive a reload', async ({ page }) => {
        await openApp(page);
        await openRollTab(page);

        await page.evaluate(() => {
            window.__opDock._pianoroll.addNote({ midi: 62, start: 4, dur: 3 });
        });
        const bpm = page.locator('.pianoroll-bpm');
        await bpm.fill('97');
        await bpm.dispatchEvent('change');

        await page.reload();
        await expect(page.locator('.keyboard .key').first()).toBeVisible();
        await openRollTab(page);

        expect(await getNotes(page)).toEqual([{ midi: 62, start: 4, dur: 3 }]);
        await expect(page.locator('.pianoroll-bpm')).toHaveValue('97');
    });

    test('a legacy piano-roll blob is ignored — Project is a clean break', async ({ page }) => {
        // Project is a major version change with no retro-compatibility:
        // the pre-Patterns blob is not read, and must not be able to
        // resurrect itself into a fresh workspace.
        await page.addInitScript(([key, payload]) => {
            localStorage.setItem(key, JSON.stringify(payload));
        }, [LEGACY_ROLL_KEY, {
            measures: 1,
            bpm: 140,
            notes: [{ midi: 60, start: 0, dur: 2, slot: 0 }],
        }]);

        await openApp(page);
        await openRollTab(page);

        expect(await getNotes(page)).toEqual([]);
        await expect(page.locator('.pianoroll-bpm')).toHaveValue('120');
        // And it is left where it is rather than deleted — not ours to bin.
        expect(await page.evaluate((k) => !!localStorage.getItem(k), LEGACY_ROLL_KEY)).toBe(true);
    });

    test('an edit the page dies holding is recovered from the journal', async ({ page }) => {
        // Measured: on a reload the unload handlers do run and the
        // IndexedDB write still does not commit. The synchronous
        // localStorage journal is what makes this survive at all.
        await openApp(page);
        await openRollTab(page);
        await page.evaluate(() => {
            window.__opDock._pianoroll.addNote({ midi: 55, start: 0, dur: 1 });
        });
        expect(await page.evaluate(() => window.__opProject.isDirty())).toBe(true);

        await page.reload();
        await expect(page.locator('.keyboard .key').first()).toBeVisible();
        await openRollTab(page);
        expect(await getNotes(page)).toEqual([{ midi: 55, start: 0, dur: 1 }]);

        // And once recovered it is written properly, so the scratch copy goes.
        await expect
            .poll(() => page.evaluate(() => localStorage.getItem('openpatches_project_journal')))
            .toBe(null);
    });
});
