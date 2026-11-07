// The device-type control in MIDI › Devices, and how the chosen profile
// shapes the "send bank" confirmation: no backup offered on a device that
// cannot be dumped, no memory-protect advice for a device without the switch.

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

beforeEach(() => {
    localStorage.clear();
    midi._reset();
    stub = installMidiStub();
    document.body.children.length = 0;
});

const flush = () => new Promise(r => setImmediate(r));

async function enableWith(outputName) {
    midi._reset();
    stub = installMidiStub({ outputs: [outputName] });
    await midi.requestMidi({ sysex: true });
    midi.setSelectedOutput('out0');
    document.body.children.length = 0;
}

describe('Device type select', () => {
    test('lists Auto-detect first, then every profile, and writes through', async () => {
        await enableWith('Out A');
        panel.openMidiSettings({});
        const sel = document.body.querySelector('.midi-device-type');
        const values = sel.querySelectorAll('option').map(o => o.value);
        assert.equal(values[0], 'auto');
        assert.deepEqual(values.slice(1).sort(), ['dexed', 'dx7', 'dx7ii', 'generic', 'volcafm', 'volcafm2']);
        assert.equal(sel.value, 'auto');

        sel.value = 'dx7';
        sel.dispatch('change');
        assert.equal(midi.getDeviceType(), 'dx7');
        assert.equal(JSON.parse(localStorage.getItem('openpatches_midi')).deviceType, 'dx7');
    });

    test('the Auto-detect option says what it detected', async () => {
        await enableWith('Dexed');
        panel.openMidiSettings({});
        const sel = document.body.querySelector('.midi-device-type');
        assert.equal(sel.querySelectorAll('option')[0].textContent, 'Auto-detect (Dexed)');
        sel.value = 'volcafm';
        sel.dispatch('change');
        assert.equal(sel.querySelectorAll('option')[0].textContent, 'Auto-detect',
            'once a choice is explicit, the detection result is no longer the headline');
    });

    test("the profile's notes are shown under the select and follow the choice", async () => {
        await enableWith('Korg volca fm');
        panel.openMidiSettings({});
        const notes = () => document.body.querySelector('.midi-device-notes').children.map(li => li.textContent);
        assert.ok(notes().some(n => /3-voice/.test(n)), 'volca notes');
        const sel = document.body.querySelector('.midi-device-type');
        sel.value = 'dx7';
        sel.dispatch('change');
        assert.ok(notes().some(n => /front panel/.test(n)), 'DX7 notes');
        assert.ok(notes().some(n => /Sys Info Avail/.test(n)), 'the SysEx channel note rides along');
    });
});

describe('send-bank confirmation follows the profile', () => {
    const patches = [{ name: 'A', voice_data: new Uint8Array(128) }];

    // Open the confirm dialog and hand back its parts; `cancel()` closes it
    // and lets sendBankToDevice resolve.
    async function openConfirm() {
        const done = panel.sendBankToDevice(patches, 'My bank', {
            appendLog() {}, showProgress() {}, hideProgress() {}, setProgressLabel() {},
            showError(m) { throw new Error('unexpected error dialog: ' + m); },
            onBackupReceived() {},
        });
        await flush();
        const overlay = document.body.querySelector('.modal-overlay');
        assert.ok(overlay, 'the confirm dialog is open');
        const buttons = overlay.querySelectorAll('button');
        return {
            warnings: overlay.querySelectorAll('.midi-warning').map(w => w),
            backupBox: overlay.querySelector('.midi-backup-box'),
            backupHint: overlay.querySelector('.midi-backup-hint'),
            hints: overlay.querySelectorAll('.midi-hint').map(h => h.textContent),
            cancel: async () => {
                buttons.find(b => b.textContent === 'Cancel').dispatch('click');
                await done;
            },
        };
    }

    test('volca fm: no bulk confirm — the guided dialog opens instead', async () => {
        await enableWith('Korg volca fm');
        const done = panel.sendBankToDevice(patches, 'My bank', {
            appendLog() {}, showProgress() {}, hideProgress() {}, setProgressLabel() {},
            showError(m) { throw new Error('unexpected error dialog: ' + m); },
            onBackupReceived() {},
        });
        await flush();
        const overlay = document.body.querySelector('.modal-overlay');
        assert.ok(overlay, 'a dialog is open');
        assert.equal(overlay.querySelector('.midi-backup-box'), null, 'no backup leg in the guided flow');
        const buttons = overlay.querySelectorAll('button');
        assert.ok(buttons.some(b => b.textContent === 'Start'), 'the guided intro');
        buttons.find(b => b.textContent === 'Cancel').dispatch('click');
        await done;
    });

    test('Dexed: same posture, with its own reason', async () => {
        await enableWith('Dexed');
        const ui = await openConfirm();
        assert.equal(ui.backupBox.disabled, true);
        assert.match(ui.backupHint.textContent, /Cart manager/);
        assert.equal(ui.warnings.length, 1);
        await ui.cancel();
    });

    test('DX7: backup on by default and the memory-protect warning is shown', async () => {
        await enableWith('Yamaha DX7');
        const ui = await openConfirm();
        assert.equal(ui.backupBox.checked, true);
        assert.equal(ui.backupBox.disabled, false);
        assert.equal(ui.warnings.length, 2, 'overwrite + memory protect');
        assert.match(ui.backupHint.textContent, /saved to a new container/);
        await ui.cancel();
    });

    test('an explicit choice beats the port name', async () => {
        await enableWith('UM-ONE');
        midi.setDeviceType('dexed');
        const ui = await openConfirm();
        assert.equal(ui.backupBox.disabled, true);
        await ui.cancel();
    });

    test('the dialog is right even before MIDI has been enabled this session', async () => {
        await enableWith('Dexed');
        midi._reset();                      // settings back, access gone
        document.body.children.length = 0;
        const ui = await openConfirm();
        assert.equal(ui.backupBox.disabled, true, 'remembered port name → Dexed profile');
        await ui.cancel();
    });
});
