// The project store in a real browser: a real IndexedDB, a real profile in
// localStorage, and the footer's save light driven by both.
//
// The unit suite proves the store's logic against a memory backend. This
// proves the parts a stub cannot: that a body actually lands in IndexedDB,
// survives a reload, and that the indicator the user reads agrees with it.

import { test, expect, openApp, openSectionPane } from './fixtures.js';

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

test.describe('project management lives in the File menu', () => {
    const openFileMenu = (page) => page.locator('.menu-item[data-menu="file"] .menu-label').click();

    test('the menu bar shows the open project, and renames it on click', async ({ page }) => {
        await openApp(page);
        await expect(page.locator('#menu-status')).toHaveText('Untitled project');

        page.once('dialog', (d) => d.accept('Nocturne'));
        await page.locator('#menu-status').click();
        await expect(page.locator('#menu-status')).toHaveText('Nocturne');
        expect(await page.evaluate(() => window.__opProject.get().name)).toBe('Nocturne');
    });

    test('New Project switches to an empty one', async ({ page }) => {
        await openApp(page);
        await page.evaluate(() => window.__opProject.update((p) => { p.bpm = 96; }, 'e2e'));

        await openFileMenu(page);
        await page.locator('#menu-new-project').click();
        await expect.poll(() => bodyIds(page)).toHaveLength(2);
        expect(await page.evaluate(() => window.__opProject.get().bpm)).toBe(120);
    });

    test('the Projects dialog opens, duplicates and deletes', async ({ page }) => {
        await openApp(page);
        await openFileMenu(page);
        await page.locator('#menu-projects').click();
        await expect(page.locator('.project-row')).toHaveCount(1);

        await page.locator('.project-duplicate').first().click();
        await expect.poll(() => bodyIds(page)).toHaveLength(2);
        await expect(page.locator('#menu-status')).toHaveText('Untitled project copy');

        await openFileMenu(page);
        await page.locator('#menu-projects').click();
        await expect(page.locator('.project-row')).toHaveCount(2);

        page.once('dialog', (d) => d.accept());
        await page.locator('.project-row', { hasText: 'copy' }).locator('.project-delete').click();
        await expect(page.locator('.project-row')).toHaveCount(1);
        await expect.poll(() => bodyIds(page)).toHaveLength(1);
    });

    test('the Section editor names the section, not the project', async ({ page }) => {
        await openApp(page);
        await openSectionPane(page);
        await expect(page.locator('.section-name')).toHaveValue('Section 1');
        // Project switching left this toolbar: a project is the whole piece.
        await expect(page.locator('.section-select')).toHaveCount(0);

        await page.locator('.section-name').fill('Chorus');
        await page.locator('.section-name').dispatchEvent('change');
        expect(await page.evaluate(() => window.__opProject.getSection().name)).toBe('Chorus');
        await expect(page.locator('#menu-status')).toHaveText('Untitled project');
    });
});

test.describe('export and import', () => {
    const openFileMenu = (page) => page.locator('.menu-item[data-menu="file"] .menu-label').click();

    /** Export the open project and read the file back as JSON. */
    async function exportAndRead(page) {
        const pending = page.waitForEvent('download');
        await openFileMenu(page);
        await page.locator('#menu-export-project').click();
        const file = await pending;
        const stream = await file.createReadStream();
        const chunks = [];
        for await (const c of stream) chunks.push(c);
        return { file, doc: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    }

    test('a project exports to one JSON file, with no server', async ({ page }) => {
        const apiCalls = [];
        page.on('request', (r) => { if (r.url().includes('/api/')) apiCalls.push(r.url()); });

        await openApp(page);
        await page.evaluate(() => {
            window.__opProject.rename('Nocturne', 'e2e');
            window.__opProject.update((project, section) => {
                project.bpm = 96;
                section.bpm = 72;
                section.name = 'Chorus';
            }, 'e2e');
        });

        const { file, doc } = await exportAndRead(page);
        expect(file.suggestedFilename()).toBe('Nocturne.opproj');
        expect(doc.kind).toBe('openpatches.project');
        expect(doc.project.name).toBe('Nocturne');
        expect(doc.project.bpm).toBe(96);
        expect(doc.project.sections[0]).toMatchObject({ name: 'Chorus', bpm: 72 });
        expect(apiCalls, 'the export must not need a backend').toEqual([]);
    });

    test('importing the file back gives a second, independent project', async ({ page }) => {
        await openApp(page);
        await page.evaluate(() => {
            window.__opProject.rename('Nocturne', 'e2e');
            window.__opProject.update((p) => { p.bpm = 96; }, 'e2e');
        });
        const { doc } = await exportAndRead(page);

        // Feed the file back through the same input the menu item opens.
        await page.setInputFiles('#wav-input', {
            name: 'Nocturne.opproj',
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(doc)),
        });

        await expect.poll(() => bodyIds(page)).toHaveLength(2);
        // The incoming one is renamed; the one on disk is untouched.
        await expect(page.locator('#menu-status')).toHaveText('Nocturne 2');
        expect(await page.evaluate(() => window.__opProject.get().bpm)).toBe(96);

        const names = (await profile(page)).projects.map((p) => p.name).sort();
        expect(names).toEqual(['Nocturne', 'Nocturne 2']);
    });

    test('a file Android renamed to .opproj.json is still a project import', async ({ page }) => {
        await openApp(page);
        await page.evaluate(() => {
            window.__opProject.rename('Nocturne', 'e2e');
        });
        const { doc } = await exportAndRead(page);

        // Android's download manager appends .json to a downloaded file
        // whose extension does not match its application/json MIME type.
        // Routed by extension alone, this went down the WAV path and the
        // probe server answered "not a valid WAV file".
        await page.setInputFiles('#wav-input', {
            name: 'Nocturne.opproj.json',
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(doc)),
        });

        await expect.poll(() => bodyIds(page)).toHaveLength(2);
        await expect(page.locator('#menu-status')).toHaveText('Nocturne 2');
    });

    test('a file from a newer format is refused, not half-read', async ({ page }) => {
        await openApp(page);
        const before = await bodyIds(page);

        await page.setInputFiles('#wav-input', {
            name: 'future.opproj',
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify({
                kind: 'openpatches.project',
                schemaVersion: 999,
                project: { name: 'From the future' },
            })),
        });

        // Refused with a message the user can act on, rather than a
        // quietly lesser copy of their work.
        await expect(page.locator('#error-modal')).toBeVisible();
        await expect(page.locator('#error-message')).toContainText(/newer version/);
        expect(await bodyIds(page)).toEqual(before, 'nothing was imported');
    });
});

test.describe('Delete All Data', () => {
    // The old "Clear History" removed five of twenty-odd localStorage keys
    // — patterns, sections, patch renames and the tag vocabulary all survived
    // a "clear all" — and it orphaned every imported WAV, because the
    // canvas records were dropped without deleting the blobs they pointed
    // at. The assertion is therefore that storage is *empty*, not that
    // some list of keys was removed: a list drifts, this cannot.

    const uploadKeys = (page) => page.evaluate(() => new Promise((resolve) => {
        const req = indexedDB.open('openpatches');
        req.onsuccess = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('uploads')) return resolve([]);
            const q = db.transaction('uploads', 'readonly').objectStore('uploads').getAllKeys();
            q.onsuccess = () => resolve(q.result);
            q.onerror = () => resolve([]);
        };
        req.onerror = () => resolve([]);
    }));

    test('takes the projects, the profile and the uploaded WAVs together', async ({ page }) => {
        await openApp(page);
        await expect.poll(() => bodyIds(page)).toHaveLength(1);

        await page.evaluate(async () => {
            window.__opProject.update((project) => { project.name = 'Doomed'; }, 'e2e');
            window.__opProject.createNew('Second', 'e2e');
        });
        // A WAV blob, as an import would leave behind.
        await page.evaluate(() => new Promise((resolve) => {
            const req = indexedDB.open('openpatches');
            req.onsuccess = (e) => {
                const db = e.target.result;
                const tx = db.transaction('uploads', 'readwrite');
                tx.objectStore('uploads').put(new Uint8Array([1, 2, 3]), 'job_x');
                tx.oncomplete = () => resolve();
            };
        }));
        await expect.poll(() => bodyIds(page)).toHaveLength(2);
        expect(await uploadKeys(page)).toContain('job_x');

        page.once('dialog', (d) => d.accept());
        await page.locator('.menu-item[data-menu="history"] .menu-label').click();
        await page.locator('#menu-clear-delete-all').click();

        // One fresh, empty project is left — the app is never without one.
        await expect.poll(() => bodyIds(page)).toHaveLength(1);
        expect(await page.evaluate(() => window.__opProject.get().name)).toBe('Untitled project');
        expect((await profile(page)).projects).toHaveLength(1);
        expect(await uploadKeys(page)).toEqual([]);
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
