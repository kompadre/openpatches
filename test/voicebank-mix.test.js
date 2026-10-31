// Mute / Solo on the Mixer strips. Both are channel-volume overrides:
// entry.volume keeps the fader's value, entry.effectiveVolume is what the
// engine hears, and onVolumeChange fires with the effective value whenever
// the mix moves a channel. Solo couples the strips — soloing one silences
// the rest, and removing the soloed strip un-silences them.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createVoiceBank;

before(async () => {
    installBrowserEnv();
    ({ createVoiceBank } = await import('../html/components/voicebank.js'));
});

let volumeCalls;

beforeEach(() => {
    localStorage.clear();
    volumeCalls = [];
});

function build() {
    const bank = createVoiceBank({
        onVolumeChange: (slot, vol) => volumeCalls.push([slot, vol]),
    });
    bank._assignToSlot(0, { name: 'A', voiceData: 'a-data' });
    bank._assignToSlot(1, { name: 'B', voiceData: 'b-data' });
    bank._assignToSlot(2, { name: 'C', voiceData: 'c-data' });
    volumeCalls.length = 0;
    return bank;
}

describe('mute', () => {
    test('muting silences the channel; the fader value stays', () => {
        const bank = build();
        bank._toggleMute(0);
        const e = bank._getEntries()[0];
        assert.equal(e.muted, true);
        assert.equal(e.effectiveVolume, 0);
        assert.equal(e.volume, 100, 'the fader did not move');
        assert.deepEqual(volumeCalls, [[0, 0]]);
    });

    test('unmuting restores the fader volume', () => {
        const bank = build();
        bank._toggleMute(0);
        volumeCalls.length = 0;
        bank._toggleMute(0);
        assert.equal(bank._getEntries()[0].effectiveVolume, 100);
        assert.deepEqual(volumeCalls, [[0, 100]]);
    });

    test('mute is persisted and still effective after a reload', () => {
        build()._toggleMute(1);
        const bank = createVoiceBank({});
        const e = bank._getEntries()[1];
        assert.equal(e.muted, true);
        assert.equal(e.effectiveVolume, 0, 'recomputed on load');
    });
});

describe('solo', () => {
    test('soloing a strip silences every other strip', () => {
        const bank = build();
        bank._toggleSolo(1);
        const [a, b, c] = bank._getEntries();
        assert.equal(a.effectiveVolume, 0);
        assert.equal(b.effectiveVolume, 100);
        assert.equal(c.effectiveVolume, 0);
        assert.deepEqual(volumeCalls.sort(), [[0, 0], [2, 0]], 'only the moved channels are pushed');
    });

    test('two solos are both audible', () => {
        const bank = build();
        bank._toggleSolo(0);
        bank._toggleSolo(2);
        const [a, b, c] = bank._getEntries();
        assert.equal(a.effectiveVolume, 100);
        assert.equal(b.effectiveVolume, 0);
        assert.equal(c.effectiveVolume, 100);
    });

    test('solo beats mute on the soloed strip, and un-soloing re-applies the mute', () => {
        const bank = build();
        bank._toggleMute(0);
        bank._toggleSolo(0);
        assert.equal(bank._getEntries()[0].effectiveVolume, 100, 'solo wins while on');
        bank._toggleSolo(0);
        assert.equal(bank._getEntries()[0].effectiveVolume, 0, 'the mute is still there');
    });

    test('removing the soloed strip un-silences the others', () => {
        const bank = build();
        bank._toggleSolo(1);
        volumeCalls.length = 0;
        bank._removeEntry(bank._getEntries()[1].id);
        const [a, , c] = bank._getEntries();
        assert.equal(a.effectiveVolume, 100);
        assert.equal(c.effectiveVolume, 100);
        assert.deepEqual(volumeCalls.sort(), [[0, 100], [2, 100]]);
    });

    test('a voice assigned while another strip is soloed comes in silent', () => {
        const bank = build();
        bank._toggleSolo(0);
        bank._assignToSlot(4, { name: 'D', voiceData: 'd-data' });
        assert.equal(bank._getEntries()[4].effectiveVolume, 0);
    });
});
