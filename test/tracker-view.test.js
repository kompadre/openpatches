// The Tracker tab's view: heads with the compact/expanded toggle, the ✎
// popover (repeats, + Bar), active-track selection, and the viewport it
// reports to the Section pane. Drawing itself is a canvas stub here; what
// the cells say is the model's job and tested in tracker-model.test.js.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createTracker, makeProjectSession, seedPattern;

before(async () => {
    installBrowserEnv();
    ({ createTracker } = await import('../html/components/tracker.js'));
    ({ makeProjectSession, seedPattern } = await import('./project-fixture.js'));
});

let session;

// Moves start after a held press (HOLD_MS): the clock is mocked, and
// `hold()` waits it out. A drag straight away selects. Commits are tested through flush(), never a timer.
// Each test's own mock (t.mock), which node scopes and restores per test.
const HOLD = 1000;
let clock = null;
const hold = () => clock.tick(HOLD);

beforeEach((t) => {
    clock = t.mock.timers;
    clock.enable({ apis: ['setTimeout'] });
    localStorage.clear();
    document.body.children.length = 0;
    session = makeProjectSession();
});

function build(opts = {}) {
    const calls = { selected: [], viewports: [] };
    const tracker = createTracker({
        session,
        transport: null,
        log: () => {},
        getSlotData: () => null,
        onSelectTrack: (slot) => calls.selected.push(slot),
        onViewport: (r) => calls.viewports.push(r),
        ...opts,
    });
    document.body.appendChild(tracker.element);
    tracker.setShown(true);
    const q = (s) => tracker.element.querySelector(s);
    const qa = (s) => tracker.element.querySelectorAll(s);
    const canvas = q('.tracker-canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
    // Geometry from the heads, so the tests do not hard-code lane widths
    // (the active track carries a spare sub-lane).
    const head = (i) => {
        const h = qa('.tracker-head')[i];
        return { x: parseFloat(h.style.left), w: parseFloat(h.style.width) };
    };
    const press = (x, y) => canvas.dispatch('mousedown', { clientX: x, clientY: y });
    const key = (code, extra = {}) => canvas.dispatch('keydown', {
        code, key: extra.key || '', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
        preventDefault() {}, stopPropagation() {}, ...extra,
    });
    return { tracker, q, qa, calls, canvas, head, press, key };
}

const ROW = 16;
const docFire = (type, ev) => {
    for (const fn of [...(document._listeners[type] || [])]) fn({ type, ...ev });
};

describe('tracker view', () => {
    test('one head per track, named and numbered, with a mode toggle', () => {
        seedPattern(session, { slot: 2, notes: [{ midi: 60, start: 0, dur: 4 }] });
        const { qa } = build();
        const heads = qa('.tracker-head');
        assert.equal(heads.length, 1);
        assert.match(heads[0].querySelector('.tracker-head-name').textContent, /^3 /);
        assert.equal(heads[0].querySelector('.tracker-mode').textContent, '▥', 'expanded by default');
    });

    test('the mode toggle writes track.compact through the session, packed', () => {
        const { track } = seedPattern(session, { notes: [{ midi: 60, start: 0, dur: 4 }] });
        const { q } = build();
        q('.tracker-mode').dispatch('click');
        const stored = session.get().tracks.find(t => t.id === track.id);
        assert.equal(stored.compact, true);
        assert.equal(q('.tracker-mode').textContent, '▣', 'the head follows the session event');
        q('.tracker-mode').dispatch('click');
        assert.equal('compact' in session.get().tracks.find(t => t.id === track.id), false,
            'expanded is the default and is not stored');
    });

    test('clicking a head selects that voice', () => {
        seedPattern(session, { slot: 1, notes: [] });
        const { q, calls } = build();
        q('.tracker-head-name').dispatch('click');
        assert.deepEqual(calls.selected, [1]);
        assert.equal(q('.tracker-head').className.includes('active'), true);
    });

    test('setActiveSlot marks the column without echoing a selection', () => {
        seedPattern(session, { slot: 1, notes: [] });
        const { tracker, q, calls } = build();
        tracker.setActiveSlot(1);
        assert.equal(q('.tracker-head').className.includes('active'), true);
        assert.deepEqual(calls.selected, [], 'no feedback loop through the bank');
    });

    test('the ✎ popover: repeats write the clip, + Bar lengthens the pattern', () => {
        const { pattern, clip } = seedPattern(session, { notes: [{ midi: 60, start: 0, dur: 4 }] });
        const { tracker, q, head, press } = build();

        // ✎ sits in the gap right of the track's column, on the clip's first row.
        const pencil = () => press(head(0).x + head(0).w + 4, 4);
        pencil();
        const pop = q('.tracker-popover');
        assert.ok(pop, 'the popover is open');
        assert.equal(pop.querySelector('.tracker-popover-title').textContent, pattern.name);

        const buttons = pop.querySelectorAll('button');
        buttons.find(b => b.textContent === '+').dispatch('click');
        assert.equal(session.getSection().clips.find(c => c.id === clip.id).repeats, 2);

        pencil();
        q('.tracker-popover').querySelectorAll('button')
            .find(b => b.textContent === '+ Bar to pattern').dispatch('click');
        assert.equal(session.getPattern(pattern.id).measures, 2);
        assert.equal(q('.tracker-popover'), null, 'closed after acting');
        void tracker;
    });

    test('the ✎ popover: Edit opens the clip in the Pattern editor, committing first', () => {
        const { pattern, clip, track } = seedPattern(session, { notes: [{ midi: 60, start: 0, dur: 4 }] });
        const opened = [];
        let touched = 0;
        const { tracker, q, head, press, key } = build({
            onOpenPattern: (...args) => opened.push({ args, pending: touched }),
        });
        session.subscribe((ev) => { if (ev.source === 'tracker') touched++; });

        // A pending (uncommitted) edit, then ✎ → Edit.
        press(head(0).x + 4, ROW * 2 + 4);
        key('KeyZ');
        press(head(0).x + head(0).w + 4, 4);
        q('.tracker-popover').querySelectorAll('button')
            .find(b => b.textContent === 'Edit').dispatch('click');

        assert.equal(opened.length, 1);
        assert.deepEqual(opened[0].args, [clip.id, track.id, pattern.id]);
        assert.ok(opened[0].pending > 0, 'the pending edit was committed before opening');
        assert.equal(q('.tracker-popover'), null, 'closed after acting');
        void tracker;
    });

    test('the ✎ popover has no Edit without an onOpenPattern', () => {
        seedPattern(session, { notes: [{ midi: 60, start: 0, dur: 4 }] });
        const { q, head, press } = build();
        press(head(0).x + head(0).w + 4, 4);
        assert.equal(q('.tracker-popover').querySelectorAll('button').find(b => b.textContent === 'Edit'), undefined);
    });

    // Double-click empty space in a track: a new one-bar pattern, there.
    const dbl = (canvas, x, y) => canvas.dispatch('dblclick', { clientX: x, clientY: y });
    const patternCount = () => session.listPatterns().length;

    test('double-clicking empty track space makes a one-bar pattern at that row', () => {
        const { track } = seedPattern(session, { notes: [{ midi: 60, start: 0, dur: 4 }] });
        const { tracker, q, head, canvas } = build();
        const before = patternCount();
        dbl(canvas, head(0).x + 4, ROW * 20 + 4);                    // row 20: below the one-bar clip
        assert.equal(patternCount(), before + 1);
        const clip = session.getSection().clips.find(c => c.startCol === 20);
        assert.ok(clip, 'placed at the clicked row');
        assert.equal(clip.trackId, track.id);
        const made = session.getPattern(clip.patternId);
        assert.equal(made.measures, 1);
        assert.match(made.name, /^Pattern \d+$/);
        assert.equal(tracker.getCursor().col, 20, 'the cursor waits there to type into it');
        assert.match(q('.tracker-status').textContent, /type notes/);
    });

    test('double-clicking inside a clip makes nothing', () => {
        seedPattern(session, { notes: [] });
        const { head, canvas } = build();
        const before = patternCount();
        dbl(canvas, head(0).x + 4, ROW * 5 + 4);
        assert.equal(patternCount(), before);
        assert.equal(session.getSection().clips.length, 1);
    });

    test('no bar of room before the next clip: refused, and no orphan pattern left behind', () => {
        const { track, pattern } = seedPattern(session, { notes: [] });
        session.update((project, section) => {
            section.clips.push({ id: 'c2', trackId: track.id, patternId: pattern.id, startCol: 24, repeats: 1 });
        }, 'test');
        const { q, head, canvas } = build();
        const before = patternCount();
        dbl(canvas, head(0).x + 4, ROW * 16 + 4);                    // rows 16–23 free: half a bar
        assert.equal(patternCount(), before, 'nothing created');
        assert.equal(session.getSection().clips.length, 2);
        assert.match(q('.tracker-status').textContent, /No room/);
    });

    // A pattern dragged from the Section library, released over the grid.
    const withView = (q) => {
        q('.tracker-scroll').getBoundingClientRect = () => ({ left: 0, top: 0, right: 2000, bottom: 2000 });
    };

    test('a library drop places the pattern on the track and row under the pointer', () => {
        const { track } = seedPattern(session, { notes: [] });
        const other = session.createPattern({ name: 'Lib', measures: 1 }, 'test');
        const { tracker, q, head } = build();
        withView(q);
        // Dropped in the gap right of the lanes, on row 32: still this track.
        const ok = tracker.dropPattern(head(0).x + head(0).w + 4, ROW * 32 + 4, other.id);
        assert.equal(ok, true);
        const clip = session.getSection().clips.find(c => c.patternId === other.id);
        assert.ok(clip);
        assert.equal(clip.trackId, track.id);
        assert.equal(clip.startCol, 32);
        assert.equal(tracker.getCursor().col, 32);
    });

    test('a library drop onto a clip is refused with a message, but still claimed', () => {
        seedPattern(session, { notes: [] });
        const other = session.createPattern({ name: 'Lib', measures: 1 }, 'test');
        const { tracker, q, head } = build();
        withView(q);
        assert.equal(tracker.dropPattern(head(0).x + 4, 30 + ROW * 3, other.id), true);
        assert.equal(session.getSection().clips.length, 1, 'nothing placed');
        assert.match(q('.tracker-status').textContent, /clip here already/);
    });

    test('a library drop outside the grid, or while hidden, is left to the caller', () => {
        seedPattern(session, { notes: [] });
        const other = session.createPattern({ name: 'Lib', measures: 1 }, 'test');
        const { tracker, q } = build();
        withView(q);
        assert.equal(tracker.dropPattern(3000, 100, other.id), false, 'right of the view');
        assert.equal(tracker.dropPattern(100, 10, other.id), false, 'over the heads');
        tracker.setShown(false);
        assert.equal(tracker.dropPattern(100, 300, other.id), false, 'tab not on screen');
        assert.equal(session.getSection().clips.length, 1);
    });

    test('clicking a track column selects its voice', () => {
        seedPattern(session, { slot: 0, notes: [] });
        seedPattern(session, { slot: 3, notes: [] });
        const { calls, head, press } = build();
        press(head(1).x + 4, 200);
        assert.deepEqual(calls.selected, [3]);
    });

    test('the viewport is reported shown and cleared hidden', () => {
        seedPattern(session, { notes: [] });
        const { tracker, calls } = build();
        const last = () => calls.viewports.at(-1);
        assert.ok(last(), 'reported on first draw');
        assert.equal(last().startCol, 0);
        assert.ok(last().endCol > 0);
        tracker.setShown(false);
        assert.equal(last(), null, 'the Section pane hides the band');
    });
});

describe('tracker editing', () => {
    const N = (midi, start, dur, lane) => (lane == null ? { midi, start, dur } : { midi, start, dur, lane });
    const notesOf = (session, id) => session.getPattern(id).notes.map(n => [n.midi, n.start, n.dur, n.lane || 0]);

    test('FT2 keys enter notes at the cursor, step down, and audition', () => {
        const heard = [];
        const { pattern } = seedPattern(session, { slot: 0, notes: [] });
        const { head, press, key, tracker } = build({ playNote: (m, s) => heard.push([m, s]) });
        press(head(0).x + 4, 0);                 // row 0, lane 0
        key('KeyZ');                             // C-4
        key('KeyQ');                             // C-5 on the next row
        assert.deepEqual(heard, [[60, 0], [72, 0]]);
        assert.deepEqual(notesOf(session, pattern.id), [[60, 0, 1, 0], [72, 1, 15, 0]]);
        assert.equal(tracker.getCursor().col, 2, 'stepped past both');
    });

    test('1 is OFF, Delete clears, and the cursor steps', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 0, 16)] });
        const { head, press, key } = build();
        press(head(0).x + 4, 4 * ROW);
        key('Digit1');
        assert.deepEqual(notesOf(session, pattern.id), [[60, 0, 4, 0]]);
        press(head(0).x + 4, 4 * ROW);
        key('', { key: 'Delete' });
        assert.deepEqual(notesOf(session, pattern.id), [[60, 0, 16, 0]], 'the OFF is gone, the note holds');
    });

    test('typing outside a clip says so and changes nothing', () => {
        const { pattern } = seedPattern(session, { notes: [] });
        const { head, press, key, q, tracker } = build();
        press(head(0).x + 4, 20 * ROW);          // bar 2: the clip is one bar
        key('KeyZ');
        assert.match(q('.tracker-status').textContent, /No pattern here/);
        assert.deepEqual(notesOf(session, pattern.id), []);
        assert.equal(tracker.getCursor().col, 20, 'no step on a refusal');
    });

    test('the spare sub-lane takes a chord note', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 0, 16)] });
        const { head, press, key } = build();
        assert.equal(head(0).w, 2 * 46, 'one lane in use plus a spare on the active track');
        press(head(0).x + 46 + 4, 0);            // lane 1
        key('KeyC');                             // E-4
        assert.deepEqual(notesOf(session, pattern.id), [[60, 0, 16, 0], [64, 0, 16, 1]]);
    });

    test('edits commit after the quiet time: one session event, lanes packed', async () => {
        const { pattern } = seedPattern(session, { notes: [] });
        const events = [];
        session.subscribe((ev) => { if (ev.source === 'tracker') events.push(ev); });
        const { head, press, key, tracker } = build();
        press(head(0).x + 46 + 4, 0);            // type into lane 1 of an empty pattern
        key('KeyZ');
        assert.equal(events.length, 0, 'nothing announced while typing');
        assert.equal(session.getPattern(pattern.id).notes[0].lane, 1, 'kept where typed for now');
        tracker.flush();                         // what the 3 s timer does
        assert.equal(events.length, 1);
        assert.equal('lane' in session.getPattern(pattern.id).notes[0], false, 'packed down to lane 0');
    });

    test('leaving the tab commits', () => {
        const { pattern } = seedPattern(session, { notes: [] });
        const events = [];
        session.subscribe((ev) => { if (ev.source === 'tracker') events.push(ev); });
        const { head, press, key, tracker } = build();
        press(head(0).x + 4, 0);
        key('KeyZ');
        tracker.setShown(false);
        assert.equal(events.length, 1);
        void pattern;
    });

    test('dragging a note past the pattern end adds a bar and lands it there', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 4, 2)] });
        const { head, press } = build();
        press(head(0).x + 4, 4 * ROW);
        hold();
        docFire('mouseup', { clientX: head(0).x + 4, clientY: 20 * ROW });
        const p = session.getPattern(pattern.id);
        assert.equal(p.measures, 2);
        assert.deepEqual(p.notes.map(n => [n.midi, n.start, n.dur]), [[60, 20, 2]]);
    });

    test('a growth that would run into the next clip is refused', () => {
        const { pattern, track } = seedPattern(session, { notes: [N(60, 4, 2)] });
        const other = session.createPattern({ name: 'Next' }, 'test');
        session.update((project, section) => {
            section.clips.push({ id: 'c2', trackId: track.id, patternId: other.id, startCol: 16, repeats: 1 });
        }, 'test');
        const { head, press, q } = build();
        press(head(0).x + 4, 4 * ROW);
        hold();
        docFire('mouseup', { clientX: head(0).x + 4, clientY: 20 * ROW });
        assert.equal(session.getPattern(pattern.id).measures, 1);
        assert.match(q('.tracker-status').textContent, /No room/);
    });
});

describe('tracker selection', () => {
    const N = (midi, start, dur, lane) => (lane == null ? { midi, start, dur } : { midi, start, dur, lane });
    const notesOf = (id) => session.getPattern(id).notes.map(n => [n.midi, n.start, n.dur, n.lane || 0])
        .sort((a, b) => a[3] - b[3] || a[1] - b[1]);
    const setStep = (q, v) => { const s = q('.tracker-step'); s.value = String(v); s.dispatch('change'); };
    // A drag from one cell to another: press, then document move and release.
    const dragSel = (h, x0, row0, x1, row1, extra = {}) => {
        h.canvas.dispatch('mousedown', { clientX: x0, clientY: row0 * ROW + 4, ...extra });
        docFire('mousemove', { clientX: x1, clientY: row1 * ROW + 4 });
        docFire('mouseup', { clientX: x1, clientY: row1 * ROW + 4 });
    };

    test('a drag selects a block; a note then fills it every Step rows', () => {
        const { pattern } = seedPattern(session, { notes: [] });
        const h = build();
        setStep(h.q, 4);
        const x = h.head(0).x + 4;
        dragSel(h, x, 0, x, 11);
        assert.deepEqual(h.tracker.getSelection(), { slot: 0, lanes: [0, 0], rows: [0, 11] });
        assert.match(h.q('.tracker-status').textContent, /12 cells selected/);
        h.key('KeyZ');                                   // C-4 at octave 4
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[60, 0, 4, 0], [60, 4, 4, 0], [60, 8, 8, 0]]);
        assert.equal(h.tracker.getCursor().col, 11, 'the cursor does not jump on a fill');
        assert.ok(h.tracker.getSelection(), 'the selection stays, so another note can replace it');
    });

    test('a drag straight away selects, from a note too, and moves nothing', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 2, 2)] });
        const h = build();
        const x = h.head(0).x + 4;
        dragSel(h, x, 2, x, 6);                           // from the note's first row
        assert.deepEqual(h.tracker.getSelection(), { slot: 0, lanes: [0, 0], rows: [2, 6] });
        assert.deepEqual(notesOf(pattern.id), [[60, 2, 2, 0]], 'not moved');
    });

    test('held for a second on a note, a drag moves the note; sooner, it selects', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 2, 2)] });
        const h = build();
        const x = h.head(0).x + 4;
        h.canvas.dispatch('mousedown', { clientX: x, clientY: 2 * ROW + 4 });
        clock.tick(HOLD - 1);
        docFire('mousemove', { clientX: x, clientY: 6 * ROW + 4 });
        docFire('mouseup', { clientX: x, clientY: 6 * ROW + 4 });
        assert.deepEqual(notesOf(pattern.id), [[60, 2, 2, 0]], 'a second not yet up: selected instead');
        assert.ok(h.tracker.getSelection());

        h.canvas.dispatch('mousedown', { clientX: x, clientY: 2 * ROW + 4 });   // inside the block…
        docFire('mouseup', {});                                                  // …a click drops it
        assert.equal(h.tracker.getSelection(), null);
        h.canvas.dispatch('mousedown', { clientX: x, clientY: 2 * ROW + 4 });
        hold();
        assert.match(h.q('.tracker-status').textContent, /Drag C-4 up or down/);
        docFire('mousemove', { clientX: x, clientY: 6 * ROW + 4 });
        docFire('mouseup', { clientX: x, clientY: 6 * ROW + 4 });
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[60, 6, 2, 0]]);
    });

    test('held on an empty cell nothing arms; moving after still selects', () => {
        seedPattern(session, { notes: [] });
        const h = build();
        const x = h.head(0).x + 4;
        h.canvas.dispatch('mousedown', { clientX: x, clientY: 3 * ROW + 4 });
        hold();
        assert.equal(h.q('.tracker-status').textContent, '');
        docFire('mousemove', { clientX: x, clientY: 7 * ROW + 4 });
        docFire('mouseup', { clientX: x, clientY: 7 * ROW + 4 });
        assert.deepEqual(h.tracker.getSelection().rows, [3, 7]);
    });

    test('held inside the selection, a drag moves the whole block, and the selection with it', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 0, 2), N(62, 2, 2), N(67, 12, 4)] });
        const h = build();
        const x = h.head(0).x + 4;
        dragSel(h, x, 0, x, 3);                           // rows 0–3: 60 and 62
        h.canvas.dispatch('mousedown', { clientX: x, clientY: 1 * ROW + 4 });
        assert.ok(h.tracker.getSelection(), 'a press inside keeps it');
        hold();
        assert.match(h.q('.tracker-status').textContent, /Move the selection/);
        docFire('mousemove', { clientX: x, clientY: 5 * ROW + 4 });
        docFire('mouseup', { clientX: x, clientY: 5 * ROW + 4 });
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[60, 4, 2, 0], [62, 6, 2, 0], [67, 12, 4, 0]]);
        assert.deepEqual(h.tracker.getSelection().rows, [4, 7], 'the selection followed');
    });

    test('a block move is held inside its repeat and its track', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 0, 2)] });
        seedPattern(session, { slot: 1, notes: [] });
        const h = build();
        const x = h.head(0).x + 4;
        dragSel(h, x, 0, x, 3);
        h.canvas.dispatch('mousedown', { clientX: x, clientY: 2 * ROW + 4 });
        hold();
        // Far down and into the next track: rows stop at the pattern's
        // end (block 0–3 → 12–15), lanes at the track's last (its spare).
        docFire('mousemove', { clientX: h.head(1).x + 4, clientY: 40 * ROW + 4 });
        docFire('mouseup', { clientX: h.head(1).x + 4, clientY: 40 * ROW + 4 });
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[60, 12, 2, 0]], 'packed back to lane 0 on commit');
        assert.deepEqual(h.tracker.getSelection().rows, [12, 15]);
    });

    test('a selection is held inside its track and its pattern (one repeat)', () => {
        const { track } = seedPattern(session, { notes: [] });
        session.update((project, section) => {
            section.clips.find(c => c.trackId === track.id).repeats = 2;   // rows 0–31, pattern 0–15 twice
        }, 'test');
        seedPattern(session, { slot: 1, notes: [] });
        const h = build();
        const x = h.head(0).x + 4;
        dragSel(h, x, 10, h.head(1).x + 4, 25);           // into the next track, past the repeat seam
        assert.deepEqual(h.tracker.getSelection(), { slot: 0, lanes: [0, 1], rows: [10, 15] },
            'lanes clamped to track 1 (with its spare lane), rows to the first repeat');
    });

    test('a drag from outside any clip selects nothing', () => {
        seedPattern(session, { notes: [] });
        const h = build();
        const x = h.head(0).x + 4;
        dragSel(h, x, 20, x, 10);
        assert.equal(h.tracker.getSelection(), null);
    });

    test('Shift-click and Shift-arrows extend from the cursor; a plain click or Escape drops it', () => {
        seedPattern(session, { notes: [] });
        const h = build();
        const x = h.head(0).x + 4;
        h.press(x, 2 * ROW + 4);
        h.canvas.dispatch('mousedown', { clientX: x, clientY: 5 * ROW + 4, shiftKey: true });
        docFire('mouseup', {});
        assert.deepEqual(h.tracker.getSelection().rows, [2, 5]);
        h.key('ArrowDown', { key: 'ArrowDown', shiftKey: true });
        h.key('ArrowRight', { key: 'ArrowRight', shiftKey: true });
        assert.deepEqual(h.tracker.getSelection(), { slot: 0, lanes: [0, 1], rows: [2, 6] });
        h.key('Escape', { key: 'Escape' });
        assert.equal(h.tracker.getSelection(), null);
        h.key('ArrowDown', { key: 'ArrowDown', shiftKey: true });
        assert.ok(h.tracker.getSelection());
        h.press(x, 9 * ROW + 4);
        assert.equal(h.tracker.getSelection(), null, 'a plain click drops it');
    });

    test('Delete empties the block, OFF silences it', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 0, 2), N(62, 2, 2), N(64, 4, 12)] });
        const h = build();
        const x = h.head(0).x + 4;
        dragSel(h, x, 1, x, 3);
        h.key('Delete', { key: 'Delete' });
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[60, 0, 4, 0], [64, 4, 12, 0]], '62 gone, 60 sustains through');
        dragSel(h, x, 6, x, 9);
        h.key('Digit1');
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[60, 0, 4, 0], [64, 4, 2, 0]]);
    });

    test('across lanes a note fills only the first lane; OFF still takes every lane', () => {
        // A chord: 60 in lane 0, 64 in lane 1, both the whole bar.
        const { pattern } = seedPattern(session, { notes: [N(60, 0, 16), N(64, 0, 16, 1)] });
        const h = build();
        setStep(h.q, 4);
        const x0 = h.head(0).x + 4;
        dragSel(h, x0, 2, x0 + 46, 9);                    // lanes 0–1, rows 2–9
        assert.deepEqual(h.tracker.getSelection().lanes, [0, 1]);
        assert.match(h.q('.tracker-status').textContent, /fills the first lane every 4 rows/);
        h.key('KeyZ');
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[60, 0, 2, 0], [60, 2, 4, 0], [60, 6, 10, 0], [64, 0, 16, 1]],
            'lane 1 keeps its E-4 untouched — no second C there');
        h.key('Digit1');
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[60, 0, 2, 0], [64, 0, 2, 1]], 'both lanes silenced from row 2');
    });

    test('the on-screen keyboard (enterKey) fills the selection, without a second audition', () => {
        const { pattern } = seedPattern(session, { notes: [] });
        const played = [];
        const h = build({ playNote: (midi, slot) => played.push([midi, slot]) });
        setStep(h.q, 2);
        const x = h.head(0).x + 4;
        dragSel(h, x, 0, x, 3);
        assert.equal(h.tracker.enterKey(48), true);
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[48, 0, 2, 0], [48, 2, 14, 0]]);
        assert.deepEqual(played, [], 'the keyboard already sounded it');
    });

    test('enterKey without a selection writes at the cursor and steps on; outside a pattern it declines quietly', () => {
        const { pattern } = seedPattern(session, { notes: [] });
        const h = build();
        const x = h.head(0).x + 4;
        h.press(x, 3 * ROW + 4);
        assert.equal(h.tracker.enterKey(67), true);
        assert.equal(h.tracker.getCursor().col, 4);
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[67, 3, 13, 0]]);
        h.press(x, 30 * ROW + 4);
        assert.equal(h.tracker.enterKey(67), false);
        assert.equal(h.q('.tracker-status').textContent, '', 'no nagging');
        h.tracker.setShown(false);
        h.press(x, 3 * ROW + 4);
        assert.equal(h.tracker.enterKey(67), false, 'not while the tab is hidden');
    });

    // Copy → a stamp that follows the pointer; a click puts it down.
    const btn = (h) => h.q('.tracker-copy');
    const move = (h, x, row) => h.canvas.dispatch('mousemove', { clientX: x, clientY: row * ROW + 4 });

    test('Copy is disabled without a selection; armed, it lights and the status says what to do', () => {
        seedPattern(session, { notes: [N(60, 0, 2)] });
        const h = build();
        assert.equal(btn(h).disabled, true);
        const x = h.head(0).x + 4;
        dragSel(h, x, 0, x, 3);
        assert.equal(btn(h).disabled, false);
        btn(h).dispatch('click');
        assert.ok(btn(h).classList.contains('active'));
        assert.match(h.q('.tracker-status').textContent, /Arrows move the copy/);
        btn(h).dispatch('click');                         // Copy again cancels
        assert.equal(btn(h).classList.contains('active'), false);
    });

    test('a click puts the copy down; it becomes the selection and the stamp is spent', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 0, 2), N(62, 2, 2)] });
        const h = build();
        const x = h.head(0).x + 4;
        dragSel(h, x, 0, x, 3);
        btn(h).dispatch('click');
        move(h, x, 8);
        h.press(x, 8 * ROW + 4);
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[60, 0, 2, 0], [62, 2, 2, 0], [60, 8, 2, 0], [62, 10, 2, 0]]);
        assert.deepEqual(h.tracker.getSelection(), { slot: 0, lanes: [0, 0], rows: [8, 11] });
        assert.equal(btn(h).classList.contains('active'), false, 'spent');
        h.press(x, 14 * ROW + 4);                         // an ordinary click again
        h.tracker.flush();
        assert.equal(session.getPattern(pattern.id).notes.length, 4);
    });

    test('the copy is held inside the repeat it lands in', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 0, 2)] });
        const h = build();
        const x = h.head(0).x + 4;
        dragSel(h, x, 0, x, 3);
        btn(h).dispatch('click');
        h.press(x, 15 * ROW + 4);                         // a 4-row block at row 15 → pulled up to 12
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[60, 0, 2, 0], [60, 12, 2, 0]]);
    });

    test('into another track and pattern', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 0, 2)] });
        const other = seedPattern(session, { slot: 1, notes: [] });
        const h = build();
        dragSel(h, h.head(0).x + 4, 0, h.head(0).x + 4, 1);
        btn(h).dispatch('click');
        h.press(h.head(1).x + 4, 4 * ROW + 4);
        h.tracker.flush();
        assert.deepEqual(notesOf(other.pattern.id), [[60, 4, 2, 0]]);
        assert.deepEqual(notesOf(pattern.id), [[60, 0, 2, 0]]);
        assert.equal(h.tracker.getSelection().slot, 1);
    });

    test('Ctrl+C arms, Escape cancels; a click off any clip places nothing and keeps it armed', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 0, 2)] });
        const h = build();
        const x = h.head(0).x + 4;
        dragSel(h, x, 0, x, 1);
        let stopped = false;
        h.key('KeyC', { key: 'c', ctrlKey: true, stopPropagation() { stopped = true; } });
        assert.ok(btn(h).classList.contains('active'));
        assert.equal(stopped, true, 'the Section and the roll do not copy too');
        h.press(x, 30 * ROW + 4);                         // no clip there
        assert.match(h.q('.tracker-status').textContent, /Not in a pattern/);
        assert.ok(btn(h).classList.contains('active'));
        h.key('Escape', { key: 'Escape' });
        assert.equal(btn(h).classList.contains('active'), false);
        assert.equal(session.getPattern(pattern.id).notes.length, 1);
    });

    test('keyboard only: Ctrl+C starts the shadow over the selection, arrows steer, Enter places', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 0, 2), N(62, 2, 2)] });
        const h = build();
        const x = h.head(0).x + 4;
        // The selection too without the mouse: Shift-arrows from row 0.
        h.press(x, 4);
        for (let i = 0; i < 3; i++) h.key('ArrowDown', { key: 'ArrowDown', shiftKey: true });
        assert.deepEqual(h.tracker.getSelection().rows, [0, 3]);
        h.key('KeyC', { key: 'c', ctrlKey: true });
        for (let i = 0; i < 8; i++) h.key('ArrowDown', { key: 'ArrowDown' });
        h.key('Enter', { key: 'Enter' });
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[60, 0, 2, 0], [62, 2, 2, 0], [60, 8, 2, 0], [62, 10, 2, 0]]);
        assert.deepEqual(h.tracker.getSelection().rows, [8, 11], 'the copy is the selection');
        assert.equal(btn(h).classList.contains('active'), false, 'spent');
    });

    test('Ctrl+V places too, and the arrows did not move the cursor meanwhile', () => {
        const { pattern } = seedPattern(session, { notes: [N(60, 0, 2)] });
        const h = build();
        const x = h.head(0).x + 4;
        dragSel(h, x, 0, x, 1);
        h.key('KeyC', { key: 'c', ctrlKey: true });
        h.key('ArrowDown', { key: 'ArrowDown' });
        h.key('ArrowDown', { key: 'ArrowDown' });
        assert.equal(h.tracker.getCursor().col, 1, 'still the selection corner: the arrows steered the shadow');
        h.key('KeyV', { key: 'v', ctrlKey: true });
        h.tracker.flush();
        assert.deepEqual(notesOf(pattern.id), [[60, 0, 2, 0], [60, 2, 2, 0]]);
    });

    test('pinned at a repeat edge, a row step hops to the next repeat; Page steps a bar', () => {
        const { track, pattern } = seedPattern(session, { notes: [N(60, 8, 2)] });
        session.update((project, section) => {
            section.clips.find(c => c.trackId === track.id).repeats = 2;   // rows 0–31
        }, 'test');
        const h = build();
        const x = h.head(0).x + 4;
        dragSel(h, x, 8, x, 15);                          // the last 8 rows of repeat 1, C-4@8 inside
        h.key('KeyC', { key: 'c', ctrlKey: true });
        h.key('ArrowDown', { key: 'ArrowDown' });         // pinned at 8 → hops to the next repeat
        h.key('Enter', { key: 'Enter' });
        h.tracker.flush();
        // Rows 16–23 are the next repeat's pattern columns 0–7: the copy
        // of C-4@8 lands on pattern column 0 — shown in both repeats.
        assert.deepEqual(notesOf(pattern.id), [[60, 0, 2, 0], [60, 8, 2, 0]]);
        assert.deepEqual(h.tracker.getSelection().rows, [16, 23]);

        // PageUp from there: a bar up, back into repeat 1 at its clamp.
        h.key('KeyC', { key: 'c', ctrlKey: true });
        h.key('PageUp', { key: 'PageUp' });
        h.key('Escape', { key: 'Escape' });
        assert.equal(btn(h).classList.contains('active'), false);
        assert.equal(h.tracker.getSelection(), null, 'Escape drops the movement and the selection');
    });
});
