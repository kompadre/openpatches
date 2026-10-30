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
    await expect(page.locator('.dock-tab', { hasText: 'Song' })).toBeVisible();
}

/** One pattern, one track, one clip at the top of the song. */
async function seedSong(page) {
    await page.evaluate(async () => {
        const sm = await import('/html/components/song-model.js');
        const dock = window.__opDock;
        const pattern = sm.createPattern({ name: 'Pat', measures: 1 });
        sm.patternStore.put(pattern);
        dock._session.update((song) => {
            const track = sm.createTrack({ name: 'T', slot: 0 });
            song.tracks.push(track);
            sm.addClip(song, { patternId: pattern.id, trackId: track.id, startCol: 0, repeats: 1 },
                (id) => sm.patternStore.get(id));
        }, 'e2e');
        dock._songEditor.render();
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
        window.__opDock._session.get().clips.map((c) => ({ start: c.startCol, repeats: c.repeats })));
}

test.describe('mobile', () => {
    test('song editor fits the screen with a long song', async ({ page }) => {
        await openMobile(page);
        await seedSong(page);
        await page.evaluate(async () => {
            const sm = await import('/html/components/song-model.js');
            const dock = window.__opDock;
            const pattern = sm.createPattern({ name: 'Far', measures: 1 });
            sm.patternStore.put(pattern);
            dock._session.update((song) => {
                sm.addClip(song, {
                    patternId: pattern.id, trackId: song.tracks[0].id, startCol: 200 * 16, repeats: 1,
                }, (id) => sm.patternStore.get(id));
            }, 'e2e');
            dock._songEditor.render();
        });
        await page.locator('.dock-tab', { hasText: 'Song' }).click();
        await expect(page.locator('.song-editor')).toBeVisible();

        // The mobile face of the stranding bug: before the width:100% fix,
        // one small clip was enough to put Play at x=-258 on a 390px screen.
        const l = await page.evaluate(() => {
            const x = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().x);
            return {
                toolbar: x('.song-toolbar button'),
                palette: x('.song-palette'),
                editorW: Math.round(document.querySelector('.song-editor').getBoundingClientRect().width),
            };
        });
        expect(l.toolbar).toBeGreaterThanOrEqual(0);
        expect(l.palette).toBeGreaterThanOrEqual(0);
        expect(l.editorW).toBeLessThanOrEqual(390);
    });

    test('a tap places a clip, a swipe scrolls the grid', async ({ page }) => {
        await openMobile(page);
        await seedSong(page);
        await page.locator('.dock-tab', { hasText: 'Song' }).click();
        await expect(page.locator('.song-clip')).toBeVisible();

        await page.locator('.song-pattern-item').first().tap();
        const lane = await page.locator('.song-lane').first().boundingBox();
        await page.touchscreen.tap(lane.x + 150, lane.y + lane.height / 2);
        await expect.poll(() => clips(page)).toHaveLength(2);

        const grid = page.locator('.song-grid');
        const before = await grid.evaluate((el) => el.scrollLeft);
        await touchSwipe(page,
            { x: lane.x + 200, y: lane.y + lane.height / 2 },
            { x: lane.x + 20, y: lane.y + lane.height / 2 });
        expect(await grid.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
    });

    test('a touch-drag moves a clip and does not throw', async ({ page }) => {
        // pointer() used to read e.touches[0] on touchend, where the list is
        // empty — every drag crashed at the commit step and the clip snapped
        // back. The fixture's pageerror guard doubles as the crash assertion.
        await openMobile(page);
        await seedSong(page);
        await page.locator('.dock-tab', { hasText: 'Song' }).click();
        await expect(page.locator('.song-clip')).toBeVisible();

        const clip = await page.locator('.song-clip').first().boundingBox();
        await touchSwipe(page,
            { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 },
            { x: clip.x + clip.width / 2 + 97, y: clip.y + clip.height / 2 });

        // 97px right at 48px/measure, snapped to the bar: two bars = 32 cols.
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
});
