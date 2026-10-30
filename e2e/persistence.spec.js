// Persistence across real page loads. The unit suite covers the stores
// against a fake localStorage inside one process; what it cannot do is tear
// the world down and boot app.js again on top of what was written. These
// tests do exactly that — including booting on top of a *legacy* world, the
// pre-Patterns piano-roll blob, which only the migration still reads.

import { test, expect, openApp, openRollTab } from './fixtures.js';

const LEGACY_ROLL_KEY = 'openpatches_pianoroll';
const MIGRATION_KEY = 'openpatches_seq_migrated';
const PATTERNS_KEY = 'openpatches_patterns';

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

    test('a legacy piano-roll blob is migrated into the song world', async ({ page }) => {
        // Seed the pre-Patterns store the way the old roll wrote it, before
        // any app code runs. Only migrateIfNeeded() still reads this key.
        await page.addInitScript(([key, payload]) => {
            if (!localStorage.getItem('openpatches_seq_migrated')) {
                localStorage.setItem(key, JSON.stringify(payload));
            }
        }, [LEGACY_ROLL_KEY, {
            measures: 1,
            bpm: 140,
            notes: [
                { midi: 60, start: 0, dur: 2, slot: 0 },
                { midi: 67, start: 4, dur: 1, slot: 0 },
            ],
        }]);

        await openApp(page);
        await openRollTab(page);

        // The user's notes came through, at the user's tempo.
        expect(await getNotes(page)).toEqual([
            { midi: 60, start: 0, dur: 2 },
            { midi: 67, start: 4, dur: 1 },
        ]);
        await expect(page.locator('.pianoroll-bpm')).toHaveValue('140');

        const after = await page.evaluate(([migKey, patKey]) => ({
            marker: JSON.parse(localStorage.getItem(migKey)),
            patterns: Object.keys(JSON.parse(localStorage.getItem(patKey) || '{}')).length,
        }), [MIGRATION_KEY, PATTERNS_KEY]);
        expect(after.marker?.version).toBeGreaterThanOrEqual(1);
        expect(after.patterns).toBeGreaterThanOrEqual(1);

        // Second boot on the migrated world: same notes, and — the property
        // the migration promises — no duplicated library entries.
        await page.reload();
        await expect(page.locator('.keyboard .key').first()).toBeVisible();
        await openRollTab(page);

        expect(await getNotes(page)).toHaveLength(2);
        const patternsAfterReload = await page.evaluate((patKey) =>
            Object.keys(JSON.parse(localStorage.getItem(patKey) || '{}')).length, PATTERNS_KEY);
        expect(patternsAfterReload).toBe(after.patterns);
    });
});
