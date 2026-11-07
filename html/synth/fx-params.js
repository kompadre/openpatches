// Per-track effect parameter IDs — the JS side of the WASM contract.
//
// MIRRORS external/msfa-wasm/fx_params.h. The two are kept in step by
// test/fx-params-sync.test.js, which parses the header and compares it to
// the tables here. Append new entries at the END; renumbering silently
// repoints every saved project's parameters.
//
// The chain is delay -> drive -> compressor -> reverb send. Drive sits
// AFTER the delay on purpose: the repeats come out dirty.

/** Channels carrying effects. 8..15 (preview is 15) bypass the stage. */
export const FX_CHANNELS = 8;

/** Bitmask for setFxEnabled(channel, mask). */
export const FxEnable = {
    FX_EN_DELAY: 1 << 0,
    FX_EN_DRIVE: 1 << 1,
    FX_EN_COMP: 1 << 2,
    FX_EN_SEND: 1 << 3,
};

/** Per-channel parameter IDs for setFxParam(channel, param, value). */
export const FxParam = {
    FX_DELAY_TIME: 0,
    FX_DELAY_FEEDBACK: 1,
    FX_DELAY_MIX: 2,
    FX_DRIVE_AMOUNT: 3,
    FX_DRIVE_LEVEL: 4,
    FX_COMP_THRESHOLD: 5,
    FX_COMP_RATIO: 6,
    FX_COMP_ATTACK: 7,
    FX_COMP_RELEASE: 8,
    FX_COMP_MAKEUP: 9,
    FX_SEND_LEVEL: 10,
    FX_PARAM_COUNT: 11,
};

/** Global parameter IDs for setGlobalFxParam(param, value). */
export const FxGlobalParam = {
    FX_G_REVERB_DECAY: 0,
    FX_G_REVERB_DAMPING: 1,
    FX_G_REVERB_LEVEL: 2,
    FX_G_DUCK_SOURCE: 3,
    FX_G_DUCK_AMOUNT: 4,
    FX_G_DUCK_THRESHOLD: 5,
    FX_G_DUCK_ATTACK: 6,
    FX_G_DUCK_RELEASE: 7,
    FX_G_PARAM_COUNT: 8,
};

/**
 * Ranges the WASM side clamps to. Kept here so the Mixer's controls and the
 * project model's `clampInt`/`clampNum` guards agree with the engine
 * instead of each inventing their own limits.
 *
 * `{ min, max, def, unit }` — `def` is the engine's own default, which is
 * what a track that has never been touched sounds like.
 */
export const FX_RANGES = {
    FX_DELAY_TIME: { min: 1, max: 750, def: 250, unit: 'ms' },
    FX_DELAY_FEEDBACK: { min: 0, max: 0.95, def: 0.35, unit: '' },
    FX_DELAY_MIX: { min: 0, max: 1, def: 0.3, unit: '' },
    FX_DRIVE_AMOUNT: { min: 1, max: 64, def: 1, unit: '' },
    FX_DRIVE_LEVEL: { min: 0, max: 1, def: 1, unit: '' },
    FX_COMP_THRESHOLD: { min: -60, max: 0, def: -18, unit: 'dB' },
    FX_COMP_RATIO: { min: 1, max: 20, def: 4, unit: ':1' },
    FX_COMP_ATTACK: { min: 0.1, max: 200, def: 10, unit: 'ms' },
    FX_COMP_RELEASE: { min: 1, max: 2000, def: 150, unit: 'ms' },
    FX_COMP_MAKEUP: { min: 0, max: 24, def: 0, unit: 'dB' },
    FX_SEND_LEVEL: { min: 0, max: 1, def: 0, unit: '' },
};

/**
 * The persisted field names, mapped to the enum members they set.
 *
 * `track.fx` and `project.fx` are JSON a user can export and re-import, so
 * they carry readable keys rather than enum numbers — a saved project must
 * not break when an ID is appended. This table is the one place the two
 * namings meet: adding a parameter means a line in `fx_params.h`, a line in
 * the enum above, a range, and a line here. Nothing in project-model.js or
 * the Mixer needs to learn the new name.
 */
export const FX_FIELDS = {
    delayTime: 'FX_DELAY_TIME',
    delayFeedback: 'FX_DELAY_FEEDBACK',
    delayMix: 'FX_DELAY_MIX',
    driveAmount: 'FX_DRIVE_AMOUNT',
    driveLevel: 'FX_DRIVE_LEVEL',
    compThreshold: 'FX_COMP_THRESHOLD',
    compRatio: 'FX_COMP_RATIO',
    compAttack: 'FX_COMP_ATTACK',
    compRelease: 'FX_COMP_RELEASE',
    compMakeup: 'FX_COMP_MAKEUP',
    sendLevel: 'FX_SEND_LEVEL',
};

export const FX_GLOBAL_FIELDS = {
    reverbDecay: 'FX_G_REVERB_DECAY',
    reverbDamping: 'FX_G_REVERB_DAMPING',
    reverbLevel: 'FX_G_REVERB_LEVEL',
    duckSource: 'FX_G_DUCK_SOURCE',
    duckAmount: 'FX_G_DUCK_AMOUNT',
    duckThreshold: 'FX_G_DUCK_THRESHOLD',
    duckAttack: 'FX_G_DUCK_ATTACK',
    duckRelease: 'FX_G_DUCK_RELEASE',
};

/** Which boolean on `track.fx` switches which bit of the enable mask. */
export const FX_ENABLE_FIELDS = {
    delay: 'FX_EN_DELAY',
    drive: 'FX_EN_DRIVE',
    comp: 'FX_EN_COMP',
    send: 'FX_EN_SEND',
};

/** The enable bitmask for a `track.fx` record. */
export function fxEnableMask(fx) {
    let mask = 0;
    if (!fx) return mask;
    for (const [field, bit] of Object.entries(FX_ENABLE_FIELDS)) {
        if (fx[field] === true) mask |= FxEnable[bit];
    }
    return mask;
}

export const FX_GLOBAL_RANGES = {
    FX_G_REVERB_DECAY: { min: 0, max: 0.98, def: 0.84, unit: '' },
    FX_G_REVERB_DAMPING: { min: 0, max: 1, def: 0.4, unit: '' },
    FX_G_REVERB_LEVEL: { min: 0, max: 1, def: 0.5, unit: '' },
    FX_G_DUCK_SOURCE: { min: -1, max: FX_CHANNELS - 1, def: -1, unit: '' },
    FX_G_DUCK_AMOUNT: { min: 0, max: 40, def: 12, unit: 'dB' },
    FX_G_DUCK_THRESHOLD: { min: -60, max: 0, def: -30, unit: 'dB' },
    FX_G_DUCK_ATTACK: { min: 0.1, max: 200, def: 5, unit: 'ms' },
    FX_G_DUCK_RELEASE: { min: 1, max: 2000, def: 180, unit: 'ms' },
};
