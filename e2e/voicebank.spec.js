// The voice bank as the user drives it: assign from a patch's ♫ picker,
// read the slot back off every copy of that patch, and mix it in the Mixer
// tab. The unit suite covers the bank's data contract against a stub DOM;
// what only exists here is the journey through real rendering — a popover
// that has to be positioned and clickable, badges on rows the canvas
// rebuilds, and mute/solo reaching the engine across a reload.

import { readFileSync } from 'node:fs';
import { test, expect, openApp, openMixerTab } from './fixtures.js';

const DEMO_SYX = 'html/DEMO.syx';

async function importDemoBank(page) {
    await page.locator('.menu-item[data-menu="file"] .menu-label').click();
    const picker = page.waitForEvent('filechooser');
    await page.locator('#menu-import-syx').click();
    await (await picker).setFiles(DEMO_SYX);
    // The import lands as a container of patch rows on the canvas.
    await expect(page.locator('.patch-row').first()).toBeVisible();
}

/** The bank as the app sees it: one row per occupied slot. */
function bankState(page) {
    return page.evaluate(() => window.__opDock._voiceBank._getEntries()
        .map((e, i) => e ? {
            slot: i, name: e.name, volume: e.volume,
            effective: e.effectiveVolume, muted: !!e.muted, solo: !!e.solo,
        } : null)
        .filter(Boolean));
}

/** Open the ♫ picker on a patch row and commit slot `n` (1-based label). */
async function assignRowToSlot(row, n) {
    await row.locator('.patch-assign').click();
    const pop = row.locator('.patch-assign-pop');
    await expect(pop).toBeVisible();
    await pop.locator('.patch-assign-slot').nth(n - 1).click();
    await expect(pop).toHaveCount(0);
}

test.describe('assigning patches to the bank', () => {
    test('the ♫ picker puts a patch in the slot the user chose', async ({ page }) => {
        await openApp(page);
        await importDemoBank(page);

        const rows = page.locator('.patch-row');
        const firstName = await rows.first().locator('.patch-name').textContent();
        await assignRowToSlot(rows.first(), 3);

        expect(await bankState(page)).toEqual([
            { slot: 2, name: firstName.trim(), volume: 100, effective: 100, muted: false, solo: false },
        ]);
    });

    test('the slot badge appears on the row and survives a canvas re-render', async ({ page }) => {
        await openApp(page);
        await importDemoBank(page);

        const row = page.locator('.patch-row').first();
        const badge = row.locator('.patch-slot-badge');
        await expect(badge).toBeHidden();

        await assignRowToSlot(row, 2);
        await expect(badge).toBeVisible();
        await expect(badge).toHaveText('2');

        // A reload rebuilds every row from scratch and replays the bank
        // snapshot, so the number has to come back on the new element.
        await page.reload();
        await expect(page.locator('.patch-row').first().locator('.patch-slot-badge')).toHaveText('2');
    });

    test('reassigning to an occupied slot swaps the two voices', async ({ page }) => {
        await openApp(page);
        await importDemoBank(page);

        const rows = page.locator('.patch-row');
        await assignRowToSlot(rows.nth(0), 1);
        await assignRowToSlot(rows.nth(1), 2);

        const before = await bankState(page);
        expect(before.map(e => e.slot)).toEqual([0, 1]);

        // Slot 1's voice onto slot 2 — the occupant falls back to slot 1.
        await assignRowToSlot(rows.nth(0), 2);

        const after = await bankState(page);
        expect(after.map(e => [e.slot, e.name])).toEqual([
            [0, before[1].name],
            [1, before[0].name],
        ]);

        // And both rows show their new numbers.
        await expect(rows.nth(0).locator('.patch-slot-badge')).toHaveText('2');
        await expect(rows.nth(1).locator('.patch-slot-badge')).toHaveText('1');
    });

    test('one voice never occupies two slots', async ({ page }) => {
        await openApp(page);
        await importDemoBank(page);

        const row = page.locator('.patch-row').first();
        await assignRowToSlot(row, 1);
        await assignRowToSlot(row, 5);

        const state = await bankState(page);
        expect(state).toHaveLength(1);
        expect(state[0].slot).toBe(4);
    });
});

test.describe('the Mixer', () => {
    test('renders one strip per slot and follows an assignment', async ({ page }) => {
        await openApp(page);
        await importDemoBank(page);
        await assignRowToSlot(page.locator('.patch-row').first(), 1);

        await openMixerTab(page);
        await expect(page.locator('.voicebank-item')).toHaveCount(8);
        await expect(page.locator('.voicebank-item').first()).not.toHaveClass(/voicebank-empty/);
        await expect(page.locator('.voicebank-item').nth(1)).toHaveClass(/voicebank-empty/);
        await expect(page.locator('.voicebank-item').first().locator('.voicebank-name')).toBeVisible();
    });

    test('mute silences the channel without moving the fader, and persists', async ({ page }) => {
        await openApp(page);
        await importDemoBank(page);
        await assignRowToSlot(page.locator('.patch-row').first(), 1);
        await openMixerTab(page);

        await page.locator('.voicebank-item').first().locator('.voicebank-mute').click();
        let state = await bankState(page);
        expect(state[0]).toMatchObject({ muted: true, volume: 100, effective: 0 });

        await page.reload();
        await expect(page.locator('.keyboard .key').first()).toBeVisible();
        state = await bankState(page);
        expect(state[0]).toMatchObject({ muted: true, volume: 100, effective: 0 });

        await openMixerTab(page);
        await expect(page.locator('.voicebank-mute').first()).toHaveClass(/on/);
    });

    test('solo silences every other strip and releases them when switched off', async ({ page }) => {
        await openApp(page);
        await importDemoBank(page);
        const rows = page.locator('.patch-row');
        await assignRowToSlot(rows.nth(0), 1);
        await assignRowToSlot(rows.nth(1), 2);
        await openMixerTab(page);

        const solo2 = page.locator('.voicebank-item').nth(1).locator('.voicebank-solo');
        await solo2.click();
        expect((await bankState(page)).map(e => e.effective)).toEqual([0, 100]);

        await solo2.click();
        expect((await bankState(page)).map(e => e.effective)).toEqual([100, 100]);
    });

    test('removing a voice leaves a hole — the slots below keep their channel', async ({ page }) => {
        await openApp(page);
        await importDemoBank(page);
        const rows = page.locator('.patch-row');
        await assignRowToSlot(rows.nth(0), 1);
        await assignRowToSlot(rows.nth(1), 2);
        await assignRowToSlot(rows.nth(2), 3);
        await openMixerTab(page);

        const names = (await bankState(page)).map(e => e.name);
        await page.locator('.voicebank-item').nth(1).locator('.voicebank-remove').click();

        const after = await bankState(page);
        expect(after.map(e => [e.slot, e.name])).toEqual([
            [0, names[0]],
            [2, names[2]],
        ]);
        // The third voice still wears slot 3 on its row.
        await expect(rows.nth(2).locator('.patch-slot-badge')).toHaveText('3');
    });
});
