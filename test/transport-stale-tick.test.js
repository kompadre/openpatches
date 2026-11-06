// Ticks that arrive long after they were due move the playhead but play
// nothing. An unfocused Chrome window (the download bubble after an export)
// can have its ticks held and delivered in one burst; sounding them all at
// once was a cacophonous cluster.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createPianoroll, makeProjectSession, seedPattern;

before(async () => {
    installBrowserEnv();
    ({ createPianoroll } = await import('../html/components/pianoroll.js'));
    ({ makeProjectSession, seedPattern } = await import('./project-fixture.js'));
});

function build() {
    const handlers = [];
    const tickWorker = {
        postMessage() {},
        addEventListener(type, fn) { if (type === 'message') handlers.push(fn); },
        tick(col, at) { for (const fn of handlers) fn({ data: { type: 'tick', col, at } }); },
    };
    const played = [];
    const session = makeProjectSession();
    seedPattern(session, { measures: 1, notes: [0, 1, 2, 3].map(start => ({ midi: 60, start, dur: 1, slot: 0 })) });
    const roll = createPianoroll({
        session, playNoteFn: (midi) => played.push(midi), onNotesChange: () => {},
        activeSlot: 0, tickWorker, startWorker: () => {}, stopWorker: () => {}, getSlotData: () => null,
    });
    return { roll, tickWorker, played };
}

test('a tick on time sounds its notes', () => {
    const { roll, tickWorker, played } = build();
    roll.startPlayback();
    tickWorker.tick(0, Date.now());
    tickWorker.tick(1);                       // no timestamp: treated as on time
    assert.equal(played.length, 2);
});

test('a stale tick is silent', () => {
    const { roll, tickWorker, played } = build();
    roll.startPlayback();
    const late = Date.now() - 5000;
    for (const col of [0, 1, 2]) tickWorker.tick(col, late);
    assert.equal(played.length, 0, 'the held-back burst must not play');
    tickWorker.tick(3, Date.now());
    assert.equal(played.length, 1, 'playback resumes with the next fresh tick');
});
