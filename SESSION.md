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
- [x] **MIDI device profiles (2026-10-28) — first cut.** `html/synth/midi-devices.js`
  is a data table of what differs between DX7-dialect synths: `generic`,
  `dx7` (Mk I, also TX7), `dx7ii` (II-D/II-FD/DX7s/TX802), `dexed`, `volcafm`.
  Per profile: `bankSend {supported, target, memoryProtect|null}`,
  `bankReceive {supported, dumpRequest, manualHint, reason}`, `programCount`,
  `polyphony`, `velocity`, `multitimbral`, `editBufferNote`,
  `sysexChannelNote`, `notes[]`. Facts encoded: the **Mk I ignores dump
  requests** (front panel: Function › 8 › MIDI › Transmit) and has memory
  protect; the **II-series answers dump requests**; **Dexed and the volca fm
  are receive-only** (no dump request, cannot transmit) and have no memory
  protect; volca is 6-voice and the original ignores velocity. The
  `generic` fallback is optimistic (sends the request) and verbose. Selection:
  `midi.getDeviceType()`/`setDeviceType(id)` persisted, default `'auto'` →
  `detectDeviceType(portName)` on the output's name (rules ordered
  most-specific first: dx7ii before dx7; II/2 matched without a trailing
  word boundary so "DX7 IIFD" works). `getResolvedDeviceType()` /
  `getDeviceProfile()` resolve auto, falling back to the **remembered port
  name** when MIDI is not yet enabled — the send-bank confirm dialog runs
  before the permission prompt. **Transport:** `receiveBank()` refuses up
  front with `bankReceive.reason` on receive-only devices (before the
  input-port check, nothing sent, no collector left armed), skips the dump
  request when `dumpRequest` is false, and its timeout message names the
  device and carries `manualHint`. `sendBank()` checks `bankSend.supported`
  (all current profiles accept banks). **Panel:** "Device type" select
  (`.midi-device-type`, Auto-detect shows the detected name) with the
  profile's notes under it; the send-bank confirm uses `bankSend.target` in
  the overwrite warning, shows the memory-protect box only when the profile
  has one, and disables + unticks the backup checkbox with the reason when
  the device cannot be dumped. Not yet wired (data only): `polyphony`,
  `velocity`, `multitimbral` — the latter is the Phase 3b hook. Unverified
  details flagged for a hardware pass: TX802 bank placement (64 internal
  voices, which half a 32-voice dump fills), volca fm2 program count, whether
  Dexed really ignores `F0 43 2n 09 F7` (believed so). Tests:
  `test/midi-devices.test.js`, device block in
  `test/midi-sysex-transport.test.js`, `test/midi-panel-devices.test.js`.
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

### Feature: Patterns, Tracks and the Song editor (6 phases)

Plan agreed 2026-10-29. Moved here from TODO.md. The piano roll becomes a
reusable **Pattern** (monotimbral, no per-note slot); a **Song** arranges
patterns as **clips** on **tracks**, each track bound to a voice-bank slot
(= synth channel = MIDI channel, unchanged). Multitimbral/drum patterns are
deliberately later — `pattern.kind` is the hook.

- [x] **Phase 1 — model and migration (2026-10-29).** `html/components/song-model.js`,
  pure data + localStorage, no DOM. Factories (`createPattern`/`Track`/`Clip`/`Song`)
  are **total**: fed storage or a hand-edited blob they return a well-formed
  record, dropping what is invalid — a note starting past the end of its
  pattern is dropped (unreachable), one merely running past is cut at the end
  (the resize-handle rule), a clip whose track or pattern is gone is dropped.
  Geometry: `patternCols`, `clipSpan` (pattern length × repeats),
  `songLength`, `findClipOverlap`; `addClip`/`updateClip` refuse an overlap
  with `'Clip overlaps'` (store errors are shown verbatim, as
  `'Song exists'` was), `removeTrack` takes its clips with it. **Stores are
  id-keyed**, not name-keyed like the legacy one — the editors rename freely
  and two patterns may share a name, so `create()` always mints a fresh id and
  `put()` is the update path. **Migration** (`splitNotesBySlot` →
  `songFromLegacyRoll` → `buildMigration` → `migrateIfNeeded`) turns the flat
  roll blob into one pattern + track per used slot, all clips at measure 0;
  each legacy snapshot song converts the same way, keeping its voice bank.
  Guarded by `openpatches_seq_migrated`, whose marker is written **last** so a
  failed write retries instead of leaving a half-migrated library. The legacy
  keys are read-only and left in place until phase 6.
  **Nothing calls `migrateIfNeeded()` yet** — phase 3 wires it at startup.
  `test/song-model.test.js`, `test/song-migration.test.js` (66 tests).
- [ ] **Phase 2 — sequencer core.** `html/synth/sequencer.js`: given a song +
  patterns, answer "what starts at absolute column N, on which slot",
  honoring mute/solo and the loop range. Pure, no DOM, no worker.
- [ ] **Phase 3 — pattern editor refactor.** pianoroll.js edits a Pattern
  through a small interface; per-note `slot` removed; existing tests updated.
- [ ] **Phase 4 — song editor.** `html/components/song-editor.js`: tracks ×
  measures grid, pattern palette, clip place/move/resize/delete, per-track
  slot picker + mute/solo.
- [ ] **Phase 5 — transport integration.** Pattern mode vs Song mode, tick
  handling moved from pianoroll.js to a transport in toolbar.js, recording
  into the pattern, playhead in both editors.
- [ ] **Phase 6 — cleanup.** Remove song-bar.js and the legacy snapshot
  store, update HEARME.tts and the tutorial.

Open decision (assumed, flag if wrong): a Song keeps the voice-bank snapshot
the legacy songs carried, so sounds still travel with notes; it is dropped
when **Project** (TODO.md) takes ownership of the voice bank.

Bug survey 2026-10-23 — swept 2026-10-29; everything fixed is in CHANGELOG.md. Still open:

- [ ] Voice bank: removing a slot shifts the channels of the slots after it, but piano-roll notes keep their old `slot` index and so change sound. Deferred on purpose — the slot↔note binding is being redesigned under the Pattern/Song work in TODO.md.
- [ ] `audio-manager` ready-handshake resolves unconditionally after 2 s (deliberate fallback, left alone).
- [ ] Recorded notes are not clamped to the loop end on insert (the recorder seam-splits held notes, so this does not occur in practice); only interactive resize is clamped.

## Open Questions / Gotchas In Flight

_(Things discovered mid-task that the next agent needs to know, but that aren't
yet stable enough to be an AGENTS.md rule.)_

- 2026-10-24: single-engine refactor (committed in c55711b). One long-lived worklet engine for all audible output; previews (canvas playPatch, edit panel) now play realtime on channel 15 instead of offline-render → decode → inject. `playNoteRealtime` releases the previous preview note before starting a new one (note-off matches all notes with same channel+midi). One shared main-thread offline instance (`dx7-synth.js` `renderOffline` + `batchRenderWaveforms`, re-exported by audio-manager) — was two. New WASM exports: `all_notes_off()` (keyup+fade, state survives; also CC 120/123) and `get_channel_samples(ch, n)` (pre-filter int32 capture of last render; single static buffer — read before the next call). `send_midi` drops messages instead of nanosleep-spinning when the ring is full. Deliberately ONE wasm build: compile-flagging `channel_outputs_` out would have meant either losing per-channel capture everywhere or shipping two binaries. `playSamplesInWorklet`/`play-samples` kept but currently unused.

## Architecture

OpenPatches is a browser-based DX7 patch editor and sequencer. It communicates with the fmguessr inference server via REST API (see API.md).

**Frontend (Vanilla JS, no framework):**
- `html/app.js`: main orchestrator. Wires file input, menu bar, canvas, toolbar. Creates tick worker, `stopTickWorker` helper. PlayNote/playPatch with multi-channel support. Emergency stop with voice reload.
- `html/components/canvas.js`: Canvas — patches + PatchContainers on night-sky. Drag-to-reposition, snap-into-container (only after a real move — a tap on a floating patch's header never absorbs it), resize containers. State derived from linked Job. Uses `onDoc()` helper for **every** document-level listener (drag/resize/touchcancel, more-menu close) with cleanup via `clearDocListeners()` on each `renderAll()` to prevent stale closures. `initCanvas()` is re-entrant: the sky drop handlers and the window `touch-drop-patch` handler are kept in module vars and replaced, not stacked. `addPatchToContainer()` on a grouped container files the patch under an `ADDED` group (`ADDED_GROUP_LABEL`) so it renders; `removePatchFromCanvas()` also drops it from its group. All interactive elements in `#night-sky`.
- `html/components/song-bar.js`: the Song: name / Save / Delete bar with its autocomplete dropdown; state machine typing ↔ loaded, backed by `songStore`. Mounted by the toolbar, which supplies `getSong`/`loadSong` spanning the piano roll and the voice bank.
- `html/components/toolbar.js`: Unified Piano Roll + Keyboard panel with tabs: Canvas | Piano Roll | Edit | Log | Mute. Song bar on top of the piano roll panel. Keyboard integrated into Piano Roll panel (recording controls + octave selector + piano keys below pianoroll grid), wrapped in a collapsible `.keyboard-wrapper` under a `.kb-toggle` bar (state in `openpatches_kb_collapsed`). VoiceBank select dropdown. Undo button for recording. Mobile octave selector (0–7). **Record** exists twice: `.kb-btn-record` in the mobile-only `kb-controls` row and `.pianoroll-record` inserted into the piano roll transport row for desktop; both call `toggleRecording()`. Uses tick worker for precise playback/recording timing. **Note dispatch:** every note source goes through `noteOn(midi, velocity, when)` / `noteOff(midi, when)` — on-screen keys, and `handleMidiMessage` for external MIDI. `heldNotes` (a Set) is the authority on what is down; `noteOff` is a no-op for anything not in it. Timing is `performance.now()` so `MIDIMessageEvent.timeStamp` can be passed straight in as `when`. The midi-manager import is namespaced `midiManager` because `midi` is the note-number parameter name throughout the file.
- `html/components/edit-panel.js`: Morph / Params / Random editing. One shared range slider: `setSliderMode()` swaps min/max/step and restores the mode's own last value from `dataset.<mode>Val` (the browser clamps on a range change, which used to destroy the other mode's setting). Params **Save** takes algorithm/feedback from the edited `currentMutation.globals` and saves offline — audition is local-synth first, `/api/play` as fallback, and neither is required.
- `html/components/job.js`: Job class — steering object for WAV import lifecycle. Owns: probe → match → poll → complete/fail. `complete()` writes the canvas entries and `ctr.patchIds` itself and saves the container once — it must not go through `addPatchToContainer()`, whose per-patch re-read/re-save would be overwritten by the stale copy.
- `html/components/song-model.js`: Sequencer data model — **Pattern** (reusable, monotimbral, notes carry no voice; `kind` is the hook for drum patterns later), **Track** (bound to a voice-bank slot = synth channel = MIDI channel, unchanged), **Clip** (a pattern placed on a track at a measure, with a repeat count) and **Song** (tracks + clips + bpm + loop range). `patternStore`/`songStore` are id-keyed; `COLS_PER_MEASURE` lives here and pianoroll.js adopts it in phase 3. One clip per track per measure — a track is a monophonic timeline, so two clips in one place would mean two patterns on one voice. Also owns the one-shot migration off the piano-roll blob. Imports patch-model.js only for the legacy song store.
- `html/components/patch-model.js`: Unified data model + stores (localStorage). `patchStore`, `canvasStore`, `jobStore`, `tagStore`, `songStore` (named sequencer snapshots; `create()` refuses collisions with `'Song exists'`). `createPatch()` ids hash `voice_data|name` when a name is given, so one voice under two names (a match in several result groups) is two records; re-importing the same bank still yields the same ids.
- `html/components/patch-row.js`: Unified patch row rendering with star drag handle, mini spectrogram, assign/edit/remove buttons. Touch drag between containers with floating clone; crossing back into the body cancels the drag-out (clone removed, no clone on drop), `touchcancel` aborts cleanly. `reorderContainerPatch()` applies a touch reorder to the group that holds both rows **and** the flat list (a grouped container renders only its groups; a move across groups is refused). One document `mouseup` disarms the star-armed row instead of one listener per row.
- `html/components/patch.js`: Waveform helpers only — `decodeWavSamples` (general RIFF chunk walk: `fmt ` and `data` in any order with LIST/fact between, 16-bit PCM or 32-bit float, N channels mixed to mono), `drawMiniWaveform`, `wavSampleCache`, `releaseWavUrl` (revokes the `blob:` URL `playPatch` returns, once the waveform is drawn — the consumer owns it).
- `html/components/voicebank.js`: Voice palette (8 slots). Persists to localStorage. `_setEntries(list)` replaces every slot at once (song load). Each entry has static channel assignment (0-7). Compact mode on mobile: vertical bars, tap to select, vertical drag for volume. Exposes `_render()` for re-rendering after class changes.
- `html/components/pianoroll.js`: Sequencer with looping. Hit-testing folds the second (loop) grid copy onto the first (`foldX`), interactive right-edge resize is clamped to the loop end (`clampDur`), `touchcancel` restores whatever was mid-move. Notes store per-note `voiceData` and `channel`. Touch support: `TOUCH_RESIZE_MARGIN = 20`, visual resize handles, double-tap to delete. Long-press (1s) to create note when stopped, drag to scroll. **Follow-scroll is opt-in** (`followPlayhead`, default off, persisted): only then is the canvas double-wide (content drawn twice for a seamless loop) and the view scrolled per tick; otherwise the red 2 px playhead is the only motion. `canvas.width` is assigned only on change. `handlePlaybackTick(col)` driven by tick worker. `setRecordingTickHandler` for recording delegation. `insertControl(el)` lets the toolbar place its Record button after Stop. `getSong()`/`loadSong(data)` are the song store's view of the roll.
- `html/components/syx-parser.js`: `.syx` reader. Rejects anything whose format byte is not `0x09` (32-voice bank); verifies the checksum but only **warns** (`patches.checksumOk === false`, surfaced in the log by `importSyxBank`) because hex-edited banks with stale checksums are common.
- `html/components/syx-builder.js`: DX7 SysEx **encoder** (syx-parser.js is the reader). Bulk dump `F0 43 0n 09 20 00 <4096 packed> <cksum> F7` = 4104 bytes; edit-buffer voice `F0 43 0n 00 01 1B <155 unpacked> <cksum> F7` = 163; dump request `F0 43 2n 09 F7`. Checksum = `(128 - (sum & 0x7F)) & 0x7F`. `patch.voice_data` is already the packed 128-byte form so a bank is a straight concatenation, padded to 32 with `makeInitVoice()`. `unpackVoice()` expands packed 128 → VCED 155 (17-byte ops become 21, 26 global bytes become 29) using dx7-params' `readOp`/`readGlobal`. **`html/DEMO.syx` is the golden test fixture** — parse → rebuild is asserted byte-identical, and unpack → repack is asserted lossless across all 32 voices.
- `html/components/tag-editor.js`: Tag editor component with autocomplete.
- `html/components/tutorial.js`: First-run tutorial modal with overlay highlights. Skips clip-path on mobile.
- `html/synth/audio-manager.js`: Singleton AudioContext + AudioWorklet. `acquire()` creates once, `initAudio()` loads modules once. Multi-channel: `sendVoiceSnapshot()`, `playNoteOnChannel()`. `emergencyStop()` reinitializes MSFA engine. No malloc/free — uses static WASM buffers. `playNoteOnChannel` guards against stale note-off via self-reference check.
- `html/synth/midi-devices.js`: device profile table + `detectDeviceType(portName)`; see the profiles entry above. Pure data/regex, no DOM, no MIDI.
- `html/synth/midi-manager.js`: Web MIDI singleton, same shape as audio-manager. Holds the persisted `deviceType` ('auto' or a profile id) and resolves it via `getDeviceProfile()`; `receiveBank`/`sendBank` consult the profile. Access is requested only on demand and never at import time. Two permission tiers: `requestMidi({sysex:false})` for notes, `requestMidi({sysex:true})` for bulk dumps — the upgrade re-prompts and swaps the `MIDIAccess`, so `attachInputListener()` re-binds the input handler by object identity, and a generation counter stops an older in-flight request clobbering a newer grant. Port selection persists to localStorage by id **with a name fallback** (ids are not stable across sessions). `panic()` = CC 120 + CC 123 on all 16 channels; called on emergency stop, output change, `pagehide` and tab-hide. `receiveBank`/`sendBank` are the real SysEx transport (see syx-builder). Test seams: `_reset()`, `_getAccess()`. **Note output:** `outputMode` (internal/midi/both), `slotChannels[8]` (slot → MIDI channel, identity default), `playNoteOut()`/`stopNoteOut()`/`releaseAllOut()` with an `outNotes` map keyed `"channel:midi"`. `isInternalEnabled()` returns true when MIDI-only is selected but no device is reachable — the app must never go silent because a cable was unplugged. **Output latency:** a persisted setting (`getOutputLatency`/`setOutputLatency`, default 317 measured against a Volca FM, max 1000) added to every note-path timestamp by `sendAt()`, the single send helper; SysEx is unstamped. `panic()` sweeps twice, now and at `+latency`. `playLatencyProbe(midi, {durMs, voiceData, onWire})` is the calibration tick for the settings modal.
- `html/components/midi-panel.js`: MIDI settings modal (enable, input/output selects, device channel, **device type** with profile notes, output mode, slot map, **output-latency slider + flashing test-tone calibrator** fed by `opts.playTestNote`/`prepareTestNote`/`testVoiceData` from app.js, audition, panic) and `sendBankToDevice()` — the guarded confirm → optional backup → send flow. A failed backup aborts the send; it never falls through to "proceed anyway". Transport is real since Phase 4; the backup step uses `receiveBank`.
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
