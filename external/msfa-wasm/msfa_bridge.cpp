// MSFA DX7 WASM bridge — clean C exports for AudioWorklet
// Based on MSFA by Google (Apache 2.0), patched for fmguessr

#include "synth_unit.h"
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

extern "C" {

void init_engine(int sample_rate) {
  Freqlut::init(sample_rate);
  Exp2::init();
  Sin::init();
  Lfo::init(sample_rate);
  PitchEnv::init(sample_rate);
  synth = new SynthUnit(&rb);
  // Default all channels to volume 100 (out of 127)
  for (int ch = 0; ch < 16; ch++) {
    SynthUnit::SetChannelVolume(ch, 100 * 256 / 127);
  }
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
  rb.Write(msg, 3);
}

void note_on(int note, int velocity) {
  uint8_t msg[3] = { 0x90, (uint8_t)note, (uint8_t)velocity };
  rb.Write(msg, 3);
}

void note_off(int note) {
  uint8_t msg[3] = { 0x80, (uint8_t)note, 0 };
  rb.Write(msg, 3);
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

int main() { return 0; }

}
