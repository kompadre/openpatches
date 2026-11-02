// The project store in a real browser: a real IndexedDB, a real profile in
// localStorage, and the footer's save light driven by both.
//
// The unit suite proves the store's logic against a memory backend. This
// proves the parts a stub cannot: that a body actually lands in IndexedDB,
// survives a reload, and that the indicator the user reads agrees with it.

import { test, expect, openApp } from './fixtures.js';

const PROFILE_KEY = 'openpatches_profile';

const profile = (page) => page.evaluate((k) =>
    JSON.parse(localStorage.getItem(k) || 'null'), PROFILE_KEY);

const bodyIds = (page) => page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('openpatches_projects');
    req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('projects', 'readonly');
        const q = tx.objectStore('projects').getAllKeys();
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
}));

/** The store only autosaves at long intervals; force the write. */
const flush = (page) => page.evaluate(() => window.__opProject.flush());

test.describe('the project store', () => {
    test('a project is created, written to IndexedDB and indexed', async ({ page }) => {
        await openApp(page);
        await expect.poll(() => bodyIds(page)).toHaveLength(1);

        const [id] = await bodyIds(page);
        const p = await profile(page);
        expect(p.currentProjectId).toBe(id);
        expect(p.projects).toHaveLength(1);
        expect(p.projects[0].name).toBe('Untitled project');
    });

    test('an edit survives a reload — the body really round-trips', async ({ page }) => {
        await openApp(page);
        await expect.poll(() => bodyIds(page)).toHaveLength(1);

        await page.evaluate(() => {
            window.__opProject.update((project) => {
                project.name = 'Nocturne';
                project.bpm = 96;
                project.sections[0].bpm = 72;     // the Allegro override
            }, 'e2e');
        });
        await flush(page);

        await page.reload();
        await expect(page.locator('.keyboard .key').first()).toBeVisible();
        await expect.poll(() => page.evaluate(() => {
            const p = window.__opProject.get();
            return p && { name: p.name, bpm: p.bpm, sectionBpm: p.sections[0].bpm };
        })).toEqual({ name: 'Nocturne', bpm: 96, sectionBpm: 72 });

        // The section override is what the transport would play at.
        expect(await page.evaluate(() => window.__opProject.getBpm())).toBe(72);
        expect((await profile(page)).projects[0].name).toBe('Nocturne');
    });

    test('a second project is a separate body, and the first is untouched', async ({ page }) => {
        await openApp(page);
        await expect.poll(() => bodyIds(page)).toHaveLength(1);
        const [first] = await bodyIds(page);

        await page.evaluate(() => window.__opProject.createNew('Second', 'e2e'));
        await expect.poll(() => bodyIds(page)).toHaveLength(2);

        const p = await profile(page);
        expect(p.projects.map(r => r.name).sort()).toEqual(['Second', 'Untitled project']);
        expect(p.currentProjectId).not.toBe(first);
    });
});

test.describe('the save indicator', () => {
    test('the floppy light reports a written project', async ({ page }) => {
        await openApp(page);
        const dot = page.locator('#save-status');
        const label = page.locator('#save-status-text');

        await expect(dot).toHaveClass(/save-saved/);
        await expect(label).toHaveText(/^Saved /);
        await expect(dot).toHaveText('■', { useInnerText: false });
    });

    test('an unwritten edit shows, and clears once it is written', async ({ page }) => {
        await openApp(page);
        await expect(page.locator('#save-status')).toHaveClass(/save-saved/);

        // Dirty but not yet written: the title is where "there are newer
        // changes" is said, because the text must not claim a save that
        // did not happen.
        await page.evaluate(() => window.__opProject.update((p) => { p.bpm = 131; }, 'e2e'));
        await expect(page.locator('#save-status')).toHaveAttribute('title', /newer changes/);

        await flush(page);
        await expect(page.locator('#save-status')).toHaveAttribute('title', /Everything is written/);
    });

    test('the light sits with the audio and MIDI ones, and is the third shape', async ({ page }) => {
        await openApp(page);
        const glyphs = await page.evaluate(() => [
            document.getElementById('audio-status').textContent.trim(),
            document.getElementById('midi-status').textContent.trim(),
            document.getElementById('save-status').textContent.trim(),
        ]);
        expect(glyphs).toEqual(['●', '◆', '■']);

        // The light and its text must stay adjacent: the footer is
        // space-between, and as two items they drift to opposite ends.
        const gap = await page.evaluate(() => {
            const d = document.getElementById('save-status').getBoundingClientRect();
            const t = document.getElementById('save-status-text').getBoundingClientRect();
            return t.left - d.right;
        });
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThan(20);
    });
});
