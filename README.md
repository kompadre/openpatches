# OpenPatches

Browser-based DX7 FM synthesizer patch editor, sequencer, and explorer.

**Live at:** [openpatch.es](https://openpatch.es)

## Features

- **Patch Editor** — Edit DX7 parameters (operators, envelopes, algorithms) in the browser
- **Patch Matching** — Import any `.wav` audio and find the closest DX7 patch via genetic algorithms (powered by [fmguessr](https://github.com/kompadre/fmguessr))
- **Piano Roll Sequencer** — Multi-measure sequencer with per-note patch assignment
- **Voice Bank** — 8-slot voice palette with drag-to-reorder, per-slot volume control
- **Morph** — Interpolate between two patches with spectral optimization
- **Real-time Preview** — Browser-based DX7 synth via WebAssembly AudioWorklet
- **SYX Export** — Export patches as DX7 SysEx bank files

## Tech Stack

- Vanilla JavaScript (no framework)
- MSFA DX7 engine compiled to WebAssembly (`zig c++ -target wasm32-wasi`)
- AudioWorklet for real-time synthesis
- Communicates with fmguessr server for patch inference (see [API.md](API.md))

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

Requires the fmguessr inference server to be running for `/api/*` endpoints.

## API

See [API.md](API.md) for the complete REST API contract used to communicate with the fmguessr inference backend.

## License

MIT License — see [LICENSE](LICENSE)
