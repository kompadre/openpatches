// Collaborate: two tabs of one browser, and two browser contexts (as two
// machines) through the server's room relay. The host shares; a second tab
// joins by link, mirrors the project live, plays it, and edits it —
// conflicts refereed per atom, with a table and Reapply mine. Stopping
// leaves the guest a choice.

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

test('share, join by link, follow live, play; guest edits reach the host; stop, keep a copy', async ({ page, context }) => {
    await openApp(page);
    await seed(page);

    // Host: File › Collaborate… — asked who they are, once — › Start sharing.
    await page.locator('.menu-item[data-menu="file"] .menu-label').click();
    await page.locator('#menu-collab').click();
    await expect(page.locator('.collab-identity h4')).toHaveText('Who are you?');
    await page.locator('.collab-host-btn').click();
    await expect(page.locator('.collab-error')).toHaveText('Pick a name first');
    await page.locator('.collab-alias-input').fill('Ann');
    await page.locator('.collab-swatch').nth(5).click();
    await page.locator('.collab-host-btn').click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('openpatches_profile')).identity)).toEqual({ alias: 'Ann', color: '#3b8fd1' });
    const code = (await page.locator('.collab-code').textContent()).trim();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    await expect(page.locator('#menu-collab-chip')).toContainText('Sharing ' + code + ' · 0 in');

    // Guest: a second tab by link. The URL loses ?join, the project arrives.
    const guest = await guestPage(context, code);
    await expect(guest.locator('#menu-collab-chip')).toContainText('With Jam');
    expect(new URL(guest.url()).search).toBe('');
    await expect(guest.locator('#menu-status')).toHaveText('Jam');
    expect(await notes(guest)).toEqual([[60, 0, 4]]);
    expect(await guest.evaluate(() => window.__opProject.isGuest())).toBe(true);
    await expect(page.locator('.collab-peers')).toHaveText('1 person in');
    await expect(page.locator('#menu-collab-chip')).toContainText('1 in');
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

    // A guest edit reaches the host, and stays on the guest.
    await guest.evaluate(() => {
        const p = Object.values(window.__opProject.get().patterns)[0];
        p.notes.push({ midi: 64, start: 4, dur: 4 });
        window.__opProject.touchPattern(p.id, 'tracker');
    });
    await expect.poll(() => notes(page)).toEqual([[60, 0, 4], [64, 4, 4], [67, 8, 4]]);
    await expect.poll(() => guest.evaluate(() => window.__opCollab.status().pending)).toBe(0);
    expect(await notes(guest)).toEqual([[60, 0, 4], [64, 4, 4], [67, 8, 4]]);
    expect(await guest.evaluate(() => window.__opCollab.status().conflicts)).toEqual([]);
    await guest.screenshot({ path: '/tmp/op-shots/collab-guest-edit.png', clip: { x: 0, y: 0, width: 1280, height: 40 } });

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
    expect(await notes(guest)).toEqual([[60, 0, 4], [64, 4, 4], [67, 8, 4]]);
    await expect(page.locator('#menu-collab-chip')).toBeHidden();

    expect(guest.opErrors).toEqual([]);
});

/** The guest's alias is the same browser's profile; name the host first, then join. */
async function shared(page, context) {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => {
        localStorage.setItem('openpatches_profile', JSON.stringify({
            ...JSON.parse(localStorage.getItem('openpatches_profile') || '{}'), identity: { alias: 'Ann', color: '#3b8fd1' },
        }));
    });
    const code = await page.evaluate(() => window.__opCollab.host());
    const guest = await guestPage(context, code);
    await expect(guest.locator('#menu-collab-chip')).toContainText('With Jam');
    return { code, guest };
}

const status = (p) => p.evaluate(() => window.__opCollab.status());
const bpm = (p) => p.evaluate(() => window.__opProject.get().bpm);
const setBpm = (p, v, begin = false) => p.evaluate(([v, begin]) => {
    if (begin) window.__opProject.beginEdit({}, 'transport');
    window.__opProject.update((prj) => { prj.bpm = v; }, 'transport');
}, [v, begin]);

test('each kind of conflict on purpose: lost, overridden, invariant; the table, Reapply mine, presence', async ({ page, context }) => {
    const { guest } = await shared(page, context);

    // 1. A conflict the host started first: the guest's edit loses, snaps back, gets a row.
    await setBpm(page, 60);
    await guest.waitForTimeout(30);
    await setBpm(guest, 50);
    await expect.poll(() => bpm(page)).toBe(60);
    await expect.poll(() => bpm(guest)).toBe(60);
    await expect(guest.locator('#menu-collab-chip')).toContainText('⚠ 1');
    let rows = (await status(guest)).conflicts;
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('conflict');
    expect(rows[0].reason).toMatch(/Ann started first/);
    expect((await status(page)).conflicts).toEqual([]);

    // The table says what, yours, theirs, kept; Reapply mine sends it again and wins now.
    await guest.locator('#menu-collab-chip').click();
    const line = guest.locator('.collab-conflict-row');
    await expect(line).toHaveCount(1);
    await expect(line.locator('.collab-what')).toHaveText('project › tempo');
    await expect(line.locator('.collab-mine')).toContainText('50');
    await expect(line.locator('.collab-theirs')).toContainText('Ann: 60');
    await expect(line.locator('.collab-kept')).toContainText('Ann started first');
    await guest.screenshot({ path: '/tmp/op-shots/collab-conflicts.png' });
    await line.locator('.collab-reapply-btn').click();
    await expect(guest.locator('.collab-conflict-row')).toHaveCount(0);
    await expect.poll(() => bpm(page)).toBe(50);
    await expect.poll(() => bpm(guest)).toBe(50);
    expect((await status(guest)).conflicts).toEqual([]);
    await guest.locator('.modal-dialog:has(.collab-dialog) .modal-close').click();

    // 2. Overridden: the guest begins first, the host edits and lands first, the guest's
    //    commit beats it — the host gets the row, both end on the guest's value.
    await setBpm(guest, 90, true);           // began first; sent after the quiet time
    await page.waitForTimeout(30);
    await setBpm(page, 80);
    await expect.poll(() => bpm(guest)).toBe(90);
    await expect.poll(() => bpm(page)).toBe(90);
    await expect(page.locator('#menu-collab-chip')).toContainText('⚠ 1');
    rows = (await status(page)).conflicts;
    expect(rows[0].kind).toBe('overridden');
    expect((await status(guest)).conflicts).toEqual([]);

    // 3. An invariant: the host places a second clip at bar 3; the guest, unaware, moves the
    //    first clip there too — rejected with the reason, the move comes back.
    await page.evaluate(async () => {
        const M = await import('/html/components/project-model.js');
        window.__opProject.update((p, sec) => {
            M.addClip(p, sec, { trackId: p.tracks[0].id, patternId: Object.keys(p.patterns)[0], startCol: 32 });
        }, 'section-editor');
    });
    await guest.evaluate(() => window.__opProject.update((p, sec) => { sec.clips[0].startCol = 32; }, 'section-editor'));
    const starts = (p) => p.evaluate(() => window.__opProject.getSection().clips.map((c) => c.startCol).sort((a, b) => a - b));
    await expect.poll(() => starts(page)).toEqual([0, 32]);
    await expect.poll(() => starts(guest)).toEqual([0, 32]);
    await expect.poll(async () => (await status(guest)).conflicts.map((r) => r.kind)).toEqual(['invariant']);
    expect((await status(guest)).conflicts[0].reason).toMatch(/overlap/);

    // 4. Presence: the guest's first keystroke says so on the host, until the edit lands.
    await guest.evaluate(() => {
        const p = Object.values(window.__opProject.get().patterns)[0];
        window.__opProject.beginEdit({ patternId: p.id }, 'tracker');
    });
    await page.locator('#menu-collab-chip').click();
    await expect(page.locator('.collab-editing')).toHaveText(/is editing Riff/);
    await guest.evaluate(() => {
        const p = Object.values(window.__opProject.get().patterns)[0];
        p.notes.push({ midi: 64, start: 4, dur: 4 });
        window.__opProject.touchPattern(p.id, 'tracker');
    });
    await expect(page.locator('.collab-editing')).toHaveCount(0);
    await expect.poll(() => notes(page)).toEqual([[60, 0, 4], [64, 4, 4]]);

    expect(guest.opErrors).toEqual([]);
});

test('another machine: a separate browser context joins through the relay, edits, and conflicts', async ({ page, browser }) => {
    // A second context shares no storage and no BroadcastChannel with the
    // first — as far as the app can tell, another computer. Only the
    // server's room relay (server.py › /api/room/<code>) can join them.
    await openApp(page);
    await seed(page);
    await page.evaluate(() => {
        localStorage.setItem('openpatches_profile', JSON.stringify({
            ...JSON.parse(localStorage.getItem('openpatches_profile') || '{}'), identity: { alias: 'Ann', color: '#3b8fd1' },
        }));
    });
    const code = await page.evaluate(() => window.__opCollab.host());
    await expect.poll(async () => (await status(page)).link).toBe('relay');

    const other = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await other.addInitScript(() => {
        localStorage.setItem('openpatches_profile', JSON.stringify({ identity: { alias: 'Bob', color: '#d84a6b' } }));
    });
    const guest = await guestPage(other, code);
    await expect(guest.locator('#menu-collab-chip')).toContainText('With Jam');
    expect((await status(guest)).link).toBe('relay');
    expect(await notes(guest)).toEqual([[60, 0, 4]]);
    await expect.poll(async () => (await status(page)).peers).toBe(1);

    // Both ways: the host's edit arrives; the guest's edit lands on the host.
    await page.evaluate(() => {
        const p = Object.values(window.__opProject.get().patterns)[0];
        p.notes.push({ midi: 67, start: 8, dur: 4 });
        window.__opProject.touchPattern(p.id, 'roll');
    });
    await expect.poll(() => notes(guest)).toEqual([[60, 0, 4], [67, 8, 4]]);
    await guest.evaluate(() => {
        const p = Object.values(window.__opProject.get().patterns)[0];
        p.notes.push({ midi: 64, start: 4, dur: 4 });
        window.__opProject.touchPattern(p.id, 'roll');
    });
    await expect.poll(() => notes(page)).toEqual([[60, 0, 4], [64, 4, 4], [67, 8, 4]]);

    // A conflict across machines: the host started first; Bob's row names Ann.
    await setBpm(page, 60);
    await guest.waitForTimeout(30);
    await setBpm(guest, 50);
    await expect.poll(() => bpm(guest)).toBe(60);
    await expect.poll(async () => (await status(guest)).conflicts.map((r) => r.reason)).toEqual([expect.stringMatching(/Ann started first/)]);

    // Guest's own identity came from its own profile, not the host's.
    expect(await guest.evaluate(() => window.__opCollab.status().alias)).toBe('Bob');

    // The host stops: the other machine is told.
    await page.evaluate(() => window.__opCollab.stopHosting());
    await expect(guest.locator('#menu-collab-chip')).toContainText(/Session ended|host stopped/);
    expect(guest.opErrors).toEqual([]);
    await other.close();
});

/** Record a page's sockets, so a test can cut one as a network would. */
const recordSockets = () => {
    const Real = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends Real {
        constructor(...a) { super(...a); window.__sockets.push(this); }
    };
};

test('a dropped socket reconnects and catches up; a host that vanishes is noticed', async ({ page, browser }) => {
    await page.addInitScript(recordSockets);
    await openApp(page);
    await seed(page);
    const code = await page.evaluate(() => window.__opCollab.host());
    await expect.poll(async () => (await status(page)).link).toBe('relay');

    const other = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await other.addInitScript(() => {
        localStorage.setItem('openpatches_profile', JSON.stringify({ identity: { alias: 'Bob', color: '#d84a6b' } }));
    });
    await other.addInitScript(recordSockets);
    const guest = await guestPage(other, code);
    await expect(guest.locator('#menu-collab-chip')).toContainText('With Jam');

    // Cut the guest's socket. While it is down: an edit on each side.
    await guest.evaluate(() => window.__sockets.at(-1).close());
    await expect.poll(async () => (await status(guest)).link).not.toBe('relay');
    await page.evaluate(() => window.__opProject.update((p) => { p.name = 'Jam renamed'; }, 'e2e'));
    await guest.evaluate(() => window.__opProject.update((p) => { p.bpm = 77; }, 'transport'));

    // It comes back by itself, resyncs, and its edit gets through.
    await expect.poll(async () => (await status(guest)).link, { timeout: 10000 }).toBe('relay');
    expect(await guest.evaluate(() => window.__sockets.length)).toBeGreaterThan(1);
    await expect.poll(() => guest.evaluate(() => window.__opProject.get().name)).toBe('Jam renamed');
    await expect.poll(() => bpm(page)).toBe(77);
    await expect.poll(async () => (await status(guest)).pending).toBe(0);

    // The host's network goes, with no goodbye and no way back: the relay
    // tells the guest, who says so and waits out the grace period.
    await page.evaluate(() => {
        window.WebSocket = class { constructor() { throw new Error('offline'); } };
        window.__sockets.at(-1).close();
    });
    await expect.poll(async () => (await status(guest)).hostAway, { timeout: 10000 }).toBe(true);
    expect((await status(guest)).state).toBe('watching');
    await expect(guest.locator('#menu-collab-chip')).toContainText(/not answering|Waiting for the host/);
    expect(guest.opErrors).toEqual([]);
    await other.close();
});

test('a wrong code: the dialog says no one is sharing it', async ({ page }) => {
    await openApp(page);
    await page.locator('.menu-item[data-menu="file"] .menu-label').click();
    await page.locator('#menu-collab').click();
    await page.locator('.collab-code-input').fill('zzzz99');
    await page.locator('.collab-join-btn').click();
    await expect(page.locator('.collab-error')).toHaveText('Pick a name first');
    await page.locator('.collab-alias-input').fill('Bob');
    await page.locator('.collab-join-btn').click();
    await expect(page.locator('#menu-collab-chip')).toContainText('Joining ZZZZ99');
    await expect(page.locator('.collab-error')).toHaveText('No one is sharing with code ZZZZ99', { timeout: 6000 });
    await expect(page.locator('#menu-collab-chip')).toBeHidden();
    expect(await page.evaluate(() => window.__opProject.isGuest())).toBe(false);
});
