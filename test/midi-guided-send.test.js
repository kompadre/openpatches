// The guided (turn-based) bank send for the volcas: no 4104-byte bulk dump
// — the volca fm's MIDI implementation has none, and on real hardware it is
// ignored — so each voice goes to the edit buffer in turn and the user saves
// it on the device before asking for the next.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let midi;
let panel;
let stub;

before(async () => {
    installBrowserEnv();
    installMidiStub();
    midi = await import('../html/synth/midi-manager.js');
    panel = await import('../html/components/midi-panel.js');
});

beforeEach(async () => {
    localStorage.clear();
    midi._reset();
    stub = installMidiStub({ outputs: ['Korg volca fm2'] });
    await midi.requestMidi({ sysex: true });
    midi.setSelectedOutput('out0');
    document.body.children.length = 0;
});

const flush = () => new Promise(r => setImmediate(r));
const out = () => stub.outputs[0];
const voiceDumps = () => out().sent.filter(s => s[0][0] === 0xF0);

// Two distinguishable voices: byte 0 is OP6 EG rate 1, any 7-bit value is fine.
const voice = (b) => { const v = new Uint8Array(128); v[0] = b; return v; };
const patches = [
    { name: 'BRASS 1', voice_data: voice(1) },
    { name: 'E.PIANO', voice_data: voice(2) },
    { name: 'TUB BELLS', voice_data: voice(3) },
];

function begin(onLog, onError) {
    const logs = [];
    const done = panel.sendBankToDevice(patches, 'My bank', {
        appendLog(m) { logs.push(m); if (onLog) onLog(m); },
        showProgress() {}, hideProgress() {}, setProgressLabel() {},
        showError(m) { if (onError) onError(m); else throw new Error('unexpected error dialog: ' + m); },
        onBackupReceived() { throw new Error('the guided flow has no backup leg'); },
    });
    return { done, logs };
}

const overlay = () => document.body.querySelector('.modal-overlay');
const button = (label) => overlay().querySelectorAll('button').find(b => b.textContent === label);

describe('guided bank send', () => {
    test('walks every voice: one edit-buffer dump per step, Done closes and logs', async () => {
        const { done, logs } = begin();
        await flush();

        // Intro: nothing sent yet — the Start click is the user gesture.
        assert.ok(button('Start'), 'intro screen');
        assert.equal(voiceDumps().length, 0, 'nothing sent before Start');

        button('Start').dispatch('click');
        await flush();
        assert.equal(voiceDumps().length, 1, 'voice 1 sent on Start');
        assert.equal(overlay().querySelector('.midi-guided-name').textContent, 'BRASS 1');
        assert.equal(overlay().querySelector('.midi-guided-count').textContent, 'Voice 1 of 3');

        button('Next').dispatch('click');
        await flush();
        assert.equal(voiceDumps().length, 2, 'voice 2 sent on Next');
        assert.equal(overlay().querySelector('.midi-guided-name').textContent, 'E.PIANO');

        button('Next').dispatch('click');
        await flush();
        assert.equal(voiceDumps().length, 3);
        assert.ok(button('Done'), 'the last step says Done, not Next');

        button('Done').dispatch('click');
        await done;
        assert.equal(overlay(), null, 'the dialog is closed');
        assert.match(logs.at(-1), /one voice at a time/);
        assert.match(logs.at(-1), /3 voice/);

        // Each dump is a 163-byte format-0 single voice, not a bulk dump,
        // and each carries its own patch (byte 6 is the first packed byte).
        for (const [i, [bytes]] of voiceDumps().entries()) {
            assert.equal(bytes.length, 163, 'single-voice VCED');
            assert.equal(bytes[3], 0x00, 'format 0: edit buffer');
            assert.equal(bytes[6], i + 1, 'the right voice at the right step');
        }
    });

    test('identical voices are still re-sent — the device may have moved on between steps', async () => {
        // Audition already loaded voice 1 into the edit buffer.
        midi.sendVoiceToEditBuffer(patches[0].voice_data);
        assert.equal(voiceDumps().length, 1);

        const { done } = begin();
        await flush();
        button('Start').dispatch('click');
        await flush();
        assert.equal(voiceDumps().length, 2, 'sent again despite the dedupe cache');
        button('Cancel').dispatch('click');
        await done;
    });

    test('Cancel mid-way stops, closes, and says how far it got', async () => {
        const { done, logs } = begin();
        await flush();
        button('Start').dispatch('click');
        await flush();
        button('Next').dispatch('click');
        await flush();

        button('Cancel').dispatch('click');
        await done;
        assert.equal(overlay(), null);
        assert.equal(voiceDumps().length, 2, 'voice 3 was never sent');
        assert.match(logs.at(-1), /stopped after 2 of 3/);
    });

    test('Resend repeats the current voice without advancing', async () => {
        const { done } = begin();
        await flush();
        button('Start').dispatch('click');
        await flush();

        button('Resend').dispatch('click');
        await flush();
        assert.equal(voiceDumps().length, 2, 'same voice twice');
        assert.equal(overlay().querySelector('.midi-guided-count').textContent, 'Voice 1 of 3');
        assert.deepEqual(voiceDumps()[0][0], voiceDumps()[1][0], 'byte-identical resend');
        button('Cancel').dispatch('click');
        await done;
    });

    test('volca fm (original) routes here too', async () => {
        midi._reset();
        stub = installMidiStub({ outputs: ['Korg volca fm'] });
        await midi.requestMidi({ sysex: true });
        midi.setSelectedOutput('out0');
        document.body.children.length = 0;

        const { done } = begin();
        await flush();
        assert.ok(button('Start'), 'guided intro for the original volca fm');
        button('Cancel').dispatch('click');
        await done;
    });

    test('a failed send shows the warning and offers Resend', async () => {
        const { done } = begin();
        await flush();
        out().send = () => { throw new Error('port gone'); };
        button('Start').dispatch('click');
        await flush();
        const status = overlay().querySelector('.midi-guided-status');
        assert.match(status.textContent, /Could not send/);
        button('Cancel').dispatch('click');
        await done;
    });
});
