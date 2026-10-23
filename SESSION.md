# SESSION.md

Living project state. Agents own this file: update it as the codebase and the
work-in-progress change. AGENTS.md holds the durable rules; everything that
drifts belongs here.

## Current Tasks & Goals

_(Keep a short list of what is in flight, what is done, and what is blocked.
Replace entries as work completes — this is a working set, not a changelog.)_

Bug survey 2026-10-23 (all confirmed by code trace, none fixed yet). Ordered by severity:

- [ ] `job.js complete()` reads `ctr` once, calls `addPatchToContainer()` per patch (each re-reads + saves), then `putContainer(ctr)` with the stale copy → `patchIds` reset to `[]`. Assign/Export/Sort see no patches; `restore()` re-runs `complete()` every reload.
- [x] `dx7-params.js` byte 13 KVS/AMS swap — fixed, `test/dx7-params-kvs-ams.test.js`.
- [x] Tick-worker restart race — fixed with a generation counter (`startTickWorker`/`stopTickWorker` in app.js, `startWorker` opt in toolbar/pianoroll), `test/tick-worker-restart.test.js`. Record now stops playback first; pianoroll Play is a no-op while recording.
- [ ] Keyboard `mouseleave` always fires `handleEnd` → `stopNoteFn` note-off even if key wasn't pressed; sweeping the mouse cuts sequencer notes on the active slot. `activeSounds` is never populated because `playNote` returns undefined.
- [ ] Key released before `acquire()` resolves → `stopNoteFn` skipped (`isReady()` false) → 30 s stuck note.
- [ ] `audio-manager initAudio()` never clears `initPromise`/`ctx` on rejection → one failed load kills audio until reload. Also ready-handshake resolves unconditionally after 2 s.
- [ ] Menu "Emergency stop" (app.js) reinits engine but never re-sends voice snapshot or channel volumes → silent INIT patches. Persisted volumes are never pushed to synth on load either.
- [ ] `voicebank.js` `entry.volume || DEFAULT_VOLUME` treats 0 as unset (UI shows 100 while muted). Colors not reassigned after splice/remove; drop color computed before index clamp. Removing a slot shifts channels but pianoroll notes keep old `slot`.
- [ ] `patch-row.js` touch drag: `isOutside` latches → drag out and back in creates a clone; no `touchcancel` handlers (also canvas.js, pianoroll.js) leave stale drag state. Touch reorder writes `ctr.patchIds` but grouped containers render `group.patchIds`.
- [ ] `canvas.js` floating-patch `handleEnd` ignores `didMove` → tap on header absorbs patch into any overlapping container. `addPatchToContainer` onto a grouped container makes the patch invisible.
- [ ] `removeContainer` leaves job in `jobStore`, polling continues and resumes on reload.
- [ ] `edit-panel.js`: `createTagEditor(editSlot)` throws when A removed while B set; `status.textContent` typo (→ `statusEl`) in Random error path; Params Save stores stale `algorithm`/`feedback` metadata; shared slider clamps value on mode switch; Save requires `/api/play`.
- [ ] `pianoroll.js` hit-testing ignores loop wrap (second copy unclickable, creates duplicates); Stop doesn't `releaseAllNotes()`; notes can extend past loop end; Play button label desyncs on empty roll.
- [ ] Listener leaks: `makeStarDraggable` document mouseup, more-menu document click (not via `onDoc`), `initCanvas` re-registers drop/`touch-drop-patch` handlers per call.
- [ ] `dx7-processor` `fillRingBuffer()` after MIDI is a no-op (ring always full) → fixed ~300 ms latency on every note.
- [x] `msfa_bridge.cpp init_engine()` SynthUnit leak (~13 MB per preview) — fixed: `SynthUnit` destructor, `RingBuffer::Reset()`, new `reset_engine()` export; `renderOffline` and `batchRenderWaveforms` call it per render. WASM rebuilt. `test/wasm-engine-reset.test.js`.
- [x] Canvas thumbnails identical on load, correct after preview — same root cause: `batchRenderWaveforms` rendered patches back-to-back with no note-off and no engine reset, so each thumbnail contained every earlier patch still ringing (up to 16 voices). Preview re-initialised the engine, hence the "fix on preview". Fixed by the per-patch `reset_engine()` above.
- [ ] Minor: WAV import doesn't reset `fileInput.value`; WAV decoder requires `data` right after `fmt`; syx parser skips format/checksum; patch IDs hash voice_data so duplicate voices collide; `createObjectURL` never revoked; "Start Matching" not disabled on click; fixed-mode freq display formula wrong.

## Open Questions / Gotchas In Flight

_(Things discovered mid-task that the next agent needs to know, but that aren't
yet stable enough to be an AGENTS.md rule.)_

## Architecture

OpenPatches is a browser-based DX7 patch editor and sequencer. It communicates with the fmguessr inference server via REST API (see API.md).

**Frontend (Vanilla JS, no framework):**
- `html/app.js`: main orchestrator. Wires file input, menu bar, canvas, toolbar. Creates tick worker, `stopTickWorker` helper. PlayNote/playPatch with multi-channel support. Emergency stop with voice reload.
- `html/components/canvas.js`: Canvas — patches + PatchContainers on night-sky. Drag-to-reposition, snap-into-container, resize containers. State derived from linked Job. Uses `onDoc()` helper for document-level listeners with cleanup via `clearDocListeners()` on each `renderAll()` to prevent stale closures. All interactive elements in `#night-sky`.
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
- `html/synth/tick-worker.js`: Web Worker heartbeat for pianoroll. Atomics.wait path (SharedArrayBuffer) for zero-CPU sleeping, setTimeout fallback. Absolute targeting (`t0 + col * msPer`), spin for sub-ms precision. Start/stop via a generation counter in shared memory (`Int32Array[0]`): app.js `startTickWorker`/`stopTickWorker` bump it + `Atomics.notify`; a loop exits when the counter moves, and a `start` whose `gen` is outdated is ignored. Always start through `opts.startWorker`, never raw `postMessage`. Worker stays alive for reuse.
- `html/synth/dx7-synth.js`: Batch waveform rendering only (main thread WASM). No realtime synth code.
- `html/synth/dx7-processor.js`: AudioWorkletProcessor wrapping MSFA DX7 engine. Ring buffer (~300ms lookahead) for audio stability. Handles `voice-snapshot`, `midi`, `patch`, `play-samples`, `channel-volume`, `reinit` messages. MIDI logging via `logMidi` no-op (override to enable).
- WASM: `html/synth/wasm/msfa.wasm` (zig c++ build). Binary fetched on main thread, passed to AudioWorklet via `processorOptions`. Static buffers: `get_patch_buffer()`, `load_voice_from_buffer()`. Voice stealing with 64-sample fade-out. `init_engine(sr)` once per instance (builds LUTs, sets volumes); `reset_engine()` before every offline render — deletes and recreates the SynthUnit and clears the MIDI ring buffer so renders are independent and memory stays flat. The main-thread renderers (`dx7-synth.js`, `audio-manager.js` offline path) each hold their own instance.

**Layout (CSS Grid):**
- `#page-content`: CSS grid, `grid-template-rows: 1fr 1fr`, `height: calc(100vh - header - footer)`. Top half: night-sky, bottom half: piano dock.
- `#night-sky`: CSS grid (`grid-template: 1fr / 1fr`), `overflow: auto`. Background, border, and border-radius applied directly. `pointer-events` managed on children.
- `#piano-dock`: `overflow: auto`. Tab bar + active panel.
- Mobile (≤600px): `#page-content` is `display: block`. `#piano-dock` is `position: fixed`, full-screen below header. 5 tabs: Canvas | Piano Roll | Edit | Log | Mute. Hamburger menu.

**MSFA DX7 synth architecture (multitimbral):**
- 16 MIDI channels, 32 patch slots, 16 polyphonic voices, 16 LFOs.
- Fixed channel→slot mapping: channel N always reads from slot N. Set at init via `ProgramChange(ch, ch)`.
- `SetVoice(slot, data)` → `memcpy` into `patch_data_[slot*128]` + `UnpackPatch` into `unpacked_patch_[slot]` + LFO reset. Channel uses new patch immediately on next note-on.
- Default patch: silent INIT (all output levels 0). All 32 slots initialized with it.
- Note-on reads `unpacked_patch_[cmd_ch]` where `cmd_ch = MIDI_status & 0x0f`.
- VoiceBank → synth via `sendVoiceSnapshot(entries)`: worklet receives `voice-snapshot` message, loops `loadPatch(data, slot)` per entry. No ProgramChange needed.
- Preview: offline render on main thread (`offlineWasm`) + sample injection into worklet (`play-samples` message).
- Realtime preview (`playNoteRealtime`) uses the dedicated preview slot/channel 15 — never slots 0-7, which belong to the VoiceBank.
- Pianoroll playback: `playNoteOnChannel(channel, midi)` via worklet `send_midi(0x90 | ch, ...)`. Channel = VoiceBank array index.

**Deploy:** Docker via `deploy/Dockerfile` + `deploy/docker-compose.yml`. Caddy reverse proxy for static files + API proxy to fmguessr server. COOP + COEP headers enabled for SharedArrayBuffer support.
