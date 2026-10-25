// Regression: persisted VoiceBank volumes were never pushed to the synth on
// a fresh page load — the engine starts every channel at its default, and
// nothing sent `channel-volume` until the user dragged a slider. The volume
// now rides along with sendVoiceSnapshot, diffed per slot like the patch bytes.

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

function volumeMsgs() {
    return sent
        .filter(m => m.type === 'channel-volume')
        .map(m => [m.channel, m.volume]);
}

describe('channel volumes in sendVoiceSnapshot', () => {
    test('persisted volumes are pushed with the first snapshot', () => {
        sent.length = 0;
        audio.sendVoiceSnapshot([
            { voiceData: fakeVoice(0x11), volume: 64 },
            { voiceData: fakeVoice(0x22), volume: 127 },
        ]);
        assert.deepEqual(volumeMsgs(), [[0, 64], [1, 127]]);
    });

    test('unchanged volumes are not re-sent', () => {
        sent.length = 0;
        audio.sendVoiceSnapshot([
            { voiceData: fakeVoice(0x11), volume: 64 },
            { voiceData: fakeVoice(0x22), volume: 127 },
        ]);
        assert.deepEqual(volumeMsgs(), []);
    });

    test('volume 0 is honored, not treated as unset', () => {
        sent.length = 0;
        audio.sendVoiceSnapshot([
            { voiceData: fakeVoice(0x11), volume: 0 },
            { voiceData: fakeVoice(0x22), volume: 127 },
        ]);
        assert.deepEqual(volumeMsgs(), [[0, 0]]);
    });

    test('a missing volume falls back to the default', () => {
        sent.length = 0;
        audio.sendVoiceSnapshot([{ voiceData: fakeVoice(0x33) }]);
        assert.deepEqual(volumeMsgs(), [[0, 100]]);
    });

    test('a direct setChannelVolume suppresses a redundant snapshot push', () => {
        audio.setChannelVolume(3, 42);
        sent.length = 0;
        audio.sendVoiceSnapshot([
            {}, {}, {},
            { voiceData: fakeVoice(0x44), volume: 42 },
        ]);
        assert.deepEqual(volumeMsgs(), []);
    });
});
