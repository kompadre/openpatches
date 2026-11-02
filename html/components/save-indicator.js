// The save indicator: the footer's third light.
//
// Audio is a circle and MIDI a rhombus, so this is a **square** — the
// floppy disk, and with it the metaphor that does the rest of the work: a
// drive light that **blinks while it is writing** and sits dark the rest of
// the time. No modal, no interruption; the light is where you already look
// for whether the app is alive.
//
// (A modal was the first idea and was measured out of it: a save is ~2–4 ms
// of main-thread work plus an off-thread commit, so a dialog bracketing the
// real duration would flash for single-digit milliseconds — invisible, or a
// strobe. Making it perceptible would mean blocking the user for half a
// second every thirty, to say nothing they can act on.)
//
// Beside the square is the thing a light cannot say: *when*. "Saving…"
// while it writes, "Saved 2 minutes ago" after, counting up on its own.
//
// The formatting half is pure and exported on its own, so the wording is
// testable without a DOM.

/** How often the "… ago" text re-reads the clock while nothing else happens. */
export const REFRESH_MS = 20_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * What the indicator should be showing, from the three facts it has.
 *
 * Kept separate from the DOM because the wording is the part with rules in
 * it — singular vs plural, the "just now" window, what to say before the
 * first save — and those deserve tests that do not need a document.
 *
 * @param {{saving: boolean, savedAt: number|null, dirty: boolean}} state
 * @param {number} now
 * @returns {{state: 'saving'|'saved'|'unsaved'|'idle', text: string, title: string}}
 */
export function describeSave({ saving, savedAt, dirty, failed }, now = Date.now()) {
    if (saving) {
        return { state: 'saving', text: 'Saving…', title: 'Writing your project to this browser' };
    }
    // A failed write outranks everything a successful one could say: the
    // stored project is behind what is on screen, and leaving now costs
    // the difference.
    if (failed) {
        return {
            state: 'failed',
            text: 'Not saved',
            title: 'Your changes could not be saved. Click to try again, and do not close this tab until it succeeds.',
        };
    }
    if (savedAt == null) {
        // Nothing has been written yet this session. Say which it is: with
        // edits pending that is worth noticing, without them it is just a
        // project nobody has touched.
        return dirty
            ? { state: 'unsaved', text: 'Not saved yet', title: 'There are changes that have not been written yet' }
            : { state: 'idle', text: '', title: 'No changes to save' };
    }
    const ago = relativeTime(now - savedAt);
    return {
        state: 'saved',
        text: `Saved ${ago}`,
        title: dirty
            ? `Last saved ${ago}. There are newer changes still to write. Click to save now.`
            : `Last saved ${ago}. Everything is written. Click to save now.`,
    };
}

/**
 * "just now", "1 minute ago", "7 minutes ago", "1 hour ago", "3 days ago".
 *
 * Hand-rolled rather than `Intl.RelativeTimeFormat` because this is the one
 * string in the app that changes while you watch it, and the exact wording
 * — especially the generous "just now" window — is a deliberate choice
 * rather than a locale's.
 */
export function relativeTime(ms) {
    if (ms < 45_000) return 'just now';
    if (ms < HOUR) return plural(Math.round(ms / MINUTE), 'minute');
    if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour');
    return plural(Math.floor(ms / DAY), 'day');
}

function plural(n, unit) {
    return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/**
 * The "your work is at risk" warning.
 *
 * Deliberately **not** raised from the unload handler, where the quota
 * failure actually happens: by then the page is going and nothing can be
 * shown. There are exactly two moments it can be told, and both are while
 * the page is alive:
 *
 *   - a write **fails** (IndexedDB quota, a closed database) — said at
 *     once, because staying on the page and retrying is a real option;
 *   - the **next boot** after a last gasp that could not even journal —
 *     said once, because the work is already gone and pretending
 *     otherwise is worse.
 *
 * It sits above the footer rather than over the page. The action is "wait,
 * or press Save" — trapping the user behind an overlay would stop them
 * freeing the space that might let the save through.
 */
export function attachSaveWarning({ session, root, lost } = {}) {
    const el = root || document.getElementById('save-warning');
    if (!el) return () => {};

    const text = el.querySelector('.save-warning-text');
    const button = el.querySelector('.save-warning-save');

    function show(message, { retry }) {
        if (text) text.textContent = message;
        if (button) button.style.display = retry ? '' : 'none';
        el.style.display = '';
    }
    function hide() { el.style.display = 'none'; }

    hide();
    // A marker from the last page load: the work is gone, so there is
    // nothing to retry — only something to own up to.
    if (lost) {
        show(`Changes to “${lost.name || 'your project'}” from your last session could not be saved `
            + 'and have been lost. Browser storage was full.', { retry: false });
    }

    const unsubscribe = session.subscribe(() => {
        if (session.hasFailed && session.hasFailed()) {
            show('Your changes could not be saved — browser storage may be full. '
                + 'Do not close this tab until the save goes through.', { retry: true });
        } else if (!lost || session.isSaving() || !session.isDirty()) {
            hide();
        }
    });

    const onSave = () => { if (session.flush) session.flush(); };
    if (button && button.addEventListener) button.addEventListener('click', onSave);

    return () => {
        unsubscribe();
        if (button && button.removeEventListener) button.removeEventListener('click', onSave);
    };
}

/**
 * Drive the footer element from a project session.
 *
 * `session` need only provide `subscribe`, `isSaving` and `isDirty`, which
 * is what makes this testable against a stub. Returns a teardown.
 *
 * @param {object} opts
 * @param {object} opts.session
 * @param {HTMLElement} [opts.root]   defaults to #save-status
 * @param {HTMLElement} [opts.label]  defaults to #save-status-text
 */
export function attachSaveIndicator({ session, root, label, now = () => Date.now() } = {}) {
    const dot = root || document.getElementById('save-status');
    const text = label || document.getElementById('save-status-text');
    if (!dot || !session) return () => {};

    let savedAt = null;
    let wasSaving = false;

    function render() {
        const view = describeSave(
            {
                saving: session.isSaving(),
                savedAt,
                dirty: session.isDirty(),
                failed: session.hasFailed ? session.hasFailed() : false,
            },
            now(),
        );
        dot.className = 'save-status save-' + view.state;
        dot.title = view.title;
        if (text) text.textContent = view.text;
    }

    const unsubscribe = session.subscribe(() => {
        // The moment a write finishes is the only place `savedAt` can be
        // learned — the store reports that it is saving, not when it last
        // did. Edges, not levels: a 'saving' event that is still true is
        // the start of the same write, not a new one.
        const saving = session.isSaving();
        if (wasSaving && !saving) savedAt = now();
        wasSaving = saving;
        render();
    });

    // The light is also a button. A save that failed, or an edit the user
    // wants on disk before they walk away, needs somewhere to press — and
    // the thing already reporting the state is the obvious place.
    const onClick = () => { if (session.flush) session.flush(); };
    if (dot.addEventListener) dot.addEventListener('click', onClick);

    // Nothing else ticks while the user reads, so "2 minutes ago" would sit
    // at "just now" forever without this.
    const timer = setInterval(render, REFRESH_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();

    render();

    return () => {
        unsubscribe();
        clearInterval(timer);
        if (dot.removeEventListener) dot.removeEventListener('click', onClick);
    };
}
