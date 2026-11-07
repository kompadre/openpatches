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

beforeEach(() => {
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
        docFire('mouseup', { clientX: head(0).x + 4, clientY: 20 * ROW });
        assert.equal(session.getPattern(pattern.id).measures, 1);
        assert.match(q('.tracker-status').textContent, /No room/);
    });
});
