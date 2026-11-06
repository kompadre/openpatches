// The transport bar: the one Play / Stop / Record / BPM, with a switch for
// what Play acts on. It replaced the Section toolbar's Play/Stop/BPM and the
// piano roll's, which wrote the same tempo from two boxes.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createTransportBar, createTransport, createToolbar, makeProjectSession, M;

before(async () => {
    installBrowserEnv();
    ({ createTransportBar } = await import('../html/components/transport-bar.js'));
    ({ createTransport } = await import('../html/synth/transport.js'));
    ({ createToolbar } = await import('../html/components/toolbar.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
    M = await import('../html/components/project-model.js');
});

beforeEach(() => localStorage.clear());

const ev = () => ({ stopPropagation() {}, preventDefault() {} });

function build({ onPlay, onStop } = {}) {
    const session = makeProjectSession();
    const pattern = session.createPattern({ name: 'A', measures: 1, notes: [{ midi: 60, start: 0, dur: 1 }] });
    let clipId = null;
    session.update((project, section) => {
        const t = M.createTrack({ slot: 0 });
        project.tracks.push(t);
        clipId = M.addClip(project, section, { trackId: t.id, patternId: pattern.id, startCol: 0 }).id;
    }, 'test');
    const transport = createTransport({
        session, tickWorker: { postMessage() {}, addEventListener() {} }, startWorker: () => {}, stopWorker: () => {},
        playNote: () => {}, getSlotData: () => null, getPattern: (id) => session.getPattern(id),
        getEditTarget: () => ({ trackId: session.get().tracks[0].id, clipId, pattern: session.getPattern(pattern.id), slot: 0 }),
    });
    const bar = createTransportBar({ transport, session, onPlay, onStop });
    const q = (cls) => bar.element.querySelector('.' + cls);
    return { bar, transport, session, q, play: () => q('transport-play'), stop: () => q('transport-stop') };
}

describe('Play and Stop', () => {
    test('drive the transport in the mode the switch shows', () => {
        const h = build();
        assert.equal(h.play().disabled, false);
        assert.equal(h.stop().disabled, true);

        h.play().dispatch('click', ev());
        assert.equal(h.transport.isPlaying(), true);
        assert.equal(h.transport.getMode(), 'section', 'section is the default');
        assert.equal(h.play().disabled, true);
        assert.ok(h.play().classList.contains('active'));
        assert.equal(h.stop().disabled, false);

        h.stop().dispatch('click', ev());
        assert.equal(h.transport.isPlaying(), false);
        assert.equal(h.play().disabled, false);
        assert.equal(h.stop().disabled, true);
    });

    test('the caller can take the presses — the toolbar routes them through the roll and the recorder', () => {
        const calls = [];
        const h = build({ onPlay: () => calls.push('play'), onStop: () => calls.push('stop') });
        h.play().dispatch('click', ev());
        h.stop().dispatch('click', ev());
        assert.deepEqual(calls, ['play', 'stop']);
        assert.equal(h.transport.isPlaying(), false, 'the default actions did not run as well');
    });

    test('Play is disabled while recording, since it would be a silent no-op', () => {
        const h = build();
        h.transport.startRecording();
        assert.equal(h.play().disabled, true);
        assert.equal(h.stop().disabled, false);
        h.transport.stop();
        assert.equal(h.play().disabled, false);
    });
});

describe('the mode switch', () => {
    test('offers the transport\'s modes, lights the current one, and sets it', () => {
        const h = build();
        const btns = Array.from(h.bar.element.querySelectorAll('.transport-mode'));
        assert.deepEqual(btns.map(b => b.dataset.mode), ['piece', 'section', 'pattern']);
        assert.deepEqual(btns.map(b => b.classList.contains('active')), [false, true, false]);

        btns[2].dispatch('click', ev());
        assert.equal(h.transport.getMode(), 'pattern');
        assert.deepEqual(btns.map(b => b.classList.contains('active')), [false, false, true]);

        h.play().dispatch('click', ev());
        assert.equal(h.transport.isPlaying(), true);
        assert.deepEqual(h.transport.getSequence().range, { startCol: 0, endCol: 16 }, 'the pattern window');
    });

    test('a mode set elsewhere is reflected', () => {
        const h = build();
        h.transport.setMode('pattern');
        const btns = Array.from(h.bar.element.querySelectorAll('.transport-mode'));
        assert.deepEqual(btns.map(b => b.classList.contains('active')), [false, false, true]);
    });
});

describe('BPM', () => {
    test('shows the project tempo and writes it through, clamped', () => {
        const h = build();
        const bpm = h.q('transport-bpm');
        assert.equal(bpm.value, String(h.session.get().bpm));

        bpm.value = '97';
        bpm.dispatch('change');
        assert.equal(h.session.get().bpm, 97);

        bpm.value = '9999';
        bpm.dispatch('change');
        assert.equal(h.session.get().bpm, M.MAX_BPM, 'clamped');
        assert.equal(bpm.value, String(M.MAX_BPM), 'and the box shows what was kept');
    });

    test('follows a tempo set elsewhere', () => {
        const h = build();
        h.session.update((p) => { p.bpm = 72; }, 'test');
        assert.equal(h.q('transport-bpm').value, '72');
    });
});

describe('in the dock', () => {
    function dock() {
        return createToolbar({
            session: makeProjectSession(),
            playNoteFn: () => Promise.resolve(() => {}),
            stopNoteFn: () => {},
            tickWorker: { postMessage() {}, addEventListener() {} },
            startWorker: () => {},
            stopWorker: () => {},
        });
    }

    test('sits in the top strip, before the tabs, and nowhere else', () => {
        const d = dock();
        const top = d.querySelector('.dock-top');
        assert.ok(top);
        assert.ok(top.children[0].classList.contains('transport-bar'));
        assert.ok(top.children[1].classList.contains('dock-tabs'));
        assert.equal(d.querySelectorAll('.transport-play').length, 1);
        assert.equal(d.querySelector('.pianoroll-play'), null, 'the roll\'s own Play is gone');
        assert.equal(d.querySelector('.section-play'), null, 'and the Section toolbar\'s');
        assert.equal(d.querySelectorAll('.transport-bpm').length, 1, 'one tempo box');
        assert.equal(d.querySelector('.section-bpm'), null);
        assert.equal(d.querySelector('.pianoroll-bpm'), null);
    });

    test('in pattern mode Play goes through the roll, which needs something to play', () => {
        const d = dock();
        const transport = d._pianoroll.getTransport();
        transport.setMode('pattern');
        d.querySelector('.transport-play').dispatch('click', ev());
        assert.equal(transport.isPlaying(), false, 'an empty roll stays stopped');
        d._pianoroll.addNote({ midi: 60, start: 0, dur: 1, slot: 0 });
        d.querySelector('.transport-play').dispatch('click', ev());
        assert.equal(transport.isPlaying(), true);
        assert.equal(transport.getMode(), 'pattern');
        d.querySelector('.transport-stop').dispatch('click', ev());
        assert.equal(transport.isPlaying(), false);
    });
});
