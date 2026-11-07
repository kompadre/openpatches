// `track.fx` and `project.fx`: the persisted half of the effects.
//
// Two traps this file exists to hold shut:
//
//   * **Effect parameters are fractional.** `clampInt` rounds, so a delay
//     feedback of 0.35 would store as 0 and a mix of 0.3 as silence. They
//     go through `clampNum`, which does not round but keeps the same
//     explicit `null` guard — `Number(null)` is 0, and 0 is finite.
//   * **Switching an effect off must not forget how it was set up.** The
//     flags and the parameters are separate fields for exactly that
//     reason: bypass, not reset.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    createTrack, createTrackFx, createProject, createProjectFx,
    normalizeProject, MAX_SLOTS,
} from '../html/components/project-model.js';
import {
    FX_FIELDS, FX_GLOBAL_FIELDS, FX_ENABLE_FIELDS,
    FX_RANGES, FX_GLOBAL_RANGES,
} from '../html/synth/fx-params.js';

describe('createTrackFx', () => {
    test('a track is born with a complete, in-range rack', () => {
        const fx = createTrack().fx;
        for (const field of Object.keys(FX_ENABLE_FIELDS)) {
            assert.equal(fx[field], false, `${field} should start off`);
        }
        for (const [field, param] of Object.entries(FX_FIELDS)) {
            assert.equal(fx[field], FX_RANGES[param].def, `${field} default`);
        }
    });

    test('fractional parameters are NOT rounded away', () => {
        const fx = createTrackFx({ delayFeedback: 0.35, delayMix: 0.3, sendLevel: 0.45 });
        assert.equal(fx.delayFeedback, 0.35);
        assert.equal(fx.delayMix, 0.3);
        assert.equal(fx.sendLevel, 0.45);
    });

    test('null and nonsense fall back to the default, not to zero', () => {
        // Number(null) is 0 and finite — a null mix would read as a
        // deliberate "fully dry", a null threshold as -60 dB.
        const fx = createTrackFx({
            delayMix: null, compThreshold: null, delayTime: undefined,
            driveAmount: 'loud', compRatio: NaN, compRelease: Infinity,
        });
        assert.equal(fx.delayMix, FX_RANGES.FX_DELAY_MIX.def);
        assert.equal(fx.compThreshold, FX_RANGES.FX_COMP_THRESHOLD.def);
        assert.equal(fx.delayTime, FX_RANGES.FX_DELAY_TIME.def);
        assert.equal(fx.driveAmount, FX_RANGES.FX_DRIVE_AMOUNT.def);
        assert.equal(fx.compRatio, FX_RANGES.FX_COMP_RATIO.def);
        assert.equal(fx.compRelease, FX_RANGES.FX_COMP_RELEASE.def);
    });

    test('out-of-range values are clamped to the engine’s own bounds', () => {
        const fx = createTrackFx({ delayTime: 99999, delayFeedback: 5, compThreshold: -500 });
        assert.equal(fx.delayTime, FX_RANGES.FX_DELAY_TIME.max);
        assert.equal(fx.delayFeedback, FX_RANGES.FX_DELAY_FEEDBACK.max);
        assert.equal(fx.compThreshold, FX_RANGES.FX_COMP_THRESHOLD.min);
    });

    test('only a real `true` switches an effect on', () => {
        const fx = createTrackFx({ delay: 1, drive: 'yes', comp: true, send: null });
        assert.equal(fx.delay, false);
        assert.equal(fx.drive, false);
        assert.equal(fx.comp, true);
        assert.equal(fx.send, false);
    });

    test('switching off keeps the settings — bypass, not reset', () => {
        const configured = createTrackFx({ delay: true, delayTime: 125, delayMix: 0.8 });
        const bypassed = createTrackFx({ ...configured, delay: false });
        assert.equal(bypassed.delay, false);
        assert.equal(bypassed.delayTime, 125);
        assert.equal(bypassed.delayMix, 0.8);
    });

    test('a non-object partial is a default rack, not a crash', () => {
        for (const bad of [null, undefined, 'delay', 42, []]) {
            assert.equal(createTrackFx(bad).delayTime, FX_RANGES.FX_DELAY_TIME.def);
        }
    });
});

describe('createProjectFx', () => {
    test('defaults are complete and in range', () => {
        const fx = createProject().fx;
        for (const [field, param] of Object.entries(FX_GLOBAL_FIELDS)) {
            if (field === 'duckSource') continue;
            assert.equal(fx[field], FX_GLOBAL_RANGES[param].def, field);
        }
    });

    test('nobody is boosted by default', () => {
        assert.equal(createProjectFx().duckSource, -1);
    });

    test('a duck source that is not a slot means nobody', () => {
        assert.equal(createProjectFx({ duckSource: 99 }).duckSource, -1);
        assert.equal(createProjectFx({ duckSource: -5 }).duckSource, -1);
        assert.equal(createProjectFx({ duckSource: 1.5 }).duckSource, -1);
        assert.equal(createProjectFx({ duckSource: 'kick' }).duckSource, -1);
        assert.equal(createProjectFx({ duckSource: 3 }).duckSource, 3);
    });
});

describe('normalizeProject and the rack', () => {
    test('a stored project missing fx entirely comes back complete', () => {
        const project = normalizeProject({
            tracks: [{ id: 't1', slot: 0, name: 'A' }],
            sections: [], patterns: {},
        });
        assert.equal(project.fx.reverbLevel, FX_GLOBAL_RANGES.FX_G_REVERB_LEVEL.def);
        assert.equal(project.tracks[0].fx.delayTime, FX_RANGES.FX_DELAY_TIME.def);
        assert.equal(project.tracks[0].fx.delay, false);
    });

    test('a duck source naming an empty slot is dropped', () => {
        // Otherwise the mix quietly ducks under a track that is not there,
        // and nothing in the UI explains why it got soft.
        const project = createProject({
            tracks: [{ slot: 0, name: 'A' }],
            fx: { duckSource: 5 },
        });
        assert.equal(project.fx.duckSource, -1);
    });

    test('a duck source naming a real track survives', () => {
        const project = createProject({
            tracks: [{ slot: 0, name: 'A' }, { slot: 5, name: 'B' }],
            fx: { duckSource: 5 },
        });
        assert.equal(project.fx.duckSource, 5);
    });

    test('removing the boosted track drops the duck on the next normalize', () => {
        const project = createProject({
            tracks: [{ slot: 0, name: 'A' }, { slot: 5, name: 'Kick' }],
            fx: { duckSource: 5 },
        });
        project.tracks = project.tracks.filter(t => t.slot !== 5);
        normalizeProject(project);
        assert.equal(project.fx.duckSource, -1);
    });
});

describe('the rack survives a save/load round trip', () => {
    test('JSON out and back is the same rack', () => {
        const project = createProject({
            name: 'Round trip',
            tracks: [{ slot: 0, name: 'Lead', fx: { delay: true, delayTime: 125, delayFeedback: 0.6 } }],
            fx: { reverbLevel: 0.75, duckSource: 0, duckAmount: 18 },
        });
        const back = createProject(JSON.parse(JSON.stringify(project)));

        assert.deepEqual(back.tracks[0].fx, project.tracks[0].fx);
        assert.deepEqual(back.fx, project.fx);
        assert.equal(back.tracks[0].fx.delayFeedback, 0.6, 'not rounded on the way back');
        assert.equal(back.fx.duckSource, 0);
    });

    test('every slot can carry its own rack', () => {
        const tracks = [];
        for (let slot = 0; slot < MAX_SLOTS; slot++) {
            tracks.push({ slot, name: 'T' + slot, fx: { drive: true, driveAmount: slot + 1 } });
        }
        const project = createProject({ tracks });
        for (let slot = 0; slot < MAX_SLOTS; slot++) {
            assert.equal(project.tracks[slot].fx.driveAmount, slot + 1);
            assert.equal(project.tracks[slot].fx.drive, true);
        }
    });
});
