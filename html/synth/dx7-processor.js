// DX7 AudioWorkletProcessor — WASM via processorOptions
// Based on MSFA by Google (Apache 2.0), patched for openpatches

const logMidi = () => {};

const wasiStub = {
  fd_close: () => 0,
  fd_fdstat_get: () => 0,
  fd_seek: () => 0,
  fd_write: () => 0,
  poll_oneoff: () => 0,
  proc_exit: () => {},
};

class DX7Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.bufsize = 128;
    this.sr = sampleRate;
    this.ready = false;
    this.hasError = false;

    // Ring buffer for pre-rendered audio (~300ms lookahead)
    this.bufferMs = 300;
    this.ringBlocks = Math.ceil((this.sr * this.bufferMs / 1000) / this.bufsize);
    this.ringSize = this.ringBlocks * this.bufsize;
    this.ringBuffer = new Float32Array(this.ringSize);
    this.ringWrite = 0;
    this.ringRead = 0;
    this.ringAvailable = 0;

    // Preview playback state (fed from main-thread offline render)
    this.previewBuffer = null;
    this.previewPos = 0;
    this.previewRemaining = 0;

    this.port.onmessage = this.handleMessage.bind(this);

    const wasmBytes = options.processorOptions?.wasmBytes;
    if (wasmBytes) {
      this._init(wasmBytes);
    } else {
      this.hasError = true;
      console.error('[DX7] No wasmBytes in processorOptions');
    }
  }

  async _init(wasmBytes) {
    try {
      const { instance } = await WebAssembly.instantiate(wasmBytes, {
        wasi_snapshot_preview1: wasiStub,
      });
      this.exp = instance.exports;
      this.heapI16 = new Int16Array(this.exp.memory.buffer);

      this.exp.init_engine(this.sr);

      this.patchPtr = this.exp.get_patch_buffer();
      this.patchView = new Uint8Array(this.exp.memory.buffer, this.patchPtr, 128);

      this.ready = true;
      this.port.postMessage({ type: 'ready' });
      this.fillRingBuffer();

      if (this._pending) {
        for (const msg of this._pending) this.handleMessage(msg);
        this._pending = null;
      }
    } catch (err) {
      this.hasError = true;
      console.error('[DX7] WASM init failed:', err);
      this.port.postMessage({ type: 'error', error: err.message });
    }
  }

  refreshHeap() {
    if (this.heapI16.buffer !== this.exp.memory.buffer) {
      this.heapI16 = new Int16Array(this.exp.memory.buffer);
      this.patchView = new Uint8Array(this.exp.memory.buffer, this.patchPtr, 128);
    }
  }

  // Pre-render blocks into the ring buffer
  fillRingBuffer() {
    if (!this.ready || this.hasError) return;
    // Fill until we have at least ringBlocks worth of audio ahead
    while (this.ringAvailable < this.ringSize) {
      const ptr = this.exp.render_audio(this.bufsize);
      if (!ptr) break;
      this.refreshHeap();
      const i16base = ptr >> 1;
      for (let i = 0; i < this.bufsize; i++) {
        this.ringBuffer[this.ringWrite] = this.heapI16[i16base + i] * (1.0 / 32768.0);
        this.ringWrite = (this.ringWrite + 1) % this.ringSize;
      }
      this.ringAvailable += this.bufsize;
    }
  }

  handleMessage(e) {
    if (!this.ready) {
      if (!this._pending) this._pending = [];
      this._pending.push(e);
      return;
    }
    const msg = e.data;
    switch (msg.type) {
      case 'patch':
        this.loadPatch(msg.data, msg.slot || 0);
        break;
      case 'voice-snapshot':
        // Load all voices from VoiceBank: [{slot, data}]
        // Channel N always maps to slot N — no ProgramChange needed
        if (Array.isArray(msg.voices)) {
          for (const v of msg.voices) {
            this.loadPatch(v.data, v.slot);
          }
        }
        break;
      case 'midi':
      case 'raw-midi':
        if (msg.data[0] >= 0x80 && msg.data[0] <= 0x9f) {
          const status = msg.data[0] & 0xf0;
          const ch = msg.data[0] & 0x0f;
          const note = msg.data[1];
          const vel = msg.data[2];
          const type = status === 0x90 ? 'note-on' : 'note-off';
          logMidi(`[wasm-midi] ${type} ch=${ch} note=${note} vel=${vel}`);
        }
        this.exp.send_midi(msg.data[0], msg.data[1], msg.data[2]);
        // Pre-render a few blocks so the note starts immediately
        this.fillRingBuffer();
        break;
      case 'play-samples':
        // Overwrite any active preview, reset position
        this.previewBuffer = msg.samples;
        this.previewPos = 0;
        this.previewRemaining = msg.samples.length;
        break;
      case 'channel-volume':
        if (this.exp.set_channel_volume) {
          this.exp.set_channel_volume(msg.channel, msg.volume);
        }
        break;
      case 'reinit':
        // Emergency stop: reinitialize the MSFA engine
        if (this.exp && this.exp.init_engine) {
          this.exp.init_engine(this.sr);
          this.patchPtr = this.exp.get_patch_buffer();
          this.patchView = new Uint8Array(this.exp.memory.buffer, this.patchPtr, 128);
          // Clear ring buffer
          this.ringWrite = 0;
          this.ringRead = 0;
          this.ringAvailable = 0;
          // Clear preview
          this.previewBuffer = null;
          this.previewPos = 0;
          this.previewRemaining = 0;
        }
        break;
    }
  }

  loadPatch(data, slot) {
    const voice = new Uint8Array(data);
    if (voice.length < 128) return;
    this.refreshHeap();
    this.patchView.set(voice.subarray(0, 128));
    if (slot > 0 && this.exp.load_voice_channel_from_buffer) {
      this.exp.load_voice_channel_from_buffer(slot);
    } else {
      this.exp.load_voice_from_buffer();
    }
  }

  process(inputs, outputs) {
    if (!this.ready || this.hasError) return true;

    const out = outputs[0][0];

    // Read from ring buffer
    if (this.ringAvailable >= this.bufsize) {
      for (let i = 0; i < this.bufsize; i++) {
        let sample = this.ringBuffer[this.ringRead];

        if (this.previewRemaining > 0) {
          sample = sample * 0.5 + this.previewBuffer[this.previewPos++] * 0.5;
          this.previewRemaining--;
        }

        out[i] = sample;
        this.ringRead = (this.ringRead + 1) % this.ringSize;
      }
      this.ringAvailable -= this.bufsize;
    } else {
      // Ring buffer underrun — render directly as fallback
      const ptr = this.exp.render_audio(this.bufsize);
      if (ptr) {
        this.refreshHeap();
        const i16base = ptr >> 1;
        for (let i = 0; i < this.bufsize; i++) {
          let sample = this.heapI16[i16base + i] * (1.0 / 32768.0);
          if (this.previewRemaining > 0) {
            sample = sample * 0.5 + this.previewBuffer[this.previewPos++] * 0.5;
            this.previewRemaining--;
          }
          out[i] = sample;
        }
      } else {
        out.fill(0);
      }
    }

    // Pre-render to keep ring buffer topped
    this.fillRingBuffer();

    // Clean up references when the clip finishes
    if (this.previewRemaining === 0 && this.previewBuffer) {
      this.previewBuffer = null;
    }

    return true;
  }
}

try {
  registerProcessor('dx7-synth', DX7Processor);
} catch (e) {
  // Already registered in this scope (browser caches module execution across contexts)
}
