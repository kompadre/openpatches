// Permission escalation in the MIDI settings modal.
//
// The bug this pins down: `auditionEnabled` is persisted, the SysEx grant is
// not. On a fresh load the box came back ticked while MIDI had been enabled
// with the plain tier, so auditioning silently did nothing and the only way
// out was to untick the box and tick it again.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let midi;
let panel;
let stub;
let logs;

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
    logs = [];
});

const flush = () => new Promise(r => setImmediate(r));

function openPanel() {
    panel.openMidiSettings({ appendLog: (m) => logs.push(m) });
    const q = (sel) => document.body.querySelector(sel);
    const sysexRow = q('.midi-sysex-warning');
    return {
        enable: q('.midi-enable-btn'),
        audBox: document.body.querySelectorAll('INPUT').find(i => i.type === 'checkbox'),
        sysexRow,
        sysexBtn: sysexRow.querySelector('button'),
    };
}

// Re-create the state a returning user lands in: settings restored from
// localStorage, no MIDI access yet.
async function reload() {
    midi._reset();
    stub = installMidiStub();
    document.body.children.length = 0;
}

describe('enabling MIDI asks for the tier the saved settings need', () => {
    test('audition remembered on → a single SysEx prompt, and it works immediately', async () => {
        await midi.requestMidi({ sysex: true });
        midi.setSelectedOutput('out0');
        midi.setAuditionEnabled(true);
        await reload();

        const ui = openPanel();
        assert.equal(midi.getState(), 'closed');
        ui.enable.dispatch('click');
        await flush();

        assert.deepEqual(stub.requests, [{ sysex: true }], 'one prompt, at the tier audition needs');
        assert.equal(midi.hasSysex(), true);
        assert.equal(midi.isAuditionEnabled(), true,
            'auditioning is live without the untick/retick dance');
        assert.equal(ui.sysexRow.style.display, 'none', 'nothing to warn about');
    });

    test('audition off → the weakest tier is still what gets asked for', async () => {
        const ui = openPanel();
        ui.enable.dispatch('click');
        await flush();
        assert.deepEqual(stub.requests, [{ sysex: false }]);
        assert.equal(midi.hasSysex(), false);
    });

    test('a denied prompt is reported and leaves audition off the air', async () => {
        midi.setAuditionEnabled(true);
        await reload();
        stub.grant = false;

        const ui = openPanel();
        ui.enable.dispatch('click');
        await flush();
        assert.equal(midi.isAuditionEnabled(), false);
        assert.ok(logs.some(m => /denied/i.test(m)));
    });
});

describe('the recovery row', () => {
    // Reached when the tier cannot be pre-empted: MIDI was already enabled
    // plain before audition was switched on, or the SysEx prompt was
    // dismissed.
    async function plainGrantWithAuditionOn() {
        await midi.requestMidi({ sysex: false });
        midi.setSelectedOutput('out0');
        midi.setAuditionEnabled(true);
        document.body.children.length = 0;
        return openPanel();
    }

    test('appears when audition is on but the grant is plain', async () => {
        const ui = await plainGrantWithAuditionOn();
        assert.equal(midi.auditionNeedsSysex(), true);
        assert.equal(ui.sysexRow.style.display, '', 'the row is shown');
        assert.equal(ui.audBox.checked, true, 'the box still shows what the user asked for');
        assert.equal(midi.isAuditionEnabled(), false, 'but it is not actually working');
    });

    test('its button upgrades the grant in place', async () => {
        const ui = await plainGrantWithAuditionOn();
        ui.sysexBtn.dispatch('click');
        await flush();

        assert.equal(midi.hasSysex(), true);
        assert.equal(midi.isAuditionEnabled(), true);
        assert.equal(ui.sysexRow.style.display, 'none', 'the row stands down');
        assert.ok(logs.some(m => /granted/i.test(m)));
    });

    test('a refused upgrade leaves the row up so it can be retried', async () => {
        const ui = await plainGrantWithAuditionOn();
        stub.grant = false;
        ui.sysexBtn.dispatch('click');
        await flush();

        assert.equal(midi.hasSysex(), false);
        assert.equal(ui.sysexRow.style.display, '', 'still offering the fix');
        assert.ok(logs.some(m => /not granted/i.test(m)));

        stub.grant = true;
        ui.sysexBtn.dispatch('click');
        await flush();
        assert.equal(midi.isAuditionEnabled(), true);
        assert.equal(ui.sysexRow.style.display, 'none');
    });

    test('stays hidden when audition is off, whatever the grant', async () => {
        await midi.requestMidi({ sysex: false });
        midi.setSelectedOutput('out0');
        document.body.children.length = 0;
        const ui = openPanel();
        assert.equal(midi.auditionNeedsSysex(), false);
        assert.equal(ui.sysexRow.style.display, 'none');
    });

    test('stays hidden once SysEx is held', async () => {
        await midi.requestMidi({ sysex: true });
        midi.setSelectedOutput('out0');
        midi.setAuditionEnabled(true);
        document.body.children.length = 0;
        const ui = openPanel();
        assert.equal(ui.sysexRow.style.display, 'none');
    });

    test('ticking the box when MIDI is already plain clears the row itself', async () => {
        await midi.requestMidi({ sysex: false });
        midi.setSelectedOutput('out0');
        document.body.children.length = 0;
        const ui = openPanel();

        ui.audBox.checked = true;
        ui.audBox.dispatch('change');
        await flush();

        assert.equal(midi.isAuditionEnabled(), true);
        assert.equal(ui.sysexRow.style.display, 'none', 'the tick already prompted for SysEx');
    });
});
