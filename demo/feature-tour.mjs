// The 90-second feature tour, driven in a real Chrome window.
//
// This is a *demo*, not a test: it never asserts, and a scene that cannot
// find its control logs and moves on rather than failing the run. Losing one
// scene is better than losing the take. It deliberately lives outside e2e/
// so `npm run e2e` never picks it up.
//
//   node demo/feature-tour.mjs
//   node demo/feature-tour.mjs --wav ~/sounds/bell.wav   include the WAV import
//   node demo/feature-tour.mjs --only pianoroll,section  rehearse some scenes
//   node demo/feature-tour.mjs --video                   Playwright video too
//   node demo/feature-tour.mjs --countdown 5             pause before it starts
//
// Audio: this runs headed Chrome with real output, so the synth comes out of
// your speakers and can be captured alongside the screen. Playwright's own
// video is silent — `--video` is only a visual reference.
//
// Pacing comes from demo/voice/durations.json (see make-voice.mjs): each
// scene runs for as long as its narration takes to say, plus its hold. The
// run writes demo/cues.json, the start time of every scene, for lining the
// voiceover up in an editor.

import { chromium } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenes, sceneSeconds } from './narration.js';
import { CURSOR_INIT } from './cursor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ---------------------------------------------------------------- arguments

function flag(name, fallback = null) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const next = process.argv[i + 1];
    return !next || next.startsWith('--') ? true : next;
}

const WAV_FILE = flag('wav');
const ONLY = flag('only');
const WANT_VIDEO = flag('video') === true;
const COUNTDOWN = Number(flag('countdown', 3));
const SPEED = Number(flag('speed', 1));   // >1 rehearses faster
// Rehearsal: no window on the user's desktop, so the selectors can be
// checked without hijacking the screen. Never use this for the real take —
// headless has no audio out.
const HEADLESS = flag('headless') === true;
// Save a frame at the end of every scene, to demo/out/shots/. A rehearsal
// that "passes" can still be filming an empty panel; this is how that gets
// caught without watching the whole take.
const SHOTS = flag('shots') === true;

const wanted = ONLY ? new Set(String(ONLY).split(',').map((s) => s.trim())) : null;
const running = scenes.filter((s) => !wanted || wanted.has(s.id));

// ------------------------------------------------------------------- timing

let durations = {};
const durFile = join(HERE, 'voice', 'durations.json');
if (existsSync(durFile)) {
    durations = JSON.parse(readFileSync(durFile, 'utf8'));
} else {
    console.warn('no demo/voice/durations.json — pacing from a word-count estimate.');
    console.warn('run `node demo/make-voice.mjs` for timing that matches the read.\n');
}

const sleep = (s) => new Promise((r) => setTimeout(r, Math.max(0, s * 1000) / SPEED));

// --------------------------------------------------------------------- port
// Same derivation as playwright.config.js: the port belongs to this worktree
// and this tmux pane. Importing the config would also pull in its webServer
// block, which we do not want here, so the server is started by hand below.

async function derivePort() {
    const mod = await import(join(ROOT, 'playwright.config.js'));
    return new URL(mod.default.use.baseURL).port;
}

// ------------------------------------------------------------- the narrator

const cues = [];
let t0 = 0;
let shotPage = null;   // set once the page exists, for --shots

const elapsed = () => (Date.now() - t0) / 1000;

/**
 * Run one scene, then wait out whatever is left of its narration.
 *
 * `body` should finish *inside* the spoken time — the leftover is the pause
 * the viewer watches the result in. A body that overruns only pushes the
 * cues later, which the cue sheet records truthfully.
 */
async function scene(id, body) {
    const def = scenes.find((s) => s.id === id);
    const budget = sceneSeconds(def, durations);
    const start = elapsed();

    console.log(`[${start.toFixed(1).padStart(6)}s] ${id} — ${budget.toFixed(1)}s`);

    try {
        await body();
    } catch (err) {
        console.warn(`         ! ${id} failed: ${err.message.split('\n')[0]}`);
    }

    const used = elapsed() - start;
    if (used > budget) {
        console.warn(`         ! ${id} overran by ${(used - budget).toFixed(1)}s`);
    }
    await sleep(budget - used);

    if (SHOTS && shotPage) {
        await shotPage.screenshot({
            path: join(HERE, 'out', 'shots', `${String(cues.length + 1).padStart(2, '0')}-${id}.png`),
        }).catch(() => {});
    }

    cues.push({
        id,
        title: def.title,
        start: Math.round(start * 100) / 100,
        end: Math.round(elapsed() * 100) / 100,
        text: def.text,
        ...(def.insert ? { insert: def.insert } : {}),
    });
}

// ------------------------------------------------------- watchable actions
// Playwright clicks instantly and teleports the pointer. For video, every
// interaction is slowed down and the pointer is walked to its target so the
// viewer can follow what is being operated.

function makeActions(page) {
    let at = { x: 960, y: 540 };

    /** Walk the pointer to a point over `ms`, in small steps. */
    async function glide(x, y, ms = 420) {
        const steps = Math.max(6, Math.round(ms / 16));
        await page.mouse.move(x, y, { steps });
        at = { x, y };
    }

    async function centreOf(target) {
        const loc = typeof target === 'string' ? page.locator(target) : target;
        await loc.first().waitFor({ state: 'visible', timeout: 8000 });
        const box = await loc.first().boundingBox();
        if (!box) throw new Error(`no box for ${target}`);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2, loc: loc.first() };
    }

    return {
        glide,

        /** Move to a control, flash the ripple, click it, pause to register. */
        async click(target, { after = 0.5 } = {}) {
            const { x, y, loc } = await centreOf(target);
            await glide(x, y);
            await page.evaluate(([cx, cy]) => window.__demoClickRipple?.(cx, cy), [x, y]);
            await sleep(0.14);
            await loc.click({ timeout: 8000 });
            await sleep(after);
        },

        /** Hover something long enough to read it. */
        async point(target, { dwell = 0.6 } = {}) {
            const { x, y } = await centreOf(target);
            await glide(x, y);
            await sleep(dwell);
        },

        /** A drag the viewer can actually follow. */
        async drag(from, to, { ms = 900 } = {}) {
            const a = await centreOf(from);
            await glide(a.x, a.y);
            await page.mouse.down();
            const b = typeof to === 'string' || to.first ? await centreOf(to) : to;
            await glide(b.x, b.y, ms);
            await sleep(0.25);
            await page.mouse.up();
            await sleep(0.4);
        },

        /** Type at a human speed. */
        async type(target, text) {
            const { loc, x, y } = await centreOf(target);
            await glide(x, y);
            await loc.click();
            await loc.fill('');
            await loc.type(text, { delay: 70 });
        },

        /** Open a top menu and click one of its items. */
        async menu(menuName, itemId) {
            await this.click(`.menu-item[data-menu="${menuName}"] .menu-label`, { after: 0.4 });
            await this.click(`#${itemId}`, { after: 0.6 });
        },

        /** Switch dock tabs. The Piano Roll tab is the one without a modifier class. */
        async tab(name) {
            const sel = name === 'pianoroll'
                ? '.dock-tab:not([class*="dock-tab-"])'
                : `.dock-tab-${name}`;
            await this.click(sel, { after: 0.6 });
        },
    };
}

// ----------------------------------------------------------------- the tour

async function main() {
    const port = await derivePort();
    const base = `http://localhost:${port}`;

    console.log(`serving ${ROOT} on ${base}`);
    const server = spawn('python3', ['server.py', String(port)], {
        cwd: ROOT, stdio: 'ignore',
    });
    const stopServer = () => { try { server.kill(); } catch { /* already gone */ } };
    process.on('exit', stopServer);
    process.on('SIGINT', () => { stopServer(); process.exit(130); });

    await waitForServer(base);

    // Real Chrome, not bundled Chromium: it is what the viewer recognises,
    // and it is the one wired to the system's audio output.
    const browser = await chromium.launch({
        channel: HEADLESS ? undefined : 'chrome',
        headless: HEADLESS,
        args: [
            '--autoplay-policy=no-user-gesture-required',
            '--window-size=1920,1080',
            '--window-position=0,0',
            '--hide-crash-restore-bubble',
        ],
    });

    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        ...(WANT_VIDEO
            ? { recordVideo: { dir: join(HERE, 'out'), size: { width: 1920, height: 1080 } } }
            : {}),
    });

    // First-run prompts out of the way, and the pointer in.
    await context.addInitScript(() => {
        localStorage.setItem('openpatches_tutorial', 'completed');
        localStorage.setItem('openpatches_demo_offered', '1');
    });
    await context.addInitScript(CURSOR_INIT);

    const page = await context.newPage();
    page.on('pageerror', (e) => console.warn(`         ! page error: ${e.message}`));
    // A native confirm() blocks the whole tour and is invisible in a
    // capture — accept and keep moving.
    page.on('dialog', (d) => d.accept().catch(() => {}));

    shotPage = page;
    if (SHOTS) mkdirSync(join(HERE, 'out', 'shots'), { recursive: true });

    const ui = makeActions(page);

    await page.goto(`${base}/index.html`);
    await page.locator('.keyboard .key').first().waitFor({ timeout: 20000 });
    await sleep(1);

    if (COUNTDOWN && !HEADLESS) {
        console.log(`\nstart your recording — going in ${COUNTDOWN}s\n`);
        for (let i = COUNTDOWN; i > 0; i--) { console.log(`  ${i}…`); await sleep(1); }
    }

    // The dock opens at half the window, which leaves the piano roll grid a
    // ~180px slit — too cramped to read on video. Pull the splitter up once,
    // before recording starts, so the sequencing scenes have room.
    const handle = await page.locator('#grid-resize-handle').boundingBox();
    if (handle) {
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down();
        await page.mouse.move(handle.x + handle.width / 2, handle.y - 180, { steps: 20 });
        await page.mouse.up();
        await sleep(0.5);
    }

    t0 = Date.now();
    const run = (id, body) => (!wanted || wanted.has(id)) ? scene(id, body) : Promise.resolve();

    // --- 1. the night sky, and a bank landing on it
    await run('intro', async () => {
        await ui.glide(960, 300, 700);
        await sleep(2.5);
        await ui.menu('file', 'menu-load-demo');
        await page.locator('.container-box, .patch-row').first()
            .waitFor({ timeout: 15000 }).catch(() => {});
        await sleep(1);
    });

    // --- 2. a WAV, reverse-engineered
    // Needs the fmguessr server on :8080 — html/app.js points there on
    // localhost. Without --wav the scene is skipped, not faked: a staged
    // inference result would be the one claim in this video that is untrue.
    await run('archeology', async () => {
        if (!WAV_FILE) {
            console.log('         (no --wav: leaving this scene as dead air to cut into)');
            await ui.point('#night-sky', { dwell: 1 });
            return;
        }
        await ui.click('.menu-item[data-menu="file"] .menu-label', { after: 0.4 });
        await ui.point('#menu-import-wav', { dwell: 0.5 });
        await page.locator('#wav-input').setInputFiles(resolve(WAV_FILE));
        await page.keyboard.press('Escape');
        // The progress modal is the story here; let it run.
        await sleep(2);
    });

    // --- 3. containers and sysex export
    await run('curation', async () => {
        const rows = page.locator('.sky-container .patch-row');
        if (await rows.count() > 2) {
            // Drag one patch out of the cartridge onto the open canvas.
            await ui.point(rows.nth(1), { dwell: 0.4 });
            await ui.drag(rows.nth(1).locator('.patch-drag'), { x: 420, y: 300 });
        }
        // 🎵 Assign the cartridge to the voice slots. This is what makes the
        // next four scenes possible: it fills the Mixer *and* sets the
        // active patch, without which clicks on the piano roll draw nothing
        // and the Section stays empty.
        await ui.click('.sky-container-assign', { after: 0.8 });

        // 💾 Export as .SYX — the claim the narration makes.
        await ui.point('.sky-container-export', { dwell: 1 });
    });

    // --- 4. params, morph, mutate
    await run('edit', async () => {
        const editBtn = page.locator('.patch-edit-btn');
        if (await editBtn.count()) await ui.click(editBtn.first(), { after: 0.5 });
        else await ui.tab('edit');

        await ui.click('.edit-mode-btn[data-mode="params"]', { after: 1.2 });
        await ui.click('.edit-mode-btn[data-mode="morph"]', { after: 0.8 });

        const slider = page.locator('#edit-slider');
        if (await slider.isVisible().catch(() => false)) {
            const box = await slider.boundingBox();
            await ui.glide(box.x + box.width * 0.5, box.y + box.height / 2, 300);
            await page.mouse.down();
            await ui.glide(box.x + box.width * 0.82, box.y + box.height / 2, 900);
            await page.mouse.up();
            await sleep(0.5);
        }
        await ui.click('.edit-mode-btn[data-mode="random"]', { after: 0.6 });
        // Actually mutate — the narration promises a new patch, not a tab.
        await ui.click('#edit-go', { after: 0.8 });
    });

    // --- 5. the mixer
    await run('mixer', async () => {
        await ui.tab('mixer');
        await ui.point('.voicebank-list', { dwell: 1.5 });
    });

    // --- 6. a pattern, playing
    await run('pianoroll', async () => {
        await ui.tab('pianoroll');
        // The grid canvas is ~1000px tall but `.pianoroll-scroll` clips it to
        // a short band — only that band is clickable. Targeting the canvas
        // box puts every click below the fold, where it draws nothing.
        const clip = await page.locator('.pianoroll-scroll').boundingBox();
        if (clip) {
            const baseY = clip.y + clip.height * 0.72;
            const step = Math.min(40, clip.width / 24);
            for (let i = 0; i < 5; i++) {
                const x = clip.x + 90 + i * step * 1.6;
                const y = Math.max(clip.y + 16, baseY - i * 20);
                await ui.glide(x, y, 200);
                await page.evaluate(([cx, cy]) => window.__demoClickRipple?.(cx, cy), [x, y]);
                await page.mouse.click(x, y);
                await sleep(0.22);
            }
        }
        await ui.click('.pianoroll-play', { after: 0.3 });
    });

    // --- 7. clips across a section
    await run('section', async () => {
        // Stop the piano roll first. Left running, its playhead re-renders
        // the Section on every tick and Playwright's "element is stable"
        // check never passes — every click in here times out.
        await ui.click('.pianoroll-stop', { after: 0.3 });
        await ui.tab('section');

        // The real placing gesture: select the pattern in the palette, then
        // click a lane to drop a clip there (section-editor.js:313). Click
        // the *name*, not the chip: the chip's centre is the colour-picker
        // input, which stops the click before selection happens.
        await ui.click('.section-pattern-name', { after: 0.4 });
        const lanes = page.locator('.section-lane');
        const n = await lanes.count();
        for (const [row, bar] of [[0, 1], [2, 2], [4, 1]]) {
            if (row >= n) continue;
            const lane = await lanes.nth(row).boundingBox();
            if (!lane) continue;
            const x = lane.x + 30 + bar * 46;
            const y = lane.y + lane.height / 2;
            await ui.glide(x, y, 260);
            await page.evaluate(([cx, cy]) => window.__demoClickRipple?.(cx, cy), [x, y]);
            await page.mouse.click(x, y);
            await sleep(0.3);
        }

        await ui.click('.section-play', { after: 0.3 });
    });

    // --- 8. the project
    await run('project', async () => {
        await ui.click('.section-stop', { after: 0.3 }).catch(() => {});
        await ui.click('.menu-item[data-menu="file"] .menu-label', { after: 0.5 });
        await ui.point('#menu-export-project', { dwell: 1.4 });
        await page.keyboard.press('Escape');
    });

    // --- 9. hardware. The user's Volca FM footage goes over this hold.
    await run('midi', async () => {
        // 🎹 on a cartridge sends the whole bank to the device — the most
        // direct picture of "it talks to the real thing".
        await ui.point('.sky-container-send', { dwell: 1 });
        await ui.menu('midi', 'menu-midi-devices');
        // Enable, so the device list and the slot-to-channel map fill in.
        // With no MIDI hardware present the dialog just stays as it is.
        const enable = page.locator('.midi-enable-btn');
        if (await enable.count()) await ui.click(enable.first(), { after: 1 });
        await ui.point('.modal-overlay:visible .modal-dialog', { dwell: 1.5 });
        if (SHOTS) await page.screenshot({ path: join(HERE, 'out', 'shots', '09a-midi-modal.png') });
        const close = page.locator('.modal-overlay:visible .modal-close');
        if (await close.count()) await ui.click(close.last(), { after: 0.3 });
    });

    // --- 10. back out to the sky
    // The Canvas dock tab is display:none on desktop — the night sky is
    // always on screen here — so this just settles the pointer over it.
    await run('outro', async () => {
        await ui.glide(960, 420, 1200);
        await sleep(1);
    });

    // ------------------------------------------------------------ cue sheet
    mkdirSync(join(HERE, 'out'), { recursive: true });
    const sheet = {
        recordedAt: new Date().toISOString(),
        totalSeconds: Math.round(elapsed() * 100) / 100,
        pacedFrom: existsSync(durFile) ? 'demo/voice/durations.json' : 'word-count estimate',
        cues,
    };
    const sheetPath = join(HERE, 'out', 'cues.json');
    writeFileSync(sheetPath, JSON.stringify(sheet, null, 2) + '\n');

    console.log(`\ntotal ${sheet.totalSeconds.toFixed(1)}s`);
    console.log(`cue sheet → ${sheetPath}`);

    await sleep(1);
    await context.close();
    await browser.close();
    stopServer();

    if (WANT_VIDEO) console.log(`video → ${join(HERE, 'out')}`);
}

async function waitForServer(base, tries = 40) {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(`${base}/index.html`);
            if (r.ok) return;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server never came up on ${base}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
