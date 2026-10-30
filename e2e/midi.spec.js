// The MIDI panel and the clock, against a fake navigator.requestMIDIAccess
// injected before any app code runs. test/midi-clock.test.js proves the same
// byte streams against the stub; this file proves the journey a user takes —
// menu → modal → Enable → pick ports → checkbox → real transport ticking —
// wires those bytes to an actual (fake) port, with the settings persisted.
//
// The fake mirrors test/harness.js's StubMidiPort: `sent` collects
// [data, timestamp] pairs on outputs, `onmidimessage` is how input arrives.
// It hangs off window.__midiFake for the tests to reach.

import { test, expect, openApp, openRollTab } from './fixtures.js';

const MIDI_KEY = 'openpatches_midi';

const FAKE_MIDI = () => {
    function makePort(id, name, type) {
        return {
            id, name, type,
            manufacturer: 'Fake',
            state: 'connected',
            connection: 'open',
            onmidimessage: null,
            sent: [],
            send(data, ts) { this.sent.push({ data: Array.from(data), ts: ts ?? null }); },
            open() { return Promise.resolve(this); },
            close() { return Promise.resolve(this); },
        };
    }
    const inputs = [makePort('in0', 'Fake Keys', 'input')];
    const outputs = [makePort('out0', 'Fake Synth', 'output')];
    window.__midiFake = { inputs, outputs, requests: [] };
    navigator.requestMIDIAccess = (opts = {}) => {
        window.__midiFake.requests.push({ sysex: !!opts.sysex });
        return Promise.resolve({
            inputs: new Map(inputs.map((p) => [p.id, p])),
            outputs: new Map(outputs.map((p) => [p.id, p])),
            sysexEnabled: !!opts.sysex,
            onstatechange: null,
        });
    };
};

async function openMidiPanel(page) {
    await page.locator('.menu-item[data-menu="midi"] .menu-label').click();
    await page.locator('#menu-midi-devices').click();
    await expect(page.locator('.modal-overlay .midi-enable-btn, .modal-overlay .midi-status-text').first()).toBeAttached();
}

async function enableMidi(page) {
    await page.locator('.midi-enable-btn').click();
    await expect(page.locator('.midi-status-text')).toHaveText(/Enabled/);
}

function portSelect(page, label) {
    return page.locator(`.midi-field:has(label:text-is("${label}")) select`);
}

test.describe('MIDI panel', () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(FAKE_MIDI);
        await openApp(page);
    });

    test('Enable lists the devices and a port choice survives a reload', async ({ page }) => {
        await openMidiPanel(page);

        // Nothing touched the API before the user asked — the panel promises
        // exactly that in its intro text.
        expect(await page.evaluate(() => window.__midiFake.requests.length)).toBe(0);

        await enableMidi(page);
        await expect(portSelect(page, 'Input').locator('option', { hasText: 'Fake Keys' })).toHaveCount(1);
        await expect(portSelect(page, 'Output').locator('option', { hasText: 'Fake Synth' })).toHaveCount(1);

        await portSelect(page, 'Output').selectOption('out0');
        await page.locator('.modal-close:visible').click();

        // A fresh boot re-requests access (the grant is persisted) and the
        // selection comes back — by id here, by name when ids drift.
        await page.reload();
        await expect(page.locator('.keyboard .key').first()).toBeVisible();
        await openMidiPanel(page);
        await expect(portSelect(page, 'Output')).toHaveValue('out0');
    });

    test('the send-clock checkbox persists across a reload', async ({ page }) => {
        await openMidiPanel(page);
        await enableMidi(page);

        const clockBox = page.locator('.midi-send-clock');
        await expect(clockBox).not.toBeChecked();
        await clockBox.check();

        const stored = await page.evaluate((key) =>
            JSON.parse(localStorage.getItem(key) || '{}'), MIDI_KEY);
        expect(stored.sendClock).toBe(true);

        await page.reload();
        await expect(page.locator('.keyboard .key').first()).toBeVisible();
        await openMidiPanel(page);
        await expect(page.locator('.midi-send-clock')).toBeChecked();
    });

    test('playing with send-clock on streams a timestamped beat clock', async ({ page }) => {
        await openMidiPanel(page);
        await enableMidi(page);
        await portSelect(page, 'Output').selectOption('out0');
        await page.locator('.midi-send-clock').check();
        await page.locator('.modal-close:visible').click();

        await openRollTab(page);
        await page.evaluate(() => {
            window.__opDock._pianoroll.addNote({ midi: 60, start: 0, dur: 2 });
        });
        await page.locator('.pianoroll-play').click();
        await page.waitForTimeout(1000);
        await page.locator('.pianoroll-stop').click();

        const sent = await page.evaluate(() => window.__midiFake.outputs[0].sent);
        const bytes = sent.map((m) => m.data[0]);

        // Start first, Stop last, 0xF8 ticks in between — 24 PPQN at the
        // song's 120 BPM is 48 per second; allow slack for the stop landing
        // mid-column. Each message carries a timestamp (that is the whole
        // scheduling design), and they never go backwards.
        expect(bytes[0]).toBe(0xFA);
        expect(bytes[bytes.length - 1]).toBe(0xFC);
        const ticks = sent.filter((m) => m.data[0] === 0xF8);
        expect(ticks.length).toBeGreaterThanOrEqual(42);
        expect(ticks.length).toBeLessThanOrEqual(60);
        for (const m of sent) expect(m.ts).toBeGreaterThan(0);
        for (let i = 1; i < ticks.length; i++) {
            expect(ticks[i].ts).toBeGreaterThan(ticks[i - 1].ts);
        }

        // The tempo is in the stamps: ticks are ~20.83 ms apart at 120 BPM.
        const span = ticks[ticks.length - 1].ts - ticks[0].ts;
        const msPerTick = span / (ticks.length - 1);
        expect(msPerTick).toBeGreaterThan(18);
        expect(msPerTick).toBeLessThan(24);
    });

    test('a note from the input device presses the on-screen key', async ({ page }) => {
        await openMidiPanel(page);
        await enableMidi(page);
        await portSelect(page, 'Input').selectOption('in0');
        await page.locator('.modal-close:visible').click();

        const sendNote = (bytes) => page.evaluate((data) => {
            const port = window.__midiFake.inputs[0];
            port.onmidimessage({ data: Uint8Array.from(data), timeStamp: performance.now() });
        }, bytes);

        const key = page.locator('.key[title="C4"]');
        await sendNote([0x90, 60, 100]);           // note on, middle C
        await expect(key).toHaveClass(/pressed/);

        await sendNote([0x80, 60, 0]);             // note off
        await expect(key).not.toHaveClass(/pressed/);
    });
});
