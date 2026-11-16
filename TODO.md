# TODO.md

Project backlog. Parent tasks with nested subtasks; `[ ]` pending, `[x]` done,
`[-]` superseded. Starting a parent task moves it into SESSION.md.

## Project

### Tracker (agreed 2026-11-07)

Phases 1–3 (model, view, editing) are done (CHANGELOG 2026-11-07; SESSION.md
has what must not break).
- [ ] **Phase 4 — Mobile** (later): tap-to-cursor and an entry pad. Phones
  open on Patches until then; desktop opens on the Tracker.

### Collaborative editing (agreed 2026-11-10)

M1–M4 and M3-1/M3-2 are done (CHANGELOG 2026-11-12; SESSION.md has the
standing shape). Host-authoritative; transport and playback stay local to
each peer.
- [ ] **M3-3 The Go service's relay** (parked by the user 2026-11-12): same protocol as
  the stub — `/api/room/<CODE>?peer=<id>`, forward text frames to the
  room's others, `left` notice on drop; Caddy must proxy the upgrade.
- [ ] **Listen in** — hear what a collaborator hears, as streamed audio.
  Transport stays local to each peer; nothing plays in sync.

### Piece panel follow-ups (parked 2026-11-15)

The Piece panel shipped 2026-11-15 (CHANGELOG). Not started; nothing is decided beyond the one-liners.
- [x] **Repeat count per block** (`Chorus ×2`): done 2026-11-16 (CHANGELOG).
- [ ] **Loop a run of blocks**: Shift-select consecutive blocks and loop that stretch of the piece. Today a loop only works inside one section.
- [ ] **Ruler above the strip**: bar numbers or mm:ss, so the piece reads as time.
- [ ] **Phones**: a layout for the Piece panel. The strip is hidden under 600 px for now; the header and the select row still work.

### Tracker: velocity and effects columns (agreed 2026-11-17) — before the Player

Reverses the 2026-11-07 Tracker decision "note-ons and note-offs only".
Both columns are per track. Order: the Tracker view first, playback after.
- [ ] **Velocity column**: a velocity per note, shown and edited in the
  Tracker. Stored on the note (the pattern is data, so that is the right
  home); notes without one play at today's 100.
- [ ] **Effects column**: tracker commands per track, shown and edited in
  the Tracker. The first command the Player needs is "move this track's
  position" (e.g. back 10 beats). Command set and encoding to be decided
  when the phase starts.
- [ ] **Playback honours velocity** end to end (sequencer event →
  `playNote` → internal synth and MIDI out; today both default to 100).

### Player and per-track Playheads (agreed 2026-11-17, parked) — after the Tracker columns

A **Player** with one **Playhead per track**. Decisions (user):
- **Position state lives in the Playhead**, in memory only — never in
  patterns (they are shared: one pattern can play in several places at
  once), clips, or the project body; never synced to collaborators.
  Per-track *settings* (divider, humanize) are stored on the track.
- **A jump moves along the track's timeline, scoped to the Section** — it
  can cross clips but not leave the Section.
- **Playheads line up again when a new Section starts.**
- **No synthetic note-offs on a jump**: what sounds keeps sounding. The one
  exception: **all notes off at the transition between Sections**.
- **Jumps come from the Tracker's effects column** (above).
- **Humanize is per track.** Rather than scheduling notes ahead, the clock
  can skip some of its precision spinning while micro-adjusting the pause
  between ticks; since the offsets are per track, that micro-adjustment
  must be passed on to the playheads.

Phases (proposed 2026-11-16, agreed):
- [ ] **0 — Golden capture**: today's events and playhead positions per
  column over fixture projects (loops, dividers, piece with repeats,
  pattern mode ± accompaniment). Later phases must match it exactly.
- [ ] **1 — Player + Playhead, no behaviour change**: a playhead column
  that follows the global one, the divider as a counter; the transport
  keeps the clock, modes, external sync and MIDI clock out, and hands
  firing and locating to the Player.
- [ ] **2 — The Playhead fires notes**: explicit note-on/off, the notes it
  has sounding, velocity carried, one output interface instead of the
  bare `playNote`; all notes off at a Section transition.
- [ ] **3 — Recording through the Playhead**: a take writes into the
  playhead of the track on screen. Removes `activeRecordSlot` and with it
  the live-take wrong-track bug (SESSION.md).
- [ ] **4 — Per-track moves**: `seek`/`jump` on a playhead, driven by the
  effects column; realigned at a new Section; the Tracker, Section and
  Pattern views draw one playhead per track where they differ.
- [ ] **5 — Humanize**: per-track timing and velocity; the clock's
  micro-adjustment between ticks reported to the playheads (see above).

Open, to settle when the phases start:
- Does a **section loop restarting** count as "a new Section starts"
  (realign), or only moving to another Section in the piece?
- Humanize **early** notes: with no scheduling ahead, can a note only be
  moved later than its tick? And should a pass sound the same every time
  (seeded) or differ?

### Ideas

- [ ] Import and export **MIDI** (patterns ↔ MIDI files; a section or the piece as a multi-track SMF).
- [ ] Export (and maybe import) the project as a **Reaper project** (.rpp): tracks, clips as MIDI items, tempo.
- [ ] Per section track configuration.
