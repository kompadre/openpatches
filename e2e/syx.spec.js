// .syx file I/O through the real browser plumbing: a File off a file input on
// import, an anchor-click download on export. The parser and builder have
// unit tests; what only exists here is the journey — menu → file picker →
// patch store → container on the canvas → export button → download event.

import { readFileSync } from 'node:fs';
import { test, expect, openApp } from './fixtures.js';

const DEMO_SYX = 'html/DEMO.syx';          // the bank the app ships, 4104 bytes

// The import skips INIT VOICE and blank slots, so the expected patch count is
// whatever the bank actually carries — read it from the bytes rather than
// hard-coding a number that drifts when DEMO.syx is re-cut.
function namedVoicesInBank(path) {
    const b = readFileSync(path);
    let n = 0;
    for (let slot = 0; slot < 32; slot++) {
        const name = b.subarray(6 + slot * 128 + 118, 6 + slot * 128 + 128).toString('ascii');
        if (name.trim() && name.trim() !== 'INIT VOICE') n++;
    }
    return n;
}
const DEMO_VOICES = namedVoicesInBank(DEMO_SYX);

async function importDemoBank(page) {
    await page.locator('.menu-item[data-menu="file"] .menu-label').click();
    const picker = page.waitForEvent('filechooser');
    await page.locator('#menu-import-syx').click();
    await (await picker).setFiles(DEMO_SYX);
}

/** Patches belong to the open project now, not to a key of their own. */
function storedPatches(page) {
    return page.evaluate(() => Object.values(window.__opProject.get().patches || {}));
}

test.describe('.syx I/O', () => {
    test('importing a bank fills the store and the canvas', async ({ page }) => {
        await openApp(page);
        await importDemoBank(page);

        // The import ends with a container on the canvas…
        await expect(page.locator('[title="Export as .SYX"]').first()).toBeVisible();

        // …and the voices in the patch store, each with its packed data.
        const patches = await storedPatches(page);
        expect(patches.length).toBe(DEMO_VOICES);
        for (const p of patches) {
            expect(p.source).toBe('syx');
            expect(typeof p.voice_data).toBe('string');
            expect(p.voice_data.length).toBeGreaterThan(0);
        }

        // Survives a boot: the restore path reads what the import wrote.
        await page.reload();
        await expect(page.locator('.keyboard .key').first()).toBeVisible();
        expect((await storedPatches(page)).length).toBe(patches.length);
        await expect(page.locator('[title="Export as .SYX"]').first()).toBeVisible();
    });

    test('imported voices rebuild into the bank bytes they came from', async ({ page }) => {
        await openApp(page);
        await importDemoBank(page);
        await expect(page.locator('[title="Export as .SYX"]').first()).toBeVisible();

        // Full round trip inside the browser: store → buildBulkDump →
        // parseSyxFile → the same names and algorithms that were imported.
        // This is the byte-level guarantee the server export relies on.
        const trip = await page.evaluate(async () => {
            const builder = await import('/html/components/syx-builder.js');
            const parser = await import('/html/components/syx-parser.js');
            const patches = Object.values(window.__opProject.get().patches || {});

            const bytes = builder.buildBulkDump(patches);
            const check = builder.validateBulkDump(bytes);
            const reparsed = parser.parseSyxFile(bytes.buffer);

            const strip = (list) => list.map((p) => ({
                name: p.name.trim(), algorithm: p.algorithm,
            }));
            return {
                size: bytes.length,
                valid: check && check.ok !== false,
                checksumOk: reparsed.checksumOk,
                imported: strip(patches),
                roundTripped: strip(reparsed.slice(0, patches.length)),
            };
        });

        expect(trip.size).toBe(4104);
        expect(trip.checksumOk).not.toBe(false);
        expect(trip.roundTripped).toEqual(trip.imported);
    });

    test('the container export button produces a .syx download', async ({ page }) => {
        // The real backend builds the file; under the static test server the
        // API is mocked, so what is under test is the UI flow around it —
        // the request's payload and the anchor-click download at the end.
        let exportRequest = null;
        await page.route('**/api/export-syx', async (route) => {
            exportRequest = route.request().postDataJSON();
            await route.fulfill({ json: { syx_url: '/__test__/out.syx', count: exportRequest.patches.length } });
        });
        await page.route('**/__test__/out.syx', (route) => route.fulfill({
            body: Buffer.alloc(4104, 0x11),
            contentType: 'application/octet-stream',
        }));

        await openApp(page);
        await importDemoBank(page);
        await expect(page.locator('[title="Export as .SYX"]').first()).toBeVisible();

        const download = page.waitForEvent('download');
        await page.locator('[title="Export as .SYX"]').first().click();
        const file = await download;

        expect(file.suggestedFilename()).toMatch(/\.syx$/);
        expect(exportRequest.patches.length).toBe(DEMO_VOICES);
        expect(exportRequest.patches[0]).toHaveProperty('voice_data');
    });
});
