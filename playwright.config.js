// Playwright config for the e2e suite (e2e/*.spec.js).
// The unit suite (`node --test test/`) stays dependency-free and is untouched
// by this — e2e is a separate layer that needs a real browser.
//
// The dev server is the project's own server.py: the COOP/COEP headers it
// sends are what make SharedArrayBuffer (and so the WASM synth) available,
// so the e2e runs exercise the same cross-origin-isolated context as a user.
import { defineConfig, devices } from '@playwright/test';

// The port is scoped to the worktree *and* the tmux pane, so the user (and
// any other agent, in any sibling checkout) can run this repo's server.py at
// the same time without the two fighting over one port — or, worse, one
// silently serving a *different* worktree to the other's tests. Both have
// happened. A hash of the worktree path picks the middle digits (two
// checkouts get different ports even in one pane); `TMUX_PANE` (`%N`) keeps
// its last digit as the port's last digit, per the pane convention. Range
// 8100–8899 — never 8000, which is the hand-run dev server's.
// See SESSION.md, "Pane-scoped ports".
function derivePort() {
    const path = process.cwd();
    let h = 5381;
    for (let i = 0; i < path.length; i++) h = (((h << 5) + h) + path.charCodeAt(i)) >>> 0;
    const n = parseInt(String(process.env.TMUX_PANE || '').replace(/\D/g, ''), 10);
    const lastDigit = Number.isFinite(n) ? n % 10 : h % 10;
    return 8100 + (h % 80) * 10 + lastDigit;
}

const PORT = derivePort();

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
