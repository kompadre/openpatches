// FxRack — per-track insert effects, one shared reverb, one ducker.
//
// Runs as a block-rate stage between the FM engine's per-channel sum and
// the global ResoFilter in SynthUnit::GetSamples. The FM engine stays
// fixed-point; this stage is float, because writing a reverb and a
// compressor in Q-format buys nothing audible and costs weeks.
//
// Everything is statically allocated — no malloc, per the project rule.
// Total footprint is ~1.3 MB, dominated by the eight delay lines.
//
// The rack is a process-wide singleton (fx_rack()) rather than a member of
// SynthUnit, so that reset_engine() does not forget the user's settings —
// the same reasoning that keeps channel volumes static. reset_engine()
// calls ClearState() instead, which drops the tails but keeps the params.

#ifndef __FX_H
#define __FX_H

#include <stdint.h>
#include "synth.h"
#include "fx_params.h"

// 0.75 s at 48 kHz. Delay time is clamped to what the line holds.
#define FX_MAX_DELAY_SAMPLES 36000

// Freeverb tunings are quoted for 44.1 kHz and scaled by sample rate.
// These capacities hold the largest comb/allpass at 48 kHz.
#define FX_COMB_CAPACITY 2048
#define FX_ALLPASS_CAPACITY 1024
#define FX_NUM_COMBS 8
#define FX_NUM_ALLPASS 4

// Drive waveshaper lookup: tanh over [-FX_DRIVE_LUT_RANGE, +range].
#define FX_DRIVE_LUT_SIZE 2048
#define FX_DRIVE_LUT_RANGE 8.0f

// audiobuf is 28-bit full scale at this point in GetSamples: the output
// stage does `>> 4` and then clips against 1 << 24. Scaling by 2^-28 puts
// the effects stage at a conventional +/- 1.0.
#define FX_IN_SCALE (1.0f / 268435456.0f)
#define FX_OUT_SCALE 268435456.0f

struct FxChannel {
  int enabled;              // FxEnable bitmask

  // Delay
  float delay_buf[FX_MAX_DELAY_SAMPLES];
  int delay_write;
  int delay_samples;        // currently sounding length
  int delay_samples_target; // pending length; crossfaded in over one block
  float delay_feedback;
  float delay_mix;

  // Drive (post-delay: the repeats come out dirty)
  float drive_amount;
  float drive_norm;         // 1 / tanh(drive_amount), recomputed on change
  float drive_level;

  // Compressor, envelope updated once per block
  float comp_threshold_db;
  float comp_ratio;
  float comp_attack_coef;
  float comp_release_coef;
  float comp_makeup_db;
  float comp_reduction_db;  // smoothed state
  float comp_gain;          // last block's applied gain, for interpolation

  // Reverb send, post-chain
  float send_level;
};

class FxRack {
 public:
  // Builds the drive LUT, sizes the reverb network for the sample rate and
  // restores every parameter to its neutral default. Safe to call again.
  void Init(double sample_rate);

  // Drop delay lines, reverb tails and envelope state. Parameters survive.
  void ClearState();

  void SetParam(int channel, int param, float value);
  void SetGlobalParam(int param, float value);
  void SetEnabled(int channel, int mask);

  // Whether any effect would change the signal. False means GetSamples
  // takes the bypass path and the output is bit-identical to a build
  // without this file.
  bool Active() const { return active_; }

  // One block. `in` holds FX_CHANNELS blocks of N samples at +/- 1.0 and is
  // read-only; `mix` receives the summed, effected result.
  //
  // `touched` is a bitmask of the channels a voice actually wrote into this
  // block. A channel outside it is silent, and a silent channel can be
  // skipped unless it owns a tail — a delay line or a reverb send — that
  // has to keep running. Drive and compression of silence are silence, so
  // skipping those is exact rather than an approximation.
  void ProcessBlock(const float in[FX_CHANNELS][N], float *mix,
                    unsigned touched);

 private:
  void RecomputeActive();
  float DuckGain(const float in[FX_CHANNELS][N]);
  void ProcessChannel(FxChannel &c, const float *in, float *out);
  float ReverbTick(float x);

  FxChannel chan_[FX_CHANNELS];

  // Shared mono Freeverb: 8 damped combs in parallel into 4 allpasses.
  float comb_buf_[FX_NUM_COMBS][FX_COMB_CAPACITY];
  int comb_len_[FX_NUM_COMBS];
  int comb_pos_[FX_NUM_COMBS];
  float comb_store_[FX_NUM_COMBS];   // one-pole damping state
  float allpass_buf_[FX_NUM_ALLPASS][FX_ALLPASS_CAPACITY];
  int allpass_len_[FX_NUM_ALLPASS];
  int allpass_pos_[FX_NUM_ALLPASS];
  float reverb_decay_;
  float reverb_damping_;
  float reverb_level_;

  // Ducker: one source channel, everybody else ducks under it.
  int duck_source_;
  float duck_amount_db_;
  float duck_threshold_db_;
  float duck_attack_coef_;
  float duck_release_coef_;
  float duck_reduction_db_;
  float duck_gain_;         // last block's gain, for interpolation

  float drive_lut_[FX_DRIVE_LUT_SIZE];
  float scratch_[N];
  double sample_rate_;
  bool active_;
};

// The process-wide rack. Lives across reset_engine().
FxRack &fx_rack();

#endif  // __FX_H
