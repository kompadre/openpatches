// One track, three faces.
//
// A Section lane, a Mixer strip and a piano-roll voice are not three
// things that have to be kept in step — they are three views of one
// `project.tracks` entry. This file is the guard on that: an operation
// performed through any one of them has to be visible through the others
// immediately, because there is only one record to change.
//
// It exists because the opposite was true until phase 3c, and the symptom
// was subtle: the section's track carried a `mute` that gated whether notes
// were *scheduled*, the voice bank entry carried a `muted` that gated the
// channel's *volume*, and neither surfaced the other. Muting in the Section
// tab left the Mixer looking unmuted, and vice versa.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let createToolbar, makeProjectSession, M, midi;

before(async () => {
    installBrowserEnv();
    installMidiStub();
    midi = await import('../html/synth/midi-manager.js');
    ({ createToolbar } = await import('../html/components/toolbar.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
    M = await import('../html/components/project-model.js');
});

beforeEach(() => {
    localStorage.clear();
    midi._reset();
    globalThis.confirm = () => true;
});

/** The whole dock, so all three editors are live over one project. */
function build() {
    const session = makeProjectSession();
    const dock = createToolbar({
        session,
        playNoteFn: () => Promise.resolve(() => {}),
        stopNoteFn: () => {},
        tickWorker: { postMessage() {}, addEventListener() {} },
        startWorker: () => {},
        stopWorker: () => {},
    });
    const bank = dock._voiceBank;
    bank._addEntry('Piano', 'piano-data', 'p1');
    bank._addEntry('Bass', 'bass-data', 'p2');
    return {
        session, dock, bank,
        editor: dock._sectionEditor,
        roll: dock._pianoroll,
        tracks: () => session.get().tracks,
        /** The Section editor's lane controls for the nth track. */
        lane: (n) => dock._sectionEditor.element.querySelectorAll('.section-track-head')[n],
    };
}

const click = (el) => el.dispatch('click', { stopPropagation() {}, preventDefault() {} });

describe('mute and solo are one flag', () => {
    test('muting a Mixer strip mutes the track the scheduler reads', () => {
        const h = build();
        h.bank._toggleMute(0);
        assert.equal(h.tracks()[0].mute, true);
        assert.deepEqual(
            [...M.audibleTracks(h.tracks()).map(t => t.slot)], [1],
            'and the sequencer agrees without being told',
        );
    });

    test('muting through the Section lane shows on the Mixer strip', () => {
        const h = build();
        h.session.update((project) => {
            project.tracks.find(t => t.slot === 0).mute = true;
        }, 'section-editor');

        const strip = h.bank._getEntries()[0];
        assert.equal(strip.muted, true, 'the strip is a view of the same record');
        assert.equal(strip.effectiveVolume, 0, 'and the engine hears it');
    });

    test('soloing on one side silences the other side too', () => {
        const h = build();
        h.bank._toggleSolo(1);
        assert.deepEqual(h.tracks().map(t => t.solo), [false, true]);
        assert.deepEqual(M.audibleTracks(h.tracks()).map(t => t.slot), [1]);
        assert.equal(h.bank._getEntries()[0].effectiveVolume, 0);
    });

    test('the roll plays what the one mute says', async () => {
        const { createSectionSequence } = await import('../html/synth/section-sequencer.js');
        const h = build();
        h.roll.addNote({ midi: 60, start: 0, dur: 1, slot: 0 });
        h.roll.addNote({ midi: 48, start: 0, dur: 1, slot: 1 });

        const seq = () => createSectionSequence(h.session.get(), h.session.getSection());
        assert.equal(seq().eventsAt(0).length, 2);

        h.bank._toggleMute(0);                 // muted from the Mixer…
        assert.deepEqual(seq().eventsAt(0).map(e => e.slot), [1], '…and the roll goes quiet');
    });
});

describe('a lane, a strip and a voice are the same track', () => {
    test('renaming through the Mixer renames the lane', () => {
        const h = build();
        h.bank._assignToSlot(0, { name: 'Rhodes', voiceData: 'rhodes-data', patchId: 'p9' });
        assert.equal(h.tracks().find(t => t.slot === 0).name, 'Rhodes');
    });

    test('a track the roll created becomes a strip when a voice lands on it', () => {
        const h = build();
        h.roll.setActiveSlot(4);
        h.roll.addNote({ midi: 72, start: 0, dur: 1, slot: 4 });
        assert.ok(h.tracks().some(t => t.slot === 4), 'the lane exists');
        assert.equal(h.bank._getEntries()[4], null, 'but has no voice, so no strip yet');

        h.bank._assignToSlot(4, { name: 'Lead', voiceData: 'lead-data', patchId: 'p4' });
        assert.equal(h.bank._getEntries()[4].name, 'Lead');
        assert.equal(h.tracks().filter(t => t.slot === 4).length, 1, 'filled in, not duplicated');
    });

    test('removing a track removes its strip and its clips', () => {
        const h = build();
        h.roll.addNote({ midi: 60, start: 0, dur: 1, slot: 0 });
        const id = h.tracks().find(t => t.slot === 0).id;

        h.session.update((project) => { M.removeTrack(project, id); }, 'section-editor');
        assert.equal(h.bank._getEntries()[0], null, 'the strip went with it');
        assert.equal(h.session.getSection().clips.some(c => c.trackId === id), false);
    });
});

describe('changing a lane\'s slot', () => {
    // The slot is the channel, the strip and the patch at once, so this is
    // "play this part on that instrument".

    test('an occupied slot swaps, rather than putting two tracks on one channel', () => {
        const h = build();
        const [a, b] = h.tracks();
        assert.deepEqual([a.name, b.name], ['Piano', 'Bass']);

        h.session.update((project) => { M.setTrackSlot(project, a.id, 1); }, 'section-editor');

        const bySlot = Object.fromEntries(h.tracks().map(t => [t.slot, t.name]));
        assert.deepEqual(bySlot, { 0: 'Bass', 1: 'Piano' }, 'they traded instruments');
        assert.equal(h.tracks().length, 2, 'and nobody was dropped');
    });

    test('a free slot just moves', () => {
        const h = build();
        const a = h.tracks()[0];
        h.session.update((project) => { M.setTrackSlot(project, a.id, 5); }, 'section-editor');
        assert.deepEqual(h.tracks().map(t => t.slot), [1, 5]);
    });

    test('the swap is visible on the Mixer, because the strips follow the slots', () => {
        const h = build();
        const a = h.tracks()[0];
        h.session.update((project) => { M.setTrackSlot(project, a.id, 1); }, 'section-editor');
        assert.deepEqual(
            h.bank._getEntries().slice(0, 2).map(e => e && e.name),
            ['Bass', 'Piano'],
        );
    });

    test('a collision would have cost a track and its clips — the regression this guards', () => {
        // What the lane's select used to do: assign the slot directly.
        const h = build();
        const [a] = h.tracks();
        h.session.update((project) => {
            project.tracks.find(t => t.id === a.id).slot = 1;   // the old, unguarded way
        }, 'section-editor');
        assert.equal(h.tracks().filter(t => t.slot === 1).length, 2, 'two voices on one channel');

        // …and the next load silently resolves it by dropping one.
        const reloaded = M.createProject(JSON.parse(JSON.stringify(h.session.get())));
        assert.equal(reloaded.tracks.length, 1, 'which is why setTrackSlot swaps instead');
    });
});
