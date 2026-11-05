// Layout invariants — the "is anything unreachable?" tests.
//
// The dock centres its panels (`.dock-panel { align-items: center }`). That
// is a trap: a centred box wider than its container overflows on *both*
// sides, and the start side of a centred overflow cannot be scrolled to.
// A panel that takes its content width therefore strands its own left edge —
// the section palette, the track heads — off screen permanently. Measured on a
// long section: the palette sat at x=-4412 with no way to reach it.
//
// The guard is that every panel sizes itself to the dock and scrolls
// internally. These tests hold the panels to that.

import { test, expect, openApp } from './fixtures.js';

/** A section with a clip far out at bar 200 — ~10 000 px of grid. */
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

async function openSectionTab(page) {
    await page.locator('.dock-tab', { hasText: 'Section' }).click();
    await expect(page.locator('.section-editor')).toBeVisible();
}

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
            palette: box('.section-palette'),
            editor: box('.section-editor'),
            panel: box('.dock-panel.active'),
            gridClientW: grid.clientWidth,
            gridScrollW: grid.scrollWidth,
            dockOverflow: dock.scrollWidth - dock.clientWidth,
        };
    });
}

test.describe('layout invariants', () => {
    test('a long section scrolls the grid, it does not widen the editor', async ({ page }) => {
        await openApp(page);
        await openSectionTab(page);
        await seedLongSection(page);

        const l = await layout(page);

        // The palette is the thing that goes missing, so check it first.
        expect(l.palette.x, 'palette pushed off the left edge').toBeGreaterThanOrEqual(0);

        // The editor is the dock's width, never the section's length.
        expect(l.editor.width).toBeLessThanOrEqual(l.panel.width + 1);

        // The grid is what absorbs the section: it must actually be scrolling.
        expect(l.gridScrollW).toBeGreaterThan(l.gridClientW);

        // And nothing leaks out to scroll the dock sideways.
        expect(l.dockOverflow).toBeLessThanOrEqual(2);
    });

    test('the panel contains its content even if the grid stops absorbing it', async ({ page }) => {
        // The containment above must not depend on the grid's cooperation.
        // Take the grid's own overflow away — the state the observed
        // breakage was in — and the palette must still be reachable. Without
        // `width: 100%` on .section-editor this fails with the palette at
        // x=-4412; it is the test that actually pins the fix down.
        await openApp(page);
        await openSectionTab(page);
        await seedLongSection(page);

        await page.addStyleTag({ content: '.section-grid { overflow: visible !important; }' });
        await expect.poll(async () => (await layout(page)).palette.x).toBeGreaterThanOrEqual(0);

        const l = await layout(page);
        expect(l.editor.width).toBeLessThanOrEqual(l.panel.width + 1);
    });

    test('pattern palette rows stay on one line', async ({ page }) => {
        await openApp(page);
        await page.evaluate(async () => {
            const pm = await import('/html/components/project-model.js');
            window.__opDock._session.createPattern({ name: 'A long pattern name', measures: 16 }, 'e2e');
            window.__opDock._sectionEditor.render();
        });
        await openSectionTab(page);

        // "16 bars" is squeezed by the flexible name beside it and used to
        // break after the number, doubling the height of every row.
        const rows = await page.locator('.section-pattern-len').evaluateAll((els) =>
            els.map((el) => {
                const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 12;
                return { text: el.textContent, lines: Math.round(el.getBoundingClientRect().height / lineHeight) };
            }));
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(row.lines, `"${row.text}" wrapped onto ${row.lines} lines`).toBe(1);
        }
    });

    test('every dock panel keeps every child inside the dock', async ({ page }) => {
        // The generic form of the two tests above, over every full-page tab.
        // The Section editor is the panel that has actually broken, but the
        // trap is in `.dock-panel` itself: a wide child of *any* panel is
        // centred and its left edge stranded. (Mixer, Edit and Log left the
        // dock-panel world for the bottom pane — covered below.)
        await openApp(page);
        await openSectionTab(page);
        await seedLongSection(page);

        const tabs = ['Patches', 'Piano Roll', 'Section'];
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
        expect(l.items.length).toBe(3);
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
        for (const key of ['mixer', 'edit', 'log']) {
            await page.locator(`.bpane-item-${key} .bpane-bookmark`).click();
            await expect(page.locator(`.bpane-item-${key} .bpane-body`)).toBeHidden();
        }

        // All three folded → the pane (and its handle) fold themselves.
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
});
