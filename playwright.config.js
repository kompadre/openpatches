// Playwright config for the e2e suite (e2e/*.spec.js).
// The unit suite (`node --test test/`) stays dependency-free and is untouched
// by this — e2e is a separate layer that needs a real browser.
//
// The dev server is the project's own server.py: the COOP/COEP headers it
// sends are what make SharedArrayBuffer (and so the WASM synth) available,
// so the e2e runs exercise the same cross-origin-isolated context as a user.
import { defineConfig, devices } from '@playwright/test';

const PORT = 8123;   // not 8000 — leaves the hand-run dev server alone

export default defineConfig({
    testDir: './e2e',
    fullyParallel: false,       // one audio context per browser; keep it serial
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: process.env.CI ? 'line' : 'list',

    use: {
        baseURL: `http://localhost:${PORT}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },

    projects: [{
        name: 'chromium',
        use: {
            ...devices['Desktop Chrome'],
            viewport: { width: 1400, height: 900 },
            launchOptions: {
                args: [
                    // Let AudioContext start without a trusted gesture, and
                    // render to a fake device so headless has an output.
                    '--autoplay-policy=no-user-gesture-required',
                    '--use-fake-device-for-media-stream',
                    '--use-fake-ui-for-media-stream',
                ],
            },
        },
    }],

    webServer: {
        command: `python3 server.py ${PORT}`,
        url: `http://localhost:${PORT}/index.html`,
        // Never reuse: a server already on this port may be serving a
        // *different* git worktree of this repo (sibling checkouts run the
        // same server.py), and reusing it silently tests the wrong files —
        // which has happened. Failing to bind is the better outcome.
        reuseExistingServer: false,
        stdout: 'ignore',
        stderr: 'pipe',
    },
});
