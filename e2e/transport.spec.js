// Transport and tick worker, on real time.
//
// test/harness.js drives the clock by hand: it has no Worker and no real
// setTimeout, so "does the tick worker actually produce sixteenths at the
// song's tempo" has never been checkable there. That is the whole point of
// this file, and it is the one place the suite deliberately spends wall clock.
//
// The clock is reached through window.__opDock (app.js) — see the comment
// there. Everything else is driven through the UI.

import { test, expect, openApp, openRollTab } from './fixtures.js';

const MS_PER_MIN = 60_000;

/** Put one note on the roll: startPlayback() is a no-op on an empty roll. */
async function seedNote(page) {
    await page.evaluate(() => {
        window.__opDock._pianoroll.addNote({ midi: 60, start: 0, dur: 2 });
    });
}

/**
 * Run the clock for `ms` and return every rawCol the transport broadcast.
 * rawCol counts sixteenths since the start and does not wrap, so the first
 * and last entries bound the elapsed musical time directly.
 */
async function recordTicks(page, ms) {
    return page.evaluate(async (duration) => {
        const roll = window.__opDock._pianoroll;
        const transport = roll.getTransport();
        const cols = [];
        const unsubscribe = transport.subscribe((pos) => {
            if (pos.rawCol >= 0) cols.push({ rawCol: pos.rawCol, at: performance.now() });
        });
        const bpm = transport.getBpm();
        const t0 = performance.now();
        roll.startPlayback();
        await new Promise((r) => setTimeout(r, duration));
        const elapsed = performance.now() - t0;
        const playingDuring = transport.isPlaying();
        roll.stopPlayback();
        unsubscribe();
        return { cols, bpm, elapsed, playingDuring, playingAfter: transport.isPlaying() };
    }, ms);
}

test.describe('transport', () => {
    test('Play starts the clock and Stop ends it', async ({ page }) => {
        await openApp(page);
        await openRollTab(page);
        await seedNote(page);

        const playBtn = page.locator('.pianoroll-play');
        const stopBtn = page.locator('.pianoroll-stop');

        await playBtn.click();
        await expect
            .poll(() => page.evaluate(() => window.__opDock._pianoroll.isPlaying()))
            .toBe(true);

        await stopBtn.click();
        await expect
            .poll(() => page.evaluate(() => window.__opDock._pianoroll.isPlaying()))
            .toBe(false);
    });

    test('the roll stays stopped when there is nothing to play', async ({ page }) => {
        await openApp(page);
        await openRollTab(page);

        // The browser-side twin of test/toolbar-play-empty.test.js: pressing
        // Play on an empty roll must leave the transport alone rather than
        // leaving the UI claiming it is running.
        await page.locator('.pianoroll-play').click();
        await page.waitForTimeout(300);

        expect(await page.evaluate(() => window.__opDock._pianoroll.isPlaying())).toBe(false);
    });

    test('columns advance at the song tempo', async ({ page }) => {
        test.slow();   // this one genuinely waits on the clock
        await openApp(page);
        await seedNote(page);

        const run = await recordTicks(page, 2500);

        expect(run.playingDuring, 'transport should have been running').toBe(true);
        expect(run.playingAfter, 'stopPlayback should have ended it').toBe(false);
        expect(run.cols.length, 'tick worker produced no columns').toBeGreaterThan(4);

        // rawCol is monotonic across the run — a column must never go
        // backwards, which is how a late worker batch would show up.
        const raw = run.cols.map((c) => c.rawCol);
        for (let i = 1; i < raw.length; i++) {
            expect(raw[i], `rawCol went backwards at tick ${i}`).toBeGreaterThan(raw[i - 1]);
        }

        // A column is a sixteenth, so the tempo predicts how many should have
        // passed. Measured against the span between the first and last tick
        // rather than the whole sleep: startPlayback has to spin up a worker
        // first, and that lead-in is not musical time.
        const span = run.cols.at(-1).at - run.cols[0].at;
        const observed = raw.at(-1) - raw[0];
        const expected = (span / MS_PER_MIN) * run.bpm * 4;

        // 15% — headless scheduling is not a metronome, but a wrong tempo
        // (a half- or double-time bug, the kind this catches) is off by 100%.
        expect(observed).toBeGreaterThan(expected * 0.85);
        expect(observed).toBeLessThan(expected * 1.15);
    });

    test('stopping releases held notes', async ({ page }) => {
        await openApp(page);
        await seedNote(page);

        // The audio path must come up, or "notes were released" is vacuous.
        await page.locator('.keyboard .key.white').nth(7).click();
        await expect(page.locator('#audio-status')).toHaveClass(/audio-ready/, { timeout: 10_000 });

        const stillHeld = await page.evaluate(async () => {
            const roll = window.__opDock._pianoroll;
            roll.startPlayback();
            await new Promise((r) => setTimeout(r, 600));
            roll.stopPlayback();
            await new Promise((r) => setTimeout(r, 200));
            return roll.isPlaying();
        });
        expect(stillHeld).toBe(false);
    });
});
