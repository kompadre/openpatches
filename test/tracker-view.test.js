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
    return { tracker, q, qa, calls };
}

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
        const { tracker, q } = build();

        // The popover opens from a canvas hit; drive it through the same
        // internal path a click takes by reaching the hotspot list.
        const canvas = q('.tracker-canvas');
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
        // ✎ sits in the gap right of the track's column, on the clip's first row.
        canvas.dispatch('click', { clientX: 36 + 46 + 4, clientY: 4 });
        const pop = q('.tracker-popover');
        assert.ok(pop, 'the popover is open');
        assert.equal(pop.querySelector('.tracker-popover-title').textContent, pattern.name);

        const buttons = pop.querySelectorAll('button');
        buttons.find(b => b.textContent === '+').dispatch('click');
        assert.equal(session.getSection().clips.find(c => c.id === clip.id).repeats, 2);

        canvas.dispatch('click', { clientX: 36 + 46 + 4, clientY: 4 });
        q('.tracker-popover').querySelectorAll('button')
            .find(b => b.textContent === '+ Bar to pattern').dispatch('click');
        assert.equal(session.getPattern(pattern.id).measures, 2);
        assert.equal(q('.tracker-popover'), null, 'closed after acting');
        void tracker;
    });

    test('clicking a track column selects its voice', () => {
        seedPattern(session, { slot: 0, notes: [] });
        seedPattern(session, { slot: 3, notes: [] });
        const { q, calls } = build();
        const canvas = q('.tracker-canvas');
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
        // Second column starts after ruler + first track + gap.
        canvas.dispatch('click', { clientX: 36 + 46 + 18 + 4, clientY: 200 });
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
