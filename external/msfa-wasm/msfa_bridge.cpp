// MSFA DX7 WASM bridge — clean C exports for AudioWorklet
// Based on MSFA by Google (Apache 2.0), patched for fmguessr

#include "synth_unit.h"
#include "fx.h"
#include "ringbuffer.h"
#include "patch.h"
#include "freqlut.h"
#include "exp2.h"
#include "sin.h"

static RingBuffer rb;
static SynthUnit* synth = nullptr;

// Static pre-allocated buffers — no malloc/free from JS
static uint8_t g_patch_buffer[128];
static int16_t g_render_buffer[88200]; // max ~2s at 44100Hz
static int32_t g_channel_buffer[88200]; // per-channel capture, same chunk limit

// RingBuffer::Write blocks (nanosleep-spins) when full. In single-threaded
// WASM nothing can drain it while we spin, so a full buffer would hang the
// page. Drop the message instead — the buffer holds ~21k messages, so this
// only triggers under pathological queueing.
static bool write_midi(const uint8_t* msg, int size) {
  if (rb.WriteBytesAvailable() < size) return false;
  rb.Write(msg, size);
  return true;
}

extern "C" {

// Replace the engine with a fresh one: silences every voice, forgets every
// loaded patch, and drops any MIDI still queued in the ring buffer. Lookup
// tables, channel volumes and effect PARAMETERS are untouched; the effects'
// delay lines and reverb tails are dropped, because this is the emergency
// stop and it has to be silent. Cheap enough to call before every offline
// render — this is how renders are kept independent of one another.
void reset_engine() {
  delete synth;   // SynthUnit owns 16 Dx7Notes and the channel buffers
  synth = nullptr;
  rb.Reset();
  synth = new SynthUnit(&rb);
  fx_rack().ClearState();
}

void init_engine(int sample_rate) {
  Freqlut::init(sample_rate);
  Exp2::init();
  Sin::init();
  Lfo::init(sample_rate);
  PitchEnv::init(sample_rate);
  reset_engine();
  fx_rack().Init(sample_rate);
  // Default all channels to volume 100 (out of 127)
  for (int ch = 0; ch < 16; ch++) {
    SynthUnit::SetChannelVolume(ch, 100 * 256 / 127);
  }
}

// --- Effects ---
//
// Three exports carry every parameter, so adding an effect never means
// touching Makefile.msfa. The IDs live in fx_params.h, mirrored by
// html/synth/fx-params.js and guarded by test/fx-params-sync.test.js.

// Which effects run on a channel (FxEnable bitmask). All zero on every
// channel, with ducking off, is what puts the renderer on the bypass path.
void set_fx_enabled(int channel, int mask) {
  fx_rack().SetEnabled(channel, mask);
}

void set_fx_param(int channel, int param, float value) {
  fx_rack().SetParam(channel, param, value);
}

void set_global_fx_param(int param, float value) {
  fx_rack().SetGlobalParam(param, value);
}

// --- Static patch buffer accessors ---

// Returns pointer to the static 128-byte patch buffer
uint8_t* get_patch_buffer() {
  return g_patch_buffer;
}

// Load voice from the static patch buffer into bank slot 0
void load_voice_from_buffer() {
  if (!synth) return;
  synth->SetVoice(0, g_patch_buffer);
}

// Load voice from the static patch buffer into a specific bank slot
void load_voice_channel_from_buffer(int slot) {
  if (!synth) return;
  synth->SetVoice(slot, g_patch_buffer);
}

// --- Legacy: load from pointer (for batch renderer compat) ---

void load_voice(const uint8_t* voice_data) {
  if (!synth) return;
  synth->SetVoice(0, voice_data);
}

void load_voice_channel(int slot, const uint8_t* voice_data) {
  if (!synth) return;
  synth->SetVoice(slot, voice_data);
}

// --- MIDI ---

void send_midi(uint8_t status, uint8_t data1, uint8_t data2) {
  uint8_t msg[3] = { status, data1, data2 };
  write_midi(msg, 3);
}

void note_on(int note, int velocity) {
  uint8_t msg[3] = { 0x90, (uint8_t)note, (uint8_t)velocity };
  write_midi(msg, 3);
}

void note_off(int note) {
  uint8_t msg[3] = { 0x80, (uint8_t)note, 0 };
  write_midi(msg, 3);
}

// Immediate (not queued) release of every active note with the standard
// 64-sample fade. Patches, channel volumes and LUTs are untouched.
void all_notes_off() {
  if (!synth) return;
  synth->AllNotesOff();
}

void set_channel_volume(int channel, int volume) {
  if (!synth || channel < 0 || channel >= 16) return;
  if (volume < 0) volume = 0;
  if (volume > 127) volume = 127;
  SynthUnit::SetChannelVolume(channel, (int32_t)(volume * 256 / 127));
}

// --- Render ---

// Returns pointer to static render buffer (int16 samples)
int render_audio(int n_samples) {
  if (!synth) return 0;
  synth->GetSamples(n_samples, g_render_buffer);
  return (int)(uintptr_t)g_render_buffer;
}

// Per-channel pre-filter capture of the most recent render_audio() call.
// Returns pointer to int32 samples; n_samples is clamped to the render
// chunk limit and to what the last render actually produced.
int get_channel_samples(int channel, int n_samples) {
  if (!synth || channel < 0 || channel >= 16) return 0;
  if (n_samples > 88200) n_samples = 88200;
  synth->GetChannelSamples(channel, n_samples, g_channel_buffer);
  return (int)(uintptr_t)g_channel_buffer;
}

int main() { return 0; }

}
