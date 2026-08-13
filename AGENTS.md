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
# Dev server (with COOP/COEP headers for SharedArrayBuffer)
python3 server.py                    # Serves on port 8000

# WASM synth build
make -f Makefile.msfa                # Build msfa.wasm (in html/synth/wasm/)
```

## Architecture

OpenPatches is a browser-based DX7 patch editor and sequencer. It communicates with the fmguessr inference server via REST API (see API.md).

**Frontend (Vanilla JS, no framework):**
- `html/app.js`: main orchestrator. Wires file input, menu bar, canvas, toolbar. Creates tick worker, `stopTickWorker` helper. PlayNote/playPatch with multi-channel support. Emergency stop with voice reload.
- `html/components/canvas.js`: Canvas — patches + PatchContainers on night-sky. Drag-to-reposition, snap-into-container, resize containers. State derived from linked Job. Uses `onDoc()` helper for document-level listeners with cleanup via `clearDocListeners()` on each `renderAll()` to prevent stale closures. All interactive elements in `#night-sky`, `.night-sky-canvas` is background only.
- `html/components/toolbar.js`: Unified Piano Roll + Keyboard panel with tabs: Canvas | Piano Roll | Edit | Log | Mute. Keyboard integrated into Piano Roll panel (recording controls + octave selector + piano keys below pianoroll grid). VoiceBank select dropdown. Undo button for recording. Mobile octave selector (0–7). Uses tick worker for precise playback/recording timing.
- `html/components/edit-panel.js`: Morph / Params / Random editing.
- `html/components/job.js`: Job class — steering object for WAV import lifecycle. Owns: probe → match → poll → complete/fail.
- `html/components/patch-model.js`: Unified data model + stores (localStorage). `patchStore`, `canvasStore`, `jobStore`.
- `html/components/patch-row.js`: Unified patch row rendering with star drag handle, mini spectrogram, assign/edit/remove buttons. Touch drag between containers with floating clone.
- `html/components/patch.js`: Waveform helpers only — `decodeWavSamples`, `drawMiniWaveform`, `wavSampleCache`.
- `html/components/voicebank.js`: Voice palette (8 slots). Persists to localStorage. Each entry has static channel assignment (0-7). Compact mode on mobile: vertical bars, tap to select, vertical drag for volume. Exposes `_render()` for re-rendering after class changes.
- `html/components/pianoroll.js`: Sequencer with looping. Notes store per-note `voiceData` and `channel`. Touch support: `TOUCH_RESIZE_MARGIN = 20`, visual resize handles, double-tap to delete. Long-press (1s) to create note when stopped, drag to scroll. Looping: double-wide canvas, content drawn twice for seamless loop. `handlePlaybackTick(col)` driven by tick worker. `setRecordingTickHandler` for recording delegation.
- `html/components/tag-editor.js`: Tag editor component with autocomplete.
- `html/components/tutorial.js`: First-run tutorial modal with overlay highlights. Skips clip-path on mobile.
- `html/synth/audio-manager.js`: Singleton AudioContext + AudioWorklet. `acquire()` creates once, `initAudio()` loads modules once. Multi-channel: `sendVoiceSnapshot()`, `playNoteOnChannel()`. `emergencyStop()` reinitializes MSFA engine. No malloc/free — uses static WASM buffers. `playNoteOnChannel` guards against stale note-off via self-reference check.
- `html/synth/tick-worker.js`: Web Worker heartbeat for pianoroll. Atomics.wait path (SharedArrayBuffer) for zero-CPU sleeping, setTimeout fallback. Absolute targeting (`t0 + col * msPer`), spin for sub-ms precision. Stop via `Atomics.store` + `Atomics.notify` (shared memory flag). Worker stays alive for reuse.
- `html/synth/dx7-synth.js`: Batch waveform rendering only (main thread WASM). No realtime synth code.
- `html/synth/dx7-processor.js`: AudioWorkletProcessor wrapping MSFA DX7 engine. Ring buffer (~300ms lookahead) for audio stability. Handles `voice-snapshot`, `midi`, `patch`, `play-samples`, `channel-volume`, `reinit` messages. MIDI logging via `logMidi` no-op (override to enable).
- WASM: `html/synth/wasm/msfa.wasm` (zig c++ build). Binary fetched on main thread, passed to AudioWorklet via `processorOptions`. Static buffers: `get_patch_buffer()`, `load_voice_from_buffer()`. Voice stealing with 64-sample fade-out.

**Layout (CSS Grid):**
- `#page-content`: CSS grid, `grid-template-rows: 1fr 1fr`, `height: calc(100vh - header - footer)`. Top half: night-sky, bottom half: piano dock.
- `#night-sky`: CSS grid (`grid-template: 1fr / 1fr`), `overflow: auto`. `.night-sky-canvas` is `grid-area: 1/1`, `pointer-events: none` (background only).
- `#piano-dock`: `overflow: auto`. Tab bar + active panel.
- Mobile (≤600px): `#page-content` is `display: block`. `#piano-dock` is `position: fixed`, full-screen below header. 5 tabs: Canvas | Piano Roll | Edit | Log | Mute. Hamburger menu.

**MSFA DX7 synth architecture (multitimbral):**
- 16 MIDI channels, 32 patch slots, 16 polyphonic voices, 16 LFOs.
- Fixed channel→slot mapping: channel N always reads from slot N. Set at init via `ProgramChange(ch, ch)`.
- `SetVoice(slot, data)` → `memcpy` into `patch_data_[slot*128]` + `UnpackPatch` into `unpacked_patch_[slot]` + LFO reset. Channel uses new patch immediately on next note-on.
- Default patch: silent INIT (all output levels 0). All 32 slots initialized with it.
- Note-on reads `unpacked_patch_[cmd_ch]` where `cmd_ch = MIDI_status & 0x0f`.
- VoiceBank → synth via `sendVoiceSnapshot(entries)`: worklet receives `voice-snapshot` message, loops `loadPatch(data, slot)` per entry. No ProgramChange needed.
- Preview: offline render on main thread (`offlineWasm`) + sample injection into worklet (`play-samples` message). Uses slot 0 / channel 0.
- Pianoroll playback: `playNoteOnChannel(channel, midi)` via worklet `send_midi(0x90 | ch, ...)`. Channel = VoiceBank array index.

**Deploy:** Docker via `deploy/Dockerfile` + `deploy/docker-compose.yml`. Caddy reverse proxy for static files + API proxy to fmguessr server. COOP + COEP headers enabled for SharedArrayBuffer support.
