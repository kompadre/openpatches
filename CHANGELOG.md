# CHANGELOG.md

Append-only record of completed work and structural changes, newest first.

## 2026-10-29: Moving clips between tracks

- Drag a clip in the Song tab into another lane, diagonally if you like; it previews in the target lane in that voice's colour and lands through `updateClip` with the new `trackId`, so an occupied destination is refused and reported like any other edit. Nothing in the model changed: a clip was already only a pattern placed on a track, so the notes move and the instrument stays the track's. Pure vertical drags now count as moves (they were previously ignored as hold-cancellers). `moving clips between tracks` block in `test/song-editor.test.js`.

## 2026-10-29: Song-level play controls; the roll's Play loops the pattern where it sits

- **Song tab Play / Stop** — first in its toolbar; Play there is song mode, state mirrored from the transport's broadcasts.
- **Pattern mode redefined** — the roll's Play (`transport.play({mode:'pattern'})`) loops *the song confined to one placement of the edited pattern*, from its start to its end, so the other tracks accompany inside that window instead of falling silent. A pattern placed several times (clips or repeats) loops the placement **nearest the song position**: the last song column played, or the clip just opened from the Song tab (`openClip` parks it via `setSongPosition`). Inside wins, else the closer edge, ties to the earlier. A pattern placed nowhere still loops alone. An empty pattern plays if its backing has notes.
- Sequencer: `createSongSequence` takes a `range` override; new `patternPlacements` / `nearestPlacement`. Transport: `play({mode})`, `setSongPosition`/`getSongPosition`/`getPlacement`, `pos.songCol`; pattern-mode recording goes through the song path of `mapRecordColumn` (one seam/backing code path). Song-tab playhead now moves in pattern mode too. **Record from the roll is pattern scope as well** (`startRecording({mode})`; the first browser check found a take running on to the end of the song).
- **Accompaniment is its own setting**, split out of the mode toggle after the second check: the roll's loop is always one pattern long, and `♫ With song` / `▭ Pattern only` decides only whether the rest of the song is heard inside it (`transport.getAccompany`/`setAccompany`, persisted, default on; `createSongSequence`'s new `onlyTrackId`). It applies mid-take, since it changes what sounds and not the loop.
- Tests: new `pattern mode placements` block in `transport.test.js`, `placements` in `sequencer.test.js`, buttons/parking in `song-editor.test.js`; the roll's transport tests rewritten to the new contract.

## 2026-10-29: Small wins batch (MIDI on reload, record autoscroll, pattern rename, clip gestures)

- **MIDI access on reload** — the "SysEx permission gets lost" report. Nothing was lost: nothing was ever asked for again. `requestMidi()` was only reachable from the settings modal and the send-bank flow, so every page load started with no grant and the audition box ticked on top of nothing. midi-manager now persists an `enabled` flag (set by any successful grant) and `resumeIfEnabled()`, called from `initMidiUi()`, re-requests at startup at the tier audition needs; Chrome remembers the permission so there is no prompt. A refused silent request leaves the state `closed` with Enable still on offer. `test/midi-auto-resume.test.js`.
- **Recording scrolls to the note** — a recorded note whose row is off screen centres the roll vertically; one already in view leaves the grid alone, and the horizontal position is never touched (that belongs to follow-scroll, or the user). `pianoroll.revealRow()`, `test/pianoroll-record-reveal.test.js`.
- **Pattern rename** — a ✎ button on each palette row (touch has no double-click), and the roll's legend now shows the edited pattern's name after the voice, click to rename in place. Both write through `patternStore` and notify the session, so the two editors agree. Tests in `song-editor.test.js`, `pattern-editor.test.js`.
- **Clip gestures match the roll** — double-click / double-tap on a Song-tab clip removes it; a press held still for 600 ms opens it in the piano roll (previously double-click opened). Detected from press/release so touch has both; only a tap release arms the double-tap, so re-grabbing a clip right after dragging it is safe; the click that follows a removing tap no longer re-selects the ghost. The ✎ Open / Remove buttons in the selected-clip bar remain. `clip gestures` block in `test/song-editor.test.js`.

## 2026-10-29: Patterns, Tracks and the Song editor

The sequencer is rebuilt around reusable **patterns**. Six phases, one commit each.

- **Model** (`html/components/song-model.js`) — Pattern (a bar or more of notes, monotimbral: notes carry no voice), Track (bound to a voice-bank slot = synth channel = MIDI channel), Clip (a pattern on a track at a bar, with repeats), Song (tracks + clips + bpm + loop). Factories are total, so stored or hand-edited data comes back well-formed. Id-keyed stores, so names are free and two patterns may share one. One clip per track per bar.
- **Migration** — the old flat roll (whose per-note `slot` was the voice) becomes one pattern + track per used slot; legacy saved songs convert the same way, keeping their voice bank. Versioned and idempotent; the legacy keys are never deleted.
- **Sequencer core** (`html/synth/sequencer.js`) — pure: given a song and its patterns, what starts at column N and on which slot. Patterns are snapshotted at compile time (reading one parses localStorage, which must never happen on a tick); mute/solo are read live. Solo beats mute.
- **Pattern editor** — the piano roll now edits one pattern, the active voice's. Other tracks draw as read-only ghosts behind it. `notes` became a binding repointed at the active pattern, which is why the editing layer survived the change untouched.
- **Song editor** (`html/components/song-editor.js`, Song tab) — tracks × bars grid, pattern palette, place/move/repeat/remove clips, per-track voice + mute/solo, song select/name/BPM/loop. Autosaves; model refusals ("Clip overlaps") surface in a status line. A shared `song-session.js` owns the current song so neither editor overwrites the other.
- **Transport** (`html/synth/transport.js`) — one owner of the clock, subscribed to the tick worker exactly once (previously the roll and the toolbar each drove it). Modes: Song (default, and identical to the old behaviour) and Pattern. Drives both playheads and recording; recording still sounds the whole arrangement as a backing.
- **Cleanup** — `song-bar.js` and the legacy `songStore` removed; the voice bank now follows the song on a switch; tutorial and HEARME.tts updated.

Caught in review along the way: recording into an empty song dropped the note; the tutorial was opening the wrong tab after the Song tab shifted the indices; and songs saved through the old song bar after the first migration would have been stranded by its removal.

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
