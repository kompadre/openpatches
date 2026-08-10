# OpenPatches — Sound Archeology & FM Curation

OpenPatches is a next-generation platform for **Sound Archeology** and **FM Curation**, built around the legendary Yamaha DX7 synthesis engine.

Treat the DX7 not just as a static instrument, but as a living, searchable database of timbres. OpenPatches allows you to reverse-engineer audio, curate bespoke patch banks, and compose with iconic FM sounds entirely in your browser. expansion to more synths and drum machines is in the works!

**Live at:** [openpatch.es](https://openpatch.es)

---

## Why OpenPatches?

### 1. Sound Archeology
Recover the iconic bell, bass, and pad sounds from classic tracks. Using a sophisticated pipeline of Formant Analysis and Linear Approximation (powered by [fmguessr](https://github.com/kompadre/fmguessr)), OpenPatches reverse-engineers audio recordings back into constituent DX7 parameters.

### 2. Bespoke Curation (Digital Cartridges)
Archive and categorize patches into custom containers on a "night sky" canvas. Build bespoke sets of sounds and export them as standard `.syx` files, fully compatible with original hardware, modern clones, and software instruments like Dexed.

### 3. Advanced Iteration: Morph & Mutate
Move beyond simple preset browsing. Blend timbres with spectral morphing to find the "sweet spot" between sounds, or generate smart mutations while maintaining the core character of a patch.

### 4. Compositional Context: Multitimbral Pianoroll
Use the unique **8-channel multitimbral sequencer** to hear how your patches work together in realtime. Instant verification of how different FM timbres sit in a mix, rendered with high-fidelity via WebAssembly.

### 5. The FM Advantage
Experience the benefits of pure mathematical synthesis:
- **Spectral Purity:** Noiseless by nature, free from sample artifacts.
- **Perfect Pitch Scaling:** Sounds maintain their spectral proportions perfectly across all 127 MIDI notes.
- **Zero Footprint:** A 128-byte patch can replace megabytes of samples.

---

## Roadmap

OpenPatches is designed with a multi-engine architecture in mind. Future updates will include support for:
- **Classic Drum Machines:** Reverse-engineering analog and digital percussion.
- **Subtractive Synths:** Matching audio to oscillators, filters, and LFOs.
- **Custom Inference Models:** Support for user-provided approximation models.

---

## Tech Stack

- **Vanilla JavaScript:** Zero-dependency frontend architecture.
- **WebAssembly:** MSFA DX7 engine compiled to WASM (`zig c++ -target wasm32-wasi`).
- **AudioWorklet:** High-performance, low-latency realtime synthesis.
- **IndexedDB:** Privacy-first architecture; all session data and audio binaries live in your browser.

---

## Development

```bash
# Build the WASM synth
make -f Makefile.msfa

# Serve locally (any static server)
python3 -m http.server 8081

# Requires fmguessr server running on localhost:8080 for inference features
```

## Deployment

```bash
# Build and run with Docker
cd deploy
docker compose build
docker compose up
```

Requires the `fmguessr` inference server to be running for `/api/*` endpoints.

## License

MIT License — see [LICENSE](LICENSE)
