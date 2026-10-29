// The song editor: tracks × measures, clips placed from a pattern palette,
// everything autosaved through the session. The model (song-model.js)
// decides what is legal; this is about the UI reaching it correctly and
// reporting refusals instead of swallowing them.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createSongEditor, createSongSession, M, MEASURE_W, env;

before(async () => {
    env = installBrowserEnv();
    ({ createSongEditor, MEASURE_W } = await import('../html/components/song-editor.js'));
    ({ createSongSession } = await import('../html/components/song-session.js'));
    M = await import('../html/components/song-model.js');
});

beforeEach(() => {
    localStorage.clear();
    globalThis.confirm = () => true;
});

const BANK = [
    { name: 'Piano', color: '#aaa001', voiceData: 'p' },
    { name: 'Bass', color: '#bbb002', voiceData: 'b' },
];
const getPattern = (id) => M.patternStore.get(id);

function build({ patterns = [], tracks = [], clips = [] } = {}) {
    const session = createSongSession();
    session.init();
    const made = patterns.map(p => M.patternStore.create(p));
    if (tracks.length || clips.length) {
        session.update((song) => {
            song.tracks.push(...tracks.map(t => M.createTrack(t)));
            for (const c of clips) {
                M.addClip(song, {
                    trackId: song.tracks[c.track].id,
                    patternId: made[c.pattern].id,
                    startMeasure: c.at, repeats: c.repeats || 1,
                }, getPattern);
            }
        }, 'test');
    }
    const logs = [];
    const opened = [];
    const editor = createSongEditor({
        session, log: (m) => logs.push(m),
        getSlotData: (slot) => BANK[slot] || null,
        onOpenPattern: (clipId, trackId, patternId) => opened.push({ clipId, trackId, patternId }),
    });
    const root = editor.element;
    const h = {
        editor, session, logs, opened, root, patterns: made,
        song: () => session.get(),
        status: () => root.querySelector('.song-status').textContent,
        lanes: () => root.querySelectorAll('.song-lane'),
        clips: () => root.querySelectorAll('.song-clip'),
        items: () => root.querySelectorAll('.song-pattern-item'),
        btn: (cls) => root.querySelector('.' + cls),
        click: (el, x = 0) => el.dispatch('click', { target: el, clientX: x, clientY: 0, stopPropagation() {} }),
        doc: (type, e) => (env.document._listeners[type] || []).slice().forEach(fn => fn(e)),
    };
    return h;
}

const ev = (extra = {}) => ({ preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0, cancelable: true, ...extra });

describe('rendering', () => {
    test('one row per track, one block per clip, sized by pattern length × repeats', () => {
        const h = build({
            patterns: [{ name: 'A', measures: 2 }],
            tracks: [{ slot: 0 }, { slot: 1 }],
            clips: [{ track: 0, pattern: 0, at: 1, repeats: 2 }, { track: 1, pattern: 0, at: 0 }],
        });
        assert.equal(h.lanes().length, 2);
        const clips = h.clips();
        assert.equal(clips.length, 2);
        assert.equal(clips[0].style.left, (1 * MEASURE_W) + 'px');
        assert.equal(clips[0].style.width, (4 * MEASURE_W - 2) + 'px');
        assert.equal(clips[0].querySelector('.song-clip-label').textContent, 'A ×2');
        assert.equal(clips[1].querySelector('.song-clip-label').textContent, 'A');
        assert.equal(clips[1].style.background, '#bbb002', 'coloured by the track\'s voice');
    });

    test('the palette lists every stored pattern with its length', () => {
        const h = build({ patterns: [{ name: 'Zed', measures: 1 }, { name: 'Alpha', measures: 3 }] });
        const items = h.items();
        assert.deepEqual(items.map(i => i.querySelector('.song-pattern-name').textContent), ['Alpha', 'Zed']);
        assert.deepEqual(items.map(i => i.querySelector('.song-pattern-len').textContent), ['3 bars', '1 bar']);
    });

    test('a clip whose pattern is gone is skipped, not fatal', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
        M.patternStore.remove(h.patterns[0].id);
        h.editor.render();
        assert.equal(h.clips().length, 0);
        assert.equal(h.lanes().length, 1);
    });

    test('track heads show the voice names and the bound slot', () => {
        const h = build({ tracks: [{ slot: 1 }] });
        const sel = h.root.querySelector('.song-track-slot');
        assert.equal(sel.value, '1');
        assert.deepEqual(sel.children.slice(0, 2).map(o => o.textContent), ['1. Piano', '2. Bass']);
    });
});

describe('placing clips', () => {
    test('click a lane with a pattern selected → a clip at that measure', () => {
        const h = build({ patterns: [{ name: 'A', measures: 2 }], tracks: [{ slot: 0 }] });
        h.click(h.items()[0]);
        assert.equal(h.editor.getSelectedPatternId(), h.patterns[0].id);
        h.click(h.lanes()[0], 3 * MEASURE_W + 5);
        const song = h.song();
        assert.equal(song.clips.length, 1);
        assert.equal(song.clips[0].startMeasure, 3);
        assert.equal(song.clips[0].patternId, h.patterns[0].id);
        assert.equal(M.songStore.get(song.id).clips.length, 1, 'autosaved');
        assert.equal(h.editor.getSelectedClipId(), song.clips[0].id, 'the new clip is selected');
    });

    test('without a selected pattern the click explains itself', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }] });
        h.click(h.lanes()[0], 10);
        assert.equal(h.song().clips.length, 0);
        assert.match(h.status(), /Select a pattern/);
    });

    test('an overlap is refused and reported, nothing changes', () => {
        const h = build({
            patterns: [{ name: 'A', measures: 2 }], tracks: [{ slot: 0 }],
            clips: [{ track: 0, pattern: 0, at: 0, repeats: 2 }],          // [0,4)
        });
        h.click(h.items()[0]);
        h.click(h.lanes()[0], 2 * MEASURE_W + 5);
        assert.equal(h.song().clips.length, 1);
        assert.equal(h.status(), 'Clip overlaps');
        assert.ok(h.logs.some(l => /Clip overlaps/.test(l)));
    });

    test('the same pattern can be placed on two tracks at the same bar', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }, { slot: 1 }] });
        h.click(h.items()[0]);
        h.click(h.lanes()[0], 5);
        h.click(h.lanes()[1], 5);
        assert.equal(h.song().clips.length, 2);
    });
});

describe('moving and repeating clips', () => {
    function one(extraClips = []) {
        return build({
            patterns: [{ name: 'A', measures: 2 }], tracks: [{ slot: 0 }],
            clips: [{ track: 0, pattern: 0, at: 0 }, ...extraClips],
        });
    }

    test('drag moves by whole measures', () => {
        const h = one();
        const clip = h.clips()[0];
        clip.dispatch('mousedown', ev({ clientX: 10 }));
        h.doc('mousemove', ev({ clientX: 10 + 3 * MEASURE_W }));
        h.doc('mouseup', ev({ clientX: 10 + 3 * MEASURE_W }));
        assert.equal(h.song().clips[0].startMeasure, 3);
    });

    test('a jitter under the threshold is a click, not a move', () => {
        const h = one();
        const clip = h.clips()[0];
        clip.dispatch('mousedown', ev({ clientX: 10 }));
        h.doc('mousemove', ev({ clientX: 12 }));
        h.doc('mouseup', ev({ clientX: 12 }));
        assert.equal(h.song().clips[0].startMeasure, 0);
        // Nothing happened, so nothing was redrawn: the same element is
        // still there, and the click that follows selects it as usual.
        assert.equal(h.clips()[0], clip, 'no re-render for a wobble');
        h.click(clip);
        assert.equal(h.editor.getSelectedClipId(), h.song().clips[0].id);
    });

    test('a move onto a neighbour snaps back and says why', () => {
        const h = one([{ track: 0, pattern: 0, at: 3 }]);              // [3,5)
        const clip = h.clips()[0];                                     // [0,2)
        clip.dispatch('mousedown', ev({ clientX: 0 }));
        h.doc('mousemove', ev({ clientX: 2 * MEASURE_W }));
        h.doc('mouseup', ev({ clientX: 2 * MEASURE_W }));             // → [2,4) overlaps
        assert.equal(h.song().clips[0].startMeasure, 0);
        assert.equal(h.status(), 'Clip overlaps');
        assert.equal(h.clips()[0].style.left, '0px', 're-rendered in place');
    });

    test('cannot be dragged before measure 0', () => {
        const h = one();
        const clip = h.clips()[0];
        clip.dispatch('mousedown', ev({ clientX: 200 }));
        h.doc('mousemove', ev({ clientX: 0 }));
        h.doc('mouseup', ev({ clientX: 0 }));
        assert.equal(h.song().clips[0].startMeasure, 0);
    });

    test('dragging the handle sets repeats in pattern-length steps', () => {
        const h = one();
        const handle = h.clips()[0].querySelector('.song-clip-handle');
        handle.dispatch('mousedown', ev({ clientX: 2 * MEASURE_W }));
        h.doc('mousemove', ev({ clientX: 2 * MEASURE_W + 4 * MEASURE_W }));
        h.doc('mouseup', ev({ clientX: 2 * MEASURE_W + 4 * MEASURE_W }));
        assert.equal(h.song().clips[0].repeats, 3, '2 bars + 4 bars = 6 = 3 × 2');
        assert.equal(h.clips()[0].querySelector('.song-clip-label').textContent, 'A ×3');
    });

    test('shrinking below one repeat stops at one', () => {
        const h = one();
        const handle = h.clips()[0].querySelector('.song-clip-handle');
        handle.dispatch('mousedown', ev({ clientX: 100 }));
        h.doc('mousemove', ev({ clientX: -500 }));
        h.doc('mouseup', ev({ clientX: -500 }));
        assert.equal(h.song().clips[0].repeats, 1);
    });

    test('touchcancel abandons the drag', () => {
        const h = one();
        const clip = h.clips()[0];
        clip.dispatch('touchstart', ev({ touches: [{ clientX: 0, clientY: 0 }] }));
        h.doc('touchmove', ev({ touches: [{ clientX: 3 * MEASURE_W, clientY: 0 }] }));
        h.doc('touchcancel', ev({}));
        assert.equal(h.song().clips[0].startMeasure, 0);
        assert.equal(h.clips()[0].style.left, '0px');
    });
});

describe('selecting, opening and removing clips', () => {
    function one() {
        return build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
    }

    test('click selects the clip and its pattern; Delete removes it', () => {
        const h = one();
        h.click(h.clips()[0]);
        const id = h.song().clips[0].id;
        assert.equal(h.editor.getSelectedClipId(), id);
        assert.equal(h.editor.getSelectedPatternId(), h.patterns[0].id);
        assert.ok(h.clips()[0].classList.contains('selected'));
        h.doc('keydown', { key: 'Delete', target: { tagName: 'DIV' }, preventDefault() {} });
        assert.equal(h.song().clips.length, 0);
        assert.equal(h.editor.getSelectedClipId(), null);
    });

    test('Delete while typing in a field does nothing to the clip', () => {
        const h = one();
        h.click(h.clips()[0]);
        h.doc('keydown', { key: 'Backspace', target: { tagName: 'INPUT' }, preventDefault() {} });
        assert.equal(h.song().clips.length, 1);
    });

    test('the Remove button does it without a keyboard', () => {
        const h = one();
        h.click(h.clips()[0]);
        h.btn('song-clip-remove').dispatch('click', ev());
        assert.equal(h.song().clips.length, 0);
    });

    test('double-click (or the Open button) hands the clip to the piano roll', () => {
        const h = one();
        const clip = h.clips()[0];
        clip.dispatch('dblclick', ev());
        const c = h.song().clips[0];
        assert.deepEqual(h.opened, [{ clipId: c.id, trackId: h.song().tracks[0].id, patternId: h.patterns[0].id }]);
        h.click(h.clips()[0]);
        h.btn('song-clip-open').dispatch('click', ev());
        assert.equal(h.opened.length, 2);
    });
});

describe('tracks', () => {
    test('+ Track binds the first free voice; all eight used is refused', () => {
        const h = build({ tracks: [{ slot: 0 }, { slot: 1 }] });
        h.btn('song-add-track').dispatch('click', ev());
        assert.deepEqual(h.song().tracks.map(t => t.slot), [0, 1, 2]);
        for (let i = 0; i < 6; i++) h.btn('song-add-track').dispatch('click', ev());
        assert.equal(h.song().tracks.length, 8);
        assert.match(h.status(), /All 8 voices/);
    });

    test('changing the slot rebinds the track', () => {
        const h = build({ tracks: [{ slot: 0 }] });
        const sel = h.root.querySelector('.song-track-slot');
        sel.value = '5';
        sel.dispatch('change');
        assert.equal(h.song().tracks[0].slot, 5);
    });

    test('mute and solo toggle and are what the sequencer reads', async () => {
        const { audibleTrackIds } = await import('../html/synth/sequencer.js');
        const h = build({ tracks: [{ slot: 0 }, { slot: 1 }] });
        h.root.querySelectorAll('.song-track-mute')[0].dispatch('click', ev());
        assert.equal(h.song().tracks[0].mute, true);
        assert.ok(h.root.querySelectorAll('.song-track-mute')[0].classList.contains('active'));
        assert.deepEqual([...audibleTrackIds(h.song().tracks)], [h.song().tracks[1].id]);
        h.root.querySelectorAll('.song-track-solo')[0].dispatch('click', ev());
        assert.deepEqual([...audibleTrackIds(h.song().tracks)], [h.song().tracks[0].id], 'solo beats mute');
    });

    test('removing a track takes its clips, after a confirm when it has any', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
        let asked = 0;
        globalThis.confirm = () => { asked++; return false; };
        h.btn('song-track-remove').dispatch('click', ev());
        assert.equal(asked, 1);
        assert.equal(h.song().tracks.length, 1, 'declined');
        globalThis.confirm = () => true;
        h.btn('song-track-remove').dispatch('click', ev());
        assert.deepEqual(h.song().tracks, []);
        assert.deepEqual(h.song().clips, []);
    });
});

describe('palette', () => {
    test('+ creates a pattern and selects it', () => {
        const h = build();
        h.btn('song-pattern-new').dispatch('click', ev());
        assert.equal(M.patternStore.list().length, 1);
        assert.equal(h.editor.getSelectedPatternId(), M.patternStore.list()[0].id);
    });

    test('duplicate copies the notes under a new id', () => {
        const h = build({ patterns: [{ name: 'A', notes: [{ midi: 60, start: 0, dur: 1 }] }] });
        h.btn('song-pattern-dup').dispatch('click', ev());
        const all = M.patternStore.list();
        assert.equal(all.length, 2);
        const copy = all.find(p => p.name === 'A copy');
        assert.deepEqual(copy.notes, [{ midi: 60, start: 0, dur: 1 }]);
        assert.notEqual(copy.id, h.patterns[0].id);
    });

    test('rename in place', () => {
        const h = build({ patterns: [{ name: 'A' }] });
        const nameEl = h.items()[0].querySelector('.song-pattern-name');
        nameEl.dispatch('dblclick', ev());
        nameEl.textContent = 'Bassline';
        nameEl.dispatch('blur');
        assert.equal(M.patternStore.get(h.patterns[0].id).name, 'Bassline');
    });

    test('delete is refused while the pattern is placed anywhere', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
        h.btn('song-pattern-del').dispatch('click', ev());
        assert.ok(M.patternStore.get(h.patterns[0].id), 'still there');
        assert.match(h.status(), /placed in 1 song/);
        h.click(h.clips()[0]);
        h.btn('song-clip-remove').dispatch('click', ev());
        h.btn('song-pattern-del').dispatch('click', ev());
        assert.equal(M.patternStore.get(h.patterns[0].id), null);
    });
});

describe('song toolbar', () => {
    test('rename, tempo and loop range write through to the song', () => {
        const h = build({ patterns: [{ name: 'A', measures: 2 }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0, repeats: 2 }] });
        const name = h.btn('song-name');
        name.value = ' My song ';
        name.dispatch('change');
        assert.equal(h.song().name, 'My song');

        const bpm = h.btn('song-bpm');
        bpm.value = '9999';
        bpm.dispatch('change');
        assert.equal(h.song().bpm, M.MAX_BPM, 'clamped');

        h.btn('song-loop-on').checked = true;
        h.btn('song-loop-start').value = '2';
        h.btn('song-loop-end').value = '3';
        h.btn('song-loop-end').dispatch('change');
        assert.deepEqual(h.song().loop, { start: 1, end: 3 }, '1-based inclusive bars → 0-based half-open');
        assert.ok(h.root.querySelector('.song-loop-band'), 'shown on the ruler');

        h.btn('song-loop-on').checked = false;
        h.btn('song-loop-on').dispatch('change');
        assert.equal(h.song().loop, null);
    });

    test('a backwards loop range is refused with a message', () => {
        const h = build();
        h.btn('song-loop-on').checked = true;
        h.btn('song-loop-start').value = '4';
        h.btn('song-loop-end').value = '2';
        h.btn('song-loop-end').dispatch('change');
        assert.equal(h.song().loop, null);
        assert.match(h.status(), /later/);
    });

    test('new song, switch song, delete song', () => {
        const h = build({ tracks: [{ slot: 0 }] });
        const first = h.song().id;
        h.btn('song-btn').dispatch('click', ev());                  // the first .song-btn is "+ Song"
        assert.notEqual(h.song().id, first);
        assert.deepEqual(h.song().tracks, [], 'empty');

        const sel = h.btn('song-select');
        assert.equal(sel.children.length, 2);
        sel.value = first;
        sel.dispatch('change');
        assert.equal(h.song().id, first);
        assert.equal(h.song().tracks.length, 1);

        h.btn('song-delete').dispatch('click', ev());
        assert.notEqual(h.song().id, first);
        assert.equal(h.session.list().length, 1);
    });
});

describe('it follows the session', () => {
    test('a track added elsewhere (the roll drawing a note) appears', () => {
        const h = build();
        assert.equal(h.lanes().length, 0);
        h.session.update((song) => { song.tracks.push(M.createTrack({ slot: 3 })); }, 'roll');
        assert.equal(h.lanes().length, 1);
    });

    test('a pattern lengthened elsewhere widens its clips', () => {
        const h = build({ patterns: [{ name: 'A', measures: 1 }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
        assert.equal(h.clips()[0].style.width, (MEASURE_W - 2) + 'px');
        M.patternStore.put({ ...h.patterns[0], measures: 3 });
        h.session.notifyPattern(h.patterns[0].id, 'roll');
        assert.equal(h.clips()[0].style.width, (3 * MEASURE_W - 2) + 'px');
    });

    test('destroy unhooks the keyboard and the session', () => {
        const h = build({ patterns: [{ name: 'A' }], tracks: [{ slot: 0 }], clips: [{ track: 0, pattern: 0, at: 0 }] });
        h.click(h.clips()[0]);
        h.editor.destroy();
        h.doc('keydown', { key: 'Delete', target: { tagName: 'DIV' }, preventDefault() {} });
        assert.equal(h.song().clips.length, 1);
    });
});

describe('playhead (phase 5)', () => {
    async function withTransport() {
        const { createTransport } = await import('../html/synth/transport.js');
        const session = createSongSession();
        session.init();
        const pattern = M.patternStore.create({ name: 'A', measures: 2, notes: [{ midi: 60, start: 0, dur: 1 }] });
        let clipId = null;
        session.update((song) => {
            const t = M.createTrack({ slot: 0 });
            song.tracks.push(t);
            clipId = M.addClip(song, { trackId: t.id, patternId: pattern.id, startMeasure: 0, repeats: 2 }, getPattern).id;
        }, 'test');
        const handlers = [];
        const tickWorker = {
            postMessage() {}, addEventListener(t, fn) { if (t === 'message') handlers.push(fn); },
            tick(col) { for (const fn of handlers) fn({ data: { type: 'tick', col } }); },
        };
        const transport = createTransport({
            session, tickWorker, startWorker: () => {}, stopWorker: () => {},
            playNote: () => {}, getSlotData: () => null,
            getPattern: (id) => M.patternStore.get(id),
            getEditTarget: () => ({ trackId: session.get().tracks[0].id, clipId, pattern, slot: 0 }),
        });
        const editor = createSongEditor({ session, transport, getSlotData: (s) => BANK[s] || null });
        return { editor, transport, tickWorker, session, root: editor.element };
    }

    test('hidden at rest, follows the song column while playing', async () => {
        const h = await withTransport();
        const head = () => h.root.querySelector('.song-playhead');
        assert.equal(head().style.display, 'none');

        h.transport.play();
        h.tickWorker.tick(0);
        assert.equal(head().style.display, '');
        const left0 = parseFloat(head().style.left);
        h.tickWorker.tick(16);                       // one bar on
        assert.equal(parseFloat(head().style.left) - left0, MEASURE_W);

        h.transport.stop();
        assert.equal(head().style.display, 'none');
    });

    test('hidden in pattern mode — that loop is the roll\'s business', async () => {
        const h = await withTransport();
        h.transport.setMode('pattern');
        h.transport.play();
        h.tickWorker.tick(4);
        assert.equal(h.root.querySelector('.song-playhead').style.display, 'none');
    });

    test('it survives a re-render and does not rebuild the clips per tick', async () => {
        const h = await withTransport();
        h.transport.play();
        h.tickWorker.tick(0);
        const clipEl = h.root.querySelectorAll('.song-clip')[0];
        h.tickWorker.tick(4);
        assert.equal(h.root.querySelectorAll('.song-clip')[0], clipEl, 'a tick moves the line, nothing else');
        h.editor.render();
        assert.ok(h.root.querySelector('.song-playhead'), 'still there after a render');
    });
});
