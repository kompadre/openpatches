// Playwright config for the e2e suite (e2e/*.spec.js).
// The unit suite (`node --test test/`) stays dependency-free and is untouched
// by this — e2e is a separate layer that needs a real browser.
//
// The dev server is the project's own server.py: the COOP/COEP headers it
// sends are what make SharedArrayBuffer (and so the WASM synth) available,
// so the e2e runs exercise the same cross-origin-isolated context as a user.
import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// The port is scoped to the worktree *and* the tmux pane, so the user (and
// any other agent, in any sibling checkout) can run this repo's server.py at
// the same time without the two fighting over one port — or, worse, one
// silently serving a *different* worktree to the other's tests. Both have
// happened.
//
// **It is keyed on the worktree's git dir, not its path.** A worktree can
// appear at a different path from one session to the next, and hashing the
// path meant the port moved with it: a server left running from a previous
// session sat on a port nothing would look for again, and the "if your port
// is busy it is your own orphan" rule was unenforceable because the orphan
// was never on your port. `git rev-parse --git-dir` gives
// `…/.git/worktrees/<name>`, which is keyed on the worktree's *name* and so
// survives the checkout moving; the main checkout gets its own `.git`.
// Falling back to the path keeps this working outside a repo.
//
// `TMUX_PANE` (`%N`) keeps its last digit as the port's last digit, per the
// pane convention.
//
// Range **10000–29990**, five digits. Deliberately below 32768, where
// Linux's ephemeral range starts (`/proc/sys/net/ipv4/ip_local_port_range`
// is 32768–60999 here): a listener inside that range can collide with the
// source port of an unrelated outgoing connection. 8000 is the hand-run dev
// server's and is nowhere near this range.
//
// See SESSION.md, "Pane-scoped ports".
function worktreeKey() {
    try {
        const dir = execFileSync('git', ['rev-parse', '--git-dir'], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (dir) return resolve(process.cwd(), dir);
    } catch { /* not a repo, or no git: fall through */ }
    return process.cwd();
}

function derivePort() {
    const key = worktreeKey();
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = (((h << 5) + h) + key.charCodeAt(i)) >>> 0;
    const n = parseInt(String(process.env.TMUX_PANE || '').replace(/\D/g, ''), 10);
    const lastDigit = Number.isFinite(n) ? n % 10 : h % 10;
    return 10000 + (h % 2000) * 10 + lastDigit;
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
        // Never reuse. The port is this worktree's, but a server sitting on
        // it may still be a stale one of your own from a session when this
        // worktree lived at a different path — and reusing that silently
        // tests the *old* files, which has happened and cost real time.
        // Failing to bind is the better outcome: `npm run e2e:port` prints
        // the port, and `pgrep -af "server.py <port>"` finds the orphan.
        reuseExistingServer: false,
        stdout: 'ignore',
        stderr: 'pipe',
    },
});
