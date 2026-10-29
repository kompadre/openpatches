// MIDI access is re-requested on page load once the user has enabled it.
//
// The bug this pins down: the SysEx grant "got lost" on every reload. In
// fact nothing was lost — nothing was ever asked for again. requestMidi() was
// only reachable from the settings modal and the send-bank flow, so a
// returning user with audition ticked had no access at all until they went
// back to the modal and toggled something that happened to request it.

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
});

// A fresh page load: settings come back from storage, no access is held.
function reload(opts) {
    midi._reset();
    stub = installMidiStub(opts);
}

describe('resumeIfEnabled', () => {
    test('a user who never enabled MIDI is not prompted', async () => {
        assert.equal(await midi.resumeIfEnabled(), false);
        assert.deepEqual(stub.requests, []);
        assert.equal(midi.getState(), 'closed');
    });

    test('a previous grant is re-requested at the plain tier', async () => {
        await midi.requestMidi({ sysex: false });
        midi.setSelectedOutput('out0');
        reload();

        assert.equal(midi.getState(), 'closed');
        assert.equal(await midi.resumeIfEnabled(), true);
        assert.deepEqual(stub.requests, [{ sysex: false }]);
        assert.equal(midi.getState(), 'ready');
        assert.equal(midi.getOutputPort().id, 'out0', 'remembered port is live again');
    });

    test('with audition remembered on, the SysEx tier comes back too', async () => {
        await midi.requestMidi({ sysex: true });
        midi.setSelectedOutput('out0');
        midi.setAuditionEnabled(true);
        reload();

        await midi.resumeIfEnabled();
        assert.deepEqual(stub.requests, [{ sysex: true }], 'one request, at the tier audition needs');
        assert.equal(midi.hasSysex(), true);
        assert.equal(midi.isAuditionEnabled(), true, 'auditioning works without touching the modal');
        assert.equal(midi.auditionNeedsSysex(), false);
    });

    test('a grant obtained anywhere counts — the send-bank flow included', async () => {
        await midi.requestMidi({ sysex: true });   // what sendBankToDevice asks for
        reload();
        await midi.resumeIfEnabled();
        assert.equal(midi.getState(), 'ready');
    });

    test('a refused re-request is silent and leaves Enable on offer', async () => {
        await midi.requestMidi({ sysex: false });
        reload({ grant: false });

        assert.equal(await midi.resumeIfEnabled(), false);
        assert.equal(stub.requests.length, 1);
        assert.equal(midi.getState(), 'closed', 'not "denied": no user said no');
        assert.equal(midi._getAccess(), null);
    });

    test('is a no-op when access is already held', async () => {
        await midi.requestMidi({ sysex: false });
        const n = stub.requests.length;
        assert.equal(await midi.resumeIfEnabled(), true);
        assert.equal(stub.requests.length, n);
    });

    test('unsupported browsers are left alone', async () => {
        await midi.requestMidi({ sysex: false });
        reload({ supported: false });
        assert.equal(await midi.resumeIfEnabled(), false);
        assert.equal(midi.getState(), 'unsupported');
    });
});
