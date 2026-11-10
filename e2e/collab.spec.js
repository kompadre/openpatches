// Collaborate, milestone 1: two tabs of one browser. The host shares; a
// second tab joins by link, mirrors the project live, can play it, and
// cannot change it. Stopping leaves the guest a choice.

import { test, expect, openApp } from './fixtures.js';

async function seed(page) {
    await page.evaluate(async () => {
        const M = await import('/html/components/project-model.js');
        const pattern = window.__opProject.createPattern({
            name: 'Riff', notes: [{ midi: 60, start: 0, dur: 4 }],
        }, 'e2e');
        window.__opProject.update((project, section) => {
            const track = M.createTrack({ name: 'Keys', slot: 0 });
            project.tracks.push(track);
            M.addClip(project, section, { trackId: track.id, patternId: pattern.id, startCol: 0 });
        }, 'e2e');
        window.__opProject.rename('Jam', 'e2e');
    });
}

const notes = (page) => page.evaluate(() => Object.values(window.__opProject.get().patterns)[0].notes
    .map((n) => [n.midi, n.start, n.dur]).sort((a, b) => a[1] - b[1]));

/** A second tab in the same browser — what "Open a watching tab" opens. */
async function guestPage(context, code) {
    const page = await context.newPage();
    await page.addInitScript(() => {
        localStorage.setItem('openpatches_tutorial', 'completed');
        localStorage.setItem('openpatches_demo_offered', '1');
    });
    const errors = [];
    page.on('pageerror', (err) => errors.push(`uncaught: ${err.message}`));
    page.on('console', (msg) => {
        if (msg.type() === 'error' && !/favicon|\/api\/play|DX7 synth unavailable/i.test(msg.text())) errors.push(msg.text());
    });
    page.opErrors = errors;
    await page.goto('/index.html?join=' + code);
    await expect(page.locator('.keyboard .key').first()).toBeVisible();
    return page;
}

test('share, join by link, follow live, play; guest edits are undone; stop, keep a copy', async ({ page, context }) => {
    await openApp(page);
    await seed(page);

    // Host: File › Collaborate… › Start sharing.
    await page.locator('.menu-item[data-menu="file"] .menu-label').click();
    await page.locator('#menu-collab').click();
    await page.locator('.collab-host-btn').click();
    const code = (await page.locator('.collab-code').textContent()).trim();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    await expect(page.locator('#menu-collab-chip')).toContainText('Sharing ' + code + ' · 0 watching');

    // Guest: a second tab by link. The URL loses ?join, the project arrives.
    const guest = await guestPage(context, code);
    await expect(guest.locator('#menu-collab-chip')).toContainText('Watching Jam · view only');
    expect(new URL(guest.url()).search).toBe('');
    await expect(guest.locator('#menu-status')).toHaveText('Jam');
    expect(await notes(guest)).toEqual([[60, 0, 4]]);
    expect(await guest.evaluate(() => window.__opProject.isGuest())).toBe(true);
    await expect(page.locator('.collab-peers')).toHaveText('1 person watching');
    await expect(page.locator('#menu-collab-chip')).toContainText('1 watching');
    await page.screenshot({ path: '/tmp/op-shots/collab-host.png' });
    await page.locator('.modal-dialog:has(.collab-dialog) .modal-close').click();

    // The guest's project list did not gain the host's project.
    const ids = await guest.evaluate(() => window.__opProject.list().map((p) => p.id));
    const hostId = await page.evaluate(() => window.__opProject.getId());
    const listedOnce = ids.filter((id) => id === hostId).length;
    expect(listedOnce).toBeLessThanOrEqual(1);   // the host's own tab lists it — same browser

    // The host edits a pattern in the tracker: it arrives on the guest's tracker.
    await page.evaluate(() => {
        const p = Object.values(window.__opProject.get().patterns)[0];
        p.notes.push({ midi: 67, start: 8, dur: 4 });
        window.__opProject.touchPattern(p.id, 'tracker');
    });
    await expect.poll(() => notes(guest)).toEqual([[60, 0, 4], [67, 8, 4]]);
    await guest.locator('.dock-tab-tracker').click();
    await expect(guest.locator('.tracker-head-name')).toHaveText('1 Keys');

    // The band follows too: the host renames the track.
    await page.evaluate(() => window.__opProject.update((p) => { p.tracks[0].name = 'Lead'; }, 'voicebank', 'tracks'));
    await expect(guest.locator('.tracker-head-name')).toHaveText('1 Lead');

    // The guest can play it.
    await guest.evaluate(() => window.__opDock._pianoroll.getTransport().play());
    await expect.poll(() => guest.evaluate(() => window.__opDock._pianoroll.getTransport().isRunning())).toBe(true);
    // …and keeps playing while the host edits.
    await page.evaluate(() => window.__opProject.update((p) => { p.bpm = 100; }, 'e2e'));
    await expect.poll(() => guest.evaluate(() => window.__opProject.get().bpm)).toBe(100);
    expect(await guest.evaluate(() => window.__opDock._pianoroll.getTransport().isRunning())).toBe(true);
    await guest.evaluate(() => window.__opDock._pianoroll.getTransport().stop());

    // A guest edit is undone, and the chip says why.
    await guest.evaluate(() => {
        const p = Object.values(window.__opProject.get().patterns)[0];
        p.notes.length = 0;
        window.__opProject.touchPattern(p.id, 'tracker');
    });
    await expect(guest.locator('#menu-collab-chip')).toContainText('View only');
    await guest.screenshot({ path: '/tmp/op-shots/collab-guest-notice.png', clip: { x: 0, y: 0, width: 1280, height: 40 } });
    expect(await notes(guest)).toEqual([[60, 0, 4], [67, 8, 4]]);
    expect(await notes(page)).toEqual([[60, 0, 4], [67, 8, 4]]);

    // Host stops: the guest still sees the project, and keeps a copy.
    await page.evaluate(() => window.__opCollab.stopHosting());
    await expect(guest.locator('#menu-collab-chip')).toContainText(/Session ended|host stopped/);
    await guest.locator('#menu-collab-chip').click();
    await guest.locator('.collab-copy-btn').click();
    await expect(guest.locator('#menu-collab-chip')).toBeHidden();
    const copy = await guest.evaluate(() => ({
        id: window.__opProject.getId(), name: window.__opProject.get().name, guest: window.__opProject.isGuest(),
    }));
    expect(copy.guest).toBe(false);
    expect(copy.id).not.toBe(hostId);
    expect(copy.name).toMatch(/^Jam/);
    expect(await notes(guest)).toEqual([[60, 0, 4], [67, 8, 4]]);
    await expect(page.locator('#menu-collab-chip')).toBeHidden();

    expect(guest.opErrors).toEqual([]);
});

test('a wrong code: the dialog says no one is sharing it', async ({ page }) => {
    await openApp(page);
    await page.locator('.menu-item[data-menu="file"] .menu-label').click();
    await page.locator('#menu-collab').click();
    await page.locator('.collab-code-input').fill('zzzz99');
    await page.locator('.collab-join-btn').click();
    await expect(page.locator('#menu-collab-chip')).toContainText('Joining ZZZZ99');
    await expect(page.locator('.collab-error')).toHaveText('No one is sharing with code ZZZZ99', { timeout: 6000 });
    await expect(page.locator('#menu-collab-chip')).toBeHidden();
    expect(await page.evaluate(() => window.__opProject.isGuest())).toBe(false);
});
