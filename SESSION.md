# SESSION.md

Living project state. Agents own this file: update it as the codebase and the
work-in-progress change. AGENTS.md holds the durable rules; everything that
drifts belongs here.

## Current Tasks & Goals

_(Keep a short list of what is in flight, what is done, and what is blocked.
Replace entries as work completes — this is a working set, not a changelog.)_

### Feature: Web MIDI (4 phases)

Plan agreed 2026-10-25. Three features: record from a MIDI keyboard, play the
pianoroll out to hardware, upload SYX banks. MIDI access is requested lazily,
only when a feature needs it, and SysEx is a separate upgrade on top.

- [x] **Phase 1 — access, device selection, panic.** `html/synth/midi-manager.js`
  (singleton, mirrors audio-manager), `html/components/midi-panel.js` (settings
  modal + guarded bank-send flow), MIDI menu + footer status dot, container
  "Send to device" button. Bulk transport (`receiveBank`/`sendBank`) is a
  deliberate stub that drives the progress UI then rejects. `test/midi-manager.test.js`.
- [x] **Phase 2 — MIDI in → recording.** Per-key closures in `toolbar.js`
  replaced by shared `noteOn(midi, velocity, when)` / `noteOff(midi, when)` /
  `releaseAllHeld()`, driven by both the on-screen keys and
  `handleMidiMessage`. Velocity-0 note-on = note-off; CC 120/123 release
  everything; system messages (status ≥ 0xF0) ignored. Recorder switched to
  `performance.now()` so `MIDIMessageEvent.timeStamp` is used directly. Omni /
  channel-N input filter persisted in midi-manager. Notes outside the C2–C6
  grid are **octave-folded** into range (note-on and note-off fold identically,
  so nothing sticks). MIDI activity lamp in the recording controls.
  `test/midi-input-recording.test.js`.
- [x] **Phase 3 — playback → MIDI out.** Fan-out in app.js `playNote()`
  (`joinStops` merges the internal + MIDI stop functions) and `stopNoteFn`.
  Output mode Internal / MIDI / Both, default Internal; "MIDI only" with no
  reachable device falls back to the internal synth rather than going silent.
  Per-slot → channel map, identity default, free-form — **no monotimbral
  special-casing**: a monotimbral synth ignores channels it is not set to,
  which is harmless. Patch previews stay internal regardless of mode (nothing
  is loaded on the device to preview with until Phase 4). Note-offs for piano
  roll notes are **timestamped** `time + OUTPUT_LATENCY_MS + durMs - NOTE_OFF_GAP_MS`
  (2 ms gap so a repeat of the same pitch is not cut); held keys pass
  `{sustained:true}` and are released explicitly instead, since their 30 s is a
  safety value not a duration. `test/midi-output-routing.test.js`,
  `test/pianoroll-stop-release.test.js`.
- [x] **Output latency (2026-10-28).** Bench-tested against a Korg Volca FM:
  unstamped MIDI reached the hardware ~⅓ s before the internal synth sounded
  the same note, so "both" mode flammed. The latency is a persisted setting
  (`getOutputLatency`/`setOutputLatency`, clamped 0..`MAX_OUTPUT_LATENCY_MS`
  = 1000, default `DEFAULT_OUTPUT_LATENCY_MS` = 317) applied in exactly one
  place, `sendAt()`; every note-path message goes through it: note-on,
  scheduled note-off, `stop()`, `stopNoteOut`, `releaseAllOut`, raw `send()`,
  and panic's second sweep. The invariant the
  tests guard is **no note-off may reach the wire ahead of its own note-on**
  (shifting only the note-on, the first attempt, stuck every note shorter
  than 317 ms). `panic()` sends its 32 CCs twice: unstamped (so it still goes
  out on `pagehide`) and again at `+OUTPUT_LATENCY_MS` to catch note-ons
  queued in the window — Chrome never implemented `MIDIOutput.clear()`.
  SysEx (edit buffer, bank, dump request) stays unstamped on purpose: the
  audition VCED gets a 317 ms head start on its ~50 ms wire time.
  `sendNoteOnChannel` takes a `time` option (performance.now() clock,
  default now) that the note-on, note-off and bookkeeping timer are all
  relative to — the hook Phase 3b note-on scheduling will use. Tests: the
  `output latency` block in `test/midi-output-routing.test.js` pins
  `performance.now` for exact stamps.
- [x] **Latency calibration UI (2026-10-28).** "Output latency" field in the
  MIDI settings modal: range slider + number box + Default button writing
  through live, and a **test tone** loop — once a second `playTestNote`
  (app.js: INIT VOICE via `playNoteRealtime` on the preview channel) sounds
  locally while `midi.playLatencyProbe()` sends the same note to the device's
  basic channel, exactly as a piano-roll note is. The probe's `onWire`
  callback fires at `+latency`, i.e. when the note-on leaves, and the modal
  lights `.midi-latency-flash` on it (no transition in, short fade out). The
  user is told to slide until the flash lands on the tone from the speakers;
  with audition on the device gets the same INIT VOICE (`testVoiceData`) so
  the two notes can be heard fusing. `prepareTestNote` (= `acquire`) warms
  the synth before the first tick. The panel receives all of this via opts,
  toolbar-style, so it stays importable under the harness; the loop is torn
  down on Stop and on modal close. `test/midi-latency-calibration.test.js`.
- [x] **Modals scroll (2026-10-28).** `.modal-dialog` is now `max-height: 88vh`
  + column flex, `.modal-body` is `flex: 1 1 auto; min-height: 0; overflow-y:
  auto` (the `min-height: 0` is the part that actually enables the scroll).
  The MIDI settings grew past the viewport once the latency block landed and
  the top and bottom were unreachable. Shared shell, so every modal benefits.
- [x] **SysEx escalation on reload (2026-10-28).** `auditionEnabled` is
  persisted but the permission tier is not, so a returning user got the box
  ticked on top of a plain `{sysex:false}` grant: auditioning silently did
  nothing and the only cure was untick → retick. Two-part fix: the panel's
  **Enable MIDI** now requests `{sysex: getAuditionEnabled()}`, so the saved
  settings decide the tier and a first-time user still sees the weak prompt;
  and `midi.auditionNeedsSysex()` (audition on + a grant held + not sysex)
  drives a `.midi-sysex-warning` row with a **Grant SysEx** button for the
  cases the pre-request cannot cover (MIDI enabled before audition was
  switched on, or the prompt dismissed). `refresh()` re-syncs the checkbox
  from `getAuditionEnabled()` so the UI cannot drift from the real state.
  `test/midi-panel-permissions.test.js`.
- [ ] **Phase 3b (later, as agreed)** — note-on scheduling (the `time` option
  on `playNoteOut` is already in place), and letting the user declare (or
  autodetect) that a device is multitimbral.
- [x] **Phase 4 — SysEx bulk transport + live audition.**
  `html/components/syx-builder.js` is the write side of syx-parser: bulk dump,
  single-voice edit-buffer dump, dump request, `sysexChecksum`,
  `validateBulkDump`, `unpackVoice` (packed 128 → VCED 155, built on
  dx7-params' `readOp`/`readGlobal` so bit layouts have one authority) and a
  programmatically-built `makeInitVoice()` for padding. Real `receiveBank`
  (dump request + SysEx collector that reassembles split messages, ignores
  unrelated SysEx, validates the checksum) and `sendBank` (one message, no
  chunking; progress estimated from the 31250-baud byte rate since MIDI gives
  no completion signal). Audition sends a VCED to the device's edit buffer,
  deduped by content, then plays on the device channel — wired into
  `playNote`'s preview path, `playPatch`, and edit-panel's
  `playVoiceDataLocally`. `test/syx-builder.test.js`,
  `test/midi-sysex-transport.test.js`.
- [x] `HEARME.tts` updated: new Chapter Eleven on Web MIDI (old Chapter Eleven
  renumbered to Twelve), preamble hash/date refreshed to `1cd2ea1`.

Bug survey 2026-10-23 (all confirmed by code trace, none fixed yet). Ordered by severity:

- [ ] `job.js complete()` reads `ctr` once, calls `addPatchToContainer()` per patch (each re-reads + saves), then `putContainer(ctr)` with the stale copy → `patchIds` reset to `[]`. Assign/Export/Sort see no patches; `restore()` re-runs `complete()` every reload.
- [x] `dx7-params.js` byte 13 KVS/AMS swap — fixed, `test/dx7-params-kvs-ams.test.js`.
- [x] Tick-worker restart race — fixed with a generation counter (`startTickWorker`/`stopTickWorker` in app.js, `startWorker` opt in toolbar/pianoroll), `test/tick-worker-restart.test.js`. Record now stops playback first; pianoroll Play is a no-op while recording.
- [x] Keyboard `mouseleave` note-off for unpressed keys — fixed in Phase 2: a `heldNotes` set gates `noteOff`, so a mouse sweep emits nothing. `activeSounds` now populates because `playNote` returns a stop function (`withTimeout` in app.js wraps it with the safety timer and cancels the timer on explicit release).
- [x] Key released before `acquire()` resolves → 30 s stuck note — fixed in Phase 2: if the key is already up when the async stop function arrives, `noteOn` calls it immediately instead of storing it.
- [x] `audio-manager initAudio()` never cleared `initPromise`/`ctx` on rejection — fixed: a `.catch` on the init promise tears down `ctx`/`dx7Node`/diff caches and sets state `closed`, so the next `acquire()` retries. Remaining: the ready-handshake still resolves unconditionally after 2 s (deliberate fallback, left alone).
- [x] Menu "Emergency stop" never re-sent snapshot/volumes — fixed: shared `doEmergencyStop()` in app.js re-sends the snapshot on both paths, and worklet `reinit` now calls `reset_engine()` (channel volumes are static in WASM and survive). Remaining: persisted volumes still aren't pushed to the synth on initial page load.
- [x] Persisted channel volumes never pushed on initial load — fixed: `sendVoiceSnapshot` now sends `channel-volume` per slot, diffed via `lastSentVolume` (also updated by `setChannelVolume`, so the drag path doesn't cause a redundant push). `test/channel-volume-snapshot.test.js`.
- [x] `voicebank.js` volume 0 treated as unset (`||` → `??`, incl. the `loadState` backfill) and colors not reassigned after splice — fixed with `reindexColors()` at the top of `render()`. `test/voicebank-slot-state.test.js`. Remaining in this area: drop color computed before index clamp; removing a slot shifts channels but pianoroll notes keep their old `slot`.
- [ ] `patch-row.js` touch drag: `isOutside` latches → drag out and back in creates a clone; no `touchcancel` handlers (also canvas.js, pianoroll.js) leave stale drag state. Touch reorder writes `ctr.patchIds` but grouped containers render `group.patchIds`.
- [ ] `canvas.js` floating-patch `handleEnd` ignores `didMove` → tap on header absorbs patch into any overlapping container. `addPatchToContainer` onto a grouped container makes the patch invisible.
- [x] `removeContainer` left the job in `jobStore` — fixed: it now calls `jobManager.stop()` + `jobStore.remove()` alongside the IndexedDB delete. (canvas.js now imports job.js, which already imported canvas.js — a deliberate ESM cycle; both sides only read the binding inside functions.)
- [ ] `edit-panel.js`: Params Save stores stale `algorithm`/`feedback` metadata; shared slider clamps value on mode switch; Save requires `/api/play`. (`createTagEditor(null)` throw and the `status.textContent` typo are fixed.)
- [ ] `pianoroll.js` hit-testing ignores loop wrap (second copy unclickable, creates duplicates); notes can extend past loop end; Play button label desyncs on empty roll. (Stop not calling `releaseAllNotes()` is fixed — `onStopPlayback` opt, wired in app.js to release both the internal synth and MIDI out.)
- [ ] Listener leaks: `makeStarDraggable` document mouseup, more-menu document click (not via `onDoc`), `initCanvas` re-registers drop/`touch-drop-patch` handlers per call.
- [x] `dx7-processor` 300 ms note-on latency — fixed by shrinking the ring lookahead to 4 blocks (~12 ms); underrun fallback still renders inline. 16-voice block renders in ~43 µs, so the cushion is ample.
- [x] `msfa_bridge.cpp init_engine()` SynthUnit leak (~13 MB per preview) — fixed: `SynthUnit` destructor, `RingBuffer::Reset()`, new `reset_engine()` export; `renderOffline` and `batchRenderWaveforms` call it per render. WASM rebuilt. `test/wasm-engine-reset.test.js`.
- [x] Canvas thumbnails identical on load, correct after preview — same root cause: `batchRenderWaveforms` rendered patches back-to-back with no note-off and no engine reset, so each thumbnail contained every earlier patch still ringing (up to 16 voices). Preview re-initialised the engine, hence the "fix on preview". Fixed by the per-patch `reset_engine()` above.
- [ ] Minor, still open: WAV decoder requires `data` right after `fmt`; syx parser skips format/checksum; patch IDs hash voice_data so duplicate voices collide; the `playPatch` waveform object URL (app.js ~223) is still never revoked — the canvas owns it, so it needs an owner-side fix.
- [x] Minor, fixed: WAV import resets `fileInput.value`; "Start Matching" disables itself on click and restores if the job never reaches `polling`; the play-original object URL is revoked on `ended`/`error`; `freqDisplay` now uses the real DX7 formulas — fixed `10^(coarse%4 + fine/100)` Hz, ratio `coarse * (1 + fine/100)` with coarse 0 meaning 0.5. `test/dx7-freq-display.test.js`.

## Open Questions / Gotchas In Flight

_(Things discovered mid-task that the next agent needs to know, but that aren't
yet stable enough to be an AGENTS.md rule.)_

- 2026-10-24: single-engine refactor (committed in c55711b). One long-lived worklet engine for all audible output; previews (canvas playPatch, edit panel) now play realtime on channel 15 instead of offline-render → decode → inject. `playNoteRealtime` releases the previous preview note before starting a new one (note-off matches all notes with same channel+midi). One shared main-thread offline instance (`dx7-synth.js` `renderOffline` + `batchRenderWaveforms`, re-exported by audio-manager) — was two. New WASM exports: `all_notes_off()` (keyup+fade, state survives; also CC 120/123) and `get_channel_samples(ch, n)` (pre-filter int32 capture of last render; single static buffer — read before the next call). `send_midi` drops messages instead of nanosleep-spinning when the ring is full. Deliberately ONE wasm build: compile-flagging `channel_outputs_` out would have meant either losing per-channel capture everywhere or shipping two binaries. `playSamplesInWorklet`/`play-samples` kept but currently unused.

## Architecture

OpenPatches is a browser-based DX7 patch editor and sequencer. It communicates with the fmguessr inference server via REST API (see API.md).

**Frontend (Vanilla JS, no framework):**
- `html/app.js`: main orchestrator. Wires file input, menu bar, canvas, toolbar. Creates tick worker, `stopTickWorker` helper. PlayNote/playPatch with multi-channel support. Emergency stop with voice reload.
- `html/components/canvas.js`: Canvas — patches + PatchContainers on night-sky. Drag-to-reposition, snap-into-container, resize containers. State derived from linked Job. Uses `onDoc()` helper for document-level listeners with cleanup via `clearDocListeners()` on each `renderAll()` to prevent stale closures. All interactive elements in `#night-sky`.
- `html/components/toolbar.js`: Unified Piano Roll + Keyboard panel with tabs: Canvas | Piano Roll | Edit | Log | Mute. Keyboard integrated into Piano Roll panel (recording controls + octave selector + piano keys below pianoroll grid). VoiceBank select dropdown. Undo button for recording. Mobile octave selector (0–7). Uses tick worker for precise playback/recording timing. **Note dispatch:** every note source goes through `noteOn(midi, velocity, when)` / `noteOff(midi, when)` — on-screen keys, and `handleMidiMessage` for external MIDI. `heldNotes` (a Set) is the authority on what is down; `noteOff` is a no-op for anything not in it. Timing is `performance.now()` so `MIDIMessageEvent.timeStamp` can be passed straight in as `when`. The midi-manager import is namespaced `midiManager` because `midi` is the note-number parameter name throughout the file.
- `html/components/edit-panel.js`: Morph / Params / Random editing.
- `html/components/job.js`: Job class — steering object for WAV import lifecycle. Owns: probe → match → poll → complete/fail.
- `html/components/patch-model.js`: Unified data model + stores (localStorage). `patchStore`, `canvasStore`, `jobStore`.
- `html/components/patch-row.js`: Unified patch row rendering with star drag handle, mini spectrogram, assign/edit/remove buttons. Touch drag between containers with floating clone.
- `html/components/patch.js`: Waveform helpers only — `decodeWavSamples`, `drawMiniWaveform`, `wavSampleCache`.
- `html/components/voicebank.js`: Voice palette (8 slots). Persists to localStorage. Each entry has static channel assignment (0-7). Compact mode on mobile: vertical bars, tap to select, vertical drag for volume. Exposes `_render()` for re-rendering after class changes.
- `html/components/pianoroll.js`: Sequencer with looping. Notes store per-note `voiceData` and `channel`. Touch support: `TOUCH_RESIZE_MARGIN = 20`, visual resize handles, double-tap to delete. Long-press (1s) to create note when stopped, drag to scroll. Looping: double-wide canvas, content drawn twice for seamless loop. `handlePlaybackTick(col)` driven by tick worker. `setRecordingTickHandler` for recording delegation.
- `html/components/syx-builder.js`: DX7 SysEx **encoder** (syx-parser.js is the reader). Bulk dump `F0 43 0n 09 20 00 <4096 packed> <cksum> F7` = 4104 bytes; edit-buffer voice `F0 43 0n 00 01 1B <155 unpacked> <cksum> F7` = 163; dump request `F0 43 2n 09 F7`. Checksum = `(128 - (sum & 0x7F)) & 0x7F`. `patch.voice_data` is already the packed 128-byte form so a bank is a straight concatenation, padded to 32 with `makeInitVoice()`. `unpackVoice()` expands packed 128 → VCED 155 (17-byte ops become 21, 26 global bytes become 29) using dx7-params' `readOp`/`readGlobal`. **`html/DEMO.syx` is the golden test fixture** — parse → rebuild is asserted byte-identical, and unpack → repack is asserted lossless across all 32 voices.
- `html/components/tag-editor.js`: Tag editor component with autocomplete.
- `html/components/tutorial.js`: First-run tutorial modal with overlay highlights. Skips clip-path on mobile.
- `html/synth/audio-manager.js`: Singleton AudioContext + AudioWorklet. `acquire()` creates once, `initAudio()` loads modules once. Multi-channel: `sendVoiceSnapshot()`, `playNoteOnChannel()`. `emergencyStop()` reinitializes MSFA engine. No malloc/free — uses static WASM buffers. `playNoteOnChannel` guards against stale note-off via self-reference check.
- `html/synth/midi-manager.js`: Web MIDI singleton, same shape as audio-manager. Access is requested only on demand and never at import time. Two permission tiers: `requestMidi({sysex:false})` for notes, `requestMidi({sysex:true})` for bulk dumps — the upgrade re-prompts and swaps the `MIDIAccess`, so `attachInputListener()` re-binds the input handler by object identity, and a generation counter stops an older in-flight request clobbering a newer grant. Port selection persists to localStorage by id **with a name fallback** (ids are not stable across sessions). `panic()` = CC 120 + CC 123 on all 16 channels; called on emergency stop, output change, `pagehide` and tab-hide. `receiveBank`/`sendBank` are the real SysEx transport (see syx-builder). Test seams: `_reset()`, `_getAccess()`. **Note output:** `outputMode` (internal/midi/both), `slotChannels[8]` (slot → MIDI channel, identity default), `playNoteOut()`/`stopNoteOut()`/`releaseAllOut()` with an `outNotes` map keyed `"channel:midi"`. `isInternalEnabled()` returns true when MIDI-only is selected but no device is reachable — the app must never go silent because a cable was unplugged. **Output latency:** a persisted setting (`getOutputLatency`/`setOutputLatency`, default 317 measured against a Volca FM, max 1000) added to every note-path timestamp by `sendAt()`, the single send helper; SysEx is unstamped. `panic()` sweeps twice, now and at `+latency`. `playLatencyProbe(midi, {durMs, voiceData, onWire})` is the calibration tick for the settings modal.
- `html/components/midi-panel.js`: MIDI settings modal (enable, input/output selects, device channel, output mode, slot map, **output-latency slider + flashing test-tone calibrator** fed by `opts.playTestNote`/`prepareTestNote`/`testVoiceData` from app.js, audition, panic) and `sendBankToDevice()` — the guarded confirm → optional backup → send flow. A failed backup aborts the send; it never falls through to "proceed anyway". Transport is real since Phase 4; the backup step uses `receiveBank`.
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
