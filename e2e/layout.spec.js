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
        // The generic form of the two tests above, over every tab. The
        // Section editor is the panel that has actually broken, but the trap
        // is in `.dock-panel` itself: a wide child of *any* panel is centred
        // and its left edge stranded. Nothing in the CSS forbids that — the
        // other panels merely happen to be width:100% today — so this walks
        // the tabs and holds each active panel's children to the dock.
        await openApp(page);
        await openSectionTab(page);
        await seedLongSection(page);

        const tabs = ['Patches', 'Piano Roll', 'Section', 'Mixer', 'Edit', 'Log'];
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
});
