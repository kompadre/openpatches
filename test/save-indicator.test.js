// The save indicator: the footer's floppy light and the text beside it.
//
// The wording is the part with rules in it — the "just now" window,
// singular vs plural, what to say before anything has been written — so
// describeSave() is pure and gets most of these. The DOM half is checked
// against a stub session for the one thing it has to get right: noticing
// the *edge* where a write finishes, which is the only moment it can learn
// when "last saved" was.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let describeSave, relativeTime, attachSaveIndicator;

before(async () => {
    installBrowserEnv();
    ({ describeSave, relativeTime, attachSaveIndicator } =
        await import('../html/components/save-indicator.js'));
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('relativeTime', () => {
    test('a generous "just now" window, so the text is not jittery', () => {
        assert.equal(relativeTime(0), 'just now');
        assert.equal(relativeTime(44_000), 'just now');
    });

    test('singular has no s', () => {
        assert.equal(relativeTime(MINUTE), '1 minute ago');
        assert.equal(relativeTime(HOUR), '1 hour ago');
        assert.equal(relativeTime(24 * HOUR), '1 day ago');
    });

    test('plural does', () => {
        assert.equal(relativeTime(7 * MINUTE), '7 minutes ago');
        assert.equal(relativeTime(3 * HOUR), '3 hours ago');
        assert.equal(relativeTime(50 * HOUR), '2 days ago');
    });

    test('minutes round, hours and days floor — "1 hour" should not mean 119 minutes', () => {
        assert.equal(relativeTime(90_000), '2 minutes ago', '1.5 min rounds up');
        assert.equal(relativeTime(119 * MINUTE), '1 hour ago');
    });
});

describe('describeSave', () => {
    test('writing: blinking, and says so', () => {
        const v = describeSave({ saving: true, savedAt: null, dirty: true });
        assert.equal(v.state, 'saving');
        assert.equal(v.text, 'Saving…');
    });

    test('saving wins over everything else — it is the live fact', () => {
        const v = describeSave({ saving: true, savedAt: 1000, dirty: false }, 999_999);
        assert.equal(v.state, 'saving');
    });

    test('nothing written yet and nothing to write: dark and silent', () => {
        const v = describeSave({ saving: false, savedAt: null, dirty: false });
        assert.equal(v.state, 'idle');
        assert.equal(v.text, '', 'no text for a project nobody has touched');
    });

    test('nothing written yet but edits pending: worth noticing', () => {
        const v = describeSave({ saving: false, savedAt: null, dirty: true });
        assert.equal(v.state, 'unsaved');
        assert.equal(v.text, 'Not saved yet');
    });

    test('written, and counting up', () => {
        const now = 10 * MINUTE;
        const v = describeSave({ saving: false, savedAt: now - 2 * MINUTE, dirty: false }, now);
        assert.equal(v.state, 'saved');
        assert.equal(v.text, 'Saved 2 minutes ago');
        assert.match(v.title, /Everything is written/);
    });

    test('written, but there are newer changes — the title says so, the text does not lie', () => {
        const now = 10 * MINUTE;
        const v = describeSave({ saving: false, savedAt: now - MINUTE, dirty: true }, now);
        assert.equal(v.state, 'saved', 'it really was saved a minute ago');
        assert.equal(v.text, 'Saved 1 minute ago');
        assert.match(v.title, /newer changes/);
    });
});

describe('attachSaveIndicator', () => {
    let dot, label, listeners, stub, clock;

    beforeEach(() => {
        dot = document.createElement('span');
        label = document.createElement('span');
        listeners = new Set();
        clock = 1_000_000;
        stub = {
            saving: false,
            dirty: false,
            isSaving() { return this.saving; },
            isDirty() { return this.dirty; },
            subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
            emit() { for (const fn of [...listeners]) fn({ kind: 'saving' }); },
        };
    });

    const attach = () => attachSaveIndicator({
        session: stub, root: dot, label, now: () => clock,
    });

    test('renders the current state straight away', () => {
        attach();
        assert.match(dot.className, /save-idle/);
        assert.equal(label.textContent, '');
    });

    test('a write makes it blink, and finishing it starts the clock', () => {
        attach();

        stub.saving = true;
        stub.emit();
        assert.match(dot.className, /save-saving/);
        assert.equal(label.textContent, 'Saving…');

        stub.saving = false;
        stub.emit();
        assert.match(dot.className, /save-saved/);
        assert.equal(label.textContent, 'Saved just now');

        clock += 3 * MINUTE;
        stub.emit();
        assert.equal(label.textContent, 'Saved 3 minutes ago');
    });

    test('edges, not levels: two events during one write are still one write', () => {
        // The store reports *that* it is saving, never when it last did, so
        // the only place "last saved" can be learned is the true -> false
        // edge. Treating every event as an end would reset the clock
        // mid-write and report a save that had not happened.
        attach();
        stub.saving = true;
        stub.emit();
        clock += 5 * MINUTE;
        stub.emit();
        assert.equal(label.textContent, 'Saving…', 'still the same write');

        stub.saving = false;
        stub.emit();
        assert.equal(label.textContent, 'Saved just now');
    });

    test('a pending edit before the first write shows as unsaved', () => {
        attach();
        stub.dirty = true;
        stub.emit();
        assert.match(dot.className, /save-unsaved/);
        assert.equal(label.textContent, 'Not saved yet');
    });

    test('tearing down stops listening', () => {
        const detach = attach();
        detach();
        assert.equal(listeners.size, 0);
    });

    test('no element, no crash — the footer may not be there in a test page', () => {
        const detach = attachSaveIndicator({ session: stub, root: null, label: null });
        assert.equal(typeof detach, 'function');
        detach();
    });
});
