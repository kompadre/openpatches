// The Device panel and the midi-manager state behind it: Stop pauses every
// musical message to the external synth (notes, clock, audition) and
// silences it first; Resume puts things back; the panel shows the profile,
// port, channel and the voice last loaded into the edit buffer, and keeps
// up as they change.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let midi, panelMod, stub;

before(async () => {
    installBrowserEnv();
    installMidiStub();
    midi = await import('../html/synth/midi-manager.js');
    panelMod = await import('../html/components/device-panel.js');
});

async function connect(name = 'Korg volca fm2') {
    localStorage.clear();
    midi._reset();
    stub = installMidiStub({ outputs: [name] });
    await midi.requestMidi({ sysex: true });
    midi.setSelectedOutput('out0');
    stub.outputs[0].sent.length = 0;
    document.body.children.length = 0;
}

const out = () => stub.outputs[0];
const voice = (name) => {
    const v = new Uint8Array(128);
    for (let i = 0; i < 10; i++) v[118 + i] = (name.charCodeAt(i) || 32);
    return v;
};

describe('pausing MIDI out', () => {
    beforeEach(() => connect());

    test('gates notes, clock and audition; internal takes over in MIDI-only mode', () => {
        midi.setOutputMode('midi');
        midi.setSendClock(true);
        midi.setAuditionEnabled(true);
        assert.equal(midi.isMidiOutEnabled(), true);
        assert.equal(midi.isInternalEnabled(), false);

        midi.setOutputPaused(true);
        assert.equal(midi.isMidiOutEnabled(), false);
        assert.equal(midi.isClockOutEnabled(), false);
        assert.equal(midi.isAuditionEnabled(), false);
        assert.equal(midi.isInternalEnabled(), true, 'not silent: the local synth plays meanwhile');
        assert.equal(midi.clockStart(0), false, 'no clock start while paused');

        midi.setOutputPaused(false);
        assert.equal(midi.isMidiOutEnabled(), true);
        assert.equal(midi.isClockOutEnabled(), true);
        assert.equal(midi.isAuditionEnabled(), true);
        assert.equal(midi.getOutputMode(), 'midi', 'settings untouched by the pause');
    });

    test('stopping silences the device first (All Notes Off on every channel)', () => {
        midi.setOutputPaused(true);
        const allNotesOff = out().sent.filter(([d]) => (d[0] & 0xF0) === 0xB0 && d[1] === 123);
        assert.ok(allNotesOff.length >= 16);
    });

    test('is session-only — a reload does not come back paused', () => {
        midi.setOutputPaused(true);
        midi._reset();
        assert.equal(midi.isOutputPaused(), false);
        assert.ok(!('paused' in JSON.parse(localStorage.getItem('openpatches_midi') || '{}')));
    });
});

describe('current voice', () => {
    beforeEach(() => connect());

    test('is the name of the voice last sent to the edit buffer', () => {
        assert.equal(midi.getCurrentVoice(), null, 'unknown until we send one');
        midi.sendVoiceToEditBuffer(voice('E.PIANO 1'));
        assert.equal(midi.getCurrentVoice().name, 'E.PIANO 1');
    });

    test('is forgotten when the output device changes', () => {
        midi.sendVoiceToEditBuffer(voice('BRASS'));
        midi.setSelectedOutput(null);
        assert.equal(midi.getCurrentVoice(), null);
    });
});

describe('the panel', () => {
    beforeEach(() => connect());

    const mount = (opts) => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const logs = [];
        const p = panelMod.createDevicePanel(host, { appendLog: (m) => logs.push(m), ...opts });
        const q = (s) => host.querySelector(s);
        return { p, q, logs };
    };

    test('shows the profile, port, channel and patch, and follows changes', () => {
        const { q } = mount();
        assert.match(q('.device-name').textContent, /volca fm2/);
        assert.equal(q('.device-port').textContent, 'Korg volca fm2');
        assert.equal(q('.device-channel').textContent, '1');
        assert.equal(q('.device-patch').textContent, '—');

        midi.setDeviceChannel(4);
        assert.equal(q('.device-channel').textContent, '5');
        midi.sendVoiceToEditBuffer(voice('TUB BELLS'));
        assert.equal(q('.device-patch').textContent, 'TUB BELLS');
        midi.setDeviceType('dx7');
        assert.match(q('.device-name').textContent, /DX7/);
        assert.doesNotMatch(q('.device-name').textContent, /auto/);
    });

    test('Stop / Resume toggles the pause and says so', () => {
        const { q, logs } = mount();
        const btn = q('.device-toggle');
        assert.match(btn.textContent, /Stop/);
        btn.dispatch('click');
        assert.equal(midi.isOutputPaused(), true);
        assert.match(btn.textContent, /Resume/);
        assert.match(logs.at(-1), /stopped/);
        btn.dispatch('click');
        assert.equal(midi.isOutputPaused(), false);
        assert.match(btn.textContent, /Stop/);
        assert.match(logs.at(-1), /resumed/);
    });

    test('with no output, Stop is disabled and the hint says where to pick one', () => {
        midi.setSelectedOutput(null);
        const { q } = mount();
        assert.equal(q('.device-port').textContent, 'Not connected');
        assert.equal(q('.device-toggle').disabled, true);
        assert.match(q('.device-hint').textContent, /MIDI › Devices/);
    });

    test('the MIDI… button opens the settings when the host provides them', () => {
        let opened = 0;
        const { q } = mount({ onOpenSettings: () => opened++ });
        q('.device-settings').dispatch('click');
        assert.equal(opened, 1);
    });

    test('destroy stops listening', () => {
        const { p, q } = mount();
        p.destroy();
        midi.setDeviceChannel(9);
        assert.equal(q('.device-channel'), null, 'removed from the page');
    });
});
