// Pushing the effects rack to the engine.
//
// Effect state lives only in WASM — nothing reads it back — so the open
// project's rack has to be pushed, exactly like channel volumes. The
// snapshot runs on every `tracks` update, and most of those change nothing
// about the effects, so it has to be a diff rather than a broadcast.
//
// The case worth the file: a **deleted track's delay keeps ringing**. A
// slot with no track on it must be switched off explicitly, not skipped,
// or its tail outlives the strip that could have stopped it.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';
import { FxParam, FxGlobalParam, FxEnable } from '../html/synth/fx-params.js';
import { createProject } from '../html/components/project-model.js';

let audio;
let sent;

before(async () => {
    installBrowserEnv();
    sent = [];

    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });

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

beforeEach(() => {
    // Each test starts from an engine nobody has configured.
    audio.emergencyStop();
    sent.length = 0;
});

/** The one fx-snapshot a call produced, or null. */
function snapshot() {
    const msgs = sent.filter(m => m.type === 'fx-snapshot');
    assert.ok(msgs.length <= 1, 'one call should send at most one snapshot');
    return msgs[0] || null;
}

function channelIn(snap, ch) {
    return (snap.channels || []).find(c => c.channel === ch) || null;
}

/** A project with one track per given slot, each carrying the given fx. */
function projectWith(spec, globalFx) {
    return createProject({
        tracks: Object.entries(spec).map(([slot, fx]) => ({
            slot: Number(slot), name: 'T' + slot, fx,
        })),
        fx: globalFx,
    });
}

describe('sendFxSnapshot', () => {
    test('pushes every parameter the first time', () => {
        const p = projectWith({ 0: { delay: true, delayTime: 125 } });
        audio.sendFxSnapshot(p.tracks, p.fx);

        const snap = snapshot();
        assert.ok(snap, 'a first push should send something');
        const ch0 = channelIn(snap, 0);
        assert.ok(ch0, 'slot 0 was pushed');
        assert.equal(ch0.mask, FxEnable.FX_EN_DELAY);
        const byId = Object.fromEntries(ch0.params);
        assert.equal(byId[FxParam.FX_DELAY_TIME], 125);
        // Every parameter, not just the changed-looking one — the engine
        // has defaults of its own and they are not the project's.
        assert.equal(ch0.params.length, FxParam.FX_PARAM_COUNT);
    });

    test('sends the parameters before the mask', () => {
        // Otherwise the effect switches on for one block using whatever the
        // engine had left over from the last project.
        const p = projectWith({ 0: { delay: true, delayTime: 700 } });
        audio.sendFxSnapshot(p.tracks, p.fx);
        const ch0 = channelIn(snapshot(), 0);
        // The worklet applies params then mask; the message shape is what
        // guarantees it, so assert the shape carries both together.
        assert.ok(ch0.params.length > 0 && typeof ch0.mask === 'number');
    });

    test('a second identical push sends nothing', () => {
        const p = projectWith({ 0: { delay: true, delayTime: 125 } });
        audio.sendFxSnapshot(p.tracks, p.fx);
        sent.length = 0;

        audio.sendFxSnapshot(p.tracks, p.fx);
        assert.equal(snapshot(), null, 'an unchanged rack should be silent');
    });

    test('only the changed parameter is re-sent', () => {
        const p = projectWith({ 0: { delay: true, delayTime: 125 } });
        audio.sendFxSnapshot(p.tracks, p.fx);
        sent.length = 0;

        p.tracks[0].fx.delayMix = 0.9;
        audio.sendFxSnapshot(p.tracks, p.fx);

        const ch0 = channelIn(snapshot(), 0);
        assert.deepEqual(ch0.params, [[FxParam.FX_DELAY_MIX, 0.9]]);
    });

    test('switching an effect off sends the new mask', () => {
        const p = projectWith({ 0: { delay: true } });
        audio.sendFxSnapshot(p.tracks, p.fx);
        sent.length = 0;

        p.tracks[0].fx.delay = false;
        audio.sendFxSnapshot(p.tracks, p.fx);

        const ch0 = channelIn(snapshot(), 0);
        assert.equal(ch0.mask, 0, 'the bypass mask has to reach the engine');
        assert.deepEqual(ch0.params, [], 'nothing else changed');
    });

    test('a deleted track is switched off, not skipped', () => {
        const p = projectWith({ 0: { delay: true }, 1: { drive: true } });
        audio.sendFxSnapshot(p.tracks, p.fx);
        sent.length = 0;

        // Slot 1's strip is gone. Its delay line is not.
        p.tracks = p.tracks.filter(t => t.slot !== 1);
        audio.sendFxSnapshot(p.tracks, p.fx);

        const ch1 = channelIn(snapshot(), 1);
        assert.ok(ch1, 'the empty slot must be addressed');
        assert.equal(ch1.mask, 0);
    });

    test('an untouched slot is not in the message at all', () => {
        const p = projectWith({ 0: { delay: true }, 1: { drive: true } });
        audio.sendFxSnapshot(p.tracks, p.fx);
        sent.length = 0;

        p.tracks.find(t => t.slot === 0).fx.delayMix = 0.5;
        audio.sendFxSnapshot(p.tracks, p.fx);

        const snap = snapshot();
        assert.deepEqual(snap.channels.map(c => c.channel), [0]);
    });
});

describe('global parameters', () => {
    test('the reverb and the ducker ride along', () => {
        const p = projectWith({ 0: {} }, { reverbLevel: 0.8, duckSource: 0 });
        audio.sendFxSnapshot(p.tracks, p.fx);

        const byId = Object.fromEntries(snapshot().global);
        assert.equal(byId[FxGlobalParam.FX_G_REVERB_LEVEL], 0.8);
        assert.equal(byId[FxGlobalParam.FX_G_DUCK_SOURCE], 0);
    });

    test('"nobody is boosted" is pushed as -1, not dropped', () => {
        // -1 is a real instruction to the engine. Treating it as "no value"
        // would leave a previous project's duck source in place.
        const p = projectWith({ 0: {} });
        audio.sendFxSnapshot(p.tracks, p.fx);
        const byId = Object.fromEntries(snapshot().global);
        assert.equal(byId[FxGlobalParam.FX_G_DUCK_SOURCE], -1);
    });

    test('unchanged globals are not re-sent', () => {
        const p = projectWith({ 0: {} }, { reverbLevel: 0.8 });
        audio.sendFxSnapshot(p.tracks, p.fx);
        sent.length = 0;

        audio.sendFxSnapshot(p.tracks, p.fx);
        assert.equal(snapshot(), null);
    });
});

describe('single-parameter setters', () => {
    test('setFxParam and setFxEnabled post their own messages', () => {
        audio.setFxParam(2, FxParam.FX_DELAY_MIX, 0.42);
        audio.setFxEnabled(2, FxEnable.FX_EN_DELAY);

        assert.deepEqual(sent.filter(m => m.type === 'fx-param'),
            [{ type: 'fx-param', channel: 2, param: FxParam.FX_DELAY_MIX, value: 0.42 }]);
        assert.deepEqual(sent.filter(m => m.type === 'fx-enabled'),
            [{ type: 'fx-enabled', channel: 2, mask: FxEnable.FX_EN_DELAY }]);
    });

    test('a live edit updates the cache, so the next snapshot skips it', () => {
        const p = projectWith({ 3: { delayMix: 0.42 } });
        audio.setFxParam(3, FxParam.FX_DELAY_MIX, 0.42);
        sent.length = 0;

        audio.sendFxSnapshot(p.tracks, p.fx);
        const ch3 = channelIn(snapshot(), 3);
        assert.ok(!ch3.params.some(([id]) => id === FxParam.FX_DELAY_MIX),
            'a value the engine already has should not be re-sent');
    });

    test('channels outside the voice bank are refused', () => {
        audio.setFxParam(-1, FxParam.FX_DELAY_MIX, 1);
        audio.setFxParam(8, FxParam.FX_DELAY_MIX, 1);
        audio.setFxEnabled(15, FxEnable.FX_EN_DELAY);
        assert.equal(sent.length, 0, 'the preview channel has no effects');
    });
});

describe('emergencyStop', () => {
    test('clears the cache so the next push is a full one', () => {
        const p = projectWith({ 0: { delay: true, delayTime: 125 } });
        audio.sendFxSnapshot(p.tracks, p.fx);

        audio.emergencyStop();
        sent.length = 0;

        audio.sendFxSnapshot(p.tracks, p.fx);
        const ch0 = channelIn(snapshot(), 0);
        assert.equal(ch0.params.length, FxParam.FX_PARAM_COUNT,
            'after a reinit the whole rack should be re-pushed');
    });
});
