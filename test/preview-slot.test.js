// Regression: patch preview must not clobber VoiceBank slot 0.
//
// playNoteRealtime used to load the previewed patch into WASM slot 0 and play on
// MIDI channel 0 — overwriting whatever the user had in VoiceBank slot 0.
// It must use the dedicated preview slot/channel (15) instead.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

const PREVIEW_SLOT = 15;
const PREVIEW_CHANNEL = 15;
const VOICE_BANK_SLOTS = 8;

let audio;
let sent; // every message posted to the worklet

before(async () => {
    installBrowserEnv();

    sent = [];

    globalThis.fetch = async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
    });

    globalThis.AudioContext = class {
        constructor() {
            this.state = 'running';
            this.destination = {};
            this.audioWorklet = { addModule: async () => {} };
        }
    };

    globalThis.AudioWorkletNode = class {
        constructor() {
            this.port = {
                postMessage: (m) => sent.push(m),
                // audio-manager awaits a 'ready' message; deliver it as soon as it subscribes.
                set onmessage(fn) { setTimeout(() => fn({ data: { type: 'ready' } }), 0); },
                get onmessage() { return null; },
            };
        }
        connect() {}
    };

    audio = await import('../html/synth/audio-manager.js');
    await audio.acquire();
    assert.ok(audio.isReady(), 'audio engine should report ready');
});

// A valid 128-byte voice, base64-encoded.
function fakeVoice(fill) {
    return Buffer.alloc(128, fill).toString('base64');
}

describe('playNoteRealtime (patch preview)', () => {
    test('loads the patch into the preview slot, not slot 0', () => {
        sent.length = 0;
        audio.playNoteRealtime(fakeVoice(0x42), 60);

        const patchMsgs = sent.filter(m => m.type === 'patch');
        assert.equal(patchMsgs.length, 1, 'should load exactly one patch');
        assert.equal(patchMsgs[0].slot, PREVIEW_SLOT);
        assert.ok(
            patchMsgs[0].slot >= VOICE_BANK_SLOTS,
            `preview slot ${patchMsgs[0].slot} must be outside the VoiceBank range 0-${VOICE_BANK_SLOTS - 1}`,
        );
    });

    test('plays note-on and note-off on the preview channel', () => {
        sent.length = 0;
        const stop = audio.playNoteRealtime(fakeVoice(0x42), 64);

        const noteOn = sent.find(m => m.type === 'midi' && (m.data[0] & 0xf0) === 0x90);
        assert.ok(noteOn, 'should send a note-on');
        assert.equal(noteOn.data[0] & 0x0f, PREVIEW_CHANNEL, 'note-on channel');
        assert.equal(noteOn.data[1], 64, 'note-on midi number');

        sent.length = 0;
        stop();
        const noteOff = sent.find(m => m.type === 'midi' && (m.data[0] & 0xf0) === 0x80);
        assert.ok(noteOff, 'should send a note-off');
        assert.equal(noteOff.data[0] & 0x0f, PREVIEW_CHANNEL, 'note-off channel');
    });

    test('never touches a VoiceBank slot or channel', () => {
        sent.length = 0;
        const stop = audio.playNoteRealtime(fakeVoice(0x7f), 72);
        stop();

        for (const m of sent) {
            if (m.type === 'patch') {
                assert.ok(m.slot >= VOICE_BANK_SLOTS, `patch written to VoiceBank slot ${m.slot}`);
            }
            if (m.type === 'midi') {
                const ch = m.data[0] & 0x0f;
                assert.ok(ch >= VOICE_BANK_SLOTS, `MIDI sent on VoiceBank channel ${ch}`);
            }
        }
    });

    test('a preview leaves an existing VoiceBank snapshot intact', () => {
        // Load slots 0 and 1, then preview, and confirm neither was rewritten.
        audio.sendVoiceSnapshot([
            { voiceData: fakeVoice(0x01) },
            { voiceData: fakeVoice(0x02) },
        ]);
        sent.length = 0;

        const stop = audio.playNoteRealtime(fakeVoice(0x03), 60);
        stop();

        const touched = sent
            .filter(m => m.type === 'patch' || m.type === 'voice-snapshot')
            .flatMap(m => (m.type === 'patch' ? [m.slot] : m.voices.map(v => v.slot)));
        assert.deepEqual(touched, [PREVIEW_SLOT], 'preview should only write the preview slot');
    });

    test('rejects unusable voice data instead of posting a bad patch', () => {
        sent.length = 0;
        assert.equal(audio.playNoteRealtime(null, 60), null);
        assert.equal(audio.playNoteRealtime(undefined, 60), null);
        assert.equal(sent.length, 0, 'nothing should be posted for empty voice data');
    });
});
