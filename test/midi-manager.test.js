// Phase 1 of the Web MIDI feature: on-demand access, device selection and
// panic. The behaviours locked down here are the ones that are either
// invisible until they break (the sysex upgrade stranding the input listener)
// or unrecoverable when they do (a stuck note on external hardware).

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let midi;
let stub;

before(async () => {
    installBrowserEnv();
    installMidiStub();
    midi = await import('../html/synth/midi-manager.js');
});

beforeEach(() => {
    localStorage.clear();
    midi._reset();
    stub = installMidiStub();
    midi.setSelectedInput(null);
    midi.setSelectedOutput(null);
});

describe('access is only requested on demand', () => {
    test('importing the module requests nothing', () => {
        // beforeEach reinstalled the stub after the module was imported, so an
        // import-time request would still show up on a later call. The real
        // check is that merely reading state does not prompt.
        assert.equal(midi.getState(), 'closed');
        assert.deepEqual(stub.requests, []);
    });

    test('reading ports before enabling returns nothing, without prompting', () => {
        assert.deepEqual(midi.listInputs(), []);
        assert.deepEqual(midi.listOutputs(), []);
        assert.deepEqual(stub.requests, []);
    });

    test('requestMidi asks for the weakest tier by default', async () => {
        await midi.requestMidi();
        assert.deepEqual(stub.requests, [{ sysex: false }]);
        assert.equal(midi.getState(), 'ready');
        assert.equal(midi.hasSysex(), false);
    });

    test('a second plain request reuses the existing grant', async () => {
        await midi.requestMidi();
        await midi.requestMidi();
        assert.equal(stub.requests.length, 1);
    });

    test('concurrent requests share one prompt', async () => {
        await Promise.all([midi.requestMidi(), midi.requestMidi(), midi.requestMidi()]);
        assert.equal(stub.requests.length, 1);
    });

    test('a denied request leaves state denied and rethrows', async () => {
        stub.grant = false;
        await assert.rejects(() => midi.requestMidi(), /Permission denied/);
        assert.equal(midi.getState(), 'denied');
        // and it can be retried once the user relents
        stub.grant = true;
        await midi.requestMidi();
        assert.equal(midi.getState(), 'ready');
    });
});

describe('sysex upgrade', () => {
    test('asking for sysex after a plain grant re-prompts with sysex', async () => {
        await midi.requestMidi();
        await midi.requestMidi({ sysex: true });
        assert.deepEqual(stub.requests, [{ sysex: false }, { sysex: true }]);
        assert.equal(midi.hasSysex(), true);
    });

    test('a plain request after a sysex grant does not re-prompt', async () => {
        await midi.requestMidi({ sysex: true });
        await midi.requestMidi({ sysex: false });
        assert.equal(stub.requests.length, 1);
        assert.equal(midi.hasSysex(), true);
    });

    test('a slow plain request cannot clobber a sysex grant that lands first', async () => {
        // Hold the plain request open, let the sysex one resolve, then release.
        let releasePlain;
        const realRequest = globalThis.navigator.requestMIDIAccess;
        globalThis.navigator.requestMIDIAccess = (opts) => {
            if (opts.sysex) return realRequest(opts);
            return new Promise(res => { releasePlain = () => res(realRequest(opts)); });
        };

        const plain = midi.requestMidi({ sysex: false });
        const upgraded = midi.requestMidi({ sysex: true });
        await upgraded;
        assert.equal(midi.hasSysex(), true);

        releasePlain();
        await plain;
        assert.equal(midi.hasSysex(), true, 'the stale plain grant must not win');
        // hasSysex() alone is not enough: the real failure is the cached
        // access object being swapped for the non-sysex one while the flag
        // stays true, so every later SysEx send fails for no visible reason.
        assert.equal(midi._getAccess().sysexEnabled, true, 'cached access must be the sysex grant');
        assert.equal(midi.getState(), 'ready');

        globalThis.navigator.requestMIDIAccess = realRequest;
    });

    test('a handler registered before MIDI is enabled still gets attached', async () => {
        const received = [];
        midi.setOnMidiMessage((e) => received.push([...e.data]));
        midi.setSelectedInput('in0');
        await midi.requestMidi();
        stub.inputs[0].receive([0x90, 48, 64]);
        assert.deepEqual(received, [[0x90, 48, 64]]);
    });

    test('the input listener survives the upgrade', async () => {
        await midi.requestMidi();
        midi.setSelectedInput('in0');
        const received = [];
        midi.setOnMidiMessage((e) => received.push([...e.data]));
        stub.inputs[0].receive([0x90, 60, 100]);
        assert.deepEqual(received, [[0x90, 60, 100]]);

        // The upgrade replaces every port object; without re-attaching, the
        // handler would be stranded on the old one and MIDI input would go
        // silent the moment a SysEx send happened.
        await midi.requestMidi({ sysex: true });
        stub.inputs[0].receive([0x90, 64, 100]);
        assert.deepEqual(received, [[0x90, 60, 100], [0x90, 64, 100]]);
    });
});

describe('port selection', () => {
    test('selecting an output routes send()', async () => {
        await midi.requestMidi();
        midi.setSelectedOutput('out0');
        assert.equal(midi.send([0x90, 60, 100]), true);
        assert.deepEqual(stub.outputs[0].sent.at(-1)[0], [0x90, 60, 100]);
    });

    test('send with no output selected is a no-op, not a throw', async () => {
        await midi.requestMidi();
        assert.equal(midi.send([0x90, 60, 100]), false);
    });

    test('selection is persisted and restored by id', async () => {
        await midi.requestMidi();
        midi.setSelectedInput('in0');
        midi.setSelectedOutput('out0');
        const saved = JSON.parse(localStorage.getItem('openpatches_midi'));
        assert.equal(saved.inputId, 'in0');
        assert.equal(saved.outputId, 'out0');
        assert.equal(saved.names.out0, 'Out A');
    });

    test('a port whose id changed is still found by name', async () => {
        await midi.requestMidi();
        midi.setSelectedOutput('out0');
        // Re-enumerate with a different id but the same device name, as
        // happens across browser sessions.
        stub.outputs[0].id = 'out-renumbered';
        stub.access.outputs = new Map([['out-renumbered', stub.outputs[0]]]);
        assert.equal(midi.getOutputPort(), stub.outputs[0]);
    });

    test('device channel is validated and persisted', () => {
        midi.setDeviceChannel(5);
        assert.equal(midi.getDeviceChannel(), 5);
        midi.setDeviceChannel(16);
        midi.setDeviceChannel(-1);
        assert.equal(midi.getDeviceChannel(), 5);
    });
});

describe('panic', () => {
    test('sends All Sound Off + All Notes Off on all 16 channels', async () => {
        await midi.requestMidi();
        midi.setSelectedOutput('out0');
        stub.outputs[0].sent.length = 0;

        assert.equal(midi.panic(), true);

        const sent = stub.outputs[0].sent.map(s => s[0]);
        assert.equal(sent.length, 32);
        for (let ch = 0; ch < 16; ch++) {
            assert.deepEqual(sent[ch * 2], [0xB0 | ch, 120, 0], 'all sound off ch' + ch);
            assert.deepEqual(sent[ch * 2 + 1], [0xB0 | ch, 123, 0], 'all notes off ch' + ch);
        }
    });

    test('panic with no output selected is a safe no-op', () => {
        assert.equal(midi.panic(), false);
    });

    test('switching output panics the device being left behind', async () => {
        await midi.requestMidi();
        midi.setSelectedOutput('out0');
        stub.outputs[0].sent.length = 0;
        midi.setSelectedOutput(null);
        assert.equal(stub.outputs[0].sent.length, 32);
    });
});

describe('bulk transport guards', () => {
    test('receiveBank refuses without sysex permission', async () => {
        await midi.requestMidi();
        await assert.rejects(() => midi.receiveBank(), /SysEx permission/);
    });

    test('sendBank refuses without sysex permission', async () => {
        await midi.requestMidi();
        await assert.rejects(() => midi.sendBank(null), /SysEx permission/);
    });

    test('receiveBank refuses without an input device', async () => {
        await midi.requestMidi({ sysex: true });
        midi.setSelectedOutput('out0');
        await assert.rejects(() => midi.receiveBank(), /No MIDI input device/);
    });

    test('sendBank refuses without an output device', async () => {
        await midi.requestMidi({ sysex: true });
        await assert.rejects(() => midi.sendBank(null), /No MIDI output device/);
    });
});

describe('unsupported browsers', () => {
    test('isSupported is false and requestMidi rejects', async () => {
        installMidiStub({ supported: false });
        assert.equal(midi.isSupported(), false);
        assert.equal(midi.getState(), 'unsupported');
        await assert.rejects(() => midi.requestMidi(), /not supported/);
    });
});
