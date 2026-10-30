// The real audio graph. None of this exists under test/harness.js: there is
// no AudioContext, no AudioWorklet and no WebAssembly in the stub, so the
// whole init path — addModule, the wasm fetch, the worklet node — is only ever
// exercised here or by hand.
//
// audio-manager.js is a singleton module. Importing it from page.evaluate()
// gets the *same* instance the app holds, because the module registry is keyed
// by resolved URL and this is the URL app.js imports.
const AUDIO_MANAGER = '/html/synth/audio-manager.js';

import { test, expect, openApp } from './fixtures.js';

/** Press a keyboard key — the app's cheapest route into acquire(). */
async function playAKey(page) {
    await page.locator('.keyboard .key.white').nth(7).click();
}

test.describe('audio engine', () => {
    test('msfa.wasm is served and is valid WebAssembly', async ({ page }) => {
        await openApp(page);

        // A broken or missing build is otherwise invisible: initAudio() has a
        // 2 s fallback timeout and resolves even if the worklet never reports
        // ready, so "audio is ready" alone does not prove the synth loaded.
        const wasm = await page.evaluate(async () => {
            const resp = await fetch('/html/synth/wasm/msfa.wasm');
            if (!resp.ok) return { ok: false, status: resp.status };
            const bytes = await resp.arrayBuffer();
            return { ok: true, bytes: bytes.byteLength, valid: WebAssembly.validate(bytes) };
        });
        expect(wasm.ok, `msfa.wasm fetch failed (${wasm.status})`).toBe(true);
        expect(wasm.valid, 'msfa.wasm is not valid WebAssembly').toBe(true);
        expect(wasm.bytes).toBeGreaterThan(1000);
    });

    test('a key press brings the engine up and leaves it running', async ({ page }) => {
        await openApp(page);

        // Before any gesture the manager reports closed.
        const before = await page.evaluate(
            (url) => import(url).then((m) => m.getState()), AUDIO_MANAGER);
        expect(before).toBe('closed');

        await playAKey(page);

        // app.js mirrors the manager's state onto #audio-status as a class.
        await expect(page.locator('#audio-status')).toHaveClass(/audio-ready/, { timeout: 10_000 });

        const after = await page.evaluate(
            (url) => import(url).then((m) => ({ state: m.getState(), ready: m.isReady() })),
            AUDIO_MANAGER);
        expect(after).toEqual({ state: 'ready', ready: true });
    });

    test('initAudio runs exactly once across many gestures', async ({ page }) => {
        await openApp(page);

        // AGENTS.md: "AudioManager is a singleton — initAudio() runs once.
        // Never re-call addModule()." A second addModule() for the same name
        // throws, so count the calls and assert one.
        await page.evaluate(() => {
            window.__addModuleCalls = 0;
            const proto = Object.getPrototypeOf(AudioWorklet.prototype) === null
                ? AudioWorklet.prototype : AudioWorklet.prototype;
            const orig = proto.addModule;
            proto.addModule = function (...args) {
                window.__addModuleCalls++;
                return orig.apply(this, args);
            };
        });

        for (let i = 0; i < 4; i++) {
            await page.locator('.keyboard .key.white').nth(i).click();
            await page.waitForTimeout(150);
        }
        await expect(page.locator('#audio-status')).toHaveClass(/audio-ready/, { timeout: 10_000 });

        expect(await page.evaluate(() => window.__addModuleCalls)).toBe(1);

        // And one context, still running.
        const ctx = await page.evaluate(
            (url) => import(url).then((m) => m.getState()), AUDIO_MANAGER);
        expect(ctx).toBe('ready');
    });

    test('a note reaches the worklet and is released', async ({ page }) => {
        await openApp(page);
        await playAKey(page);
        await expect(page.locator('#audio-status')).toHaveClass(/audio-ready/, { timeout: 10_000 });

        // Drive the manager directly: play on a channel, then all-notes-off.
        // The point is that these calls survive a real worklet round trip
        // without throwing — the stub cannot tell us that.
        const result = await page.evaluate(async (url) => {
            const m = await import(url);
            m.playNoteOnChannel(0, 60, 100);
            m.playNoteOnChannel(0, 64, 100);
            await new Promise((r) => setTimeout(r, 200));
            m.allNotesOff();
            m.releaseAllNotes();
            return 'ok';
        }, AUDIO_MANAGER);
        expect(result).toBe('ok');
    });
});
