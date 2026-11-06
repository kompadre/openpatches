// Piece mode: the sections in order, the Section pane following the
// playhead, a tempo ramp handed to the worker tick by tick.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let createTransport, makeProjectSession, M;

before(async () => {
    installBrowserEnv();
    installMidiStub();
    ({ createTransport } = await import('../html/synth/transport.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
    M = await import('../html/components/project-model.js');
});

beforeEach(() => localStorage.clear());

function build() {
    const session = makeProjectSession({ bpm: 100 });
    const a = session.createPattern({ name: 'A', measures: 1, notes: [{ midi: 60, start: 0, dur: 1 }] }, 'test');
    const b = session.createPattern({ name: 'B', measures: 1, notes: [{ midi: 72, start: 0, dur: 1 }] }, 'test');
    let s2;
    session.update((p, s) => {
        const t = M.createTrack({ slot: 0 });
        p.tracks.push(t);
        M.addClip(p, s, { trackId: t.id, patternId: a.id, startCol: 0 });
        s2 = M.addSection(p, { name: 'Two' });
        M.addClip(p, s2, { trackId: t.id, patternId: b.id, startCol: 0 });
    }, 'test');
    const handlers = [];
    const tempos = [];
    const tickWorker = {
        started: [],
        postMessage() {},
        addEventListener(type, fn) { if (type === 'message') handlers.push(fn); },
        tick(col) { for (const fn of handlers) fn({ data: { type: 'tick', col } }); },
    };
    const played = [];
    const positions = [];
    const transport = createTransport({
        session, tickWorker,
        startWorker: (w, bpm, col) => w.started.push({ bpm, col }),
        stopWorker: () => {},
        tempoWorker: (w, bpm) => tempos.push(bpm),
        playNote: (midi) => played.push(midi),
        getSlotData: () => null,
        getPattern: (id) => session.getPattern(id),
        getEditTarget: () => null,
    });
    transport.subscribe(p => positions.push(p));
    return { session, transport, tickWorker, played, positions, tempos, s1: session.get().sections[0], s2 };
}

describe('piece mode', () => {
    test('plays the sections in order and the edited section follows the playhead', () => {
        const h = build();
        h.transport.setMode('piece');
        assert.equal(h.session.getSectionId(), h.s1.id);
        assert.equal(h.transport.play(), true);
        assert.deepEqual(h.transport.getSequence().range, { startCol: 0, endCol: 32 });
        h.tickWorker.tick(0);
        assert.deepEqual(h.played, [60]);
        assert.equal(h.positions.at(-1).sectionCol, 0);
        h.tickWorker.tick(16);
        assert.deepEqual(h.played, [60, 72], 'section two\'s note, at its own column 0');
        assert.equal(h.session.getSectionId(), h.s2.id, 'the pane followed');
        assert.equal(h.positions.at(-1).sectionCol, 0, 'the playhead on section two\'s own timeline');
        assert.equal(h.transport.getSectionColumn(), 0);
        h.tickWorker.tick(32);
        assert.equal(h.session.getSectionId(), h.s1.id, 'and wrapped back to the top');
        assert.deepEqual(h.played, [60, 72, 60]);
    });

    test('Record from piece mode records the section on screen', () => {
        const h = build();
        h.transport.setMode('piece');
        h.transport.startRecording();
        assert.equal(h.transport.getMode(), 'section');
        assert.equal(h.transport.isRecording(), true);
    });

    test('with nothing in any section there is nothing to play', () => {
        const h = build();
        h.session.update((p) => { for (const s of p.sections) s.clips.length = 0; }, 'test');
        h.transport.setMode('piece');
        assert.equal(h.transport.play(), false);
    });
});

describe('tempo ramps', () => {
    test('a section with an end tempo hands a new tempo to the worker as the playhead advances', () => {
        const h = build();
        h.session.update((p, s) => { s.bpmEnd = 130; }, 'test');             // section one: 100 → 130 over 16 columns
        h.transport.play();
        assert.equal(h.tickWorker.started[0].bpm, 100, 'starts at the start tempo');
        h.tickWorker.tick(0);
        assert.deepEqual(h.tempos, [], 'column 0 is the start tempo: nothing to send');
        h.tickWorker.tick(1);
        assert.equal(h.tempos.length, 1);
        assert.equal(h.tempos[0], 102, '100 + 30 × 1/15');
        h.tickWorker.tick(15);
        assert.equal(h.tempos.at(-1), 130, 'the last column is at the end tempo');
        assert.equal(h.transport.getBpm(), 130);
        assert.equal(h.positions.at(-1).bpm, 130, 'and the broadcast says so');
    });

    test('in piece mode each section ramps on its own; a section without an end tempo holds', () => {
        const h = build();
        h.session.update((p) => { p.sections[0].bpmEnd = 130; p.sections[1].bpm = 60; }, 'test');
        h.transport.setMode('piece');
        h.transport.play();
        h.tickWorker.tick(15);
        assert.equal(h.tempos.at(-1), 130);
        h.tickWorker.tick(16);
        assert.equal(h.tempos.at(-1), 60, 'section two: its own tempo, flat');
        h.tickWorker.tick(20);
        assert.equal(h.tempos.at(-1), 60, 'and nothing more to send while it holds');
        assert.equal(h.tempos.length, h.tempos.filter(t => t !== 60).length + 1);
    });
});
