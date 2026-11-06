// FxRack implementation. See fx.h for the shape and the reasoning.

#include "fx.h"

#include <math.h>
#include <string.h>

// Freeverb tunings, quoted for 44.1 kHz and scaled to the actual rate.
static const int kCombTuning[FX_NUM_COMBS] = {
  1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617
};
static const int kAllpassTuning[FX_NUM_ALLPASS] = { 556, 441, 341, 225 };

// Freeverb's input trim. Eight combs in parallel need it.
static const float kReverbInputGain = 0.015f;
static const float kAllpassFeedback = 0.5f;

static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

static inline int clampi(int v, int lo, int hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// One-pole smoothing coefficient for an envelope updated once per block.
static float BlockCoef(double sample_rate, float ms) {
  if (ms < 0.01f) ms = 0.01f;
  float block_period = (float)(N / sample_rate);
  return expf(-block_period / (ms * 0.001f));
}

static inline float DbToGain(float db) {
  return powf(10.0f, db * 0.05f);
}

static inline float PeakDb(const float *buf) {
  float peak = 0.0f;
  for (int j = 0; j < N; ++j) {
    float a = buf[j] < 0.0f ? -buf[j] : buf[j];
    if (a > peak) peak = a;
  }
  return 20.0f * log10f(peak + 1e-9f);
}

// File-scope rather than a function-local static: FxRack has no constructor,
// so this lands in .bss zero-initialised and needs no __cxa_guard_* at all.
static FxRack g_rack;

FxRack &fx_rack() { return g_rack; }

void FxRack::Init(double sample_rate) {
  sample_rate_ = sample_rate > 0 ? sample_rate : 44100.0;

  for (int i = 0; i < FX_DRIVE_LUT_SIZE; ++i) {
    float x = -FX_DRIVE_LUT_RANGE +
        (2.0f * FX_DRIVE_LUT_RANGE * i) / (FX_DRIVE_LUT_SIZE - 1);
    drive_lut_[i] = tanhf(x);
  }

  float scale = (float)(sample_rate_ / 44100.0);
  for (int i = 0; i < FX_NUM_COMBS; ++i) {
    comb_len_[i] = clampi((int)(kCombTuning[i] * scale), 1, FX_COMB_CAPACITY);
  }
  for (int i = 0; i < FX_NUM_ALLPASS; ++i) {
    allpass_len_[i] =
        clampi((int)(kAllpassTuning[i] * scale), 1, FX_ALLPASS_CAPACITY);
  }

  reverb_decay_ = 0.84f;
  reverb_damping_ = 0.4f;
  reverb_level_ = 0.5f;

  duck_source_ = -1;
  duck_amount_db_ = 12.0f;
  duck_threshold_db_ = -30.0f;
  duck_attack_coef_ = BlockCoef(sample_rate_, 5.0f);
  duck_release_coef_ = BlockCoef(sample_rate_, 180.0f);

  for (int ch = 0; ch < FX_CHANNELS; ++ch) {
    FxChannel &c = chan_[ch];
    c.enabled = 0;
    c.delay_samples = clampi((int)(0.25 * sample_rate_), 1,
                             FX_MAX_DELAY_SAMPLES - 1);
    c.delay_samples_target = c.delay_samples;
    c.delay_feedback = 0.35f;
    c.delay_mix = 0.3f;
    c.drive_amount = 1.0f;
    c.drive_norm = 1.0f / tanhf(1.0f);
    c.drive_level = 1.0f;
    c.comp_threshold_db = -18.0f;
    c.comp_ratio = 4.0f;
    c.comp_attack_coef = BlockCoef(sample_rate_, 10.0f);
    c.comp_release_coef = BlockCoef(sample_rate_, 150.0f);
    c.comp_makeup_db = 0.0f;
    c.send_level = 0.0f;
  }

  ClearState();
  RecomputeActive();
}

void FxRack::ClearState() {
  for (int ch = 0; ch < FX_CHANNELS; ++ch) {
    FxChannel &c = chan_[ch];
    memset(c.delay_buf, 0, sizeof(c.delay_buf));
    c.delay_write = 0;
    c.comp_reduction_db = 0.0f;
    c.comp_gain = DbToGain(c.comp_makeup_db);
  }
  memset(comb_buf_, 0, sizeof(comb_buf_));
  memset(allpass_buf_, 0, sizeof(allpass_buf_));
  memset(comb_store_, 0, sizeof(comb_store_));
  memset(comb_pos_, 0, sizeof(comb_pos_));
  memset(allpass_pos_, 0, sizeof(allpass_pos_));
  duck_reduction_db_ = 0.0f;
  duck_gain_ = 1.0f;
}

void FxRack::RecomputeActive() {
  active_ = false;
  for (int ch = 0; ch < FX_CHANNELS; ++ch) {
    if (chan_[ch].enabled != 0) {
      active_ = true;
      return;
    }
  }
  // The reverb cannot be heard without a channel send, and a send needs
  // FX_EN_SEND — so reverb level alone never switches the stage on.
  if (duck_source_ >= 0 && duck_amount_db_ > 0.0f) active_ = true;
}

void FxRack::SetEnabled(int channel, int mask) {
  if (channel < 0 || channel >= FX_CHANNELS) return;
  chan_[channel].enabled = mask & (FX_EN_DELAY | FX_EN_DRIVE | FX_EN_COMP |
                                   FX_EN_SEND);
  RecomputeActive();
}

void FxRack::SetParam(int channel, int param, float value) {
  if (channel < 0 || channel >= FX_CHANNELS) return;
  FxChannel &c = chan_[channel];
  switch (param) {
    case FX_DELAY_TIME: {
      float ms = clampf(value, 1.0f, 750.0f);
      int samples = (int)(ms * 0.001f * sample_rate_);
      c.delay_samples_target = clampi(samples, 1, FX_MAX_DELAY_SAMPLES - 1);
      break;
    }
    case FX_DELAY_FEEDBACK:
      c.delay_feedback = clampf(value, 0.0f, 0.95f);
      break;
    case FX_DELAY_MIX:
      c.delay_mix = clampf(value, 0.0f, 1.0f);
      break;
    case FX_DRIVE_AMOUNT:
      c.drive_amount = clampf(value, 1.0f, 64.0f);
      c.drive_norm = 1.0f / tanhf(c.drive_amount);
      break;
    case FX_DRIVE_LEVEL:
      c.drive_level = clampf(value, 0.0f, 1.0f);
      break;
    case FX_COMP_THRESHOLD:
      c.comp_threshold_db = clampf(value, -60.0f, 0.0f);
      break;
    case FX_COMP_RATIO:
      c.comp_ratio = clampf(value, 1.0f, 20.0f);
      break;
    case FX_COMP_ATTACK:
      c.comp_attack_coef = BlockCoef(sample_rate_, clampf(value, 0.1f, 200.0f));
      break;
    case FX_COMP_RELEASE:
      c.comp_release_coef =
          BlockCoef(sample_rate_, clampf(value, 1.0f, 2000.0f));
      break;
    case FX_COMP_MAKEUP:
      c.comp_makeup_db = clampf(value, 0.0f, 24.0f);
      break;
    case FX_SEND_LEVEL:
      c.send_level = clampf(value, 0.0f, 1.0f);
      break;
    default:
      break;
  }
}

void FxRack::SetGlobalParam(int param, float value) {
  switch (param) {
    case FX_G_REVERB_DECAY:
      reverb_decay_ = clampf(value, 0.0f, 0.98f);
      break;
    case FX_G_REVERB_DAMPING:
      reverb_damping_ = clampf(value, 0.0f, 1.0f);
      break;
    case FX_G_REVERB_LEVEL:
      reverb_level_ = clampf(value, 0.0f, 1.0f);
      break;
    case FX_G_DUCK_SOURCE: {
      int src = (int)value;
      duck_source_ = (src >= 0 && src < FX_CHANNELS) ? src : -1;
      RecomputeActive();
      break;
    }
    case FX_G_DUCK_AMOUNT:
      duck_amount_db_ = clampf(value, 0.0f, 40.0f);
      RecomputeActive();
      break;
    case FX_G_DUCK_THRESHOLD:
      duck_threshold_db_ = clampf(value, -60.0f, 0.0f);
      break;
    case FX_G_DUCK_ATTACK:
      duck_attack_coef_ = BlockCoef(sample_rate_, clampf(value, 0.1f, 200.0f));
      break;
    case FX_G_DUCK_RELEASE:
      duck_release_coef_ =
          BlockCoef(sample_rate_, clampf(value, 1.0f, 2000.0f));
      break;
    default:
      break;
  }
}

// Gain the non-source channels should reach by the end of this block.
float FxRack::DuckGain(const float in[FX_CHANNELS][N]) {
  if (duck_source_ < 0 || duck_amount_db_ <= 0.0f) return 1.0f;
  // Follows the source PRE-effects: how hard the part was played, not how
  // loud its delay tail happens to be.
  float db = PeakDb(in[duck_source_]);
  float target = db > duck_threshold_db_ ? duck_amount_db_ : 0.0f;
  float coef = target > duck_reduction_db_ ? duck_attack_coef_
                                           : duck_release_coef_;
  duck_reduction_db_ = target + (duck_reduction_db_ - target) * coef;
  return DbToGain(-duck_reduction_db_);
}

void FxRack::ProcessChannel(FxChannel &c, const float *in, float *out) {
  for (int j = 0; j < N; ++j) out[j] = in[j];

  if (c.enabled & FX_EN_DELAY) {
    int cap = FX_MAX_DELAY_SAMPLES;
    int from = c.delay_samples;
    int to = c.delay_samples_target;
    bool moving = from != to;
    for (int j = 0; j < N; ++j) {
      int r1 = c.delay_write - from;
      if (r1 < 0) r1 += cap;
      float wet = c.delay_buf[r1];
      if (moving) {
        // A delay line cannot change length silently. Crossfade the old
        // and new read heads across one block and commit at the end.
        int r2 = c.delay_write - to;
        if (r2 < 0) r2 += cap;
        float t = (float)j / (float)N;
        wet = wet * (1.0f - t) + c.delay_buf[r2] * t;
      }
      c.delay_buf[c.delay_write] = out[j] + wet * c.delay_feedback;
      if (++c.delay_write >= cap) c.delay_write = 0;
      out[j] = out[j] * (1.0f - c.delay_mix) + wet * c.delay_mix;
    }
    if (moving) c.delay_samples = to;
  }

  if (c.enabled & FX_EN_DRIVE) {
    const float step = (FX_DRIVE_LUT_SIZE - 1) / (2.0f * FX_DRIVE_LUT_RANGE);
    float g = c.drive_norm * c.drive_level;
    for (int j = 0; j < N; ++j) {
      float x = clampf(out[j] * c.drive_amount, -FX_DRIVE_LUT_RANGE,
                       FX_DRIVE_LUT_RANGE);
      float pos = (x + FX_DRIVE_LUT_RANGE) * step;
      int idx = (int)pos;
      if (idx >= FX_DRIVE_LUT_SIZE - 1) idx = FX_DRIVE_LUT_SIZE - 2;
      float frac = pos - (float)idx;
      float y = drive_lut_[idx] + (drive_lut_[idx + 1] - drive_lut_[idx]) * frac;
      out[j] = y * g;
    }
  }

  if (c.enabled & FX_EN_COMP) {
    // Envelope at block rate (1.3 ms at 48 kHz) — enough for glue and
    // ducking, not a brickwall limiter. The gain is lerped across the
    // block so the change itself never steps.
    float db = PeakDb(out);
    float over = db - c.comp_threshold_db;
    float target = over > 0.0f ? over * (1.0f - 1.0f / c.comp_ratio) : 0.0f;
    float coef = target > c.comp_reduction_db ? c.comp_attack_coef
                                              : c.comp_release_coef;
    c.comp_reduction_db = target + (c.comp_reduction_db - target) * coef;
    float gain = DbToGain(c.comp_makeup_db - c.comp_reduction_db);
    float from = c.comp_gain;
    float delta = (gain - from) / (float)N;
    for (int j = 0; j < N; ++j) out[j] *= from + delta * j;
    c.comp_gain = gain;
  }
}

float FxRack::ReverbTick(float x) {
  float input = x * kReverbInputGain;
  float sum = 0.0f;
  for (int i = 0; i < FX_NUM_COMBS; ++i) {
    float y = comb_buf_[i][comb_pos_[i]];
    comb_store_[i] = y * (1.0f - reverb_damping_) +
                     comb_store_[i] * reverb_damping_;
    comb_buf_[i][comb_pos_[i]] = input + comb_store_[i] * reverb_decay_;
    if (++comb_pos_[i] >= comb_len_[i]) comb_pos_[i] = 0;
    sum += y;
  }
  for (int i = 0; i < FX_NUM_ALLPASS; ++i) {
    float bufout = allpass_buf_[i][allpass_pos_[i]];
    float y = bufout - sum;
    allpass_buf_[i][allpass_pos_[i]] = sum + bufout * kAllpassFeedback;
    if (++allpass_pos_[i] >= allpass_len_[i]) allpass_pos_[i] = 0;
    sum = y;
  }
  return sum;
}

void FxRack::ProcessBlock(const float in[FX_CHANNELS][N], float *mix,
                          unsigned touched) {
  float duck_to = DuckGain(in);
  float duck_from = duck_gain_;
  float duck_delta = (duck_to - duck_from) / (float)N;
  duck_gain_ = duck_to;

  for (int j = 0; j < N; ++j) mix[j] = 0.0f;

  bool any_send = false;
  // Reused as the reverb's input bus; the channel loop fills it.
  float send_bus[N];
  for (int j = 0; j < N; ++j) send_bus[j] = 0.0f;

  // Tails that must keep being clocked even with nothing playing into them.
  const int kTailEffects = FX_EN_DELAY | FX_EN_SEND;

  for (int ch = 0; ch < FX_CHANNELS; ++ch) {
    FxChannel &c = chan_[ch];

    if (!(touched & (1u << ch)) && !(c.enabled & kTailEffects)) {
      // Silent, and nothing ringing. Contributes nothing to the mix; just
      // keep the compressor releasing so the next note does not land on a
      // gain reduction frozen from the last one.
      c.comp_reduction_db *= c.comp_release_coef;
      c.comp_gain = DbToGain(c.comp_makeup_db - c.comp_reduction_db);
      continue;
    }

    if (c.enabled) {
      ProcessChannel(c, in[ch], scratch_);
    } else {
      for (int j = 0; j < N; ++j) scratch_[j] = in[ch][j];
    }

    if ((c.enabled & FX_EN_SEND) && c.send_level > 0.0f) {
      any_send = true;
      for (int j = 0; j < N; ++j) send_bus[j] += scratch_[j] * c.send_level;
    }

    // The source of the duck is the one track that does not duck.
    if (ch == duck_source_) {
      for (int j = 0; j < N; ++j) mix[j] += scratch_[j];
    } else {
      for (int j = 0; j < N; ++j) mix[j] += scratch_[j] * (duck_from + duck_delta * j);
    }
  }

  // One shared reverb for the whole mix, fed by the sends. Eight per-track
  // reverbs is the one effect here whose cost would actually matter.
  if (any_send && reverb_level_ > 0.0f) {
    for (int j = 0; j < N; ++j) {
      mix[j] += ReverbTick(send_bus[j]) * reverb_level_;
    }
  }
}
