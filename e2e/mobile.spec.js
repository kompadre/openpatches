// Mobile (≤600px) layout and touch. The app has a separate mobile layout —
// fixed full-screen dock, icon tabs, one-octave keyboard — and none of it is
// exercised anywhere else: the rest of the suite runs a desktop viewport, and
// the unit harness has neither layout nor TouchEvent. Both bugs this file
// pins down (inverted keyboard, clip drag crashing on touchend) were invisible
// to every other test.

import { test, expect } from './fixtures.js';

test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
});

/**
 * Boot on mobile. openApp() waits for a visible keyboard, but the mobile
 * default tab (Canvas) keeps it hidden — wait for the icon tab strip instead.
 */
async function openMobile(page) {
    await page.goto('/index.html');
    await expect(page.locator('.dock-tab', { hasText: 'Section' })).toBeVisible();
}

/** One pattern, one track, one clip at the top of the section. */
async function seedSection(page) {
    await page.evaluate(async () => {
        const pm = await import('/html/components/project-model.js');
        const dock = window.__opDock;
        const pattern = dock._session.createPattern({ name: 'Pat', measures: 1 }, 'e2e');
        dock._session.update((project, section) => {
            const track = pm.createTrack({ name: 'T', slot: 0 });
            project.tracks.push(track);
            pm.addClip(project, section, {
                patternId: pattern.id, trackId: track.id, startCol: 0, repeats: 1,
            });
        }, 'e2e');
        dock._sectionEditor.render();
    });
}

/** A finger swipe via CDP — Playwright's tap() cannot express a drag. */
async function touchSwipe(page, from, to, steps = 12) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }],
        });
        await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
}

function clips(page) {
    return page.evaluate(() =>
        window.__opDock._session.getSection().clips.map((c) => ({ start: c.startCol, repeats: c.repeats })));
}

test.describe('mobile', () => {
    test('Section editor fits the screen with a long section', async ({ page }) => {
        await openMobile(page);
        await seedSection(page);
        await page.evaluate(async () => {
            const pm = await import('/html/components/project-model.js');
            const dock = window.__opDock;
            const pattern = dock._session.createPattern({ name: 'Far', measures: 1 }, 'e2e');
            dock._session.update((project, section) => {
                pm.addClip(project, section, {
                    patternId: pattern.id, trackId: project.tracks[0].id,
                    startCol: 200 * 16, repeats: 1,
                });
            }, 'e2e');
            dock._sectionEditor.render();
        });
        await page.locator('.dock-tab', { hasText: 'Section' }).click();
        await expect(page.locator('.section-editor')).toBeVisible();

        // The mobile face of the stranding bug: before the width:100% fix,
        // one small clip was enough to put Play at x=-258 on a 390px screen.
        // Time runs down now, so a long section is tall, not wide — the
        // grid must take that height and scroll it.
        const l = await page.evaluate(() => {
            const x = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().x);
            const grid = document.querySelector('.section-grid');
            return {
                toolbar: x('.section-toolbar button'),
                ruler: x('.section-ruler'),
                editorW: Math.round(document.querySelector('.section-editor').getBoundingClientRect().width),
                gridScrolls: grid.scrollHeight > grid.clientHeight,
            };
        });
        expect(l.toolbar).toBeGreaterThanOrEqual(0);
        expect(l.ruler).toBeGreaterThanOrEqual(0);
        expect(l.editorW).toBeLessThanOrEqual(390);
        expect(l.gridScrolls).toBe(true);
    });

    test('a tap places a clip, a swipe scrolls the grid', async ({ page }) => {
        await openMobile(page);
        await seedSection(page);
        await page.locator('.dock-tab', { hasText: 'Section' }).click();
        await expect(page.locator('.section-clip')).toBeVisible();

        // Selecting the clip selects its pattern; a tap further down the
        // lane places that pattern again (bar 4 — the clip holds bar 1).
        await page.locator('.section-clip').first().tap();
        const lane = await page.locator('.section-lane').first().boundingBox();
        await page.touchscreen.tap(lane.x + lane.width / 2, lane.y + 150);
        await expect.poll(() => clips(page)).toHaveLength(2);

        const grid = page.locator('.section-grid');
        const before = await grid.evaluate((el) => el.scrollTop);
        await touchSwipe(page,
            { x: lane.x + lane.width / 2, y: lane.y + 250 },
            { x: lane.x + lane.width / 2, y: lane.y + 60 });
        expect(await grid.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
    });

    test('a touch-drag moves a clip and does not throw', async ({ page }) => {
        // pointer() used to read e.touches[0] on touchend, where the list is
        // empty — every drag crashed at the commit step and the clip snapped
        // back. The fixture's pageerror guard doubles as the crash assertion.
        await openMobile(page);
        await seedSection(page);
        await page.locator('.dock-tab', { hasText: 'Section' }).click();
        await expect(page.locator('.section-clip')).toBeVisible();

        const clip = await page.locator('.section-clip').first().boundingBox();
        await touchSwipe(page,
            { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 },
            { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 + 97 });

        // 97px down at 48px/measure, snapped to the bar: two bars = 32 cols.
        await expect.poll(() => clips(page)).toEqual([{ start: 32, repeats: 1 }]);
    });

    test('the one-octave keyboard is a piano, not an inversion of one', async ({ page }) => {
        await openMobile(page);
        await page.locator('.dock-tab', { hasText: 'Piano Roll' }).click();

        // White keys were height:100% against a min-height-only (indefinite)
        // parent, so they collapsed to 20px while the black keys stood 50px —
        // black keys taller than white, floating below the keyboard.
        const kb = await page.evaluate(() => {
            const white = document.querySelector('.key.white').getBoundingClientRect();
            const black = document.querySelector('.key.black').getBoundingClientRect();
            return {
                whiteH: white.height, blackH: black.height,
                blackInsideWhite: black.y >= white.y - 1 && black.y + black.height <= white.y + white.height + 1,
            };
        });
        expect(kb.whiteH).toBeGreaterThan(kb.blackH);
        expect(kb.blackInsideWhite).toBe(true);
    });

    // A phone cannot usefully drag the playhead's header marker, so the
    // mobile row has two buttons that move the step-record cursor instead.
    test('the step nudge buttons fit the row and move the record cursor', async ({ page }) => {
        await openMobile(page);
        await page.locator('.dock-tab', { hasText: 'Piano Roll' }).click();

        const back = page.locator('.kb-btn-step-nudge', { hasText: '« Step' });
        const fwd = page.locator('.kb-btn-step-nudge', { hasText: 'Step »' });
        await expect(back).toBeVisible();
        await expect(fwd).toBeVisible();
        for (const b of [back, fwd]) {
            const box = await b.boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(390);
        }
        await expect(fwd).toBeDisabled();

        const cursor = () => page.evaluate(() => window.__opDock._pianoroll.getStepCursor());
        await page.locator('.transport-record').tap();  // clock stopped: a step record
        await expect(fwd).toBeEnabled();
        expect(await cursor()).toBe(0);

        await fwd.tap();
        await fwd.tap();
        expect(await cursor()).toBe(2);                 // default step: a sixteenth
        await back.tap();
        expect(await cursor()).toBe(1);
        await back.tap();
        await back.tap();
        expect(await cursor()).toBe(15);                // wrapped to the pattern end
    });
});
