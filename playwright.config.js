// Playwright config for the e2e suite (e2e/*.spec.js).
// The unit suite (`node --test test/`) stays dependency-free and is untouched
// by this — e2e is a separate layer that needs a real browser.
//
// The dev server is the project's own server.py: the COOP/COEP headers it
// sends are what make SharedArrayBuffer (and so the WASM synth) available,
// so the e2e runs exercise the same cross-origin-isolated context as a user.
import { defineConfig, devices } from '@playwright/test';

// The port is scoped to the tmux pane, so the user (and any other agent)
// can run this repo's server.py at the same time without the two fighting
// over one port — or, worse, one silently serving a *different* worktree to
// the other's tests. `TMUX_PANE` is `%N`; the port is `8100 + (N % 100)`,
// which keeps the pane's last digit as the port's last digit. Outside tmux,
// fall back to a fixed port in the same family. Never 8000 — that leaves
// the hand-run dev server alone. See SESSION.md, "Pane-scoped ports".
function panePort() {
    const n = parseInt(String(process.env.TMUX_PANE || '').replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? 8100 + (n % 100) : 8100;
}

const PORT = panePort();

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
