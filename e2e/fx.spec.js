// Phase 2: the effects rack reaches the engine, and survives a reload.
//
// The node suite proves the rack *sounds* different (test/wasm-fx.test.js
// renders through the real WASM) and that the snapshot is a correct diff
// (test/fx-snapshot.test.js). Neither can see the browser: what is left to
// check is that a change made on the open project actually crosses the
// worklet port, and that it is still there after a reload.
//
// The port is tapped in an init script, before app.js builds anything, so
// the messages are the real ones the real AudioWorkletNode received.

import { test, expect, openApp, openMixerTab, openPatchesTab } from './fixtures.js';

/**
 * Start the audio engine. `sendFxSnapshot` is a no-op until the worklet is
 * up — pressing a key is the app's cheapest route into acquire(), the same
 * one e2e/audio.spec.js uses.
 */
async function startAudio(page) {
    await page.locator('.keyboard .key.white').nth(7).click();
    await expect(page.locator('#audio-status')).toHaveClass(/audio-ready/, { timeout: 10_000 });
}

/** Record every postMessage the app sends to the synth worklet. */
async function tapWorkletPort(page) {
    await page.addInitScript(() => {
        window.__fxMsgs = [];
        const Original = window.AudioWorkletNode;
        if (!Original) return;
        window.AudioWorkletNode = class extends Original {
            constructor(...args) {
                super(...args);
                const port = this.port;
                const send = port.postMessage.bind(port);
                port.postMessage = (msg, ...rest) => {
                    if (msg && typeof msg.type === 'string' && msg.type.startsWith('fx-')) {
                        window.__fxMsgs.push(JSON.parse(JSON.stringify(msg)));
                    }
                    return send(msg, ...rest);
                };
            }
        };
    });
}

/**
 * A project with one track on slot 0, so there is a strip to put fx on.
 *
 * Goes through `createTrack` — the factory every real caller uses, and the
 * only thing that gives a track its rack. Hand-building the record here
 * would test a shape the app never produces.
 */
async function seedTrack(page) {
    await page.evaluate(async () => {
        const { createTrack } = await import('/html/components/project-model.js');
        window.__opProject.update((p) => {
            if (!p.tracks.some(t => t.slot === 0)) {
                p.tracks.push(createTrack({ name: 'Lead', slot: 0 }));
            }
        }, 'e2e', 'tracks');
    });
}

test.describe('track effects', () => {
    test('a fresh track has a complete rack, all of it switched off', async ({ page }) => {
        await openApp(page);
        await seedTrack(page);

        const fx = await page.evaluate(() => window.__opFx.list());
        expect(fx.tracks).toHaveLength(1);
        expect(fx.tracks[0].delay).toBe(false);
        expect(fx.tracks[0].drive).toBe(false);
        // Parameters are present and sane even though nothing is on.
        expect(fx.tracks[0].delayTime).toBeGreaterThan(0);
        expect(fx.global.duckSource).toBe(-1);
    });

    test('switching delay on crosses the worklet port', async ({ page }) => {
        await tapWorkletPort(page);
        await openApp(page);
        await startAudio(page);
        await seedTrack(page);

        await page.evaluate(() => { window.__fxMsgs.length = 0; });
        await page.evaluate(() => window.__opFx.on(0, 'delay'));

        // FX_EN_DELAY is bit 0.
        await expect.poll(() => page.evaluate(() => {
            return window.__fxMsgs.some(m =>
                m.type === 'fx-snapshot' &&
                (m.channels || []).some(c => c.channel === 0 && (c.mask & 1)));
        }), { timeout: 5000 }).toBe(true);
    });

    test('switching it off again sends the bypass mask', async ({ page }) => {
        await tapWorkletPort(page);
        await openApp(page);
        await startAudio(page);
        await seedTrack(page);

        await page.evaluate(() => window.__opFx.on(0, 'delay'));
        await page.evaluate(() => { window.__fxMsgs.length = 0; });
        await page.evaluate(() => window.__opFx.off(0, 'delay'));

        await expect.poll(() => page.evaluate(() => {
            return window.__fxMsgs.some(m =>
                m.type === 'fx-snapshot' &&
                (m.channels || []).some(c => c.channel === 0 && c.mask === 0));
        }), { timeout: 5000 }).toBe(true);

        expect(await page.evaluate(() => window.__opFx.list().tracks[0].delay)).toBe(false);
    });

    test('a parameter edit keeps its fraction — it is not rounded to 0', async ({ page }) => {
        await openApp(page);
        await seedTrack(page);

        await page.evaluate(() => window.__opFx.set(0, 'delayFeedback', 0.65));
        expect(await page.evaluate(() => window.__opFx.list().tracks[0].delayFeedback))
            .toBeCloseTo(0.65, 5);
    });

    test('the rack is still there after a reload', async ({ page }) => {
        await openApp(page);
        await seedTrack(page);
        await page.evaluate(() => window.__opFx.on(0, 'delay'));
        await page.evaluate(() => window.__opFx.set(0, 'delayTime', 125));
        await page.evaluate(() => window.__opFx.global('reverbLevel', 0.8));
        await page.evaluate(() => window.__opProject.flush());

        await openApp(page);

        const fx = await page.evaluate(() => window.__opFx.list());
        expect(fx.tracks[0].delay).toBe(true);
        expect(fx.tracks[0].delayTime).toBe(125);
        expect(fx.global.reverbLevel).toBeCloseTo(0.8, 5);
    });

    test('a reload re-pushes the rack to the fresh worklet', async ({ page }) => {
        // The engine holds the only copy of the effect state and nothing
        // reads it back, so a new worklet starts at the WASM defaults.
        await openApp(page);
        await seedTrack(page);
        await page.evaluate(() => window.__opFx.on(0, 'delay'));
        await page.evaluate(() => window.__opProject.flush());

        await tapWorkletPort(page);
        await openApp(page);
        await startAudio(page);

        await expect.poll(() => page.evaluate(() => {
            return (window.__fxMsgs || []).some(m =>
                m.type === 'fx-snapshot' &&
                (m.channels || []).some(c => c.channel === 0 && (c.mask & 1)));
        }), { timeout: 5000 }).toBe(true);
    });

    test('the ducker refuses a slot with no track on it', async ({ page }) => {
        await openApp(page);
        await seedTrack(page);

        await page.evaluate(() => window.__opFx.duck(5));
        // normalizeProject drops it: a mix ducking under a track that is
        // not there just sounds quiet, with nothing to point at.
        await page.evaluate(() => window.__opProject.flush());
        await openApp(page);
        expect(await page.evaluate(() => window.__opFx.list().global.duckSource)).toBe(-1);
    });

    test('naming a real track as the duck source sticks', async ({ page }) => {
        await openApp(page);
        await seedTrack(page);

        await page.evaluate(() => window.__opFx.duck(0));
        expect(await page.evaluate(() => window.__opFx.list().global.duckSource)).toBe(0);
    });

    // The one test that listens. Everything above checks that a message was
    // posted; this checks that the sound changed — the engine is tapped with
    // an AnalyserNode and measured in a window ~1 s after the note, by which
    // time a dry note has decayed to nothing but delay repeats are still
    // sounding. It is the end-to-end proof that the rack reaches the output.
    test('delay is audible, and switching it off removes it', async ({ page }) => {
        await page.addInitScript(() => {
            const AC = window.AudioContext;
            window.AudioContext = class extends AC {
                constructor(...a) { super(...a); window.__ctx = this; }
            };
            const AWN = window.AudioWorkletNode;
            window.AudioWorkletNode = class extends AWN {
                constructor(...a) { super(...a); window.__node = this; }
            };
        });
        await openApp(page);
        await startAudio(page);

        // A real patch on slot 0 — a track with no voice makes no sound to
        // put an effect on.
        await page.evaluate(async () => {
            const [{ createTrack }, audio] = await Promise.all([
                import('/html/components/project-model.js'),
                import('/html/synth/audio-manager.js'),
            ]);
            const buf = new Uint8Array(await (await fetch('/html/DEMO.syx')).arrayBuffer());
            let bin = '';
            for (const b of buf.subarray(6, 134)) bin += String.fromCharCode(b);
            window.__opProject.update((p) => {
                if (!p.tracks.some(t => t.slot === 0)) {
                    p.tracks.push(createTrack({ name: 'Lead', slot: 0 }));
                }
            }, 'e2e', 'tracks');
            audio.sendVoiceSnapshot([{ voiceData: btoa(bin), volume: 110 }]);
            window.__audio = audio;
        });

        const measure = () => page.evaluate(async () => {
            const an = window.__ctx.createAnalyser();
            an.fftSize = 2048;
            window.__node.connect(an);
            const data = new Float32Array(an.fftSize);
            window.__audio.playNoteOnChannel(0, 60, 110);
            await new Promise(r => setTimeout(r, 120));
            window.__audio.releaseAllNotes();
            await new Promise(r => setTimeout(r, 900));   // let the dry note die
            let peak = 0;
            for (let i = 0; i < 40; i++) {
                an.getFloatTimeDomainData(data);
                for (const v of data) peak = Math.max(peak, Math.abs(v));
                await new Promise(r => setTimeout(r, 16));
            }
            an.disconnect();
            return peak;
        });

        const dry = await measure();

        await page.evaluate(() => {
            window.__opFx.set(0, 'delayTime', 600);
            window.__opFx.set(0, 'delayFeedback', 0.75);
            window.__opFx.set(0, 'delayMix', 0.9);
            window.__opFx.on(0, 'delay');
        });
        await page.waitForTimeout(100);
        const wet = await measure();

        await page.evaluate(() => window.__opFx.off(0, 'delay'));
        await page.waitForTimeout(1500);   // let the tail ring out
        const off = await measure();

        expect(wet, `dry=${dry} wet=${wet}`).toBeGreaterThan(dry * 3);
        expect(off, `wet=${wet} off=${off}`).toBeLessThan(wet / 3);
    });
});

test.describe('the Mixer’s effect controls', () => {
    /** Three demo patches on slots 1–3, Mixer open. */
    async function mixerWithVoices(page) {
        await openApp(page);
        await page.locator('.menu-item[data-menu="file"] .menu-label').click();
        const picker = page.waitForEvent('filechooser');
        await page.locator('#menu-import-syx').click();
        await (await picker).setFiles('html/DEMO.syx');
        await openPatchesTab(page);
        const rows = page.locator('.patch-row');
        for (const n of [1, 2, 3]) {
            await rows.nth(n - 1).locator('.patch-assign').click();
            await rows.nth(n - 1).locator('.patch-assign-pop .patch-assign-slot').nth(n - 1).click();
        }
        await openMixerTab(page);
    }

    test('the FX button opens a popover whose toggle lights the strip', async ({ page }) => {
        await mixerWithVoices(page);
        const strip = page.locator('.voicebank-item').first();
        await strip.locator('.voicebank-fx').click();

        const pop = page.locator('.fx-pop-track');
        await expect(pop).toBeVisible();
        await expect(pop.locator('.fx-pop-title')).toContainText('1 ');

        await pop.locator('.fx-toggle[data-flag="delay"]').check();
        await expect(strip.locator('.voicebank-fx-letter[data-flag="delay"]')).toHaveClass(/on/);
        expect(await page.evaluate(() => window.__opFx.list().tracks.find(t => t.slot === 0).delay)).toBe(true);

        // The popover survived the strip re-rendering its letters.
        await expect(pop).toBeVisible();
        await page.screenshot({ path: 'test-results/fx-popover.png' });

        await pop.locator('.fx-toggle[data-flag="delay"]').uncheck();
        await expect(strip.locator('.voicebank-fx-letter[data-flag="delay"]')).not.toHaveClass(/on/);
    });

    test('a slider commits on release and keeps its fraction', async ({ page }) => {
        await mixerWithVoices(page);
        await page.locator('.voicebank-item').first().locator('.voicebank-fx').click();
        const range = page.locator('.fx-pop-track .fx-row[data-field="delayFeedback"] .fx-range');
        await range.fill('0.65');       // fires input + change on a range
        expect(await page.evaluate(() => window.__opFx.list().tracks.find(t => t.slot === 0).delayFeedback))
            .toBeCloseTo(0.65, 5);
        await expect(page.locator('.fx-pop-track .fx-row[data-field="delayFeedback"] .fx-row-value'))
            .toHaveText('0.650');
    });

    test('Escape and a click elsewhere close it', async ({ page }) => {
        await mixerWithVoices(page);
        await page.locator('.voicebank-item').first().locator('.voicebank-fx').click();
        await expect(page.locator('.fx-pop')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('.fx-pop')).toHaveCount(0);

        await page.locator('.voicebank-item').first().locator('.voicebank-fx').click();
        await expect(page.locator('.fx-pop')).toBeVisible();
        await page.mouse.click(700, 300);
        await expect(page.locator('.fx-pop')).toHaveCount(0);
    });

    test('Reverb · Duck lists the occupied slots and commits the source', async ({ page }) => {
        await mixerWithVoices(page);
        await page.locator('.voicebank-global-fx').click();
        const pop = page.locator('.fx-pop-global');
        await expect(pop).toBeVisible();
        const options = await pop.locator('.fx-duck-source option').allTextContents();
        expect(options[0]).toBe('Nobody');
        expect(options).toHaveLength(4);
        await pop.locator('.fx-duck-source').selectOption('1');
        expect(await page.evaluate(() => window.__opFx.list().global.duckSource)).toBe(1);
        await page.screenshot({ path: 'test-results/fx-global.png' });
    });

    test('the rack set from the Mixer is there after a reload', async ({ page }) => {
        await mixerWithVoices(page);
        await page.locator('.voicebank-item').first().locator('.voicebank-fx').click();
        await page.locator('.fx-pop-track .fx-toggle[data-flag="drive"]').check();
        await page.evaluate(() => window.__opProject.flush());

        await openApp(page);
        await openMixerTab(page);
        await expect(page.locator('.voicebank-item').first().locator('.voicebank-fx-letter[data-flag="drive"]')).toHaveClass(/on/);
    });
});
