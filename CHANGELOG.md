# CHANGELOG.md

Append-only record of completed work and structural changes, newest first.

## 2026-10-29: Bug survey sweep (2026-10-23 survey)

- **WAV import results lost** — `Job.complete()` wrote a stale container copy back over the per-patch saves, so `patchIds` ended up `[]` and Assign/Export/Sort saw nothing (and `restore()` repeated it on every reload). It now writes canvas entries directly and saves the container once. `test/job-complete-patches.test.js`.
- **Grouped containers** — a patch added by hand to a WAV-match container was invisible (only groups render); it is filed under an `ADDED` group. Removing a patch also removes it from its group. Touch reorder applies to the group holding both rows, not just the flat list. `test/canvas-container-edit.test.js`.
- **Touch drag** (patch-row): dragging out and back in no longer clones the patch on drop; `touchcancel` aborts cleanly in patch rows, floating patches, container drag/resize and the piano roll.
- **Floating patch tap** no longer drops the patch into whatever container its box overlaps — only a real drag does.
- **Listener leaks** — one document `mouseup` for all star handles; more-menu close handlers go through `onDoc()` and die with the render; `initCanvas()` replaces the sky drop handlers and the window `touch-drop-patch` handler instead of stacking them.
- **Edit panel** — Params Save stores the edited algorithm/feedback (was the values the patch was opened with); Save no longer requires `/api/play` (local audition first, server fallback, neither mandatory); the shared Morph/Random slider keeps a value per mode instead of being clamped on every switch. `test/edit-panel-slider.test.js`.
- **Piano roll** — clicks on the second (loop) grid copy find the notes there instead of creating duplicates; right-edge resize cannot run past the loop end; the mobile Play button only shows "Stop" when playback actually started. `test/pianoroll-loop-hittest.test.js`, `test/toolbar-play-empty.test.js`.
- **WAV decoder** walks the RIFF chunks generally (LIST/fact between `fmt ` and `data`, stereo/N-channel mixdown, 32-bit float). `test/wav-decode.test.js`.
- **SYX parser** rejects non-bank format bytes and verifies the checksum (warn-only, surfaced in the log). `test/syx-parser-format.test.js`.
- **Patch ids** hash `voice_data|name`, so one voice under several match-group names is several records. `test/patch-id.test.js`.
- **Preview blob URLs** from `playPatch` are revoked by the consumer once the waveform is drawn (`releaseWavUrl`).
- Harness: `[attr="value"]` selectors, `document.createTextNode`, `window.removeEventListener`.

## 2026-10-28: Songs

Named sequencer snapshots. `songStore` in patch-model.js (`openpatches_songs`, keyed by trimmed name; `create()` never overwrites — a collision throws `'Song exists'`). A song = the roll's notes/bpm/measures + the voice bank's eight slots, so the sounds travel with the notes. UI is `html/components/song-bar.js` above the piano roll: Save while typing, Delete (with confirm) once loaded, ✕ detaches the name, a custom suggest list (not a `<datalist>`, which cannot tell "picked" from "typed"). Load goes `stopAll()` → `voiceBank._setEntries()` → `pianoroll.loadSong()`. `test/song-store.test.js`, `test/song-bar.test.js`.

## 2026-10-28: Desktop Record + playback view

Record was mobile-only by accident (the `kb-controls` row is hidden on desktop); a second button now sits in the piano roll's transport row via `pianorollRef.insertControl()`, both driving one `toggleRecording()`. Follow-scroll is opt-in and off by default (`followPlayhead`, persisted): the canvas is single-width unless following, ticks never write `scrollLeft`, `canvas.width` is assigned only on change, and a 2 px red playhead shows position. The on-screen keyboard folds under a `.kb-toggle` bar (`openpatches_kb_collapsed`). `test/pianoroll-playhead.test.js`, `test/toolbar-record-keyboard.test.js`.

## Earlier fixes from the 2026-10-23 survey (landed before this log existed)

- `dx7-params.js` byte 13 KVS/AMS swap (`test/dx7-params-kvs-ams.test.js`).
- Tick-worker restart race — generation counter (`test/tick-worker-restart.test.js`); Record stops playback first.
- Keyboard `mouseleave` note-off for unpressed keys; key released before `acquire()` resolves no longer sticks 30 s.
- `audio-manager initAudio()` tears down on rejection so the next `acquire()` retries.
- Emergency stop re-sends the snapshot; worklet `reinit` calls `reset_engine()`.
- Persisted channel volumes pushed on initial load (`test/channel-volume-snapshot.test.js`).
- Voice bank: volume 0 is a value, colors re-indexed after splice (`test/voicebank-slot-state.test.js`).
- `removeContainer` stops and removes the linked job.
- `dx7-processor` ring lookahead cut to ~12 ms (was ~300 ms note-on latency).
- `msfa_bridge.cpp` SynthUnit leak and identical canvas thumbnails — per-render `reset_engine()` (`test/wasm-engine-reset.test.js`).
- WAV import resets `fileInput.value`; "Start Matching" disables itself; play-original URL revoked; `freqDisplay` uses the real DX7 formulas (`test/dx7-freq-display.test.js`).
