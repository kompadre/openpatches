// The Section editor: measures (down) × tracks (across), clips placed on
// lanes, everything autosaved through the session. The model
// (project-model.js) decides what is legal; this is about the UI reaching
// it correctly and reporting refusals instead of swallowing them.
//
// Time runs down: a clip's position is its `top`, its length its `height`,
// and a drag that moves it in time is a vertical one. Lanes sit side by
// side, so a drag that changes track is a horizontal one.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createSectionEditor, makeProjectSession, M, MEASURE_W, env;

// The open project the editor under test is bound to. build() sets it, and
// the pattern assertions read the library through it — patterns belong to
// the project now, not to a global store.
let session = null;

before(async () => {
    env = installBrowserEnv();
    ({ createSectionEditor, MEASURE_W } = await import('../html/components/section-editor.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
    M = await import('../html/components/project-model.js');
});

beforeEach(() => {
    localStorage.clear();
    globalThis.confirm = () => true;
});

const BANK = [
    { name: 'Piano', color: '#aaa001', voiceData: 'p' },
    { name: 'Bass', color: '#bbb002', voiceData: 'b' },
];
const COLS = 16;              // COLS_PER_MEASURE — a bar, in columns

function build({ patterns = [], tracks = [], clips = [] } = {}) {
    session = makeProjectSession();
    const made = patterns.map(p => session.createPattern(p, 'test'));
    if (tracks.length || clips.length) {
        session.update((project, section) => {
            project.tracks.push(...tracks.map(t => M.createTrack(t)));
            for (const c of clips) {
                M.addClip(project, section, {
                    trackId: project.tracks[c.track].id,
                    patternId: made[c.pattern].id,
                    startCol: c.at * COLS, repeats: c.repeats || 1,
                });
            }
        }, 'test');
    }
    const logs = [];
    const opened = [];
    const editor = createSectionEditor({
        session, log: (m) => logs.push(m),
        getSlotData: (slot) => BANK[slot] || null,
        onOpenPattern: (clipId, trackId, patternId) => opened.push({ clipId, trackId, patternId }),
    });
    const root = editor.element;
    const h = {
        editor, session, logs, opened, root, patterns: made,
        project: () => session.get(),
        section: () => session.getSection(),
        status: () => root.querySelector('.section-status').textContent,
        lanes: () => root.querySelectorAll('.section-lane'),
        heads: () => root.querySelectorAll('.section-track-head'),
        clips: () => root.querySelectorAll('.section-clip'),
        btn: (cls) => root.querySelector('.' + cls),
        /** A click at `y` px down the element — time runs down. */
        click: (el, y = 0) => el.dispatch('click', { target: el, clientX: 0, clientY: y, stopPropagation() {} }),
        doc: (type, e) => (env.document._listeners[type] || []).slice().forEach(fn => fn(e)),
    };
    return h;
}

const ev = (extra = {}) => ({ preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0, cancelable: true, ...extra });

describe('rendering', () => {
    test('one lane per track, one block per clip, sized by pattern length × repeats', () => {
        const h = build({
            patterns: [{ name: 'A', measures: 2 }],
            tracks: [{ slot: 0 }, { slot: 1 }],
            clips: [{ track: 0, pattern: 0, at: 1, repeats: 2 }, { track: 1, pattern: 0, at: 0 }],
        });
        assert.equal(h.lanes().length, 2);
        assert.equal(h.heads().length, 2, 'a head above every lane');
        const clips = h.clips();
        assert.equal(clips.length, 2);
        assert.equal(clips[0].style.top, (1 * MEASURE_W) + 'px');
        assert.equal(clips[0].style.height, (4 * MEASURE_W - 2) + 'px');
        assert.equal(clips[0].querySelector('.section-clip-label').textContent, 'A ×2');
        assert.equal(clips[1].querySelector('.section-clip-label').textContent, 'A');
        assert.equal(clips[1].style.background, h.patterns[0].color, 'painted with its pattern\'s colour');
        assert.equal(h.lanes()[1].style.backgroundColor, 'rgba(187,176,2,0.16)', 'the lane is tinted with the voice');
    });

    test('the ruler runs down the section with a tick per bar', () => {
        const h = build({ patterns: [{ name: 'A', measures: 2 }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 20 }] });
        const ticks = h.root.querySelectorAll('.section-ruler-tick');
        assert.equal(ticks.length, 26, 'the section (22 bars) plus four spare');
        assert.equal(ticks[3].style.top, (3 * MEASURE_W) + 'px');
        assert.equal(ticks[3].textContent, '4');
        assert.equal(parseFloat(h.root.querySelector('.section-ruler').style.height), 26 * MEASURE_W);
    });

    test('a clip whose pattern is gone is skipped, not fatal', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
        session.removePattern(h.patterns[0].id, 'test');
        h.editor.render();
        assert.equal(h.clips().length, 0);
        assert.equal(h.lanes().length, 1);
    });

    test('track heads show the voice names and the bound slot', () => {
        const h = build({ tracks: [{ slot: 1 }] });
        const sel = h.root.querySelector('.section-track-slot');
        assert.equal(sel.value, '1');
        assert.deepEqual(sel.children.slice(0, 2).map(o => o.textContent), ['1. Piano', '2. Bass']);
    });

    test('there is no pattern list — the toolbar has + Pattern instead', () => {
        const h = build({ patterns: [{ name: 'A' }] });
        assert.equal(h.root.querySelector('.section-palette'), null);
        assert.ok(h.btn('section-pattern-new'));
    });
});

describe('placing clips', () => {
    test('click a lane with a pattern selected → a clip at that bar', () => {
        const h = build({ patterns: [{ name: 'A', measures: 2 }], tracks: [{ slot: 0 }] });
        h.editor.selectPattern(h.patterns[0].id);
        assert.equal(h.editor.getSelectedPatternId(), h.patterns[0].id);
        h.click(h.lanes()[0], 3 * MEASURE_W + 5);
        const section = h.section();
        assert.equal(section.clips.length, 1);
        assert.equal(section.clips[0].startCol, 3 * COLS, 'a click at a bar line lands on it');
        assert.equal(section.clips[0].patternId, h.patterns[0].id);
        assert.equal(session.isDirty(), true, 'the edit reached the store, to be written');
        assert.equal(h.editor.getSelectedClipId(), section.clips[0].id, 'the new clip is selected');
    });

    test('selecting a clip selects its pattern, so a lane click places it again', () => {
        const h = build({ patterns: [{ name: 'A', measures: 2 }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
        h.click(h.clips()[0]);
        h.click(h.lanes()[0], 5 * MEASURE_W + 5);
        assert.equal(h.section().clips.length, 2);
        assert.equal(h.section().clips[1].patternId, h.patterns[0].id);
    });

    test('without a selected pattern the click explains itself', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }] });
        h.click(h.lanes()[0], 10);
        assert.equal(h.section().clips.length, 0);
        assert.match(h.status(), /Select a clip.*\+ Pattern/);
    });

    test('an overlap is refused and reported, nothing changes', () => {
        const h = build({
            patterns: [{ name: 'A', measures: 2 }], tracks: [{ slot: 0 }],
            clips: [{ track: 0, pattern: 0, at: 0, repeats: 2 }],          // [0,4)
        });
        h.editor.selectPattern(h.patterns[0].id);
        h.click(h.lanes()[0], 2 * MEASURE_W + 5);
        assert.equal(h.section().clips.length, 1);
        assert.equal(h.status(), 'Clip overlaps');
        assert.ok(h.logs.some(l => /Clip overlaps/.test(l)));
    });

    test('the same pattern can be placed on two tracks at the same bar', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }, { slot: 1 }] });
        h.editor.selectPattern(h.patterns[0].id);
        h.click(h.lanes()[0], 5);
        h.click(h.lanes()[1], 5);
        assert.equal(h.section().clips.length, 2);
    });
});

describe('moving and lengthening clips', () => {
    function one(extraClips = []) {
        return build({
            patterns: [{ name: 'A', measures: 2 }], tracks: [{ slot: 0 }],
            clips: [{ track: 0, pattern: 0, at: 0 }, ...extraClips],
        });
    }

    test('a whole-bar drag down moves by whole bars at the default snap', () => {
        const h = one();
        const clip = h.clips()[0];
        clip.dispatch('mousedown', ev({ clientY: 10 }));
        h.doc('mousemove', ev({ clientY: 10 + 3 * MEASURE_W }));
        h.doc('mouseup', ev({ clientY: 10 + 3 * MEASURE_W }));
        assert.equal(h.section().clips[0].startCol, 3 * COLS);
    });

    test('a jitter under the threshold is a click, not a move', () => {
        const h = one();
        const clip = h.clips()[0];
        clip.dispatch('mousedown', ev({ clientY: 10 }));
        h.doc('mousemove', ev({ clientY: 12 }));
        h.doc('mouseup', ev({ clientY: 12 }));
        assert.equal(h.section().clips[0].startCol, 0);
        // Nothing happened, so nothing was redrawn: the same element is
        // still there, and the click that follows selects it as usual.
        assert.equal(h.clips()[0], clip, 'no re-render for a wobble');
        h.click(clip);
        assert.equal(h.editor.getSelectedClipId(), h.section().clips[0].id);
    });

    test('a move onto a neighbour snaps back and says why', () => {
        const h = one([{ track: 0, pattern: 0, at: 3 }]);              // [3,5)
        const clip = h.clips()[0];                                     // [0,2)
        clip.dispatch('mousedown', ev({ clientY: 0 }));
        h.doc('mousemove', ev({ clientY: 2 * MEASURE_W }));
        h.doc('mouseup', ev({ clientY: 2 * MEASURE_W }));             // → [2,4) overlaps
        assert.equal(h.section().clips[0].startCol, 0);
        assert.equal(h.status(), 'Clip overlaps');
        assert.equal(h.clips()[0].style.top, '0px', 're-rendered in place');
    });

    test('cannot be dragged before the start of the section', () => {
        const h = one();
        const clip = h.clips()[0];
        clip.dispatch('mousedown', ev({ clientY: 200 }));
        h.doc('mousemove', ev({ clientY: 0 }));
        h.doc('mouseup', ev({ clientY: 0 }));
        assert.equal(h.section().clips[0].startCol, 0);
    });

    test('dragging the bottom handle gives the clip a length of its own', () => {
        const h = one();
        const handle = h.clips()[0].querySelector('.section-clip-handle');
        handle.dispatch('mousedown', ev({ clientY: 2 * MEASURE_W }));
        h.doc('mousemove', ev({ clientY: 2 * MEASURE_W + 4 * MEASURE_W }));
        h.doc('mouseup', ev({ clientY: 2 * MEASURE_W + 4 * MEASURE_W }));
        assert.equal(h.section().clips[0].lengthCols, 6 * COLS, '2 bars + 4 bars');
        assert.equal(h.section().clips[0].repeats, undefined, 'it no longer follows its pattern');
        assert.equal(h.clips()[0].querySelector('.section-clip-label').textContent, 'A ×3');
    });

    test('a length that is not whole repeats is shown as a fraction', () => {
        const h = one();
        const handle = h.clips()[0].querySelector('.section-clip-handle');
        handle.dispatch('mousedown', ev({ clientY: 0 }));
        h.doc('mousemove', ev({ clientY: MEASURE_W }));                 // 2 bars + 1 = 1.5 repeats
        h.doc('mouseup', ev({ clientY: MEASURE_W }));
        assert.equal(h.section().clips[0].lengthCols, 3 * COLS);
        assert.equal(h.clips()[0].querySelector('.section-clip-label').textContent, 'A ×1.5');
    });

    test('shrinking stops at one snap cell', () => {
        const h = one();
        const handle = h.clips()[0].querySelector('.section-clip-handle');
        handle.dispatch('mousedown', ev({ clientY: 100 }));
        h.doc('mousemove', ev({ clientY: -500 }));
        h.doc('mouseup', ev({ clientY: -500 }));
        assert.equal(h.section().clips[0].lengthCols, COLS / 2, 'half a bar, the default snap');
    });

    test('touchcancel abandons the drag', () => {
        const h = one();
        const clip = h.clips()[0];
        clip.dispatch('touchstart', ev({ touches: [{ clientX: 0, clientY: 0 }] }));
        h.doc('touchmove', ev({ touches: [{ clientX: 0, clientY: 3 * MEASURE_W }] }));
        h.doc('touchcancel', ev({}));
        assert.equal(h.section().clips[0].startCol, 0);
        assert.equal(h.clips()[0].style.top, '0px');
    });
});

describe('selecting, opening and removing clips', () => {
    function one() {
        return build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
    }

    test('click selects the clip and its pattern; Delete removes it', () => {
        const h = one();
        h.click(h.clips()[0]);
        const id = h.section().clips[0].id;
        assert.equal(h.editor.getSelectedClipId(), id);
        assert.equal(h.editor.getSelectedPatternId(), h.patterns[0].id);
        assert.ok(h.clips()[0].classList.contains('selected'));
        h.doc('keydown', { key: 'Delete', target: { tagName: 'DIV' }, preventDefault() {} });
        assert.equal(h.section().clips.length, 0);
        assert.equal(h.editor.getSelectedClipId(), null);
    });

    test('Delete while typing in a field does nothing to the clip', () => {
        const h = one();
        h.click(h.clips()[0]);
        h.doc('keydown', { key: 'Backspace', target: { tagName: 'INPUT' }, preventDefault() {} });
        assert.equal(h.section().clips.length, 1);
    });

    test('the Remove button does it without a keyboard', () => {
        const h = one();
        h.click(h.clips()[0]);
        h.btn('section-clip-remove').dispatch('click', ev());
        assert.equal(h.section().clips.length, 0);
    });

    test('the Open button hands the clip to the piano roll', () => {
        const h = one();
        h.click(h.clips()[0]);
        h.btn('section-clip-open').dispatch('click', ev());
        const c = h.section().clips[0];
        assert.deepEqual(h.opened, [{ clipId: c.id, trackId: h.project().tracks[0].id, patternId: h.patterns[0].id }]);
    });

    test('the action bar exists only while a clip is selected', () => {
        const h = one();
        assert.equal(h.btn('section-clip-remove'), null);
        h.click(h.clips()[0]);
        assert.ok(h.btn('section-clip-remove'));
        assert.ok(h.btn('section-clip-open'));
    });
});

// The two note gestures from the piano roll, on clips: double-tap removes,
// a still long press opens. Detected from press/release so touch has them
// too; `dblclick` is no longer listened for.
describe('clip gestures', () => {
    function one() {
        return build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
    }
    // A press that is released without moving. Each tap lands on a freshly
    // rendered element, as it does in the browser (the click re-renders).
    function tap(h, type = 'mouse') {
        const clip = h.clips()[0];
        if (type === 'touch') {
            clip.dispatch('touchstart', ev({ touches: [{ clientX: 5, clientY: 5 }] }));
            h.doc('touchend', ev({ changedTouches: [{ clientX: 5, clientY: 5 }] }));
        } else {
            clip.dispatch('mousedown', ev({ clientX: 5, clientY: 5 }));
            h.doc('mouseup', ev({ clientX: 5, clientY: 5 }));
            h.click(clip);
        }
    }

    test('two quick taps remove the clip', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const h = one();
        tap(h);
        assert.equal(h.section().clips.length, 1, 'one tap selects, nothing more');
        t.mock.timers.tick(150);
        tap(h);
        assert.equal(h.section().clips.length, 0);
        assert.equal(h.editor.getSelectedClipId(), null);
        assert.deepEqual(h.opened, [], 'and the hold timer was cancelled, not left to open a dead clip');
        t.mock.timers.tick(1000);
        assert.deepEqual(h.opened, []);
    });

    test('a touch tap selects the clip — preventDefault on touchstart eats the click', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const h = one();
        tap(h, 'touch');
        assert.equal(h.editor.getSelectedClipId(), h.section().clips[0].id);
        assert.equal(h.editor.getSelectedPatternId(), h.patterns[0].id);
        assert.ok(h.clips()[0].classList.contains('selected'));
        assert.equal(h.section().clips.length, 1, 'selected, not removed');
    });

    test('two quick touch taps remove it as well', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const h = one();
        tap(h, 'touch');
        t.mock.timers.tick(150);
        tap(h, 'touch');
        assert.equal(h.section().clips.length, 0);
    });

    test('two slow taps do not', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const h = one();
        tap(h);
        t.mock.timers.tick(450);
        tap(h);
        assert.equal(h.section().clips.length, 1);
    });

    test('re-grabbing a clip right after dragging it is not a double tap', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
        h.clips()[0].dispatch('mousedown', ev({ clientY: 0 }));
        h.doc('mousemove', ev({ clientY: MEASURE_W }));
        h.doc('mouseup', ev({ clientY: MEASURE_W }));
        assert.equal(h.section().clips[0].startCol, COLS);
        t.mock.timers.tick(50);
        h.clips()[0].dispatch('mousedown', ev({ clientY: MEASURE_W }));
        h.doc('mouseup', ev({ clientY: MEASURE_W }));
        assert.equal(h.section().clips.length, 1);
    });

    test('a still press of 600 ms opens the clip in the roll', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const h = one();
        h.clips()[0].dispatch('mousedown', ev({ clientX: 5, clientY: 5 }));
        t.mock.timers.tick(599);
        assert.deepEqual(h.opened, []);
        t.mock.timers.tick(1);
        const c = h.section().clips[0];
        assert.deepEqual(h.opened, [{ clipId: c.id, trackId: h.project().tracks[0].id, patternId: h.patterns[0].id }]);
        // The release that follows a hold is not a tap: another press soon
        // after must not read as a double tap and remove what was just opened.
        h.doc('mouseup', ev({ clientX: 5, clientY: 5 }));
        h.clips()[0].dispatch('mousedown', ev({ clientX: 5, clientY: 5 }));
        h.doc('mouseup', ev({ clientX: 5, clientY: 5 }));
        assert.equal(h.section().clips.length, 1);
    });

    test('a touch hold opens too', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const h = one();
        h.clips()[0].dispatch('touchstart', ev({ touches: [{ clientX: 5, clientY: 5 }] }));
        t.mock.timers.tick(600);
        assert.equal(h.opened.length, 1);
    });

    test('moving during the press cancels the hold — it is a drag', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const h = one();
        h.clips()[0].dispatch('mousedown', ev({ clientY: 0 }));
        t.mock.timers.tick(300);
        h.doc('mousemove', ev({ clientY: MEASURE_W }));
        t.mock.timers.tick(600);
        assert.deepEqual(h.opened, []);
        h.doc('mouseup', ev({ clientY: MEASURE_W }));
        assert.equal(h.section().clips[0].startCol, COLS);
    });

    test('releasing before 600 ms cancels the hold', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const h = one();
        h.clips()[0].dispatch('mousedown', ev({ clientX: 5, clientY: 5 }));
        t.mock.timers.tick(300);
        h.doc('mouseup', ev({ clientX: 5, clientY: 5 }));
        t.mock.timers.tick(600);
        assert.deepEqual(h.opened, []);
    });

    test('the length handle has neither gesture', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const h = one();
        const handle = () => h.root.querySelector('.section-clip-handle');
        handle().dispatch('mousedown', ev({ clientY: 40 }));
        t.mock.timers.tick(700);
        assert.deepEqual(h.opened, []);
        h.doc('mouseup', ev({ clientY: 40 }));
        handle().dispatch('mousedown', ev({ clientY: 40 }));
        h.doc('mouseup', ev({ clientY: 40 }));
        assert.equal(h.section().clips.length, 1);
    });
});

describe('tracks', () => {
    test('+ Track binds the first free voice; all eight used is refused', () => {
        const h = build({ tracks: [{ slot: 0 }, { slot: 1 }] });
        h.btn('section-add-track').dispatch('click', ev());
        assert.deepEqual(h.project().tracks.map(t => t.slot), [0, 1, 2]);
        for (let i = 0; i < 6; i++) h.btn('section-add-track').dispatch('click', ev());
        assert.equal(h.project().tracks.length, 8);
        assert.match(h.status(), /All 8 voices/);
    });

    test('changing the slot rebinds the track', () => {
        const h = build({ tracks: [{ slot: 0 }] });
        const sel = h.root.querySelector('.section-track-slot');
        sel.value = '5';
        sel.dispatch('change');
        assert.equal(h.project().tracks[0].slot, 5);
    });

    test('mute and solo toggle and are what the sequencer reads', async () => {
        const { audibleTrackIds } = await import('../html/synth/section-sequencer.js');
        const h = build({ tracks: [{ slot: 0 }, { slot: 1 }] });
        h.root.querySelectorAll('.section-track-mute')[0].dispatch('click', ev());
        assert.equal(h.project().tracks[0].mute, true);
        assert.ok(h.root.querySelectorAll('.section-track-mute')[0].classList.contains('active'));
        assert.deepEqual([...audibleTrackIds(h.project().tracks)], [h.project().tracks[1].id]);
        h.root.querySelectorAll('.section-track-solo')[0].dispatch('click', ev());
        assert.deepEqual([...audibleTrackIds(h.project().tracks)], [h.project().tracks[0].id], 'solo beats mute');
    });

    test('removing a track takes its clips, after a confirm when it has any', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
        let asked = 0;
        globalThis.confirm = () => { asked++; return false; };
        h.btn('section-track-remove').dispatch('click', ev());
        assert.equal(asked, 1);
        assert.equal(h.project().tracks.length, 1, 'declined');
        globalThis.confirm = () => true;
        h.btn('section-track-remove').dispatch('click', ev());
        assert.deepEqual(h.project().tracks, []);
        assert.deepEqual(h.section().clips, []);
    });

    test('the first track is current until a head is clicked', () => {
        const h = build({ tracks: [{ slot: 0 }, { slot: 1 }] });
        assert.equal(h.editor.getSelectedTrackId(), h.project().tracks[0].id);
        assert.ok(h.heads()[0].classList.contains('selected'));
        h.click(h.heads()[1]);
        assert.equal(h.editor.getSelectedTrackId(), h.project().tracks[1].id);
        assert.ok(h.heads()[1].classList.contains('selected'));
        assert.ok(h.lanes()[1].classList.contains('selected'), 'the lane shows it too');
        assert.ok(!h.heads()[0].classList.contains('selected'));
    });

    test('selecting a clip selects its track', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }, { slot: 1 }], clips: [{ track: 1, pattern: 0, at: 0 }] });
        h.click(h.clips()[0]);
        assert.equal(h.editor.getSelectedTrackId(), h.project().tracks[1].id);
    });

    test('removing the current track falls back to the first', () => {
        const h = build({ tracks: [{ slot: 0 }, { slot: 1 }] });
        h.click(h.heads()[1]);
        h.root.querySelectorAll('.section-track-remove')[1].dispatch('click', ev());
        assert.equal(h.editor.getSelectedTrackId(), h.project().tracks[0].id);
    });
});

// There is no pattern list. New patterns are born in place, at the end of
// the selected track; a pattern's name, colour and copies are edited from
// the selected clip's action bar.
describe('patterns', () => {
    test('+ Pattern creates a pattern and places it at the end of the selected track', () => {
        const h = build({
            patterns: [{ name: 'A', measures: 2 }], tracks: [{ slot: 0 }, { slot: 1 }],
            clips: [{ track: 1, pattern: 0, at: 1, repeats: 2 }],          // [1,5) on track 2
        });
        h.click(h.heads()[1]);
        h.btn('section-pattern-new').dispatch('click', ev());
        assert.equal(session.listPatterns().length, 2);
        const made = session.listPatterns().find(p => p.id !== h.patterns[0].id);
        assert.equal(made.name, 'Pattern 2');
        const clip = h.section().clips.find(c => c.patternId === made.id);
        assert.ok(clip, 'placed, not just created');
        assert.equal(clip.trackId, h.project().tracks[1].id);
        assert.equal(clip.startCol, 5 * COLS, 'right after the track\'s last clip');
        assert.equal(h.editor.getSelectedClipId(), clip.id, 'and selected');
        assert.equal(h.editor.getSelectedPatternId(), made.id);
    });

    test('on an empty track it lands at bar 1; on no track at all it makes one first', () => {
        const h = build();
        h.btn('section-pattern-new').dispatch('click', ev());
        assert.equal(h.project().tracks.length, 1, 'a track on the first free voice');
        assert.equal(h.project().tracks[0].slot, 0);
        assert.equal(h.section().clips.length, 1);
        assert.equal(h.section().clips[0].startCol, 0);
        assert.equal(h.lanes().length, 1);
        assert.equal(h.clips().length, 1);
    });

    test('duplicate copies the notes under a new id and places the copy after the clip\'s track', () => {
        const h = build({
            patterns: [{ name: 'A', notes: [{ midi: 60, start: 0, dur: 1 }] }], tracks: [{ slot: 0 }],
            clips: [{ track: 0, pattern: 0, at: 0 }],
        });
        h.click(h.clips()[0]);
        h.btn('section-pattern-dup').dispatch('click', ev());
        const all = session.listPatterns();
        assert.equal(all.length, 2);
        const copy = all.find(p => p.name === 'A copy');
        assert.deepEqual(copy.notes, [{ midi: 60, start: 0, dur: 1 }]);
        assert.notEqual(copy.id, h.patterns[0].id);
        const placed = h.section().clips.find(c => c.patternId === copy.id);
        assert.equal(placed.startCol, COLS, 'after the one-bar original');
        assert.equal(h.editor.getSelectedClipId(), placed.id);
    });

    test('the name field renames the pattern; every clip of it follows', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }, { track: 0, pattern: 0, at: 2 }] });
        h.click(h.clips()[0]);
        const name = h.btn('section-pattern-name');
        assert.equal(name.value, 'A');
        name.value = ' Bassline ';
        name.dispatch('change');
        assert.equal(session.getPattern(h.patterns[0].id).name, 'Bassline');
        assert.deepEqual(h.clips().map(c => c.querySelector('.section-clip-label').textContent), ['Bassline', 'Bassline']);
    });

    test('an empty name is discarded, not saved', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
        h.click(h.clips()[0]);
        const name = h.btn('section-pattern-name');
        name.value = '   ';
        name.dispatch('change');
        assert.equal(session.getPattern(h.patterns[0].id).name, 'A');
        assert.equal(name.value, 'A', 'the field snaps back');
    });
});

describe('section toolbar', () => {
    test('the name field renames the SECTION, not the project', () => {
        // Project naming moved to the File menu: a project is the whole
        // piece, which is more than this panel edits.
        const h = build();
        const projectName = h.project().name;
        const name = h.btn('section-name');
        name.value = ' Chorus ';
        name.dispatch('change');
        assert.equal(h.section().name, 'Chorus');
        assert.equal(h.project().name, projectName, 'the project is untouched');
    });

    test('an empty name is refused and the field snaps back', () => {
        const h = build();
        const before = h.section().name;
        const name = h.btn('section-name');
        name.value = '   ';
        name.dispatch('change');
        assert.equal(h.section().name, before);
        assert.equal(name.value, before);
    });

    test('loop range writes through', () => {
        const h = build({ patterns: [{ name: 'A', measures: 2 }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0, repeats: 2 }] });

        h.btn('section-loop-on').checked = true;
        h.btn('section-loop-start').value = '2';
        h.btn('section-loop-end').value = '3';
        h.btn('section-loop-end').dispatch('change');
        assert.deepEqual(h.section().loop, { start: 1, end: 3 }, '1-based inclusive bars → 0-based half-open');
        const band = h.root.querySelector('.section-loop-band');
        assert.ok(band, 'shown on the ruler');
        assert.equal(band.style.top, MEASURE_W + 'px');
        assert.equal(band.style.height, (2 * MEASURE_W) + 'px');

        h.btn('section-loop-on').checked = false;
        h.btn('section-loop-on').dispatch('change');
        assert.equal(h.section().loop, null);
    });

    test('a backwards loop range is refused with a message', () => {
        const h = build();
        h.btn('section-loop-on').checked = true;
        h.btn('section-loop-start').value = '4';
        h.btn('section-loop-end').value = '2';
        h.btn('section-loop-end').dispatch('change');
        assert.equal(h.section().loop, null);
        assert.match(h.status(), /later/);
    });
});

describe('it follows the session', () => {
    test('a track added elsewhere (the roll drawing a note) appears', () => {
        const h = build();
        assert.equal(h.lanes().length, 0);
        h.session.update((project) => { project.tracks.push(M.createTrack({ slot: 3 })); }, 'roll');
        assert.equal(h.lanes().length, 1);
    });

    test('a pattern lengthened elsewhere lengthens its clips', () => {
        const h = build({ patterns: [{ name: 'A', measures: 1 }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
        assert.equal(h.clips()[0].style.height, (MEASURE_W - 2) + 'px');
        session.updatePattern(h.patterns[0].id, { measures: 3 }, 'test');
        h.session.notifyPattern(h.patterns[0].id, 'roll');
        assert.equal(h.clips()[0].style.height, (3 * MEASURE_W - 2) + 'px');
    });

    test('destroy unhooks the keyboard and the session', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
        h.click(h.clips()[0]);
        h.editor.destroy();
        h.doc('keydown', { key: 'Delete', target: { tagName: 'DIV' }, preventDefault() {} });
        assert.equal(h.section().clips.length, 1);
    });
});

describe('playhead (phase 5)', () => {
    async function withTransport() {
        const { createTransport } = await import('../html/synth/transport.js');
        session = makeProjectSession();
        const pattern = session.createPattern({ name: 'A', measures: 2, notes: [{ midi: 60, start: 0, dur: 1 }] }, 'test');
        let clipId = null;
        session.update((project, section) => {
            const t = M.createTrack({ slot: 0 });
            project.tracks.push(t);
            clipId = M.addClip(project, section, {
                trackId: t.id, patternId: pattern.id, startCol: 0, repeats: 2,
            }).id;
        }, 'test');
        const handlers = [];
        const tickWorker = {
            postMessage() {}, addEventListener(t, fn) { if (t === 'message') handlers.push(fn); },
            tick(col) { for (const fn of handlers) fn({ data: { type: 'tick', col } }); },
        };
        const transport = createTransport({
            session, tickWorker, startWorker: () => {}, stopWorker: () => {},
            playNote: () => {}, getSlotData: () => null,
            getPattern: (id) => session.getPattern(id),
            getEditTarget: () => ({ trackId: session.get().tracks[0].id, clipId, pattern, slot: 0 }),
        });
        const editor = createSectionEditor({ session, transport, getSlotData: (s) => BANK[s] || null });
        return { editor, transport, tickWorker, session, root: editor.element };
    }

    test('hidden at rest, follows the section column down while playing', async () => {
        const h = await withTransport();
        const head = () => h.root.querySelector('.section-playhead');
        assert.equal(head().style.display, 'none');

        h.transport.play();
        h.tickWorker.tick(0);
        assert.equal(head().style.display, '');
        const top0 = parseFloat(head().style.top);
        h.tickWorker.tick(16);                       // one bar on
        assert.equal(parseFloat(head().style.top) - top0, MEASURE_W);

        h.transport.stop();
        assert.equal(head().style.display, 'none');
    });

    test('shown in pattern mode too — that loop is a window of the section', async () => {
        const h = await withTransport();
        const head = () => h.root.querySelector('.section-playhead');
        h.transport.setMode('pattern');
        h.transport.play();
        h.tickWorker.tick(0);
        assert.equal(head().style.display, '');
        const top0 = parseFloat(head().style.top);
        h.tickWorker.tick(16);
        assert.equal(parseFloat(head().style.top) - top0, MEASURE_W);
    });

    test('opening a clip parks the section position on it, so that placement is what loops', async () => {
        const h = await withTransport();
        // A second clip of the same pattern at bar 5.
        h.session.update((project, section) => {
            M.addClip(project, section, {
                trackId: project.tracks[0].id, patternId: section.clips[0].patternId,
                startCol: 4 * COLS,
            });
        }, 'test');
        const second = h.root.querySelectorAll('.section-clip')[1];
        second.dispatch('click', ev());
        h.root.querySelector('.section-clip-open').dispatch('click', ev());
        assert.equal(h.transport.getSectionPosition(), 4 * 16);
        h.transport.play({ mode: 'pattern' });
        assert.deepEqual(h.transport.getSequence().range, { startCol: 64, endCol: 96 });
    });

    test('it survives a re-render and does not rebuild the clips per tick', async () => {
        const h = await withTransport();
        h.transport.play();
        h.tickWorker.tick(0);
        const clipEl = h.root.querySelectorAll('.section-clip')[0];
        h.tickWorker.tick(4);
        assert.equal(h.root.querySelectorAll('.section-clip')[0], clipEl, 'a tick moves the line, nothing else');
        h.editor.render();
        assert.ok(h.root.querySelector('.section-playhead'), 'still there after a render');
    });
});

// A clip dragged sideways into another lane changes track. Only the notes
// travel — a clip is a pattern id placed somewhere, and the voice is the
// track's.
describe('moving clips between tracks', () => {
    const LANE_W = 100;
    function two(extraClips = []) {
        const h = build({
            patterns: [{ name: 'A', measures: 2, notes: [{ midi: 60, start: 0, dur: 1 }] }],
            tracks: [{ slot: 0 }, { slot: 1 }],
            clips: [{ track: 0, pattern: 0, at: 0 }, ...extraClips],
        });
        // The harness has no layout: give the lanes side-by-side rectangles.
        h.lanes().forEach((lane, i) => {
            lane.getBoundingClientRect = () => ({ left: i * LANE_W, right: (i + 1) * LANE_W, top: 0, bottom: 1000 });
        });
        return h;
    }
    const drag = (h, clip, from, to) => {
        clip.dispatch('mousedown', ev(from));
        h.doc('mousemove', ev(to));
        h.doc('mouseup', ev(to));
    };

    test('a sideways drag moves the clip to the lane under the pointer, same bar', () => {
        const h = two();
        const before = h.section().clips[0];
        drag(h, h.clips()[0], { clientX: 5, clientY: 10 }, { clientX: LANE_W + 5, clientY: 10 });
        const after = h.section().clips[0];
        assert.equal(after.trackId, h.project().tracks[1].id);
        assert.equal(after.startCol, 0);
        assert.equal(after.patternId, before.patternId, 'the same pattern — only the notes moved');
        assert.equal(h.lanes()[1].querySelectorAll('.section-clip').length, 1, 'drawn in the new lane');
        assert.equal(h.lanes()[0].querySelectorAll('.section-clip').length, 0);
        assert.equal(h.editor.getSelectedTrackId(), after.trackId, 'the destination is the current track now');
    });

    test('it then sounds on the new track\'s voice', async () => {
        const { createSectionSequence } = await import('../html/synth/section-sequencer.js');
        const h = two();
        drag(h, h.clips()[0], { clientX: 5, clientY: 10 }, { clientX: LANE_W + 5, clientY: 10 });
        const ev0 = createSectionSequence(h.project(), h.section()).eventsAt(0);
        assert.deepEqual(ev0.map(e => [e.midi, e.slot]), [[60, 1]]);
    });

    test('diagonal: bars and track change together', () => {
        const h = two();
        drag(h, h.clips()[0], { clientX: 5, clientY: 0 }, { clientX: LANE_W + 5, clientY: 3 * MEASURE_W });
        const after = h.section().clips[0];
        assert.equal(after.trackId, h.project().tracks[1].id);
        assert.equal(after.startCol, 3 * COLS);
    });

    test('while dragging, the clip previews in the target lane, keeping its pattern colour', () => {
        const h = two();
        const clip = h.clips()[0];
        clip.dispatch('mousedown', ev({ clientX: 5, clientY: 10 }));
        h.doc('mousemove', ev({ clientX: LANE_W + 5, clientY: 10 }));
        assert.equal(clip.parentNode, h.lanes()[1], 're-parented under the pointer');
        assert.equal(clip.style.background, h.patterns[0].color);
        h.doc('mousemove', ev({ clientX: 5, clientY: 10 }));
        assert.equal(clip.parentNode, h.lanes()[0], 'and back');
        h.doc('mouseup', ev({ clientX: 5, clientY: 10 }));
        assert.equal(h.section().clips[0].trackId, h.project().tracks[0].id, 'returned home: no change');
    });

    test('landing on a clip in the other lane is refused and snaps back', () => {
        const h = two([{ track: 1, pattern: 0, at: 1 }]);                 // [1,3) on track 2
        drag(h, h.clips()[0], { clientX: 5, clientY: 0 }, { clientX: LANE_W + 5, clientY: 0 });  // [0,2) → overlaps
        assert.equal(h.section().clips[0].trackId, h.project().tracks[0].id);
        assert.equal(h.status(), 'Clip overlaps');
        assert.equal(h.lanes()[0].querySelectorAll('.section-clip').length, 1, 'drawn back where it was');
    });

    test('a pointer outside every lane keeps the last lane it was over', () => {
        const h = two();
        drag(h, h.clips()[0], { clientX: 5, clientY: 10 }, { clientX: 10 * LANE_W, clientY: 10 });
        assert.equal(h.section().clips[0].trackId, h.project().tracks[0].id);
    });

    test('touch: the same, with touches', () => {
        const h = two();
        const clip = h.clips()[0];
        clip.dispatch('touchstart', ev({ touches: [{ clientX: 5, clientY: 10 }] }));
        h.doc('touchmove', ev({ touches: [{ clientX: LANE_W + 5, clientY: 10 }] }));
        h.doc('touchend', ev({ changedTouches: [{ clientX: LANE_W + 5, clientY: 10 }] }));
        assert.equal(h.section().clips[0].trackId, h.project().tracks[1].id);
    });
});

describe('pattern colours', () => {
    test('every pattern has one; the default is stable per id and survives a reload', () => {
        const h = build({ patterns: [{ name: 'A' }, { name: 'B' }] });
        const [a, b] = h.patterns;
        assert.match(a.color, /^#[0-9a-f]{6}$/);
        assert.notEqual(a.color, b.color, 'two patterns, two hues');
        const again = M.createPattern({ ...a, color: undefined });
        assert.equal(again.color, a.color, 'derived from the id, so a stored pattern without one keeps its colour');
        assert.equal(session.getPattern(a.id).color, a.color);
    });

    test('the swatch in the action bar recolours the pattern and its clips', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }, { track: 0, pattern: 0, at: 2 }] });
        h.click(h.clips()[0]);
        const swatch = h.btn('section-pattern-swatch');
        assert.equal(swatch.type, 'color');
        assert.equal(swatch.value, h.patterns[0].color);
        swatch.value = '#123456';
        swatch.dispatch('change');
        assert.equal(session.getPattern(h.patterns[0].id).color, '#123456');
        assert.deepEqual(h.clips().map(c => c.style.background), ['#123456', '#123456']);
    });

    test('moving a clip to another track keeps its colour — the pattern did not change', () => {
        const h = build({ patterns: [{ name: 'A', color: '#102030' }], tracks: [{ slot: 0 }, { slot: 1 }],
            clips: [{ track: 0, pattern: 0, at: 0 }] });
        h.session.update((project, section) => { section.clips[0].trackId = project.tracks[1].id; }, 'test');
        assert.equal(h.clips()[0].style.background, '#102030');
        assert.equal(h.lanes()[1].style.backgroundColor, 'rgba(187,176,2,0.16)');
    });
});

// Clips are not bar-aligned by nature: their geometry is columns. The Snap
// select decides how coarsely a pointer may land, and Zoom makes the bar
// taller so the fine resolutions are something a pointer can actually hit.
describe('sub-bar placement and length', () => {
    // A function, not a constant: describe bodies run before before(),
    // where MEASURE_W is imported.
    const colH = (zoom = 1) => MEASURE_W * zoom / COLS;

    function one({ snap, zoom, clips = [{ track: 0, pattern: 0, at: 0 }] } = {}) {
        if (snap != null) localStorage.setItem('openpatches_song_snap', String(snap));
        if (zoom != null) localStorage.setItem('openpatches_song_zoom', String(zoom));
        return build({ patterns: [{ name: 'A', measures: 2 }], tracks: [{ slot: 0 }], clips });
    }
    const pick = (h, cls, value) => {
        const sel = h.btn(cls);
        sel.value = String(value);
        sel.dispatch('change');
    };

    test('the toolbar offers a snap and a zoom, defaulting to half bars at ×1', () => {
        const h = one({ clips: [] });
        assert.equal(h.btn('section-snap').value, String(COLS / 2));
        assert.equal(h.btn('section-zoom').value, '1');
        assert.deepEqual(
            Array.from(h.btn('section-snap').children).map(o => o.textContent),
            ['Bar', '1/2', '1/4', '1/8', '1/16']);
    });

    test('a finer snap places a clip part-way through a bar', () => {
        const h = one({ clips: [] });
        pick(h, 'section-snap', 4);                             // quarter notes
        h.editor.selectPattern(h.patterns[0].id);
        h.click(h.lanes()[0], MEASURE_W + 7 * colH());       // bar 2, a shade past beat 2
        assert.equal(h.section().clips[0].startCol, COLS + 4, 'floored to the quarter it fell in');
    });

    test('the snap is remembered, and is what a drag moves by', () => {
        const h = one({ snap: 8 });                      // halves
        assert.equal(h.btn('section-snap').value, '8');
        const clip = h.clips()[0];
        clip.dispatch('mousedown', ev({ clientY: 0 }));
        h.doc('mousemove', ev({ clientY: 11 * colH() })); // 11 columns → nearest half is 8
        h.doc('mouseup', ev({ clientY: 11 * colH() }));
        assert.equal(h.section().clips[0].startCol, 8);
    });

    test('a drag snaps the distance, not the position: an off-grid clip stays off it', () => {
        const h = one({ snap: COLS, clips: [{ track: 0, pattern: 0, at: 0 }] });
        h.session.update((project, section) => { section.clips[0].startCol = 3; }, 'test');
        const clip = h.clips()[0];
        clip.dispatch('mousedown', ev({ clientY: 0 }));
        h.doc('mousemove', ev({ clientY: MEASURE_W }));
        h.doc('mouseup', ev({ clientY: MEASURE_W }));
        assert.equal(h.section().clips[0].startCol, 3 + COLS, 'moved a bar, kept its offset');
    });

    test('the edge handle lengthens by sub-bar steps', () => {
        const h = one({ snap: 4 });
        const handle = h.clips()[0].querySelector('.section-clip-handle');
        handle.dispatch('mousedown', ev({ clientY: 0 }));
        h.doc('mousemove', ev({ clientY: 5 * colH() }));  // 5 columns → nearest quarter is 4
        h.doc('mouseup', ev({ clientY: 5 * colH() }));
        assert.equal(h.section().clips[0].lengthCols, 2 * COLS + 4);
    });

    test('a clip is drawn, and overlaps, at its column position', () => {
        const h = one({ clips: [] });
        h.session.update((project, section) => {
            M.addClip(project, section, {
                trackId: project.tracks[0].id, patternId: h.patterns[0].id,
                startCol: 8, lengthCols: 20,
            });
        }, 'test');
        const el = h.clips()[0];
        assert.equal(el.style.top, (8 * colH()) + 'px');
        assert.equal(el.style.height, (20 * colH() - 2) + 'px');
        // [8,28) is taken, so a clip at bar 1 ([0,32)) cannot go in beside it.
        assert.throws(() => h.session.update((project, section) => {
            M.addClip(project, section, {
                trackId: project.tracks[0].id, patternId: h.patterns[0].id, startCol: 0,
            });
        }, 'test'), /overlaps/);
    });

    test('zoom makes the bar taller; everything on the grid follows', () => {
        const h = one();
        assert.equal(h.clips()[0].style.height, (2 * MEASURE_W - 2) + 'px');
        pick(h, 'section-zoom', 4);
        assert.equal(h.clips()[0].style.height, (2 * 4 * MEASURE_W - 2) + 'px');
        assert.ok(parseFloat(h.root.querySelector('.section-ruler').style.height) >= 16 * 4 * MEASURE_W);
        assert.equal(localStorage.getItem('openpatches_song_zoom'), '4', 'remembered');
    });

    test('the grid draws a snap line under every bar line', () => {
        const h = one({ snap: 4, zoom: 2 });
        const g = h.root.querySelector('.section-grid');
        assert.equal(g.style.getPropertyValue('--section-measure-h'), (2 * MEASURE_W) + 'px');
        assert.equal(g.style.getPropertyValue('--section-snap-h'), (4 * colH(2)) + 'px');
    });

    test('a drag at a fine snap still cannot cross a neighbour', () => {
        // Zoomed, because a column is 3px at ×1 and a 3px drag never clears
        // DRAG_THRESHOLD — which is what the zoom is for.
        const h = one({ snap: 1, zoom: 2, clips: [{ track: 0, pattern: 0, at: 0 }, { track: 0, pattern: 0, at: 2 }] });
        const clip = h.clips()[0];                       // [0,32)
        clip.dispatch('mousedown', ev({ clientY: 0 }));
        h.doc('mousemove', ev({ clientY: colH(2) }));    // → [1,33) runs into [32,64)
        h.doc('mouseup', ev({ clientY: colH(2) }));
        assert.equal(h.section().clips[0].startCol, 0);
        assert.equal(h.status(), 'Clip overlaps');
    });
});

// Phase 2 of the 2026-11-06 plan: narrow lanes with two-row heads, and the
// roll's selection gestures for clips — a marquee (Select mode or Shift),
// Shift-click, Delete, and Copy as a stamp that follows the pointer.
describe('track heads', () => {
    test('two rows of two squares: number and remove, then Mute and Solo', () => {
        const h = build({ tracks: [{ slot: 1 }] });
        const head = h.heads()[0];
        const kids = Array.from(head.children).map(k => k.className);
        assert.equal(kids.length, 4);
        assert.match(kids[0], /section-track-num/);
        assert.match(kids[1], /section-track-remove/);
        assert.match(kids[2], /section-track-mute/);
        assert.match(kids[3], /section-track-solo/);
        const num = head.children[0];
        assert.equal(num.children[0].textContent, '2', 'the voice slot, 1-based');
        assert.match(num.title, /2\. Bass/, 'the full name is in the tooltip');
        assert.ok(num.querySelector('.section-track-slot'), 'the voice picker sits under the number');
    });
});

describe('selecting and stamping clips', () => {
    const LANE_W = 60;
    /** The harness has no layout: rectangles from the lanes' order and the clips' style. */
    function layout(h) {
        h.lanes().forEach((lane, i) => {
            lane.getBoundingClientRect = () => ({ left: i * LANE_W, right: (i + 1) * LANE_W, top: 0, bottom: 5000 });
            for (const c of lane.querySelectorAll('.section-clip')) {
                const top = parseFloat(c.style.top), height = parseFloat(c.style.height);
                c.getBoundingClientRect = () => ({ left: i * LANE_W + 3, right: (i + 1) * LANE_W - 3, top, bottom: top + height });
            }
        });
        h.root.querySelector('.section-lanes').getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 5000 });
        h.root.querySelector('.section-grid').getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 5000 });
    }
    function three(clips) {
        const h = build({
            patterns: [{ name: 'A', measures: 1 }, { name: 'B', measures: 2 }],
            tracks: [{ slot: 0 }, { slot: 1 }, { slot: 2 }],
            clips,
        });
        layout(h);
        return h;
    }
    const key = (h, k, extra = {}) => h.doc('keydown', { key: k, target: { tagName: 'DIV' }, preventDefault() {}, ...extra });
    const pickedIds = (h) => Array.from(h.clips()).filter(c => c.classList.contains('picked')).map(c => c.dataset.clipId);
    const marquee = (h, from, to, extra = {}) => {
        layout(h);
        const lane = h.lanes()[0];
        lane.dispatch('mousedown', ev({ target: lane, ...from, ...extra }));
        h.doc('mousemove', ev(to));
        h.doc('mouseup', ev(to));
        lane.dispatch('click', { target: lane, clientX: to.clientX, clientY: to.clientY, stopPropagation() {} });
    };

    test('Shift-click adds and removes; a plain click selects one again', () => {
        const h = three([{ track: 0, pattern: 0, at: 0 }, { track: 1, pattern: 0, at: 2 }]);
        const [a, b] = h.section().clips.map(c => c.id);
        h.click(h.clips()[0]);
        h.clips()[1].dispatch('click', { shiftKey: true, stopPropagation() {} });
        assert.deepEqual(pickedIds(h).sort(), [a, b].sort());
        h.clips()[0].dispatch('click', { shiftKey: true, stopPropagation() {} });
        assert.deepEqual(pickedIds(h), [b]);
        h.click(h.clips()[0]);
        assert.deepEqual(pickedIds(h), [a]);
    });

    test('Delete removes the whole selection', () => {
        const h = three([{ track: 0, pattern: 0, at: 0 }, { track: 1, pattern: 0, at: 2 }, { track: 2, pattern: 0, at: 4 }]);
        h.click(h.clips()[0]);
        h.clips()[2].dispatch('click', { shiftKey: true, stopPropagation() {} });
        key(h, 'Delete');
        assert.deepEqual(h.section().clips.map(c => c.trackId), [h.project().tracks[1].id]);
    });

    test('in Select mode a drag over the lanes selects every clip it touches, and places nothing', () => {
        const h = three([
            { track: 0, pattern: 0, at: 0 },                    // bar 1, lane 1
            { track: 1, pattern: 1, at: 1 },                    // bars 2–3, lane 2
            { track: 2, pattern: 0, at: 6 },                    // bar 7, lane 3: outside
        ]);
        h.click(h.clips()[0]);                                  // a pattern is selected: a plain click would place it
        h.btn('section-select-mode').dispatch('click', ev());
        assert.ok(h.btn('section-select-mode').classList.contains('active'));
        const n = h.section().clips.length;
        // From the middle of bar 1 in lane 1 to a touch of bar 3 in lane 2.
        marquee(h, { clientX: 20, clientY: MEASURE_W / 2 }, { clientX: LANE_W + 10, clientY: 2 * MEASURE_W + 5 });
        assert.equal(h.section().clips.length, n, 'the click ending the marquee placed nothing');
        const ids = h.section().clips.map(c => c.id);
        assert.deepEqual(pickedIds(h).sort(), [ids[0], ids[1]].sort());
        assert.match(h.status(), /2 clips selected/);
    });

    test('Shift-drag does it without the mode, and adds to the selection', () => {
        const h = three([{ track: 0, pattern: 0, at: 0 }, { track: 2, pattern: 0, at: 4 }]);
        const ids = h.section().clips.map(c => c.id);
        h.click(h.clips()[1]);
        marquee(h, { clientX: 5, clientY: 5 }, { clientX: 10, clientY: 10 }, { shiftKey: true });
        assert.deepEqual(pickedIds(h).sort(), [...ids].sort());
    });

    test('without the mode or Shift, a press on a lane is still a placement', () => {
        const h = three([{ track: 0, pattern: 0, at: 0 }]);
        h.click(h.clips()[0]);
        marquee(h, { clientX: 70, clientY: 3 * MEASURE_W + 2 }, { clientX: 72, clientY: 3 * MEASURE_W + 2 });
        assert.equal(h.section().clips.length, 2);
    });

    test('Copy arms a stamp whose shadow follows the pointer; a press places the block there', () => {
        const h = three([{ track: 0, pattern: 0, at: 0 }, { track: 1, pattern: 1, at: 1 }]);
        h.click(h.clips()[0]);
        h.clips()[1].dispatch('click', { shiftKey: true, stopPropagation() {} });
        assert.equal(h.btn('section-copy').disabled, false);
        h.btn('section-copy').dispatch('click', ev());
        assert.ok(h.btn('section-copy').classList.contains('active'), 'lit while armed');
        layout(h);

        // Over lane 2, bar 5: the block's first lane lands there.
        const at = { clientX: LANE_W + 10, clientY: 4 * MEASURE_W + 5 };
        h.doc('mousemove', ev(at));
        const ghosts = h.root.querySelectorAll('.section-stamp-ghost');
        assert.equal(ghosts.length, 2);
        assert.equal(ghosts[0].parentNode, h.lanes()[1]);
        assert.equal(ghosts[0].style.top, (4 * MEASURE_W) + 'px');
        assert.equal(ghosts[1].parentNode, h.lanes()[2], 'the second clip keeps its lane offset');
        assert.equal(ghosts[1].style.top, (5 * MEASURE_W) + 'px', 'and its time offset');

        h.lanes()[1].dispatch('mousedown', ev({ target: h.lanes()[1], ...at }));
        const t = h.project().tracks.map(x => x.id);
        const copies = h.section().clips.slice(2);
        assert.deepEqual(copies.map(c => [t.indexOf(c.trackId), c.startCol, c.patternId]),
            [[1, 4 * COLS, h.patterns[0].id], [2, 5 * COLS, h.patterns[1].id]]);
        assert.deepEqual(pickedIds(h).sort(), copies.map(c => c.id).sort(), 'the copies are the selection');
        assert.equal(h.root.querySelectorAll('.section-stamp-ghost').length, 0, 'the stamp is spent');
        assert.equal(h.btn('section-copy').classList.contains('active'), false);
    });

    test('the block never hangs off the last track', () => {
        const h = three([{ track: 0, pattern: 0, at: 0 }, { track: 1, pattern: 0, at: 0 }]);
        h.click(h.clips()[0]);
        h.clips()[1].dispatch('click', { shiftKey: true, stopPropagation() {} });
        key(h, 'c', { ctrlKey: true });
        layout(h);
        const at = { clientX: 2 * LANE_W + 10, clientY: 3 * MEASURE_W + 5 };   // over the last lane
        h.lanes()[2].dispatch('mousedown', ev({ target: h.lanes()[2], ...at }));
        const t = h.project().tracks.map(x => x.id);
        assert.deepEqual(h.section().clips.slice(2).map(c => t.indexOf(c.trackId)), [1, 2], 'pulled back one lane');
    });

    test('a copy that would overlap is refused whole, and the stamp stays armed', () => {
        const h = three([{ track: 0, pattern: 0, at: 0 }, { track: 1, pattern: 0, at: 0 }, { track: 1, pattern: 0, at: 4 }]);
        h.click(h.clips()[0]);
        h.clips()[1].dispatch('click', { shiftKey: true, stopPropagation() {} });
        h.btn('section-copy').dispatch('click', ev());
        layout(h);
        const at = { clientX: 10, clientY: 4 * MEASURE_W + 5 };   // lane 1 is free at bar 5, lane 2 is not
        h.lanes()[0].dispatch('mousedown', ev({ target: h.lanes()[0], ...at }));
        assert.equal(h.section().clips.length, 3, 'not even the copy that fitted');
        assert.match(h.status(), /overlap/);
        assert.ok(h.btn('section-copy').classList.contains('active'));
    });

    test('Escape cancels the stamp, then drops the selection', () => {
        const h = three([{ track: 0, pattern: 0, at: 0 }]);
        h.click(h.clips()[0]);
        h.btn('section-copy').dispatch('click', ev());
        key(h, 'Escape');
        assert.equal(h.btn('section-copy').classList.contains('active'), false);
        assert.equal(pickedIds(h).length, 1, 'the clip is still selected');
        key(h, 'Escape');
        assert.equal(pickedIds(h).length, 0);
        assert.equal(Array.from(h.clips()).filter(c => c.classList.contains('selected')).length, 0);
        assert.equal(h.btn('section-copy').disabled, true, 'nothing to copy');
    });
});

describe('one selection on screen: clips here, or notes in the roll', () => {
    test('selecting a clip deselects the roll\'s notes, and selecting notes deselects the clips', async () => {
        const { createPianoroll } = await import('../html/components/pianoroll.js');
        const h = build({ patterns: [{ name: 'A', notes: [{ midi: 60, start: 0, dur: 1 }] }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
        const roll = createPianoroll({
            session, playNoteFn: () => {}, onNotesChange: () => {}, activeSlot: 0,
            tickWorker: { postMessage() {}, addEventListener() {} }, startWorker: () => {}, stopWorker: () => {},
            getSlotData: () => null,
        });
        roll.openClip(h.section().clips[0].id);
        roll.selectNotes(roll.getNotes().filter(n => n.midi === 60));
        assert.equal(roll.getSelectedNotes().length, 1);

        h.click(h.clips()[0]);
        assert.equal(roll.getSelectedNotes().length, 0, 'the clip took the selection');
        assert.equal(Array.from(h.clips()).filter(c => c.classList.contains('selected')).length, 1);

        roll.selectNotes(roll.getNotes().filter(n => n.midi === 60));
        assert.equal(roll.getSelectedNotes().length, 1);
        assert.equal(Array.from(h.clips()).filter(c => c.classList.contains('selected')).length, 0, 'and the notes took it back');
        h.doc('keydown', { key: 'Delete', target: { tagName: 'DIV' }, preventDefault() {} });
        assert.equal(h.section().clips.length, 1, 'so Delete is the roll\'s alone');
        roll.destroy && roll.destroy();
    });
});

describe('the pattern library', () => {
    const lib = (h) => h.root.querySelectorAll('.section-library-item');
    test('lists every pattern with its use count, and folds away (remembered)', () => {
        const h = build({ patterns: [{ name: 'B' }, { name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }, { track: 0, pattern: 0, at: 2 }] });
        const items = Array.from(lib(h));
        assert.deepEqual(items.map(i => i.querySelector('.section-library-name').textContent), ['A', 'B'], 'by name');
        assert.deepEqual(items.map(i => i.querySelector('.section-library-uses').textContent), ['—', '×2']);
        h.btn('section-library-head').dispatch('click', ev());
        assert.equal(lib(h).length, 0);
        assert.equal(localStorage.getItem('openpatches_section_library'), '1');
        h.btn('section-library-head').dispatch('click', ev());
        assert.equal(lib(h).length, 2);
    });

    test('a tap selects the pattern; a lane click then places it', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }] });
        lib(h)[0].dispatch('mousedown', ev({ clientX: 5, clientY: 5 }));
        h.doc('mouseup', ev({ clientX: 5, clientY: 5 }));
        assert.ok(lib(h)[0].classList.contains('selected'));
        h.click(h.lanes()[0], 2 * MEASURE_W + 3);
        assert.deepEqual(h.section().clips.map(c => c.startCol), [2 * COLS]);
    });

    test('dragged onto a lane, it is placed in the snap cell under the pointer', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }, { slot: 1 }] });
        h.lanes().forEach((lane, i) => { lane.getBoundingClientRect = () => ({ left: i * 60, right: (i + 1) * 60, top: 0, bottom: 5000 }); });
        h.root.querySelector('.section-grid').getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 5000 });
        lib(h)[0].dispatch('mousedown', ev({ clientX: 5, clientY: 900 }));
        h.doc('mousemove', ev({ clientX: 70, clientY: 3 * MEASURE_W + MEASURE_W / 2 + 2 }));
        assert.ok(document.body.querySelector('.section-library-ghost'), 'a ghost follows the pointer');
        h.doc('mouseup', ev({ clientX: 70, clientY: 3 * MEASURE_W + MEASURE_W / 2 + 2 }));
        const c = h.section().clips[0];
        assert.equal(c.trackId, h.project().tracks[1].id);
        assert.equal(c.startCol, 3 * COLS + COLS / 2, 'half-bar snap: bar 4, beat 3');
        assert.equal(document.body.querySelector('.section-library-ghost'), null);
    });

    test('dropped outside the grid, nothing is placed', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }] });
        h.lanes()[0].getBoundingClientRect = () => ({ left: 0, right: 60, top: 0, bottom: 5000 });
        h.root.querySelector('.section-grid').getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 400 });
        lib(h)[0].dispatch('mousedown', ev({ clientX: 5, clientY: 900 }));
        h.doc('mousemove', ev({ clientX: 10, clientY: 800 }));
        h.doc('mouseup', ev({ clientX: 10, clientY: 800 }));
        assert.equal(h.section().clips.length, 0);
    });
});
