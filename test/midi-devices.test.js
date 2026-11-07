// Device profiles: the table itself (every profile complete and consistent)
// and the port-name detection that picks one automatically.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEVICE_PROFILES, DEVICE_TYPE_AUTO, detectDeviceType, getProfile, isDeviceType, listDeviceTypes,
} from '../html/synth/midi-devices.js';

describe('profile table', () => {
    test('every profile is complete and self-consistent', () => {
        for (const [id, p] of Object.entries(DEVICE_PROFILES)) {
            assert.equal(p.id, id, `${id}: id matches its key`);
            assert.ok(p.name && p.family, `${id}: name + family`);
            assert.ok(Array.isArray(p.aliases) && Array.isArray(p.notes) && p.notes.length > 0, `${id}: aliases/notes`);
            assert.ok(p.programCount >= 32, `${id}: at least the 32 voices of a DX7 bank`);
            assert.ok(['bulk', 'guided'].includes(p.bankSend.strategy), `${id}: a known send strategy`);
            assert.ok(['full', 'ignored'].includes(p.velocity), `${id}: velocity`);
            assert.equal(typeof p.multitimbral, 'boolean', `${id}: multitimbral`);
            assert.ok(p.polyphony === null || Number.isInteger(p.polyphony), `${id}: polyphony`);
            assert.equal(typeof p.bankSend.supported, 'boolean');
            assert.ok(p.bankSend.target, `${id}: what a bank dump overwrites`);
            assert.ok(p.bankSend.memoryProtect === null || typeof p.bankSend.memoryProtect === 'string');
            assert.equal(typeof p.bankReceive.supported, 'boolean');
            assert.equal(typeof p.bankReceive.dumpRequest, 'boolean');
            if (p.bankReceive.supported) {
                assert.equal(p.bankReceive.reason, null, `${id}: no refusal reason when receive works`);
            } else {
                assert.ok(p.bankReceive.reason, `${id}: a refusal needs a reason the user can read`);
                assert.equal(p.bankReceive.dumpRequest, false, `${id}: cannot request from a device that cannot send`);
            }
            assert.ok(p.editBufferNote && p.sysexChannelNote, `${id}: notes`);
        }
    });

    test('the facts the transport relies on', () => {
        assert.equal(DEVICE_PROFILES.dx7.bankReceive.dumpRequest, false, 'the Mk I ignores dump requests');
        assert.ok(DEVICE_PROFILES.dx7.bankReceive.manualHint.includes('front panel'));
        assert.ok(DEVICE_PROFILES.dx7.bankSend.memoryProtect, 'the DX7 has a protect switch');
        assert.equal(DEVICE_PROFILES.dx7ii.bankReceive.dumpRequest, true, 'the II-series answers them');
        assert.equal(DEVICE_PROFILES.dexed.bankReceive.supported, false, 'Dexed cannot be dumped over MIDI');
        assert.equal(DEVICE_PROFILES.dexed.bankSend.memoryProtect, null);
        assert.equal(DEVICE_PROFILES.volcafm.bankReceive.supported, false, 'the volca is receive-only');
        assert.equal(DEVICE_PROFILES.volcafm.bankSend.memoryProtect, null);
        assert.equal(DEVICE_PROFILES.volcafm.bankSend.strategy, 'guided', 'no bulk dump: voices go one at a time');
        assert.equal(DEVICE_PROFILES.volcafm.polyphony, 3, 'the original is 3-voice; 6 is the fm2');
        assert.equal(DEVICE_PROFILES.volcafm.velocity, 'ignored');
        assert.equal(DEVICE_PROFILES.volcafm2.bankSend.strategy, 'guided');
        assert.equal(DEVICE_PROFILES.volcafm2.bankReceive.supported, false);
        assert.equal(DEVICE_PROFILES.volcafm2.polyphony, 6);
        assert.equal(DEVICE_PROFILES.volcafm2.velocity, 'full', 'the fm2 added velocity response');
        assert.equal(DEVICE_PROFILES.volcafm2.programCount, 64, 'the fm2 doubled the program slots');
        assert.equal(DEVICE_PROFILES.dx7.bankSend.strategy, 'bulk');
        assert.equal(DEVICE_PROFILES.generic.bankReceive.dumpRequest, true, 'unknown synths get the optimistic path');
        for (const p of Object.values(DEVICE_PROFILES)) assert.equal(p.bankSend.supported, true, p.id + ' accepts a bank');
    });

    test('listDeviceTypes puts auto first and covers every profile exactly once', () => {
        const ids = listDeviceTypes();
        assert.equal(ids[0], DEVICE_TYPE_AUTO);
        assert.deepEqual(ids.slice(1).sort(), Object.keys(DEVICE_PROFILES).sort());
        for (const id of ids) assert.equal(isDeviceType(id), true);
        assert.equal(isDeviceType('nonsense'), false);
        assert.equal(isDeviceType(undefined), false);
    });

    test('getProfile falls back to generic instead of throwing', () => {
        assert.equal(getProfile('dexed').id, 'dexed');
        assert.equal(getProfile('nope').id, 'generic');
        assert.equal(getProfile(undefined).id, 'generic');
        assert.equal(getProfile(DEVICE_TYPE_AUTO).id, 'generic', 'auto is not a profile; callers resolve it first');
    });
});

describe('detection from the port name', () => {
    const cases = [
        ['Dexed', 'dexed'],
        ['Dexed MIDI In', 'dexed'],
        ['volca fm', 'volcafm'],
        ['Korg volca fm SOUND', 'volcafm'],
        ['volca fm2', 'volcafm2'],
        ['Korg volca fm2 SOUND', 'volcafm2'],
        ['volca fm mk2', 'volcafm2'],
        ['volca fm mkII', 'volcafm2'],
        ['volca-fm', 'volcafm'],
        ['DX7', 'dx7'],
        ['Yamaha DX-7', 'dx7'],
        ['TX7', 'dx7'],
        ['DX7II', 'dx7ii'],
        ['DX7 II-FD', 'dx7ii'],
        ['DX7 IIFD', 'dx7ii'],
        ['DX7s', 'dx7ii'],
        ['TX802', 'dx7ii'],
        ['Yamaha DX7 2', 'dx7ii'],
        ['volca keys', 'generic', 'a different volca is not an FM synth'],
        ['UM-ONE', 'generic'],
        ['', 'generic'],
        [null, 'generic'],
        [undefined, 'generic'],
    ];
    for (const [name, expected, why] of cases) {
        test(`${JSON.stringify(name)} → ${expected}${why ? ' (' + why + ')' : ''}`, () => {
            assert.equal(detectDeviceType(name), expected);
        });
    }

    test('fm2 wins over the plain volca fm match it also contains', () => {
        assert.equal(detectDeviceType('volca fm2'), 'volcafm2');
        assert.equal(detectDeviceType('volca fm'), 'volcafm');
    });

    test('II-series wins over the plain DX7 match it also contains', () => {
        // The order of the rules is load-bearing: "DX7II" matches /dx7/ too.
        assert.equal(detectDeviceType('DX7II'), 'dx7ii');
        assert.equal(detectDeviceType('Yamaha DX7 II-D'), 'dx7ii');
    });
});
