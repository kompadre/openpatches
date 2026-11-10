# TODO.md

Project backlog. Parent tasks with nested subtasks; `[ ]` pending, `[x]` done,
`[-]` superseded. Starting a parent task moves it into SESSION.md.

## Project

### Bugs

- [ ] Flaky unit test `pattern colours` (section-editor.test.js): two random pattern ids can hash to the same hue, failing "two patterns, two hues".
- [x] Containers do not always come from inferring a WAV — loading a multitimbral `.syx` makes one too — yet the `⤒ WAV` re-upload offer appears on containers that never had a source WAV. Only containers that came from an inference job should ask for the original WAV. The offer is built in `canvas.js` where `ctr.jobId && onLoadJobWav` and the blob is absent; check what gives a `.syx` container a job id (import path in `project-io.js`, `sourceMissing`).

- [x] Pattern sub-measure placement in Section has been lost to recent changes. _(Not lost: Snap defaulted to Bar and was easy to miss. Default is now 1/2.)_
- [x] div.bpane-content.bpane-content-mixer is limited to .bpane-body viewport width. If .bpane-body scrolls to the right .bpane-content ends abruptly and doesn't cover the rest of Tracks.
- [x] In Chrome, when exporting a project while playing, the page's window looses its focus (the downloaded file list shows in the upper right corner). While the window is inactive the internal clock is still ticking. All the notes that should have played while the window was inactive play the instance it regains focus resulting in cocophonous cluster.

### Plan (agreed 2026-11-06) — phases in order; each phase moves to SESSION.md when started

**Phase 1 — Unified transport.** _Done 2026-11-06._ Play, Stop, Record and BPM once, to the left of the global tabs, with a Section/Pattern switch; the Section and Piano Roll toolbars and the mobile keyboard row lost their copies.

**Phase 2 — Thinner Section lanes, selection and stamp paste.** _Done 2026-11-06._
- [x] Head of two rows with two squares each: track number ([1]) and delete [x]; then Mute and Solo.
- [x] Selection mode and stamp paste for clips, reusing the roll's marquee and stamp.

**Phase 3 — Working with patterns.** _Done 2026-11-06._
- [x] Pattern thumbnails: small dots inside each clip where the pattern's notes are. One cached image blob per pattern, invalidated when the pattern changes. Thin lanes cramp the clip name; the dots are how a clip is recognised.
- [x] Pattern library: a collapsible sub-pane at the bottom of the Section pane with every pattern so far (thumbnails), draggable onto tracks. The list `+ Pattern` replaced, in a smaller form.
- [x] Piano Roll: switch patterns directly from the roll (the library's list again); rename the tab to Pattern.

**Phase 4 — More than one section.** _Done 2026-11-06._
- [x] A **section list** in the left pane, sibling of the library: the model carries an ordered sequence of sections and `addSection`/`removeSection` exist, but the UI edits exactly one and offers no way to add, reorder or switch. Deferred with the user on 2026-11-02.
- [x] **Whole-piece playback** — section by section. The transport's modes are `section` and `pattern`; a third scope, chosen from the unified transport.
- [x] **Tempo automation** (gradual rit./accel.). `effectiveBpm(project, section)` is the seam it grows from; the per-section override is the step-change case already working.

**Phase 5 — Standalone, any time** (revised 2026-11-06). _Done 2026-11-06._
- [x] Drag patches from the canvas onto Mixer slots to assign them.
- [x] **Re-upload a missing WAV.** An imported project carries its jobs with `sourceMissing: true` and the original `fileName`, but there is no way to supply the file afterwards.
- [x] **Storage garbage collection, on demand only** (File → Storage…): report usage per project and for WAVs, delete WAV blobs no job references. No compaction or sharing at project level, and nothing on save.
- [x] **Import from another project into the current one**: like Import Project, with a step to opt in/out of what comes in (patches, patterns).

### Tracker (agreed 2026-11-07) — phases in order

A **Tracker** tab after Pattern: the Section editor on steroids. Rows are the
edited section's sixteenths (time runs down, as in the Section pane), the
columns are the 8 tracks, and each track splits into 1–4 monophonic
**sub-lanes**. Clips show as their pattern's colour, subdued, with a small
header (the pattern's name) on the row the clip starts. Note-ons and
note-offs only — no velocity, no effect column. Entering a note inside a
clip edits its *pattern* (every placement and repeat follows). Keys are
FT2-style (Z-row / Q-row piano, `1` = OFF). Mobile later.

Decisions (with the user; stealing dropped 2026-11-07 — marking a stolen
note would be a lie about what plays):
- **Lanes are derived and stored on the notes** (`note.lane`, omitted when
  0 to keep files small; lanes past 3 derive on the fly and are not
  stored). Derivation honours a stored lane while it is free, so notes do
  not hop. While a track is being edited, re-derivation of its patterns
  waits for **3 s of inactivity** (edits mark the pattern dirty; the
  debounce applies).
- **Per-track view mode, stored packed** (`track.compact`, omitted unless
  true): *expanded* shows a sub-lane per concurrent note (as many as the
  busiest moment needs), *compact* folds the track to one column — a cell
  with several events shows the first plus `+n`, the rest in a tooltip.
- **Typing outside a pattern bails with a message.** Growing room is
  explicit: a ✎ in the gap between tracks at a clip's start offers the
  clip's repeats (×2 → ×3) and `+ Bar to pattern`; dragging a note past
  its pattern's end (phase 3) adds the bar itself.
- **Viewport rectangle**: the Section pane outlines the rows the tracker
  shows.

- [x] **Phase 1 — Pure model.** `tracker-model.js`: stable lane
  derivation, expansion of a track's clips into rows (notes, OFFs, clip
  blocks), and the tracker edit operations (note, OFF, clear) on a
  pattern. `note.lane` in the project model.
- [x] **Phase 2 — Read-only view.** The Tracker tab after Pattern (every
  viewport), the canvas grid (ruler, bar/beat shading, clip blocks in the
  pattern's colour with name headers and repeat seams), compact/expanded
  per track with the `+n` cells and tooltip, the ✎ popover (repeats,
  + Bar), active-track sync with the Mixer/roll, playhead + follow-scroll,
  the viewport rectangle in Section.
- [x] **Phase 3 — Editing.** Cursor, FT2 key entry (Z/Q rows, `1` = OFF),
  octave and edit step, delete, audition on entry, refusal outside a clip,
  note-drag past the pattern end adds a bar, the 3 s re-derivation
  debounce (dirty patterns). The pattern name moved to the gap under the ✎,
  reading downward.
- [ ] **Phase 4 — Mobile** (later): tap-to-cursor and an entry pad.

### Collaborative editing (agreed 2026-11-10) — milestones in order

Host-authoritative: one person's session is the controller; others join it,
see the project, play it, and (from M2) edit it. Host → guests: **parts**
(a pattern, a patch, the track list…) resent whole when they change, cut
from the session's existing `source`-tagged events and debounced commits.
Guest → host (M2): **edits made of atomic ops**, refereed per atom —
earliest start wins (design below). No CRDT.
Transport-agnostic protocol; browsers cannot accept sockets, so "p2p" is a
relay (first) or WebRTC (later, if latency matters).

- [x] **M1 — Protocol + mirror, one browser.** `collab-model.js` (parts,
  diff, in-place apply, messages), `collab.js` (host/guest over a
  pluggable channel; BroadcastChannel first), store/session guest mode
  (ephemeral body), File › Collaborate…, menu-bar chip, `?join=CODE`.
  Guests watch and play; their edits are reverted with a notice.
- [ ] **M2 — Guest edits, with conflicts refereed per atom.** Design agreed
  2026-11-10 (user took every recommendation); **next step: phase M2-1.**

  **Atoms** — the smallest independently changeable things:
  `pattern/<id>/note/<start>:<midi>` (value: `dur`; the lane is *not* in
  the key — it is re-derived at every commit), `pattern/<id>/{name,measures,color}`,
  `track/<id>/{name,slot,voice,volume,mute,solo,compact}`,
  `track/<id>/fx/<effect>/<param>`, `section/<id>/clip/<clipId>/{startCol,repeats,…}`,
  `section/<id>/{name,bpm,…}`, `sections/order`, project `name`/`bpm`/`fx/<param>`,
  `patch/<id>` (whole; content-addressed, add/remove only),
  `canvas/<container>/{x,y}`, and existence atoms (`pattern/<id>`, `track/<id>`,
  `clip/<id>`…) for create/delete. Notes keyed by start+pitch, **no note ids**
  (unique after a commit thanks to mergeDuplicates).
  **Groups**: a delete+insert of one pitch in one pattern within one edit is
  a move and is accepted or rejected whole; so is a new pattern with its
  first clip. Everything else is a group of one.

  **Edit** = `{ id, alias, peer, module, base, start, end, groups: [[op…]…] }`,
  op = `{ atom, before, after }` (compare-and-set; `before` from the guest's
  host-confirmed mirror). `module` = the session event's `source`. `end` =
  the editor's commit. `start` = new `session.beginEdit(scope, source)` in
  tracker (first keystroke into an uncommitted pattern), roll (press), section
  editor, mixer (grab); editors without it get start = end. Times are
  **host-clock**: ping/pong offset on join and every 30 s.

  **Referee (host)** per op: current = before → apply; current = after →
  no-op, accepted; else **conflict**. A conflict exists only if the atom's
  last accepted writer (host keeps `{edit, alias, module, start, end, version}`
  per atom) landed after the edit's `base` — versions decide *whether*,
  never intervals. Ranking: **earliest start wins**, then earliest end, then
  peer id; the loser's group is rejected (or the displaced winner gets an
  "overridden" row). **Edit beats delete** regardless of time. Invariants
  (one track per slot, no orphan/overlapping clips, notes inside the pattern)
  checked after merging; a violating group is rejected with the reason.
  **Per-group acceptance**, not all-or-nothing. **Starts older than 2 min
  lose their priority** (a forgotten open edit cannot win forever).

  **People see**: the chip shows `⚠ n conflicts`; the Log gets a line each;
  the Collaborate dialog has a session Conflicts table — What · You (value,
  module, start–end) · Them (alias, value, module, start–end) · Kept (who,
  why) · **Reapply mine** (re-sends your value as a fresh edit on the current
  base). Both sides get a row (winner's collapsed). Aliases and colours asked
  on first Share/Join, stored in the profile. **"Bob is editing Riff"**
  presence in M2, from `beginEdit` (`begin` message).

  **Guest side**: own edits show at once, marked pending; host parts arriving
  mid-edit merge **per atom**, skipping atoms with local pending changes
  (M1's whole-array pattern replace would wipe a tracker edit); acks settle
  them; rejected atoms take the host's value + a table row. The host's own
  edits go through the same referee. Resync as M1, pending edits rebased.
  New messages: `begin`, `edit`, `ack`, `overridden`, `ping`/`pong`.

  Worked examples to become tests: A adds C-4@0 / B adds E-4@4 in one pattern
  → both; same note same dur → one (agreement); same note dur 4 vs 8 →
  conflict, earliest start; notes vs rename → both; volume vs delay → both;
  clip move vs repeats → both unless it now overlaps (invariant conflict);
  clip to bar 3 vs bar 5 → conflict; delete pattern vs add a note → edit
  wins, deleter notified; tracker typing that cuts a held note (dur 16→4)
  vs roll lengthening it to 12 → conflict on that note's dur; overlapping
  notes in one lane → both, lanes repack.

  - [ ] **M2-1 Atoms and ops** (pure, collab-model or a new `collab-ops.js`):
    the atom map incl. note keys; diff two bodies → ops with before/after;
    group moves; apply ops; invariant check.
  - [ ] **M2-2 Referee** (pure): per-atom last-writer record, CAS outcomes,
    ranking, edit-beats-delete, 2-minute cap, conflict rows. Every worked
    example above as a unit test.
  - [ ] **M2-3 Clock and identity**: ping/pong host-time offset; alias and
    colour in the profile.
  - [ ] **M2-4 Wiring**: `beginEdit` in tracker/roll/section/mixer; commits →
    edits; pending overlay and per-atom merge on guests; acks; the host's own
    edits through the referee. Removes M1's view-only revert.
  - [ ] **M2-5 UI**: conflicts table, chip badge, Reapply mine, presence;
    two-tab e2e that makes each kind of conflict on purpose.
- [ ] **M3 — Real network.** A room relay (`/api/room/{code}` WebSocket in
  the Go service; a dev relay for `server.py`), join by code from another
  machine, heartbeats, reconnect + resync, host-gone handling.
- [ ] **M4 — Comforts.** Remote cursors/selections, follow the host's
  transport, soft locks ("Alex is editing Riff"), names and colours.

### Ideas

- [ ] Import and export **MIDI** (patterns ↔ MIDI files; a section or the piece as a multi-track SMF).
- [ ] Export (and maybe import) the project as a **Reaper project** (.rpp): tracks, clips as MIDI items, tempo.
