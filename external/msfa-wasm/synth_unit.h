/*
 * Copyright 2012 Google Inc.
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *      http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "controllers.h"
#include "dx7note.h"
#include "fx.h"
#include "lfo.h"
#include "ringbuffer.h"
#include "resofilter.h"

struct ActiveNote {
  int midi_note;
  bool keydown;
  bool sustained;
  bool live;
  int channel;
  int fadeSamplesRemaining;
  Dx7Note *dx7_note;
};

class SynthUnit {
 public:
  static void Init(double sample_rate);

  explicit SynthUnit(RingBuffer *ring_buffer);
  ~SynthUnit();

  void GetSamples(int n_samples, int16_t *buffer);
  // Release every active note (keyup + 64-sample fade). Safe mid-render;
  // the voices die on the next GetSamples block. Patches, volumes and
  // controllers are untouched.
  void AllNotesOff();
  // Read per-channel pre-filter audio (int32, captured via save/diff in render loop).
  // Must be called after GetSamples. Buffer must hold at least n_samples int32s.
  void GetChannelSamples(int channel, int n_samples, int32_t *buffer);
  inline void SetVolume(int ch, int volume);
  // public static inline means any file can call this, and it has ZERO function call overhead
    static inline int32_t GetChannelVolume(int chan) {
        return channel_volumes_[chan];
    }

    // Call this from your tracker/UI thread to update volumes globally
    static inline void SetChannelVolume(int chan, int32_t vol) {
        channel_volumes_[chan] = vol;
    }

    void SetBank(const uint8_t *patch_data);
    void SetVoice(int slot, const uint8_t *voice_data);
    void GetBank(uint8_t *patch_data);

 private:
  void TransferInput();

  void ConsumeInput(int n_input_bytes);

  // Choose a note for a new key-down, returns note number, or -1 if
  // none available.
  int AllocateNote();

  // zero-based
  void ProgramChange(int p, int chan);

  void SetController(int controller, int value);

  int ProcessMidiMessage(const uint8_t *buf, int buf_size);

  RingBuffer *ring_buffer_;
  static const int max_active_notes = 32;
  ActiveNote active_note_[max_active_notes];
  int current_note_;
  uint8_t input_buffer_[8192];
  size_t input_buffer_index_;

  uint8_t patch_data_[4096];
  int current_patch_[16];
  static int32_t channel_volumes_[16];

  // Per-channel PRE-EFFECTS, pre-filter output buffers, accumulated across
  // the blocks of a single GetSamples call. This is a diagnostic read by
  // get_channel_samples(); nothing in the app mixes from it, so it is sized
  // for a test-sized render rather than for a whole offline chunk. It used
  // to be 200000 (12.8 MB of .bss) and the delay lines in FxRack are paid
  // for several times over by the reduction.
  static const int max_channel_samples = 8192; // ~0.19s at 44100
  int32_t channel_outputs_[16][max_channel_samples];
  int channel_samples_written_;

  // Scratch for the effects stage, one block wide. fx_rest_ holds what came
  // from channels 8..15 (in practice just the preview on 15), which the
  // effects never see; audiobuf is rebuilt as effected-mix + fx_rest_.
  // Accumulating the *rest* rather than the effected part keeps the extra
  // add out of the hot per-note inner loop in the common case.
  float fx_blk_[FX_CHANNELS][N];
  float fx_mix_[N];
  int32_t fx_rest_[N];
  char unpacked_patch_[16][156];

  // The original DX7 had one single LFO. Later units had an LFO per note.
  Lfo lfo_[16];

  // in MIDI units (0x4000 is neutral)
  Controllers controllers_;

  ResoFilter filter_;
  int32_t filter_control_[3];
  bool sustain_;

  // Extra buffering for when GetSamples wants a buffer not a multiple of N
  int16_t extra_buf_[N];
  int extra_buf_size_;
};
