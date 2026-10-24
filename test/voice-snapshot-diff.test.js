// Regression: sendVoiceSnapshot must only send slots whose patch bytes
// changed. SetVoice resets the slot's LFO phase in the engine, so re-sending
// the full bank on every voicebank change audibly re-phased the LFO of every
// playing channel. emergencyStop() must clear the diff cache — the fresh
// engine has forgotten all patches and needs the full snapshot again.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let audio;
let sent;

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
                set onmessage(fn) { setTimeout(() => fn({ data: { type: 'ready' } }), 0); },
                get onmessage() { return null; },
            };
        }
        connect() {}
    };

    audio = await import('../html/synth/audio-manager.js');
    await audio.acquire();
    assert.ok(audio.isReady());
});

function fakeVoice(fill) {
    return Buffer.alloc(128, fill).toString('base64');
}

function sentSlots() {
    return sent
        .filter(m => m.type === 'voice-snapshot')
        .flatMap(m => m.voices.map(v => v.slot));
}

describe('sendVoiceSnapshot diffing', () => {
    test('identical snapshot is not re-sent', () => {
        const entries = [{ voiceData: fakeVoice(0x11) }, { voiceData: fakeVoice(0x22) }];
        sent.length = 0;
        audio.sendVoiceSnapshot(entries);
        assert.deepEqual(sentSlots(), [0, 1], 'first snapshot loads both slots');

        sent.length = 0;
        audio.sendVoiceSnapshot(entries);
        assert.deepEqual(sentSlots(), [], 'unchanged snapshot sends nothing');
    });

    test('only the changed slot is re-sent', () => {
        sent.length = 0;
        audio.sendVoiceSnapshot([{ voiceData: fakeVoice(0x11) }, { voiceData: fakeVoice(0x33) }]);
        assert.deepEqual(sentSlots(), [1], 'only the edited slot is sent');
    });

    test('emergencyStop clears the cache so the full bank reloads', () => {
        const entries = [{ voiceData: fakeVoice(0x11) }, { voiceData: fakeVoice(0x33) }];
        audio.sendVoiceSnapshot(entries);
        audio.emergencyStop();

        sent.length = 0;
        audio.sendVoiceSnapshot(entries);
        assert.deepEqual(sentSlots(), [0, 1], 'full snapshot re-sent after engine reset');
    });
});
