// Per-track effect parameter IDs — the contract between WASM and JS.
//
// This header is MIRRORED in html/synth/fx-params.js. The two are kept in
// step by test/fx-params-sync.test.js, which parses this file and compares
// it against the JS table. Append new entries at the END of each enum;
// renumbering silently repoints every saved project's parameters.

#ifndef __FX_PARAMS_H
#define __FX_PARAMS_H

// Number of channels that carry effects. Channels 8..15 (the preview
// channel 15 among them) bypass the whole stage.
#define FX_CHANNELS 8

// set_fx_enabled(channel, mask) — which effects run on a channel.
// A mask of 0 on every channel, with no reverb and no ducking, is what
// lets the engine take the bit-identical bypass path.
enum FxEnable {
  FX_EN_DELAY = 1 << 0,
  FX_EN_DRIVE = 1 << 1,
  FX_EN_COMP  = 1 << 2,
  FX_EN_SEND  = 1 << 3
};

// set_fx_param(channel, param, value)
// The chain is delay -> drive -> compressor -> reverb send. Drive sits
// AFTER the delay on purpose: the repeats come out dirty.
enum FxParam {
  FX_DELAY_TIME = 0,   // ms, 1 .. 750
  FX_DELAY_FEEDBACK,   // 0 .. 0.95
  FX_DELAY_MIX,        // 0 .. 1 (dry/wet)
  FX_DRIVE_AMOUNT,     // 1 .. 64 (pre-gain into the tanh)
  FX_DRIVE_LEVEL,      // 0 .. 1 (output trim)
  FX_COMP_THRESHOLD,   // dBFS, -60 .. 0
  FX_COMP_RATIO,       // 1 .. 20
  FX_COMP_ATTACK,      // ms, 0.1 .. 200
  FX_COMP_RELEASE,     // ms, 1 .. 2000
  FX_COMP_MAKEUP,      // dB, 0 .. 24
  FX_SEND_LEVEL,       // 0 .. 1, post-chain send into the shared reverb
  FX_PARAM_COUNT
};

// set_global_fx_param(param, value)
// One shared reverb and one ducker for the whole mix. The ducker has a
// single source channel: that track is left alone and every other one
// ducks under it.
enum FxGlobalParam {
  FX_G_REVERB_DECAY = 0, // 0 .. 0.98 (comb feedback)
  FX_G_REVERB_DAMPING,   // 0 .. 1 (hf absorption in the combs)
  FX_G_REVERB_LEVEL,     // 0 .. 1 (return into the mix)
  FX_G_DUCK_SOURCE,      // channel 0 .. 7, or -1 for off
  FX_G_DUCK_AMOUNT,      // dB of reduction applied to everyone else, 0 .. 40
  FX_G_DUCK_THRESHOLD,   // dBFS the source must exceed, -60 .. 0
  FX_G_DUCK_ATTACK,      // ms, 0.1 .. 200
  FX_G_DUCK_RELEASE,     // ms, 1 .. 2000
  FX_G_PARAM_COUNT
};

#endif  // __FX_PARAMS_H
