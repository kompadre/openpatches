// Phase 5 (revised): File → Storage… sweeps WAVs no project references;
// File → Import into This Project… brings chosen patches and patterns in.
import { test, expect, openApp, openSectionPane } from './fixtures.js';

const openFileMenu = (page) => page.locator('.menu-item[data-menu="file"] .menu-label').click();

test('Storage: reports usage and deletes only unreferenced WAVs', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => {
        const pm = await import('/html/components/patch-model.js');
        pm.jobStore.put({ id: 'job_kept', type: 'wav', status: 'done', fileName: 'a.wav' });
        await window.__opProject.flush();
        const db = await new Promise((res, rej) => { const r = indexedDB.open('openpatches', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        await new Promise((res) => {
            const tx = db.transaction('uploads', 'readwrite');
            tx.objectStore('uploads').put(new ArrayBuffer(1000), 'job_kept');
            tx.objectStore('uploads').put(new ArrayBuffer(3000), 'job_orphan');
            tx.oncomplete = res;
        });
    });
    await openFileMenu(page);
    await page.locator('#menu-storage').click();
    await expect(page.locator('.storage-sweep')).toHaveText('Delete 1 unused WAV');
    await expect(page.locator('.storage-dialog')).toContainText('WAV uploads (2)');
    await page.locator('.storage-sweep').click();
    await expect(page.locator('.storage-note')).toContainText('Nothing to clean up');
    const keys = await page.evaluate(async () => {
        const db = await new Promise((res) => { const r = indexedDB.open('openpatches', 1); r.onsuccess = () => res(r.result); });
        return new Promise((res) => { const q = db.transaction('uploads').objectStore('uploads').getAllKeys(); q.onsuccess = () => res(q.result); });
    });
    expect(keys).toEqual(['job_kept']);
});

test('Import into This Project: pick patterns and patches from a file', async ({ page }) => {
    await openApp(page);
    await openSectionPane(page);
    const file = {
        kind: 'openpatches.project', schemaVersion: await page.evaluate(async () => (await import('/html/components/project-model.js')).SCHEMA_VERSION),
        project: {
            name: 'Elsewhere',
            patches: { p_x: { id: 'p_x', name: 'GLASS', voice_data: btoa('x'.repeat(128)) } },
            patterns: {
                pat_a: { id: 'pat_a', name: 'Riff', measures: 1, notes: [{ midi: 60, start: 0, dur: 1 }] },
                pat_b: { id: 'pat_b', name: 'Skip me', measures: 1, notes: [] },
            },
        },
    };
    await openFileMenu(page);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#menu-import-into').click();
    await (await chooser).setFiles({ name: 'other.opproj', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await expect(page.locator('.import-into-item')).toHaveCount(3);
    await page.locator('.import-into-item', { hasText: 'Skip me' }).locator('input').uncheck();
    await expect(page.locator('.import-into-go')).toHaveText('Import 2');
    await page.locator('.import-into-go').click();
    await expect(page.locator('.section-library-name')).toHaveText(['Riff']);
    await expect(page.locator('.section-library-uses')).toHaveText(['—'], { timeout: 2000 });
    const got = await page.evaluate(async () => {
        const pm = await import('/html/components/patch-model.js');
        return { glass: !!pm.patchStore.get('p_x'), projects: window.__opProject.get().name };
    });
    expect(got.glass).toBe(true);
    expect(got.projects).toBe('Untitled project');        // still the same project
});
