// Layout invariants — the "is anything unreachable?" tests.
//
// The dock centres its panels (`.dock-panel { align-items: center }`). That
// is a trap: a centred box wider than its container overflows on *both*
// sides, and the start side of a centred overflow cannot be scrolled to.
// A panel that takes its content width therefore strands its own left edge
// off screen permanently. Measured on a long section, back when the Section
// was a full-page tab with time running across: its palette sat at x=-4412
// with no way to reach it.
//
// The guard is that every panel sizes itself to its container and scrolls
// internally. The Section now lives in the left pane with time running
// *down*, so a long section is tall rather than wide — the grid must absorb
// that height, and the pane must never take the grid's width.

import { test, expect, openApp, openSectionPane } from './fixtures.js';

/** A section with a clip far out at bar 200 — ~10 000 px of grid, downward. */
async function seedLongSection(page) {
    await page.evaluate(async () => {
        const pm = await import('/html/components/project-model.js');
        const dock = window.__opDock;
        const pattern = dock._session.createPattern({ name: 'P', measures: 1 }, 'e2e');
        dock._session.update((project, section) => {
            const track = pm.createTrack({ name: 'T', slot: 0 });
            project.tracks.push(track);
            pm.addClip(project, section, {
                patternId: pattern.id, trackId: track.id, startCol: 200 * 16, repeats: 1,
            });
        }, 'e2e');
        dock._sectionEditor.render();
    });
}

const openSectionTab = openSectionPane;

function layout(page) {
    return page.evaluate(() => {
        const box = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x), width: Math.round(r.width) };
        };
        const grid = document.querySelector('.section-grid');
        const dock = document.querySelector('#piano-dock');
        return {
            toolbar: box('.section-toolbar'),
            ruler: box('.section-ruler'),
            editor: box('.section-editor'),
            pane: box('.lpane-body'),
            gridClientH: grid.clientHeight,
            gridScrollH: grid.scrollHeight,
            dockOverflow: dock.scrollWidth - dock.clientWidth,
        };
    });
}

test.describe('layout invariants', () => {
    test('a long section scrolls the grid down, it does not grow the pane', async ({ page }) => {
        await openApp(page);
        await openSectionTab(page);
        await seedLongSection(page);

        const l = await layout(page);

        // The toolbar and the ruler are the things that would go missing.
        expect(l.toolbar.x, 'toolbar pushed off the left edge').toBeGreaterThanOrEqual(0);
        expect(l.ruler.x, 'ruler pushed off the left edge').toBeGreaterThanOrEqual(0);

        // The editor is the pane's width, never the section's.
        expect(l.editor.width).toBeLessThanOrEqual(l.pane.width + 1);

        // The grid is what absorbs the section: it must actually be scrolling, downward.
        expect(l.gridScrollH).toBeGreaterThan(l.gridClientH);

        // And nothing leaks out to scroll the dock sideways.
        expect(l.dockOverflow).toBeLessThanOrEqual(2);
    });

    test('the pane contains its content even if the grid stops absorbing it', async ({ page }) => {
        // The containment must not depend on the grid's cooperation. Take
        // the grid's own overflow away and the toolbar must still be
        // reachable and the editor still no wider than the pane.
        await openApp(page);
        await openSectionTab(page);
        await seedLongSection(page);

        await page.addStyleTag({ content: '.section-grid { overflow: visible !important; }' });
        await expect.poll(async () => (await layout(page)).toolbar.x).toBeGreaterThanOrEqual(0);

        const l = await layout(page);
        expect(l.editor.width).toBeLessThanOrEqual(l.pane.width + 1);
        expect(l.dockOverflow).toBeLessThanOrEqual(2);
    });

    test('many tracks scroll the grid sideways, inside the pane', async ({ page }) => {
        await openApp(page);
        await openSectionTab(page);
        for (let i = 0; i < 8; i++) await page.locator('.section-add-track').click();
        await expect(page.locator('.section-lane')).toHaveCount(8);

        const m = await page.evaluate(() => {
            const grid = document.querySelector('.section-grid');
            const pane = document.querySelector('.lpane-body').getBoundingClientRect();
            const editor = document.querySelector('.section-editor').getBoundingClientRect();
            return { gridOverflowX: grid.scrollWidth - grid.clientWidth, editorW: editor.width, paneW: pane.width };
        });
        expect(m.gridOverflowX).toBeGreaterThan(0);
        expect(m.editorW).toBeLessThanOrEqual(m.paneW + 1);
    });

    test('every dock panel keeps every child inside the dock', async ({ page }) => {
        // The generic form of the tests above, over every full-page tab.
        // The Section editor is the panel that actually broke, but the trap
        // is in `.dock-panel` itself: a wide child of *any* panel is centred
        // and its left edge stranded. (Section, Mixer, Edit and Log left
        // the dock-panel world for the side panes — covered separately.)
        await openApp(page);

        const tabs = ['Patches', 'Pattern'];
        for (const name of tabs) {
            await page.locator('.dock-tab', { hasText: name }).click();
            await expect(page.locator('.dock-panel.active')).toBeVisible();

            const l = await page.evaluate(() => {
                const dock = document.querySelector('#piano-dock');
                const panel = document.querySelector('.dock-panel.active');
                const p = panel.getBoundingClientRect();
                const children = [...panel.children]
                    .map((el) => ({ el, r: el.getBoundingClientRect() }))
                    .filter(({ el, r }) => r.width > 0 && getComputedStyle(el).display !== 'none')
                    .map(({ el, r }) => ({
                        tag: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
                        left: Math.round(r.left - p.left),
                        right: Math.round(r.right - p.right),
                    }));
                return {
                    panelX: Math.round(p.x),
                    children,
                    dockOverflow: dock.scrollWidth - dock.clientWidth,
                };
            });

            expect(l.panelX, `${name}: panel off the left edge`).toBeGreaterThanOrEqual(0);
            expect(l.children.length, `${name}: panel has no visible children`).toBeGreaterThan(0);
            for (const c of l.children) {
                expect(c.left, `${name}: ${c.tag} starts left of its panel`).toBeGreaterThanOrEqual(-1);
                expect(c.right, `${name}: ${c.tag} ends right of its panel`).toBeLessThanOrEqual(1);
            }
            expect(l.dockOverflow, `${name}: dock scrolls sideways`).toBeLessThanOrEqual(2);
        }
    });

    test('bottom pane items stay inside the pane, the pane inside the dock', async ({ page }) => {
        await openApp(page);
        await expect(page.locator('.bpane')).toBeVisible();

        const l = await page.evaluate(() => {
            const dock = document.querySelector('#piano-dock');
            const pane = document.querySelector('.bpane');
            const pr = pane.getBoundingClientRect();
            const items = [...pane.querySelectorAll('.bpane-item')].map((el) => {
                const r = el.getBoundingClientRect();
                return {
                    key: el.className,
                    left: Math.round(r.left - pr.left),
                    right: Math.round(r.right - pr.right),
                };
            });
            return {
                paneX: Math.round(pr.x),
                items,
                dockOverflow: dock.scrollWidth - dock.clientWidth,
            };
        });

        expect(l.paneX, 'pane off the left edge').toBeGreaterThanOrEqual(0);
        // Mixer | Edit | Device | Log, in that order.
        expect(l.items.map((it) => it.key.match(/bpane-item-(\w+)/)[1]))
            .toEqual(['mixer', 'edit', 'device', 'log']);
        for (const it of l.items) {
            expect(it.left, `${it.key} starts left of the pane`).toBeGreaterThanOrEqual(-1);
            expect(it.right, `${it.key} ends right of the pane`).toBeLessThanOrEqual(1);
        }
        expect(l.dockOverflow, 'dock scrolls sideways').toBeLessThanOrEqual(2);
    });

    test('bottom pane: bookmarks fold items, folding all folds the pane, tabs reopen it', async ({ page }) => {
        await openApp(page);
        const pane = page.locator('.bpane');
        await expect(pane).toBeVisible();

        // Fold each item by its bookmark: body hides, bookmark remains.
        for (const key of ['mixer', 'edit', 'device', 'log']) {
            await page.locator(`.bpane-item-${key} .bpane-bookmark`).click();
            await expect(page.locator(`.bpane-item-${key} .bpane-body`)).toBeHidden();
        }

        // All folded → the pane (and its handle) fold themselves.
        await expect(pane).toBeHidden();
        await expect(page.locator('.bpane-handle')).toBeHidden();
        await expect(page.locator('.dock-tab-log')).not.toHaveClass(/active/);

        // A top tab reopens the pane with just that item expanded.
        await page.locator('.dock-tab-log').click();
        await expect(pane).toBeVisible();
        await expect(page.locator('#log')).toBeVisible();
        await expect(page.locator('.bpane-item-mixer .bpane-body')).toBeHidden();
        await expect(page.locator('.dock-tab-log')).toHaveClass(/active/);

        // The same tab toggles its item away again.
        await page.locator('.dock-tab-log').click();
        await expect(pane).toBeHidden();

        // The pane-level collapse folds everything at once but the items
        // remember their state: reopening Edit via its tab must not bring
        // the others back.
        await page.locator('.dock-tab-mixer').click();
        await page.locator('.dock-tab-edit').click();
        await page.locator('.bpane-pane-collapse').click();
        await expect(pane).toBeHidden();
        await page.locator('.dock-tab-edit').click();
        await expect(pane).toBeVisible();
        await expect(page.locator('.bpane-item-edit .bpane-body')).toBeVisible();
        await expect(page.locator('.bpane-item-mixer .bpane-body')).toBeVisible();
        await expect(page.locator('.bpane-item-log .bpane-body')).toBeHidden();
    });

    test('the collapse button spans the keyboard and the pane, and stays as a bar to restore both', async ({ page }) => {
        await openApp(page);
        const btn = page.locator('.bpane-pane-collapse');
        const kb = page.locator('.dock-keyboard');
        const pane = page.locator('.bpane');

        // Down the right of both rows: from the keyboard's top to the pane's bottom.
        const b = await btn.boundingBox(), k = await kb.boundingBox(), p = await pane.boundingBox();
        expect(Math.abs(b.y - k.y)).toBeLessThanOrEqual(1);
        expect(Math.abs((b.y + b.height) - (p.y + p.height))).toBeLessThanOrEqual(1);
        expect(b.x).toBeGreaterThanOrEqual(k.x + k.width - 1);

        // Collapse: both rows go, the button remains — as a bar.
        await btn.click();
        await expect(kb).toBeHidden();
        await expect(pane).toBeHidden();
        await expect(btn).toBeVisible();
        await expect(btn).toHaveAttribute('aria-expanded', 'false');
        expect((await btn.boundingBox()).width).toBeGreaterThan(400);

        // Remembered across a reload.
        await page.reload();
        await expect(page.locator('#piano-dock')).toBeAttached();
        await expect(btn).toHaveAttribute('aria-expanded', 'false');
        await expect(pane).toBeHidden();

        // The bar brings both back.
        await btn.click();
        await expect(kb).toBeVisible();
        await expect(pane).toBeVisible();
        await expect(page.locator('.bpane-item-mixer .bpane-body')).toBeVisible();
    });

    test('restoring a pane whose items were all folded opens them all, not the keyboard alone', async ({ page }) => {
        await openApp(page);
        for (const key of ['mixer', 'edit', 'device', 'log']) {
            await page.locator(`.bpane-item-${key} .bpane-bookmark`).click();
        }
        await expect(page.locator('.bpane')).toBeHidden();
        await page.locator('.bpane-pane-collapse').click();       // collapse what is left: the keyboard
        await expect(page.locator('.dock-keyboard')).toBeHidden();
        await page.locator('.bpane-pane-collapse').click();       // restore
        await expect(page.locator('.bpane')).toBeVisible();
        for (const key of ['mixer', 'edit', 'device', 'log']) {
            await expect(page.locator(`.bpane-item-${key} .bpane-body`)).toBeVisible();
        }
    });

    test('the Device panel sits between Edit and Log, and its tab toggles it', async ({ page }) => {
        await openApp(page);
        const tabs = await page.locator('.dock-tabs .dock-tab').evaluateAll((els) =>
            els.map((e) => [...e.classList].find((c) => c.startsWith('dock-tab-'))));
        expect(tabs.indexOf('dock-tab-device')).toBe(tabs.indexOf('dock-tab-edit') + 1);
        expect(tabs.indexOf('dock-tab-log')).toBe(tabs.indexOf('dock-tab-device') + 1);

        const body = page.locator('.bpane-item-device .bpane-body');
        await expect(body).toBeVisible();
        // Headless Chromium has no MIDI device: the panel says so and
        // offers nothing to stop.
        await expect(page.locator('.device-port')).toHaveText(/Not connected|No Web MIDI/);
        await expect(page.locator('.device-toggle')).toBeDisabled();
        await page.locator('.dock-tab-device').click();
        await expect(body).toBeHidden();
        await page.locator('.dock-tab-device').click();
        await expect(body).toBeVisible();
    });

    test('left pane: the bookmark and the Section tab fold it, it keeps its width', async ({ page }) => {
        await openApp(page);
        const pane = page.locator('.lpane');
        const editor = page.locator('.section-editor');
        await expect(editor).toBeVisible();
        await expect(page.locator('.dock-tab-section')).toHaveClass(/active/);

        const paneW = await pane.evaluate((el) => el.getBoundingClientRect().width);
        const rollW = await page.locator('.dock-panel-pianoroll').evaluate((el) => el.getBoundingClientRect().width);

        // Fold by the bookmark: the editor hides, the bookmark stays, the
        // piano roll takes the room.
        await page.locator('.lpane-bookmark').click();
        await expect(editor).toBeHidden();
        await expect(page.locator('.lpane-bookmark')).toBeVisible();
        await expect(page.locator('.lpane-handle')).toBeHidden();
        await expect(page.locator('.dock-tab-section')).not.toHaveClass(/active/);
        expect(await page.locator('.dock-panel-pianoroll').evaluate((el) => el.getBoundingClientRect().width))
            .toBeGreaterThan(rollW + paneW / 2);

        // The tab reopens it at the width it had.
        await page.locator('.dock-tab-section').click();
        await expect(editor).toBeVisible();
        expect(Math.abs(await pane.evaluate((el) => el.getBoundingClientRect().width) - paneW)).toBeLessThanOrEqual(1);

        // And the tab toggles it away again.
        await page.locator('.dock-tab-section').click();
        await expect(editor).toBeHidden();
    });
});
