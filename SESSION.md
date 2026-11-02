# SESSION.md

Living project state. Agents own this file: update it as the codebase and the
work-in-progress change. AGENTS.md holds the durable rules; everything that
drifts belongs here.

## Proposed AGENTS.md rule — Pane-scoped ports and paths

_(Written 2026-10-31 at the user's request, in AGENTS.md voice and ready to
move there verbatim. Until it moves, treat it as binding anyway.)_

### Pane-scoped ports and external paths

The user works in the same repo at the same time, on their own tmux pane, and
runs the same `server.py`. Two agents (or an agent and the user) binding the
same port fight over it: one process fails to bind, or — worse — a stale
server from the other pane keeps serving a **different worktree** and the
tests silently pass against the wrong files. Both have happened.

- **Derive every port you bind from the worktree path and `$TMUX_PANE`.**
  The path hash separates sibling checkouts even inside one pane; the pane
  keeps your last-digit convention: **the port's last digit must equal the
  pane number's last digit** (`TMUX_PANE` is `%N`; `%2` here). The project
  convention, implemented in `playwright.config.js` (`derivePort()`):
  `h = djb2(cwd)`; `port = 8100 + (h % 80) * 10 + (N % 10)` — range
  8100–8899, with `h % 10` standing in for the pane digit when `$TMUX_PANE`
  is unset. This worktree on pane `%2` → `8572`.
- **Never kill a process you did not start.** A server on someone else's port
  is theirs. If your port is busy, that is your own orphan: find it with
  `pgrep -af "server.py <your-port>"` and kill only that.
- **Same rule for anything you create outside the project working directory**
  — a file, a directory, a socket, a lock. Put the pane number in the name
  (`/tmp/op-smoke-%2.mjs`), so two panes cannot collide or clobber each
  other's output. This should be rare: prefer a path inside the worktree, and
  prefer no file at all.
- If `$TMUX_PANE` is unset, say so; the path hash alone still gives a
  worktree-stable port — never fall back to a shared fixed default.

## Current Tasks & Goals

_(Keep a short list of what is in flight, what is done, and what is blocked.
Replace entries as work completes — this is a working set, not a changelog.)_

### Working convention (user, 2026-10-31)

The full Playwright run, `HEARME.tts`, `CHANGELOG.md` and the `TODO.md`
reconciliation happen only on a task's **last** phase. Intermediate phases
run `node --check` + `node --test` and tick this file only. (Open: AGENTS.md
"Keep it current ... in the same commit/change" reads per-change; awaiting
the user's wording if SESSION.md should be deferred too.)

### Project + Export (2026-11-02) — PLANNED with the user, not started

From TODO.md (both "Project" and "exporting a project" bullets, now cut).
**A major version change: no retro-compatibility, existing data is wiped.**

#### The model, as decided with the user

**Profile** — localStorage, never exported. The layer above projects: the
project index, the current-project pointer, MIDI *machine* settings (port
selection, the 317 ms output latency — port ids are not stable across
sessions and the latency was measured against this user's hardware, so
importing someone else's would be actively wrong), UI prefs
(`_roll_prefs`, `_kb_collapsed`, `_song_zoom`, `_song_snap`, `_step_len`,
`_transport_mode`, `_transport_accompany`), lifecycle flags (`_tutorial`,
`_demo_offered`) and the **global tag vocabulary**.

**Project** — one piece of music, body in IndexedDB. Two dimensions:
- **Tracks** — the vertical axis, project-level. See the merge below.
- **Sections** — an ordered sequence of smaller pieces (the user's word,
  chosen over "movement" as ambiguous and "part" as actively misleading —
  a Cubase Part is a per-track event container, i.e. our *clip*). Each
  section is a sequence of **Patterns** placed on the project's tracks.
- Also project-owned: patches, canvas layout, jobs, tempo, tags-in-use.

**Tempo**: project-level, with a **nullable per-section override that wins
when set** — announced per section the way a movement announces Allegro.
Song-level automation (gradual rit./accel.) is a later feature.

**Patterns belong to the project**, referenced by sections.

#### The structural merge: Track *is* the voice bank slot

The user's "Tracks are the other dimension of the Project" collapses a
duality the code already strains against: every lookup is
`tracks.find(t => t.slot === slot)`, so one-track-per-slot is assumed
everywhere while the model never enforced it.

**They have already drifted into a live bug — two independent mute/solo
systems for one strip:** `song.tracks[].mute/.solo`, written by the Song
tab's track-header M/S (song-editor.js:540) and read by `sequencer.js:25`
to decide which notes are **scheduled**; and the bank entry's
`.muted/.solo`, written by the Mixer strip's M/S, feeding `effectiveVolume`
to decide channel **volume**. Neither shows the other; they can disagree.

A Track becomes one object — `{id, name, slot/channel, patch, volume,
mute, solo}` — and that whole class of bug goes. `song.voiceBank` and the
global `openpatches_voicebank` both die, as song-model.js:175's own comment
already predicted.

#### Persistence: sync callers, async backend

Decided: project bodies in IndexedDB, loaded on open, dumped back on save.
**The trap:** every store today is synchronous `localStorage.setItem`, and
there are **31 synchronous save call sites**; the test harness stubs
localStorage and has no IndexedDB at all (test/harness.js:248).

So `projectStore` keeps the loaded body **in memory as the source of
truth** — which is exactly what "load on open, dump on save" means — with
all existing synchronous mutators writing to it unchanged, and a
**debounced async flush** of the whole body behind an **injectable
backend** (in-memory in tests, IndexedDB in the browser). No call site
becomes async and the harness needs no IndexedDB stub.

#### Clear History is broken — fold the fix in

`menu-clear-history` (app.js:935) removes 5 of 23 keys. **Survivors
include `_patterns` and `_arrangements`** (every pattern and song),
`_patch_names` and `_all_tags` (so a re-imported patch silently picks up
its old rename), plus every pref and both legacy keys.

**And the WAV blobs leak permanently.** IndexedDB `uploads` is pruned only
when a container is deleted from the canvas (canvas.js:253);
`canvasStore.clear()` drops the container records *without iterating them
first*, orphaning every imported WAV with no remaining reference and no UI
that can reach it. "Clear History" is itself the cause.

The refactor fixes this structurally rather than by chasing a key list:
clear the profile, drop the project store, clear the upload store. Pin it
with a test asserting storage is **empty**, not that five keys were
removed. Menu item renamed to say what it does ("Delete all projects and
patches"); the demo-offered flag and MIDI machine settings are kept —
they are profile-level and not "history".

#### Phases

Per the working convention: phases 1–5 run `node --check` + `node --test`
and tick this file only; phase 6 does the full Playwright run, HEARME.tts,
CHANGELOG.md and the TODO.md reconciliation.

- [x] **1. Model + stores — done 2026-11-02, 824 unit passing (+90).**
  Three new files, nothing existing touched; nothing is wired up yet.
  - `html/components/project-model.js` — pure data, no DOM/audio/MIDI/
    storage. Project, Section, Track (merged with the voice bank slot),
    Pattern, Clip; geometry (`clipCols`, `sectionLengthCols`); mutators
    (`addClip`/`updateClip`, `addTrack`/`removeTrack`,
    `addPattern`/`removePattern`, `addSection`/`removeSection`).
    `SCHEMA_VERSION = 1` is written into every body, for phase 5's import.
  - **`effectiveBpm(project, section)`** is the only place tempo is
    decided — `section.bpm` is **nullable**, null defers to the project,
    a number overrides. That nullability is the whole Allegro feature, and
    it is also the seam the later rit./accel. automation grows from.
  - **`normalizeProject()`** holds the invariants no single factory can
    see: one track per slot (a later duplicate is **dropped, not
    renumbered** — renumbering would silently move a part to another
    instrument), at most `MAX_SLOTS` tracks, always ≥1 section, and no
    orphan clips. `removeTrack`/`removePattern` sweep **every** section,
    which is the point of project-level tracks.
  - **One mute/solo per strip**, with `audibleTracks()` and
    `effectiveVolume()` kept side by side so the scheduler's view and the
    mixer's view cannot drift apart again.
  - `html/components/project-store.js` — in-memory body + debounced flush
    + pluggable backend (`createMemoryBackend` for tests,
    `createIdbBackend`, `createDefaultBackend` picking by capability).
    Writes are serialised through an `inFlight` chain so a slow save
    cannot be overtaken by a later one; a failed write **stays dirty** and
    is retried rather than assumed written.
  - `html/components/profile-store.js` — `openpatches_profile`: project
    index (upserted from each body, so it cannot drift), current pointer
    (falls to the most recent on removal), tag vocabulary, and
    `uniqueName()` for phase 5's collision rule.
  - Tests: `test/project-model.test.js` (43), `test/project-store.test.js`
    (23), `test/profile-store.test.js` (24).

  **Gotcha found while testing, worth remembering:** `JSON.stringify` turns
  a `Uint8Array` into `{"0":1,"1":2}` — an *object*. A caller assigning
  `track.voiceData = someUint8Array` directly (past the factory) would get
  a body that works perfectly in memory and loses its patch on the next
  load. `normalizeVoiceData()` therefore accepts that object shape too, and
  a test pins it.

  **Decided while building (the user asked about `window.onleave`):** there
  is **no "Save your changes?" on the way out**, and there cannot be. A
  page cannot show its own `confirm()` during `beforeunload` — browsers
  offer only their own generic dialog — and an IndexedDB transaction opened
  during unload is **not guaranteed to commit**. So the store autosaves,
  with an immediate flush on `visibilitychange -> hidden`, which fires
  while the page is still alive and is the only one a mobile tab-kill
  honours (`beforeunload` is skipped there and in bfcache). `pagehide` is
  wired as belt-and-braces.
  *(If an explicit Save/discard is ever wanted, that is a separate feature
  — a dirty indicator and "revert to last saved" layered on top of
  autosave, not an unload handler.)*

- [x] **1b. Autosave policy, to the user's spec — done 2026-11-02, 832
  unit passing.** Replaces phase 1's 500 ms debounce.
  - **Every 30 s (`DEFAULT_INTERVAL_MS`), and only when dirty.** One
    repeating ticker, not a timer per edit: a tick that finds the body
    clean costs nothing and a burst cannot stack timers up.
  - **`canSave()` is injected** — "is the transport idle?" A tick that
    finds it busy is skipped and retried on the next one.
  - **`flush({force:true})` bypasses `canSave()`**: open, adopt, close,
    remove, the end of a take, and the lifecycle flush. `force` is the
    difference between "autosave, if now is a good moment" and "write this
    out now, the moment may not come again".
  - **The lifecycle flush is forced on purpose.** A tab killed mid-playback
    must not lose the session: "do not save while playing" is a latency
    preference and it loses to not losing work.
  - **`isSaving()` / `whenIdle()`** are the Play deferral: pressing Play
    the millisecond a write starts parks the transport until the store is
    quiet. `whenIdle()` resolves immediately when idle, so the common case
    costs one microtask.
  - Subscribers get `save-start` / `save-end`, which is what the "Now
    saving" indicator will render from.

  **Measured, because it decides the policy:** a realistically-large body
  (8 tracks, 24 patterns × 64 notes, 6 sections × 48 clips, 1000 patches)
  is 364 KB and the synchronous JSON clone costs **4.3 ms**; a small one
  (32 patches, 85 KB) costs 1.6 ms. The IndexedDB commit itself is
  off-thread. So the don't-save-while-playing rule is avoiding a few ms of
  main-thread stall — not an audio dropout (audio is on its own thread) but
  note-scheduling jitter, since the main thread is what handles tick
  messages. Cheap to avoid, so avoided.

  **Bug this turn's tests caught:** idle was originally signalled by "the
  write settled *and* the body is no longer dirty". A **failed** write sets
  dirty back, so `saving` stuck on forever and **Play would have hung
  permanently**. Now a pending-write *counter* decides, so the last write
  settling releases the waiters however it settled. A dirty body only means
  a future tick will write, never that one is running.

  **Open with the user — the "Now saving" modal.** Asked for as
  "impossible to miss". A save is ~2–4 ms of main-thread work plus an
  off-thread commit, so a modal bracketing the real duration would flash
  for single-digit milliseconds — invisible, or a strobe. Making it
  perceptible means an artificial minimum display time, i.e. deliberately
  blocking the user for ~0.5 s every 30 s. Recommended instead: a
  prominent but non-blocking status line, with the **modal reserved for a
  save that actually takes a while** (> ~250 ms — quota pressure, a
  stalled DB), which is exactly when interrupting is warranted. **Awaiting
  the user's call; the store already emits what either needs.** Built in
  phase 3, where it can be rendered and e2e-tested — nothing is wired into
  app.js yet, so a modal built now would have nothing to show.
- [x] **2. Session + sequencer — done 2026-11-02, 885 unit passing (+53).**
  Both new files, both pure/testable; the old `song-session.js` and
  `sequencer.js` still run the UI untouched until phase 3 flips over.
  - `html/synth/section-sequencer.js` — supersedes `sequencer.js`.
    `createSectionSequence(project, section, opts)`: the **project** owns
    the tracks and the pattern library, the **section** owns the clips and
    the loop, so a clip needs both in hand to resolve. Keeps the two
    properties a tick depends on — patterns **snapshotted** (a tick never
    reads a store), mute/solo read **live** (toggling lands next column,
    no rebuild) — and `audibleTrackIds()` now just wraps project-model's
    `audibleTracks()`, so the scheduler's view and the mixer's view are
    the same function.
  - `html/components/project-session.js` — one owner of the open project
    *and* of which section is edited. Never leaves a state the UI cannot
    render: `init()` falls through remembered → most recent → new, a stale
    `sectionId` falls back to the first, and removing the last project
    mints a fresh one. `update(mutator)` hands the mutator both the body
    and the edited section. Every change upserts the profile index, so
    names and timestamps cannot drift from the bodies. `createFrom()` is
    the import path: always a fresh id and a `uniqueName()`, so the same
    file twice gives two projects and the **incoming** one is renamed.
    Re-emits the store's `save-start`/`save-end` as `kind:'saving'`, so an
    indicator can subscribe to the session alone.

  **Phase boundary moved, deliberately.** The plan had the transport in
  phase 2. It cannot go there: `transport.js` is constructed by
  `pianoroll.js` and reads `session.get()` as a *song*, so changing what
  it consumes breaks the editors in the same commit — the switch is
  atomic whether we like it or not. Transport therefore moves to phase 3,
  which keeps every commit green. Phase 2 is the pure core that phase 3
  plugs in.

- [ ] **3. Transport + editors rewired.** `transport.js` onto
  `project-session` + `section-sequencer` (one atomic switch with the
  editors, see above); the song editor becomes the **Section** editor;
  VoiceBank/Mixer binds to project tracks; pianoroll takes patterns from
  the project; canvas and patches scoped to the project. Also here: the
  **Play deferral** (`session.whenIdle()`), `canSave: () => !transport
  .isRunning()`, a forced flush when a take ends, and the **"Now saving"
  indicator** — the first point at which any of it can actually be seen or
  e2e-tested. `song.voiceBank`, `openpatches_voicebank`, `song-model.js`,
  `song-session.js` and `sequencer.js` all retire here.
- [ ] **4. Project management + the wipe fix.** Project list/switcher,
  new/rename/delete/duplicate, and the Clear History rewrite above.
- [ ] **5. Export / Import.** Single JSON file with `schemaVersion`
  (extension TBD — `.opproj`?). Export inlines patches, carries only
  tags **used in the project**, and writes jobs with their `fileName` plus
  a `sourceMissing` marker and **no WAV bytes** (the containers of patches
  they produced survive intact). Import always mints fresh ids so the same
  file twice gives two projects, suffixes the **incoming** name on
  collision, and unions tags into the profile vocabulary.
- [ ] **6. Rename pass + close-out.** Song→Project/Section across file
  names (`song-model.js`, `song-editor.js`, `song-session.js`), exports
  (`createSongSequence`, `songCol`, `songPos`), ~40 `.song-*` CSS classes,
  tab labels and e2e selectors. Deliberately last and separate, so a
  rename conflict cannot hide inside a model change. `.midi-section` →
  `.midi-group` to free the word for the musical meaning.

#### Deferred by decision, recorded so they are not re-litigated

- **No project-level UI beyond one section.** The model carries N sections;
  the UI edits exactly one. No section list, no whole-piece playback.
- **A section or pattern overriding a track's config (patch included) at
  runtime** — wanted, later.
- **Patch duplication across projects is accepted.** `voiceKey()` already
  exists when dedup is wanted. The user notes sections and patterns will
  be the real redundancy once projects are cloned; a shared-reference
  store is a later concern.
- **No WAVs in the export, ever**; at most a future "re-upload a missing
  WAV" path, with nothing done with it for now.
- Switching projects swaps the whole canvas and patch workspace — there is
  no global patch library. Accepted consequence of project-owned patches.

### MIDI clock (2026-10-30) — DONE, browser-checked 2026-11-01

From TODO.md: basic internal clock sending / syncing with external. Done
in two slices; **send** is committed (6d6de69), **receive** is in the tree.

- [x] **Send.** `midi-manager.js` owns the clock-out: `getSendClock` /
  `setSendClock` (persisted, default off), `isClockOutEnabled`,
  `clockStart(startCol)`, `clockColumn(rawCol, bpm)`, `clockStop()`.
  Beat clock is 24 PPQN and a column is a sixteenth, so each column the
  transport reaches is scheduled as **six timestamped clocks** in one batch
  — the tick worker only wakes once per column, and the stamps are what
  give the device an even beat. They are timed off a base anchored at the
  first column (`clockBase = {at, rawCol, msPerClock}`), **not** off each
  tick's arrival, so worker jitter cannot read as tempo wobble and a late
  batch cannot be stamped behind the one before it; the base re-anchors
  when the tempo changes. `startCol > 0` sends Song Position (which counts
  sixteenths, exactly our columns) + Continue instead of a bare Start.
  Everything goes through `sendAt()`, so the clock carries the same output
  latency as the notes and the device stays with what you hear.
  Independent of `outputMode` on purpose. `panic()` stops it (pagehide).
- [x] Transport calls `clockStart` on play/startRecording, `clockColumn`
  first thing in `onTick`, `clockStop` in `stop()`. It imports
  midi-manager directly, as toolbar.js does.
- [x] "Send MIDI clock" checkbox in the MIDI settings modal
  (`.midi-send-clock`). The audition checkbox gained a `.midi-audition`
  class — a panel test was finding it as "the first checkbox".
- [x] `test/midi-clock.test.js` (23). Verified in headless Chrome against a
  fake output port with the real tick worker: 48 clocks in one second at
  120 BPM, gaps identically 20.833 ms, Start at +3 ms, Stop at +1003 ms.
- [x] **Receive.** Decided with the user: **Play waits for the device's
  Start; Song Position is ignored.** `midi-manager.js`: `getSyncToClock` /
  `setSyncToClock` (persisted, default off); the input listener routes
  status ≥ 0xF8 to `handleRealtime` before SysEx/notes (realtime may land
  mid-SysEx, and toolbar's note handler drops ≥ 0xF0 anyway);
  `subscribeClockIn(fn)` emits `start` / `continue` / `stop` / `column
  {rawCol}` (every sixth clock, counted from Start; Continue keeps the
  count) / `sync {on}`; `getExternalBpm()` is the mean of the last 24 clock
  periods (one quarter), fed by clocks whether or not the device is
  running, reset by a 2 s silence. **A slave never sends clock**
  (`isClockOutEnabled` is false while syncing) — it would loop back onto
  the bus — and switching to slave stops a running clock-out.
- [x] Transport: `armed` ('play' | 'record'). With sync on, `play()` /
  `startRecording()` **arm** instead of starting the worker and broadcast
  `pos.waiting`; worker ticks are ignored while armed; clock-in `start` /
  `continue` flips `playing`/`recording` (Start from the range top,
  Continue from `lastCol`), `column` → `onTick(rawCol)`, the device's
  `stop` pauses (notes released, **still armed**), our `stop()` disarms;
  `sync` off/on under us stops. `effectiveBpm()` (device's when known,
  else the song's) times `fire()` and rides in `pos.bpm`;
  `isWaiting()`, `isRunning()` includes armed, `getEffectiveBpm()`.
  A take into an empty song (no range) still starts on Start.
- [x] UI: "Sync to external clock" checkbox (`.midi-sync-clock`); the Song
  tab's and the roll's Play get `.waiting` (amber pulse, title) and are
  disabled while Stop is live; the roll's `isPlaying()` includes waiting so
  the mobile Play/Stop toggle can disarm. toolbar.js: `recordStartTime`
  re-bases on the transition into recording (`takeRunning`), and `colAt`
  uses `transport.getEffectiveBpm()` — under an external clock Rec and the
  device's Start can be seconds apart and the tempos differ.
- [x] `test/midi-clock-in.test.js` (20). Headless Chrome, fake input port:
  armed → Start + 13 clocks → col 2 → device Stop (armed, col kept) →
  Continue + 6 → col 3 → our Stop disarms → a later Start is ignored.

**Browser-checked against Reaper, 2026-11-01, both directions. Done —
see CHANGELOG 2026-11-01.** Two bugs came out of it and the second was the
first: the tick worker could not change tempo mid-run, which made our clock
out unfollowable after a BPM change (six fast ticks, a long gap) as well as
leaving the roll's BPM box inert during playback; and the two clock settings
were independent, so clock out sat ticked and silent whenever sync had been
left on. Both fixed; "send clock" and "sync to external" are now one choice.

Known limits still standing: the measured tempo is a trailing mean (a ramp
lags by a quarter note); no Song Position by decision; the loop range is
still whole bars. Reaper translates an incoming tempo change into note and
rest lengths, which is the behaviour the user wants.

### Sub-measure clips (2026-10-30) — code complete, awaiting browser check

From TODO.md: sub-measure placement and extension of patterns in the Song
editor. Clip geometry moved from measures to **columns** (sixteenths).

- [x] Model: `clip.startCol` replaces `startMeasure`; a clip's length is
  either its own (`lengthCols`, set by dragging its edge) or its pattern's
  (`repeats` whole pattern lengths, so it follows the pattern as the
  pattern grows). Exactly one of the two is stored; `clipCols()` resolves
  them and replaces `clipSpan()`. No migration: `createClip` reads the old
  spelling, and a clip converts the first time it is moved or resized.
  `updateClip` canonicalises its `changes` first — spreading `{startMeasure}`
  over a record that already had `startCol` was a silent no-op.
- [x] Sequencer: partial repeats (a clip may end part-way through one),
  note durations cut at the clip end, `playbackRange` takes columns. A song
  still **plays to the end of the bar** its last clip ends in, so a clip cut
  to one beat does not loop the song every beat.
- [x] Editor: Snap (Bar … 1/16) and Zoom (×1 … ×8) selects, both persisted
  (`openpatches_song_snap` / `_zoom`); place floors to the snap cell, move
  and resize snap the *delta* so a deliberately off-grid clip stays off it;
  sub-bar grid lines are a second gradient under the bar lines, driven by
  `--song-snap-w` / `--song-measure-w` on `.song-grid`.
- [x] Tests: `sub-bar placement and length` in `song-editor.test.js`,
  `clips off the bar line, and cut short` in `sequencer.test.js`, new cases
  in `song-model.test.js`; the harness's `style` now has `setProperty`.

Verified in headless Chrome: the controls, a 1/4-snap placement at bar 2
beat 2 (zoom ×4), an edge drag to ×1.25, persistence, and a legacy
`startMeasure`/`repeats` song reading back in the right place, still
following its pattern until its edge is dragged.

Browser check to do: Song tab → Snap 1/4, Zoom ×4, place a clip part-way
through a bar, drag its edge to a fraction of a repeat, play it. Then
commit; CHANGELOG.md entry is in. **Zoom was not in the task** — a column
is 3px at ×1, below the 4px drag threshold, so the fine snaps need it; say
if you would rather it went.
Open: the loop range is still whole bars only.

### Step record (2026-10-30) — code complete, awaiting browser check

From TODO.md: "Rec" without Play starts a step-driven record.

- [x] Rec with the clock stopped arms a **step record** (`stepping` in
  toolbar.js; Rec while playing is still a live take, and Play while
  stepping — the roll's or the mobile one, via the roll's `onBeforePlay`
  hook — converts it into one, which is also how a take on an empty song
  starts now).
- [x] A key (or MIDI note) held a full second puts **one step length** at
  the step cursor, **in the pattern on screen** (`addStepNote` →
  `pianoroll.addNote` with the roll's `getEditTarget()` clip; with nothing
  on screen it starts a track on the record slot). Every further second
  grows it by one more step length (`syncStepNote`, 100 ms timer,
  `pianoroll.setNoteDur`), clamped at the pattern's end; the length on the
  grid at key-up is what is kept. *(Reworked 2026-10-31: the step length is
  the `.pianoroll-step-len` select — 1/16…1/1, persisted in
  `openpatches_step_len`, in the transport row after Rec and only visible
  while stepping.)*
- [x] **Rests:** a tap shorter than a second jumps the cursor to the next
  beat (the next quarter boundary; a full beat when already on one).
  *(Reworked 2026-10-31 — replaced the old one-sixteenth rest and its
  500 ms double-tap quarter.)*
- [x] Last key up ends the step: cursor += longest note (or the rest
  jump), wrapping at the pattern's end; `pianoroll.setStepCursor` draws it
  as the playhead and scrolls sideways if it left the view.
- [x] **The playhead is draggable while stepping (2026-10-31):** the
  header strip is the cursor's handle — `seekStep(col)` in pianoroll.js
  (drag or API) reports through `opts.onStepSeek`, and the toolbar's
  cursor follows. The header is now a dead zone for note drawing: a click
  there used to land a note on the top row (`pixelToRow` clamps).
- [x] The roll **centres vertically on each step note** (`addNote({reveal:
  'row'})` → `centerRow` + `revealCol`).
- [x] Tests: `test/toolbar-step-record.test.js`; Rec-from-stopped
  expectations in `toolbar-record-keyboard.test.js` now start playback
  first (a quick tap into a step record is a rest).

First browser check (2026-10-30) failed: keys produced nothing. Diagnosed in
headless Chrome: the step note went through the take's `mapRecordColumn`,
keyed on the **record slot** (`activeRecordSlot`), which can disagree with
the pattern on screen — `voiceBank._setActiveSlot()` is a no-op for an
empty slot, so opening a clip from the Song tab on such a track (or picking
one in the voice select) moves the roll but not the recorder. The note then
landed in another track's pattern, or nowhere ("nothing placed on voice N
here" in the Log tab, no JS error). Steps now bypass that mapping. **The same
desync still affects live takes** — not fixed here, worth a follow-up
(sync the record slot to the roll's edit target, or record on it directly).

Second browser check to do: Rec (stopped) → hold a key ~2.5 s (note appears
at 1 s, two sixteenths at release); a short tap (cursor +1, no note); two
quick taps (+4); a chord with staggered releases; Play while armed starts a
take; Stop Rec clears the cursor. Then commit (CHANGELOG.md entry is in).
Open: moving the cursor by clicking the ruler.

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

Bug survey 2026-10-23 — swept 2026-10-29; everything fixed is in CHANGELOG.md. Still open:

- [x] Voice bank: removing a slot shifted the channels of the slots after it. **Fixed 2026-10-31** (VoiceBank de-flaking, CHANGELOG.md): the bank is a fixed `Array(8)` and removal leaves a hole, so no entry ever changes channel.
- [ ] `audio-manager` ready-handshake resolves unconditionally after 2 s (deliberate fallback, left alone).
- [ ] Recorded notes are not clamped to the loop end on insert (the recorder seam-splits held notes, so this does not occur in practice); only interactive resize is clamped.

### e2e suite (Playwright) — complete, now a standing layer

All three phases done 2026-10-30 (see CHANGELOG.md). 31 tests, ~35 s. What a
future agent needs:

```bash
npx playwright test                  # whole suite; starts server.py 8111 itself
npx playwright test e2e/midi.spec.js
npx playwright test e2e/visual.spec.js --update-snapshots   # after an intentional style change
npx playwright show-trace test-results/<dir>/trace.zip
```

- Layer covers what `test/harness.js` structurally cannot: real AudioContext/
  AudioWorklet/WASM init, real Worker clock timing, canvas pointer math,
  reload/migration boots, filechooser/download plumbing, a fake
  `navigator.requestMIDIAccess` end to end, and four masked screenshots.
  The unit suite stays dependency-free; `@playwright/test` is the project's
  only npm dependency.
- `e2e/fixtures.js` seeds past the first-run prompts and **fails any test on a
  console error, uncaught exception or failed request** (ignore list is tiny;
  `net::ERR_ABORTED` is the downloader, not a failure). `openApp`/`openRollTab`
  live there too.
- Test hook: `window.__opDock` (app.js, next to `pianoDockWrapper`). Importing
  a module URL from `page.evaluate` returns the app's own singleton.
- Browser facts the specs are written around (each documented where it bites):
  `.kb-btn-play` is mobile-only; the roll's pane is ~180 px tall so raw mouse
  work stays at midi ≥ 77; the legend growing on first draw shifts the canvas
  a row (re-measure boundingBox every gesture); the roll's 350 ms dblclick
  window eats fast same-cell gestures; `initAudio()`'s 2 s fallback means
  "ready" alone doesn't prove the WASM loaded; DEMO.syx carries 9 named
  voices; `/api/export-syx` needs the real backend and is mocked with
  `page.route`.
- Visual baselines are Linux-Chromium renders in `e2e/visual.spec.js-snapshots/`
  (maxDiffPixelRatio 0.02 for font rasterization). They will not match on
  macOS/Windows — regenerate or skip there.
- Deferred by decision: loop-marker/foldX hit-testing (needs looping+follow
  playback state mid-gesture), real MIDI hardware, exact audio output
  comparison, full-page screenshots (night sky and spectrograms animate).

## Open Questions / Gotchas In Flight

_(Things discovered mid-task that the next agent needs to know, but that aren't
yet stable enough to be an AGENTS.md rule.)_

- 2026-10-30: **the dock centres its panels, which is a stranding trap.**
  `.dock-panel { align-items: center }`: a panel wider than the dock overflows
  on *both* sides, and the start side of a centred overflow cannot be scrolled
  to — the left edge is gone for good, not merely off screen. So **every dock
  panel must size itself to the dock and scroll internally; none may take its
  content width.** `.song-editor` violated this and a clip at bar 200 put the
  pattern palette at x=-4432 (fixed: `width: 100%`). `align-items: safe center`
  does **not** rescue this — measured, no effect. `.edit-panel-inner` is still
  vulnerable but unreachable in practice; see TODO.md.
- 2026-10-30: **`e.touches` is truthy-but-empty on `touchend`** — the lifted
  finger's position is only in `e.changedTouches`. Any handler shared between
  touchmove and touchend must check `length`, not existence, before indexing
  (song-editor's `pointer()` is the reference). The unit harness has no
  TouchEvent, so this class only ever surfaces in `e2e/mobile.spec.js` or on a
  device. Related: a child sized with `height: 100%` needs a parent with a
  *definite* height — `min-height` alone resolves the percentage as `auto`
  (the mobile keyboard collapsed this way; absolutely-positioned siblings
  resolve against the used height instead, which is how it ended up inverted).
- 2026-10-30: **a sibling worktree's dev server will silently serve you the
  wrong files.** Parallel checkouts under `.cache/claude-hfi/.../<name>` all run
  the same `server.py`, so whoever binds the port first wins and the loser's
  `python3 server.py <port>` dies quietly. This cost real debugging time: the
  song-editor bug looked unreproducible for several runs because port 8111 was
  held by the `elm` worktree. `playwright.config.js` now uses port 8123 with
  `reuseExistingServer: false` so a clash fails loudly. When probing by hand,
  check `pwdx $(pgrep -f 'server.py <port>')` before trusting a result.

- 2026-10-24: single-engine refactor (committed in c55711b). One long-lived worklet engine for all audible output; previews (canvas playPatch, edit panel) now play realtime on channel 15 instead of offline-render → decode → inject. `playNoteRealtime` releases the previous preview note before starting a new one (note-off matches all notes with same channel+midi). One shared main-thread offline instance (`dx7-synth.js` `renderOffline` + `batchRenderWaveforms`, re-exported by audio-manager) — was two. New WASM exports: `all_notes_off()` (keyup+fade, state survives; also CC 120/123) and `get_channel_samples(ch, n)` (pre-filter int32 capture of last render; single static buffer — read before the next call). `send_midi` drops messages instead of nanosleep-spinning when the ring is full. Deliberately ONE wasm build: compile-flagging `channel_outputs_` out would have meant either losing per-channel capture everywhere or shipping two binaries. `playSamplesInWorklet`/`play-samples` kept but currently unused.

## Architecture

OpenPatches is a browser-based DX7 patch editor and sequencer. It communicates with the fmguessr inference server via REST API (see API.md).

**Frontend (Vanilla JS, no framework):**
- `html/app.js`: main orchestrator. Wires file input, menu bar, canvas, toolbar. Creates tick worker, `stopTickWorker` helper. PlayNote/playPatch with multi-channel support. Emergency stop with voice reload.
- `html/components/canvas.js`: Canvas — patches + PatchContainers on night-sky. Drag-to-reposition, snap-into-container (only after a real move — a tap on a floating patch's header never absorbs it), resize containers. State derived from linked Job. Uses `onDoc()` helper for **every** document-level listener (drag/resize/touchcancel, more-menu close) with cleanup via `clearDocListeners()` on each `renderAll()` to prevent stale closures. `initCanvas()` is re-entrant: the sky drop handlers and the window `touch-drop-patch` handler are kept in module vars and replaced, not stacked. `addPatchToContainer()` on a grouped container files the patch under an `ADDED` group (`ADDED_GROUP_LABEL`) so it renders; `removePatchFromCanvas()` also drops it from its group. All interactive elements in `#night-sky`.
- `html/components/song-session.js`: the **current song**, shared by the pattern editor and the song editor. Owns persistence (songStore + `openpatches_current_song`), runs the migration in `init()`, notifies subscribers with a `source` so editors can skip their own echoes. `update(mutator, source)` is the only sanctioned way to change the song; `notifyPattern` for pattern-only changes. Always has a current song.
- `html/components/song-editor.js`: the Song tab. **Play / Stop** first in the toolbar (`.song-play`/`.song-stop`, `transport.play({mode:'song'})`, synced from the position broadcasts), tracks × measures grid, pattern palette, clip place/move/repeat/remove, per-track voice + mute/solo, song select/name/BPM/loop. `openClip` parks the transport's song position on the clip (`setSongPosition`) so that placement is what the roll loops. The playhead draws from `pos.songCol` in both modes. All changes go through the session and autosave; model refusals are shown in `.song-status`. `opts.onOpenPattern(clipId, trackId, patternId)` hands a clip to the roll. **Clip gestures** mirror the roll's notes: a second tap on the same clip within `DOUBLE_TAP_MS` removes it, a press held still for `LONG_PRESS_MS` opens it; both are detected from press/release in `startDrag` (no `dblclick` listener), with the tap memory (`lastPress`) on the editor because the click in between re-renders the clip. Only a *tap* release arms the double-tap, so re-grabbing a just-dragged clip is safe. **A body drag is two-dimensional**: measures sideways, and into another track's lane (`laneAt(clientY)` over the lanes' client rects; the element is re-parented into the target lane as a preview and recoloured to that voice); the drop goes through `updateClip` with `{startMeasure, trackId}`, so the model's overlap check covers the destination. The palette's ✎ button starts the same in-place rename as double-clicking the name; its `<input type=color>` swatch (`.song-pattern-swatch`) recolours the pattern. **Colours:** a lane's `backgroundColor` is the track's voice colour at 0.16 alpha (`tint()`; `backgroundColor` and not `background`, the bar grid is a `background-image` on the same element), a clip's background is its pattern's colour, and a cross-lane drag preview no longer recolours the clip. **Snap and zoom** (`.song-snap` / `.song-zoom`, persisted under `openpatches_song_snap` / `_zoom`, defaults Bar and ×1 so the grid behaves as it always did): snap is the resolution for placing (floored to the cell the click fell in), moving and lengthening (both snap the *delta*, so a clip put deliberately off the grid keeps its offset); zoom scales `measureW()`, needed because a column is 3px at ×1, under `DRAG_THRESHOLD`. The sub-bar grid lines are a second, fainter gradient under the bar lines, with both periods passed to the stylesheet as `--song-snap-w` / `--song-measure-w` on `.song-grid`; at Bar snap they coincide and the fainter layer is invisible. Takes `opts.transport` to draw `.song-playhead`, which is moved per tick rather than re-rendered. `destroy()` unhooks the document keydown and the session.
- `html/components/toolbar.js`: Unified Piano Roll + Keyboard panel with tabs: Canvas | Piano Roll | Song | Mixer | Edit | Log | Mute. The voice bank lives in the **Mixer** panel (`mixerPanel`, `wrapper._showMixer()`), not in `pianorollRow` — on every viewport. Creates the song session before the roll and hands it to both the roll and the song editor (`wrapper._session`, `wrapper._songEditor`, `wrapper._voiceBank`); applies a song's `voiceBank` when the session switches song and snapshots the live bank back on every bank change (source `'voicebank'`); opening a clip from the Song tab sets the voice bank's active slot, calls `pianorollRef.openClip()` and switches to the Piano Roll tab. Keyboard integrated into Piano Roll panel (recording controls + octave selector + piano keys below pianoroll grid), wrapped in a collapsible `.keyboard-wrapper` under a `.kb-toggle` bar (state in `openpatches_kb_collapsed`). VoiceBank select dropdown. Undo button for recording. Mobile octave selector (0–7). **Record** exists twice: `.kb-btn-record` in the mobile-only `kb-controls` row and `.pianoroll-record` inserted into the piano roll transport row for desktop; both call `toggleRecording()`. Uses tick worker for precise playback/recording timing. **Note dispatch:** every note source goes through `noteOn(midi, velocity, when)` / `noteOff(midi, when)` — on-screen keys, and `handleMidiMessage` for external MIDI. `heldNotes` (a Set) is the authority on what is down; `noteOff` is a no-op for anything not in it. Timing is `performance.now()` so `MIDIMessageEvent.timeStamp` can be passed straight in as `when`. The midi-manager import is namespaced `midiManager` because `midi` is the note-number parameter name throughout the file. The take's time base (`recordStartTime`) is re-based on the transition into recording (`takeRunning`), and `colAt` uses the transport's effective tempo — under an external clock Rec and the device's Start can be seconds apart. **Rec is two things:** over a running clock a live take (`recording`, `startTake`); with the clock stopped a **step record** (`stepping`): a key held a full second puts one **step length** (the stepping-only `.pianoroll-step-len` select, persisted) at `stepCol` **in the pattern on screen** (`addStepNote` uses the roll's `getEditTarget()`, not the take's slot mapping — the record slot and the roll can disagree, see the task entry), grows by one more step length per further second (`syncStepNote`, a 100 ms timer, `pianoroll.setNoteDur`); a tap under a second is a rest that jumps the cursor to the next beat; the last key-up of a step advances the cursor, wrapping at the pattern's end; the cursor is draggable by the roll's header strip (`onStepSeek`). Play while stepping (the roll's `onBeforePlay` hook, or the mobile button through `startPlayback`) converts it into a take; any clock start seen on the transport ends it.
- `html/components/edit-panel.js`: Morph / Params / Random editing. One shared range slider: `setSliderMode()` swaps min/max/step and restores the mode's own last value from `dataset.<mode>Val` (the browser clamps on a range change, which used to destroy the other mode's setting). Params **Save** takes algorithm/feedback from the edited `currentMutation.globals` and saves offline — audition is local-synth first, `/api/play` as fallback, and neither is required.
- `html/components/job.js`: Job class — steering object for WAV import lifecycle. Owns: probe → match → poll → complete/fail. `complete()` writes the canvas entries and `ctr.patchIds` itself and saves the container once — it must not go through `addPatchToContainer()`, whose per-patch re-read/re-save would be overwritten by the stale copy.
- `html/components/song-model.js`: Sequencer data model — **Pattern** (reusable, monotimbral, notes carry no voice; `kind` is the hook for drum patterns later; `color` is a `#rrggbb` the factory defaults from a hash of the id over `PATTERN_COLORS` — a palette deliberately distinct from the voice-bank slot colours — so legacy records get a stable colour on every read), **Track** (bound to a voice-bank slot = synth channel = MIDI channel, unchanged), **Clip** (a pattern placed on a track at `startCol`, in **columns**, so it need not sit on a bar line) and **Song** (tracks + clips + bpm + loop range). A clip's length is either **its own** (`lengthCols`, what dragging its edge sets, free-form so it may stop part-way through a repeat) or **its pattern's** (`repeats` whole pattern lengths, which grow with the pattern); exactly one of the two is stored and `clipCols(clip, pattern)` is the only thing that resolves them — the factory has no pattern, which is why `repeats` cannot be converted on read. `startMeasure`/`repeats` are the pre-column spelling, still read, so there is no migration: a clip converts itself the first time it is moved or resized. `patternStore`/`songStore` are id-keyed; `COLS_PER_MEASURE` lives here and pianoroll.js adopts it in phase 3. One clip per track per column — a track is a monophonic timeline, so two clips in one place would mean two patterns on one voice. Also owns the migration off the piano-roll blob and the old name-keyed song store: versioned (`migratedVersion()`, currently 2), read-only, and it never deletes the legacy keys. Imports patch-model.js only for the legacy song store.
- `html/components/patch-model.js`: Unified data model + stores (localStorage). `patchStore`, `canvasStore`, `jobStore`, `tagStore`. (The old name-keyed `songStore` is gone — sequencer state lives in song-model.js.) `createPatch()` ids hash `voice_data|name` when a name is given, so one voice under two names (a match in several result groups) is two records; re-importing the same bank still yields the same ids. **`voiceKey(voiceData)`** is the opposite and deliberately so: a *name-independent* hash (name bytes zeroed at 118–127 packed / 145–154 VCED) normalised across base64 / `Uint8Array` / `Array`, so a renamed copy is the **same voice**. Patch id answers “which record”; voiceKey answers “which sound” — the voice bank and the slot badges key on the latter. Carries its own base64 decoder (node:test has no `atob`).
- `html/components/patch-row.js`: Unified patch row rendering with star drag handle, mini spectrogram, slot badge, assign/edit/remove buttons. **`attachAssignPopover(btn, anchor, patch, opts)`** is the one way into the voice bank (also used by canvas container headers): ♫ opens `.patch-assign-pop`, eight buttons showing each slot's occupant, `.current` on the patch's own slot, first empty pre-focused, click commits via `opts.onAssignSlot(patch, idx)` and closes. **`updateBankSlots(entries)`** (driven by app.js's `onSnapshot`) rebuilds a module-level `voiceKey → {slot,color}` registry and refreshes every `.patch-slot-badge` **by document query, not subscription** — rows are rebuilt on every canvas render, so a subscriber list would accumulate dead elements. `createSlotBadge(patch)` renders the pill, hidden when the voice is not banked. A click on the row body no longer assigns. Touch drag between containers with floating clone; crossing back into the body cancels the drag-out (clone removed, no clone on drop), `touchcancel` aborts cleanly. `reorderContainerPatch()` applies a touch reorder to the group that holds both rows **and** the flat list (a grouped container renders only its groups; a move across groups is refused). One document `mouseup` disarms the star-armed row instead of one listener per row.
- `html/components/patch.js`: Waveform helpers only — `decodeWavSamples` (general RIFF chunk walk: `fmt ` and `data` in any order with LIST/fact between, 16-bit PCM or 32-bit float, N channels mixed to mono), `drawMiniWaveform`, `wavSampleCache`, `releaseWavUrl` (revokes the `blob:` URL `playPatch` returns, once the waveform is drawn — the consumer owns it).
- `html/components/voicebank.js`: the **Mixer** (8 slots), rendered in its own dock tab on every viewport — eight vertical channel strips (slot pill, name, vertical fader, volume, M/S/▶/×). **The bank is a fixed `Array(8)` and the index IS the channel** — removal leaves a `null` hole, entries never shift, colors are `PATCH_COLORS[i]`. **One write path:** `_assignToSlot(idx, {name, voiceData, patchId})` — occupied target + unbanked voice = silent overwrite; voice already elsewhere = **swap** (entries move wholesale). Identity is `voiceKey(voiceData)` from patch-model.js (name bytes zeroed), so one voice occupies at most one slot; dedup also runs in `loadState`/`_setEntries`. No drag-in, no reordering. **Mute/Solo** are volume overrides: `entry.volume` is the fader, `entry.effectiveVolume` is what the engine hears (0 when muted or solo-silenced); `applyMix()` recomputes the whole bank after any change and pushes only moved channels. Persists to localStorage incl. muted/solo. `_setEntries(list)` replaces every slot at once (song load, keeps positions). `_render()`, `_toggleMute(i)`, `_toggleSolo(i)`, `_firstEmptySlot()`.
- `html/components/pianoroll.js`: **Pattern editor** (still the piano roll on screen). Edits one monotimbral Pattern — the active voice slot's track; other tracks are read-only ghosts behind it. `notes` is a binding repointed to the active pattern's array, which is why the editing code is untouched by the Pattern move; `ensureActiveTrack()` creates a track+pattern on the first note. Measure buttons and Clear span every track. Playback is the transport's (`getTransport()`, `getMode()`, `setMode()`); **Play and Record from the roll are pattern scope** (`transport.play({mode:'pattern'})` / `startRecording({mode:'pattern'})`) — the pattern on screen, looped where it sits in the song and never longer. The `.pianoroll-accompany` button is **not** a scope switch: it toggles `transport.setAccompany()`, i.e. whether the rest of the song is heard inside that window. The roll subscribes to the transport's positions and is purely a view of them — `playCol` is `edit.patternCol`, `-1` where its pattern is not under the song's playhead. `addNote({..., clipId})` lets the recorder name the clip. Reads the current song from the shared session (`opts.session`, or its own); `tracks` is a per-song-track view (opened clip or first clip + its pattern), `liveCache` the copies being edited, cleared on foreign notifications. Patterns have individual lengths; measure buttons act on the edited one. `openClip(clipId)` edits a specific clip's pattern. View prefs in `openpatches_roll_prefs`. `getSong()`/`loadSong()` still speak the legacy flat slot-tagged shape for song-bar.js. Sequencer with looping. Hit-testing folds the second (loop) grid copy onto the first (`foldX`), interactive right-edge resize is clamped to the loop end (`clampDur`), `touchcancel` restores whatever was mid-move. Notes store per-note `voiceData` and `channel`. Touch support: `TOUCH_RESIZE_MARGIN = 20`, visual resize handles, double-tap to delete. Long-press (1s) to create note when stopped, drag to scroll. `revealRow(midi)` scrolls vertically to centre a row only when it is off screen — what `addNote` does while recording (stopped, it centres on both axes). The legend's active entry carries the edited pattern's name (`.pianoroll-legend-pattern`), click to rename in place; saved through `saveState([pattern])` so the Song tab follows. **Follow-scroll is opt-in** (`followPlayhead`, default off, persisted): only then is the canvas double-wide (content drawn twice for a seamless loop) and the view scrolled per tick; otherwise the red 2 px playhead is the only motion. `canvas.width` is assigned only on change. `handlePlaybackTick(col)` driven by tick worker. `setRecordingTickHandler` for recording delegation. `insertControl(el)` lets the toolbar place its Record button after Stop. `setStepCursor(col)` draws the step record's cursor exactly like the playhead (which wins whenever the clock runs) and scrolls sideways if it is out of view; `setNoteDur(note, dur)` is the step record's in-place resize; `addNote({reveal:'row'})` centres the row (`centerRow`) and reveals the column (`revealCol`); `getEditTarget()` is the pattern on screen as the transport sees it; `opts.onBeforePlay()` lets the toolbar claim a Play press. `getSong()`/`loadSong(data)` are the song store's view of the roll.
- `html/components/syx-parser.js`: `.syx` reader. Rejects anything whose format byte is not `0x09` (32-voice bank); verifies the checksum but only **warns** (`patches.checksumOk === false`, surfaced in the log by `importSyxBank`) because hex-edited banks with stale checksums are common.
- `html/components/syx-builder.js`: DX7 SysEx **encoder** (syx-parser.js is the reader). Bulk dump `F0 43 0n 09 20 00 <4096 packed> <cksum> F7` = 4104 bytes; edit-buffer voice `F0 43 0n 00 01 1B <155 unpacked> <cksum> F7` = 163; dump request `F0 43 2n 09 F7`. Checksum = `(128 - (sum & 0x7F)) & 0x7F`. `patch.voice_data` is already the packed 128-byte form so a bank is a straight concatenation, padded to 32 with `makeInitVoice()`. `unpackVoice()` expands packed 128 → VCED 155 (17-byte ops become 21, 26 global bytes become 29) using dx7-params' `readOp`/`readGlobal`. **`html/DEMO.syx` is the golden test fixture** — parse → rebuild is asserted byte-identical, and unpack → repack is asserted lossless across all 32 voices.
- `html/components/tag-editor.js`: Tag editor component with autocomplete.
- `html/components/tutorial.js`: First-run tutorial modal with overlay highlights. Skips clip-path on mobile.
- `html/synth/audio-manager.js`: Singleton AudioContext + AudioWorklet. `acquire()` creates once, `initAudio()` loads modules once. Multi-channel: `sendVoiceSnapshot()`, `playNoteOnChannel()`. `emergencyStop()` reinitializes MSFA engine. No malloc/free — uses static WASM buffers. `playNoteOnChannel` guards against stale note-off via self-reference check.
- `html/synth/midi-devices.js`: device profile table + `detectDeviceType(portName)`; see the profiles entry above. Pure data/regex, no DOM, no MIDI.
- `html/synth/midi-manager.js`: Web MIDI singleton, same shape as audio-manager. **Clock out** (`sendClock`, persisted, default off; `clockStart`/`clockColumn`/`clockStop`): 24 PPQN = six clocks per column, scheduled per column as one timestamped batch off a start-anchored base so worker jitter never reaches the device; Song Position + Continue when starting anywhere but the top; stopped by `panic()`. Independent of `outputMode`. **Clock in** (`syncToClock`, persisted, default off): the input listener hands status ≥ 0xF8 to `handleRealtime` first; `subscribeClockIn` emits start/continue/stop/column(rawCol, every sixth clock from Start)/sync; `getExternalBpm()` is a trailing mean over 24 periods, reset by a 2 s gap. **`sendClock` and `syncToClock` are one choice, not two** — setting either clears the other (and becoming a slave stops a running clock-out), `initFromStorage` repairs a both-on state left by an older build with sync winning, and the `!syncToClock` term in `isClockOutEnabled()` stays as an invariant now unreachable through the setters. They were independent until 2026-11-01, and the result was clock-out ticked and silently inert whenever sync had been left on. Holds the persisted `deviceType` ('auto' or a profile id) and resolves it via `getDeviceProfile()`; `receiveBank`/`sendBank` consult the profile. Access is requested only on demand and never at import time — except `resumeIfEnabled()`, which app.js calls from `initMidiUi()`: once a grant has been held (persisted `enabled` flag, set by any successful `requestMidi`) later loads re-request at the tier `auditionEnabled` needs; the browser remembers the permission so there is no prompt. A silent failure leaves the state `closed`, never `denied`. Two permission tiers: `requestMidi({sysex:false})` for notes, `requestMidi({sysex:true})` for bulk dumps — the upgrade re-prompts and swaps the `MIDIAccess`, so `attachInputListener()` re-binds the input handler by object identity, and a generation counter stops an older in-flight request clobbering a newer grant. Port selection persists to localStorage by id **with a name fallback** (ids are not stable across sessions). `panic()` = CC 120 + CC 123 on all 16 channels; called on emergency stop, output change, `pagehide` and tab-hide. `receiveBank`/`sendBank` are the real SysEx transport (see syx-builder). Test seams: `_reset()`, `_getAccess()`. **Note output:** `outputMode` (internal/midi/both), `slotChannels[8]` (slot → MIDI channel, identity default), `playNoteOut()`/`stopNoteOut()`/`releaseAllOut()` with an `outNotes` map keyed `"channel:midi"`. `isInternalEnabled()` returns true when MIDI-only is selected but no device is reachable — the app must never go silent because a cable was unplugged. **Output latency:** a persisted setting (`getOutputLatency`/`setOutputLatency`, default 317 measured against a Volca FM, max 1000) added to every note-path timestamp by `sendAt()`, the single send helper; SysEx is unstamped. `panic()` sweeps twice, now and at `+latency`. `playLatencyProbe(midi, {durMs, voiceData, onWire})` is the calibration tick for the settings modal.
- `html/components/midi-panel.js`: MIDI settings modal, laid out **by signal direction**: enable, **device type** (with profile notes), then an `Input` section (input select, input channel, sync to external clock) and an `Output` section (output select, device channel, output mode, slot map, send MIDI clock, **output-latency slider + flashing test-tone calibrator** fed by `opts.playTestNote`/`prepareTestNote`/`testVoiceData` from app.js, audition, panic). `section(title)` builds each; the headings are `h4.midi-section-title`, deliberately not `label`s — e2e finds selects by `.midi-field:has(label:text-is("Output"))`. The two clock boxes are the two halves of one choice and live one per section; `refreshClockBoxes()` reads both back from midi-manager (never from each other) and raises `.midi-clock-warning` when clock out is on with no output port, the one remaining way to tick it and get nothing. Also `sendBankToDevice()` — the guarded confirm → optional backup → send flow. A failed backup aborts the send; it never falls through to "proceed anyway". Transport is real since Phase 4; the backup step uses `receiveBank`.
- `html/synth/transport.js`: **the clock**. Also drives MIDI clock out when it is switched on — `clockStart` on play/record, `clockColumn` first thing in `onTick`, `clockStop` on stop; it imports midi-manager directly and never asks whether a device is listening. **Or follows one:** with sync on, Play/Record only **arm** (`armed`, `pos.waiting`, worker ticks ignored); the device's Start/Continue runs it (Start from the top, Continue from `lastCol` — Song Position is ignored by decision), its columns are `onTick(rawCol)`, its Stop pauses but leaves it armed, our Stop disarms. `effectiveBpm()` (the device's measured tempo when known) times notes and rides in `pos.bpm`. Sole subscriber to the tick worker; owns mode (`song`/`pattern`, persisted), play/stop/record, sequence rebuilds (`refresh()` after every edit), note firing, and the position broadcast both editors draw from. **`refresh()` also pushes the tempo** (`retempo()` → `opts.tempoWorker`), because BPM is one of the things an edit can change and the worker is told its rate once at start; it is the entry point both BPM inputs already reach (the roll's directly, the Song tab's via the session subscription), and a no-op while stopped or armed. **Pattern mode is the song confined to one placement of the edited pattern** (one pattern length, other tracks audible inside it); the placement is the one nearest `songPos` — the last song column played, or where `setSongPosition()` parked it — via `patternPlacements`/`nearestPlacement`; a pattern placed nowhere falls back to `createPatternSequence`. `play({mode})` and `startRecording({mode})` switch (and persist) the scope first. **Accompaniment** (`getAccompany`/`setAccompany`, persisted under `openpatches_transport_accompany`, default on) is orthogonal: in pattern mode it passes `onlyTrackId` to the song sequence so only the edited track sounds. It changes what sounds, never the loop, so it applies mid-take without stopping. Positions carry `songCol` (-1 only for the lone-pattern loop) and `edit` is placement-relative. Recording in pattern mode goes through the song path of `mapRecordColumn`. `mapRecordColumn(absCol, slot)` maps a recorded column onto a pattern (`{patternCol, clipId}` / `{fresh:true}` / `null`). Created by the roll unless one is passed in.
- `html/synth/sequencer.js`: pure sequencer core. A clip may start off the bar line and stop part-way through a repeat: `placementsAt` bounds it, note durations are cut at the clip's end, and `patternPlacements` emits a short last placement. The song itself still **plays to the end of the bar** its last clip ends in (`playbackRange` takes columns; the ceil is in `createSongSequence`) — a clip cut to one beat must not loop the song every beat. `createSongSequence(song, getPattern, {range})` (the override is pattern mode's window) / `createPatternSequence` share one interface; `patternPlacements(song, patternId, getPattern)` (one per repeat, sorted) and `nearestPlacement(placements, col)` (inside wins, else the closer edge, ties to the earlier) are what the transport picks the window with; `opts.onlyTrackId` confines what sounds without touching the window (`locate` still reports every track, so playheads are unaffected). They share one interface (`length`, `range`, `columnForTick`, `eventsAt`, `locate`); `audibleTrackIds` (solo set if any, else unmuted), `playbackRange`, `wrapToRange`, `msPerColumn`. Snapshots patterns at creation, reads mute/solo live. Imports song-model for `COLS_PER_MEASURE`/`clipSpan` only.
- `html/synth/tick-worker.js`: Web Worker heartbeat for pianoroll. Atomics.wait path (SharedArrayBuffer) for zero-CPU sleeping, setTimeout fallback. Absolute targeting (`anchorAt + (col - anchorCol) * msPer`), spin for sub-ms precision. Start/stop via a generation counter in shared memory (`Int32Array[0]`): app.js `startTickWorker`/`stopTickWorker` bump it + `Atomics.notify`; a loop exits when the counter moves, and a `start` whose `gen` is outdated is ignored. Always start through `opts.startWorker`, never raw `postMessage`. Worker stays alive for reuse. **Live tempo** (`Int32Array[1]`, milli-BPM — formerly the reserved slot): `setTickWorkerTempo` in app.js stores it and notifies; the fallback path takes a `{type:'tempo'}` message instead. It cannot be a message on the Atomics path — that loop blocks in `Atomics.wait` and never returns to its event loop, so a `postMessage` sits unread until the transport stops. A change **re-anchors**, it does not restart: the grid is recomputed from the last tick emitted, so emitted ticks keep their timing, pending ones move, and `rawCol` keeps counting. Gotcha when editing either loop: recompute the target *after* waking and *before* the precision spin, or a tempo drop is spun through at the old, shorter interval and the tick fires early.
- `html/synth/dx7-synth.js`: Batch waveform rendering only (main thread WASM). No realtime synth code.
- `html/synth/dx7-processor.js`: AudioWorkletProcessor wrapping MSFA DX7 engine. Ring buffer (~300ms lookahead) for audio stability. Handles `voice-snapshot`, `midi`, `patch`, `play-samples`, `channel-volume`, `reinit` messages. MIDI logging via `logMidi` no-op (override to enable).
- WASM: `html/synth/wasm/msfa.wasm` (zig c++ build). Binary fetched on main thread, passed to AudioWorklet via `processorOptions`. Static buffers: `get_patch_buffer()`, `load_voice_from_buffer()`. Voice stealing with 64-sample fade-out. `init_engine(sr)` once per instance (builds LUTs, sets volumes); `reset_engine()` before every offline render — deletes and recreates the SynthUnit and clears the MIDI ring buffer so renders are independent and memory stays flat. The main-thread renderers (`dx7-synth.js`, `audio-manager.js` offline path) each hold their own instance.

**Layout (CSS Grid):**
- `#page-content`: CSS grid, `grid-template-rows: 1fr 1fr`, `height: calc(100vh - header - footer)`. Top half: night-sky, bottom half: piano dock.
- `#night-sky`: CSS grid (`grid-template: 1fr / 1fr`), `overflow: auto`. Background, border, and border-radius applied directly. `pointer-events` managed on children.
- `#piano-dock`: `overflow: auto`. Tab bar + active panel.
- Mobile (≤600px): `#page-content` is `display: block`. `#piano-dock` is `position: fixed`, full-screen below header. 7 tabs, icon-only (labels in `title`): Canvas | Piano Roll | Song | Mixer | Edit | Log | Mute. Hamburger menu. The song editor stacks palette over grid.

**MSFA DX7 synth architecture (multitimbral):**
- 16 MIDI channels, 32 patch slots, 16 polyphonic voices, 16 LFOs.
- Fixed channel→slot mapping: channel N always reads from slot N. Set at init via `ProgramChange(ch, ch)`.
- `SetVoice(slot, data)` → `memcpy` into `patch_data_[slot*128]` + `UnpackPatch` into `unpacked_patch_[slot]` + LFO reset. Channel uses new patch immediately on next note-on.
- Default patch: silent INIT (all output levels 0). All 32 slots initialized with it.
- Note-on reads `unpacked_patch_[cmd_ch]` where `cmd_ch = MIDI_status & 0x0f`.
- VoiceBank → synth via `sendVoiceSnapshot(entries)`: worklet receives `voice-snapshot` message, loops `loadPatch(data, slot)` per entry. No ProgramChange needed. Volumes are sent as **`entry.effectiveVolume ?? entry.volume`** — the Mute/Solo-folded value. Sending the raw fader value would let the next unrelated bank change silently un-mute a channel.
- Preview: offline render on main thread (`offlineWasm`) + sample injection into worklet (`play-samples` message).
- Realtime preview (`playNoteRealtime`) uses the dedicated preview slot/channel 15 — never slots 0-7, which belong to the VoiceBank.
- Pianoroll playback: `playNoteOnChannel(channel, midi)` via worklet `send_midi(0x90 | ch, ...)`. Channel = VoiceBank array index.

**Deploy:** Docker via `deploy/Dockerfile` + `deploy/docker-compose.yml`. Caddy reverse proxy for static files + API proxy to fmguessr server. COOP + COEP headers enabled for SharedArrayBuffer support.
