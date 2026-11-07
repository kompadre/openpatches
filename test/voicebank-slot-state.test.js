// The Mixer strips are a view of the project's **tracks** — one record per
// voice, so the strip's mute and the scheduler's mute cannot disagree.
//
// Regressions in voicebank.js:
//  - `entry.volume || DEFAULT_VOLUME` treated a muted slot (0) as unset, so a
//    silenced voice displayed 100 and its overlay was drawn full.
//  - Colors are a function of the slot index (AGENTS.md), but stale saved
//    state can carry another slot's color; it is recomputed on render.
//  - The slot index IS the synth channel, but removal used to splice the
//    array: every entry below shifted channel (tracks played the wrong
//    voice) and was recolored. Removal now leaves a hole.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

const PATCH_COLORS = ['#e94560', '#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4', '#ff5722', '#607d8b'];

let createVoiceBank, makeProjectSession, createTrack;
let session = null;

before(async () => {
    installBrowserEnv();
    ({ createVoiceBank } = await import('../html/components/voicebank.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
    ({ createTrack } = await import('../html/components/project-model.js'));
});

/** Strips are tracks: seed the project's band, not a bank blob. */
function seed(entries) {
    session = makeProjectSession();
    session.update((project) => {
        (entries || []).forEach((e, i) => {
            if (!e) return;
            project.tracks.push(createTrack({
                // The strip's id *is* the track's: selecting a strip and
                // selecting a track are the same act now.
                id: e.id, name: e.name, slot: i, patchId: e.patchId,
                voiceData: e.voiceData, volume: e.volume,
                mute: !!e.muted, solo: !!e.solo,
            }));
        });
    }, 'test');
    return session;
}

function entry(id, volume, color) {
    return { id, name: id, voiceData: id + '-data', patchId: id, color, volume };
}

function occupied(bank) {
    return bank._getEntries().filter(Boolean);
}

function volumeLabels(bank) {
    // The stub element stores textContent verbatim; a real DOM stringifies it.
    return bank.querySelectorAll('.voicebank-vol').map(el => String(el.textContent));
}

beforeEach(() => { localStorage.clear(); session = null; });

describe('voicebank volume', () => {
    test('volume 0 displays as 0, not the default', () => {
        seed([entry('a', 0), entry('b', 70)]);
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        assert.deepEqual(volumeLabels(bank), ['0', '70']);
    });

    test('a missing volume is still backfilled to the default', () => {
        seed([{ id: 'a', name: 'a', voiceData: 'a-data' }]);
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        assert.deepEqual(volumeLabels(bank), ['100']);
        assert.equal(bank._getEntries()[0].volume, 100);
    });

    test('a null volume is backfilled too', () => {
        seed([entry('a', null)]);
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        assert.deepEqual(volumeLabels(bank), ['100']);
    });
});

describe('voicebank slot colors', () => {
    test('colors follow the slot index on load, overriding stale saved ones', () => {
        seed([entry('a', 100, '#ffffff'), entry('b', 100, '#000000')]);
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        assert.deepEqual(occupied(bank).map(e => e.color), PATCH_COLORS.slice(0, 2));
    });
});

describe('the slot is the channel: entries never shift', () => {
    test('the bank is always a fixed array of 8 slots', () => {
        seed([entry('a', 100)]);
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        assert.equal(bank._getEntries().length, 8);
    });

    test('removing a slot leaves a hole; the others keep index, color and volume', () => {
        seed([entry('a', 100), entry('b', 70), entry('c', 50)]);
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        bank._removeEntry('b');
        const after = bank._getEntries();
        assert.equal(after[0].id, 'a');
        assert.equal(after[1], null);
        assert.equal(after[2].id, 'c');
        assert.equal(after[2].color, PATCH_COLORS[2]);
        assert.equal(after[2].volume, 50);
    });

    test('the hole survives a save/load round trip', () => {
        seed([entry('a', 100), entry('b', 70), entry('c', 50)]);
        createVoiceBank({ session: session || makeProjectSession() })._removeEntry('b');
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        const after = bank._getEntries();
        assert.equal(after[1], null);
        assert.equal(after[2].id, 'c');
    });

    test('removing the active entry selects the first remaining one', () => {
        seed([entry('a', 100), entry('b', 100)]);
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        bank._removeEntry('a');
        assert.equal(bank._getActive().id, 'b');
    });
});

describe('one voice, one slot', () => {
    test('assignToSlot writes to the exact slot asked for', () => {
        localStorage.clear();
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        assert.ok(bank._assignToSlot(3, { name: 'Piano', voiceData: 'piano-data', patchId: 'p1' }));
        const e = bank._getEntries();
        assert.equal(e[0], null);
        assert.equal(e[3].name, 'Piano');
        assert.equal(e[3].color, PATCH_COLORS[3]);
    });

    test('assigning the same bytes to another slot is a second strip, not a move', () => {
        // It used to move: the old slot emptied and every clip on that track
        // fell silent. Two tracks of one voice — say one dry and one through
        // the delay — are a thing to want.
        localStorage.clear();
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        bank._assignToSlot(0, { name: 'Piano', voiceData: 'piano-data', patchId: 'p1' });
        bank._getEntries()[0].volume = 42;
        bank._assignToSlot(5, { name: 'Piano', voiceData: 'piano-data', patchId: 'p1' });
        const e = bank._getEntries();
        assert.equal(e[0].name, 'Piano', 'the old slot keeps its strip');
        assert.equal(e[0].volume, 42, '…and its settings');
        assert.equal(e[5].name, 'Piano');
        assert.equal(e[5].volume, 100, 'the new strip starts fresh');
        assert.equal(occupied(bank).length, 2);
        assert.equal(bank._getActive().name, 'Piano');
        assert.equal(bank._getEntries().indexOf(bank._getActive()), 5, 'the new strip is selected');
    });

    test('assigning an unassigned voice onto an occupied slot overwrites it silently', () => {
        localStorage.clear();
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        bank._assignToSlot(2, { name: 'Old', voiceData: 'old-data' });
        bank._assignToSlot(2, { name: 'New', voiceData: 'new-data' });
        const e = bank._getEntries();
        assert.equal(e[2].name, 'New');
        assert.equal(occupied(bank).length, 1, 'the old voice is gone, not relocated');
    });

    test('assigning a banked voice onto an occupied slot overwrites, never swaps', () => {
        localStorage.clear();
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        bank._assignToSlot(0, { name: 'A', voiceData: 'a-data' });
        bank._assignToSlot(3, { name: 'B', voiceData: 'b-data' });
        bank._getEntries()[0].volume = 42;
        bank._assignToSlot(3, { name: 'A', voiceData: 'a-data' });
        const e = bank._getEntries();
        assert.equal(e[3].name, 'A');
        assert.equal(e[0].name, 'A', 'slot 0 was not touched');
        assert.equal(e[0].volume, 42);
        assert.equal(occupied(bank).filter(x => x.name === 'B').length, 0, 'B is gone, not relocated');
    });

    test('assigning the voice a slot already holds just selects that strip', () => {
        localStorage.clear();
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        bank._assignToSlot(2, { name: 'A', voiceData: 'a-data' });
        bank._assignToSlot(4, { name: 'B', voiceData: 'b-data' });
        const id = bank._getEntries()[2].id;
        bank._getEntries()[2].volume = 42;
        bank._assignToSlot(2, { name: 'A renamed', voiceData: 'a-data' });
        assert.equal(bank._getEntries()[2].id, id, 'same strip, same id');
        assert.equal(bank._getEntries()[2].volume, 42);
        assert.equal(bank._getActive().id, id);
    });

    test('the voice key sees through encodings: Array and Uint8Array of the same bytes match', () => {
        // Still matters: it is what makes re-assigning to the same slot a
        // select, and what puts both numbers on the badge.
        localStorage.clear();
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        bank._assignToSlot(0, { name: 'Bass', voiceData: [1, 2, 3], patchId: 'p1' });
        bank._assignToSlot(0, { name: 'Bass copy', voiceData: Uint8Array.from([1, 2, 3]), patchId: 'p2' });
        assert.equal(bank._getEntries()[0].name, 'Bass', 'same bytes on the same slot: kept, not replaced');
        bank._assignToSlot(4, { name: 'Bass copy', voiceData: Uint8Array.from([1, 2, 3]), patchId: 'p2' });
        assert.equal(bank._getEntries()[0].voiceKey, bank._getEntries()[4].voiceKey);
    });

    test('addEntry fills the first empty slot and re-selects an existing voice', () => {
        localStorage.clear();
        const bank = createVoiceBank({ session: session || makeProjectSession() });
        bank._assignToSlot(0, { name: 'A', voiceData: 'a-data' });
        bank._assignToSlot(2, { name: 'C', voiceData: 'c-data' });
        bank._addEntry('B', 'b-data', 'pb');
        assert.equal(bank._getEntries()[1].name, 'B', 'first hole, not append');
        bank._addEntry('A again', 'a-data', 'pa');
        assert.equal(occupied(bank).length, 4, 'a second strip of the same voice');
        assert.equal(bank._getEntries()[3].name, 'A again');
        assert.equal(bank._getActive().name, 'A again');
    });

    test('reading the tracks keeps slot positions; a duplicate voice IS a strip', () => {
        // A track skipped here would still be scheduled — into a channel
        // the snapshot never loads a patch for. It played nothing, and the
        // Mixer showed a hole where the track was.
        seed([
            { id: 'a', name: 'A', voiceData: 'a-data', patchId: 'a', volume: 60 },
            null,
            { id: 'b', name: 'B', voiceData: 'b-data', patchId: 'b' },
            { id: 'dup', name: 'A dup', voiceData: 'a-data', patchId: 'a' },
        ]);
        const e = createVoiceBank({ session })._getEntries();
        assert.equal(e[0].name, 'A');
        assert.equal(e[0].volume, 60);
        assert.equal(e[1], null, 'a slot with no voice is a hole');
        assert.equal(e[2].name, 'B');
        assert.equal(e[3].name, 'A dup', 'the duplicate voice gets its strip');
        assert.equal(e[3].voiceKey, e[0].voiceKey);
    });
});
