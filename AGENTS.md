# AGENTS.md

## Rules
- Read enough context before editing. Don't creep offsets line-by-line.
- If Edit fails twice, stop and explain the issue.
- Verify JS changes with `node --check html/app.js`, `node --check html/components/*.js`, `node --check html/synth/*.js`.
- WASM build: `make -f Makefile.msfa` in `html/synth/wasm/` (uses `zig c++ -target wasm32-wasi`). Do NOT use emscripten.
- Never export `malloc`/`free` from WASM. Use static pre-allocated buffers (`get_patch_buffer()`, `load_voice_from_buffer()`).
- AudioManager is a singleton — `initAudio()` runs once. Never re-call `addModule()` after initial setup.
- Shutdown is disabled for testing — `shutdownAll()`, `setPianorollStop()`, `extendIdle()` are no-ops.
- Commit on task completion, once the user has verified the fix is correct.
- Match existing code style in each file. Don't introduce conventions that conflict with neighbors.
- Use `pianoDockWrapper` (module-scoped in app.js) to access `_voiceBank`, `_pianoroll`, `_showLog` — NOT `document.getElementById('piano-dock')` which returns the outer container, not the inner wrapper.
- VoiceBank assigns colors by slot index (PATCH_COLORS[8]). Pianoroll receives color via `setActivePatch(id, data, color, channel)` — always pass `entry.color` from voicebank.
- VoiceBank channel = array index. Entries have no `channel` property. Slot IS the channel.

## Git & Version Control Rules

- **NEVER alter Git history.** Under no circumstances should you run `git rebase`, `git commit --amend`, `git reset`, `git cherry-pick`, or perform any commit squashing/history modifications.
- **Append-only commits:** All changes must strictly be committed as NEW, additive commits on top of the current branch.
- **No speculative or broken commits:** Only commit when the code is verified, working, and builds/runs without errors.
- **Clear commit messages:** Write short, descriptive commit messages summarizing the actual functional changes made.

## Commands

```bash
# WASM synth build
make -f Makefile.msfa          # Build msfa.wasm (in html/synth/wasm/)
```

## Architecture

OpenPatches is a browser-based DX7 patch editor and sequencer. It communicates with the fmguessr inference server via REST API (see API.md).

**Frontend (Vanilla JS, no framework):**
- `html/app.js`: main orchestrator (~600 lines). Wires file input, menu bar, canvas, toolbar. PlayNote/playPatch with multi-channel support.
- `html/components/canvas.js`: Canvas — patches + PatchContainers on night-sky. Drag-to-reposition, snap-into-container, resize containers. State derived from linked Job. Uses `onDoc()` helper for document-level listeners with cleanup via `clearDocListeners()` on each `renderAll()` to prevent stale closures.
- `html/components/toolbar.js`: Bottom panel with tabs: Canvas | Piano Roll | Edit | Log. Keyboard is integrated into the Piano Roll panel (recording controls + piano keys below the pianoroll grid). On mobile (≤600px): 4 full-screen tabs, piano dock becomes main viewport. VoiceBank compact mode with vertical bars.
- `html/components/edit-panel.js`: Morph / Params / Random editing.
- `html/components/job.js`: Job class — steering object for WAV import lifecycle. Owns: probe → match → poll → complete/fail.
- `html/components/patch-model.js`: Unified data model + stores (localStorage). `patchStore`, `canvasStore`, `jobStore`.
- `html/components/patch-row.js`: Unified patch row rendering with star drag handle, mini spectrogram, assign/edit/remove buttons.
- `html/components/patch.js`: Waveform helpers only — `decodeWavSamples`, `drawMiniWaveform`, `wavSampleCache`.
- `html/components/voicebank.js`: Voice palette (8 slots). Persists to localStorage. Each entry has static channel assignment (0-7). Compact mode on mobile: vertical bars, tap to select, vertical drag for volume. Exposes `_render()` for re-rendering after class changes (e.g. adding `compact`).
- `html/components/pianoroll.js`: Sequencer. Notes store per-note `voiceData` and `channel`. Error counter stops after 3 failures. Touch support: `TOUCH_RESIZE_MARGIN = 20` for finger-friendly resize, visual resize handles on active notes, double-tap to delete.
- `html/components/tutorial.js`: First-run tutorial modal with overlay highlights.
- `html/synth/audio-manager.js`: Singleton AudioContext + AudioWorklet. `acquire()` creates once, `initAudio()` loads modules once. Multi-channel: `sendVoiceSnapshot()`, `playNoteOnChannel()`. No malloc/free — uses static WASM buffers.
- `html/synth/dx7-synth.js`: Batch waveform rendering only (main thread WASM). No realtime synth code.
- `html/synth/dx7-processor.js`: AudioWorkletProcessor wrapping MSFA DX7 engine. Handles `voice-snapshot`, `midi`, `patch`, `play-samples`, `channel-volume` messages.
- WASM: `html/synth/wasm/msfa.wasm` (zig c++ build). Binary fetched on main thread, passed to AudioWorklet via `processorOptions`. Static buffers: `get_patch_buffer()`, `load_voice_from_buffer()`. Voice stealing with 64-sample fade-out.

**MSFA DX7 synth architecture (multitimbral):**
- 16 MIDI channels, 32 patch slots, 16 polyphonic voices, 16 LFOs.
- Fixed channel→slot mapping: channel N always reads from slot N. Set at init via `ProgramChange(ch, ch)`.
- `SetVoice(slot, data)` → `memcpy` into `patch_data_[slot*128]` + `UnpackPatch` into `unpacked_patch_[slot]` + LFO reset. Channel uses new patch immediately on next note-on.
- Default patch: silent INIT (all output levels 0). All 32 slots initialized with it.
- Note-on reads `unpacked_patch_[cmd_ch]` where `cmd_ch = MIDI_status & 0x0f`.
- VoiceBank → synth via `sendVoiceSnapshot(entries)`: worklet receives `voice-snapshot` message, loops `loadPatch(data, slot)` per entry. No ProgramChange needed.
- Preview: offline render on main thread (`offlineWasm`) + sample injection into worklet (`play-samples` message). Uses slot 0 / channel 0.
- Pianoroll playback: `playNoteOnChannel(channel, midi)` via worklet `send_midi(0x90 | ch, ...)`. Channel = VoiceBank array index.

**Deploy:** Docker via `deploy/Dockerfile` + `deploy/docker-compose.yml`. Caddy reverse proxy for static files + API proxy to fmguessr server.
