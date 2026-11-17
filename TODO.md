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
- **Jumps come from the Tracker's effects column** (shipped 2026-11-17, CHANGELOG — `section.fx`, open command set).
- **Humanize is per track.** Rather than scheduling notes ahead, the clock
  can skip some of its precision spinning while micro-adjusting the pause
  between ticks; since the offsets are per track, that micro-adjustment
  must be passed on to the playheads.

**Playhead behaviour** (user, 2026-11-17). The head runs **one row ahead
of the clock**: a head *at row N* has gathered row N's events and **armed
them for the next tick**. That one-row window is what lets an event be
moved in time both ways — fired before its tick (humanize early) or after.
- **Start**: every head of a Section rests at **row −1**. The Player's
  *advance* step (move to the next row, arm its events) runs once on Play,
  before the clock's first tick — that is who arms row 0 for the first
  pass. Each tick then does: fire what is armed for this tick, advance every
  head, arm the next row.
- **Walk**: a pattern under the head → gather its events; a gap between
  patterns → arm nothing, keep stepping; the end of the track's last
  pattern → **by default wrap to the track's first row** (an effects
  command may say otherwise). Everything a head does is scoped to the
  Section.
- **Loop status**: a head that wraps — by reaching the end of its track's
  last clip (default) or by a command jumping past it — goes to the
  track's row 0 and gains the status **looped** (once; never cleared
  inside the Section). A track with no clip in the Section is **inactive**
  and takes no part in what follows; a head a command has **stopped** is
  satisfied too.
- **Section transition** (user, 2026-11-17, replaces "the longest track"):
  a head arriving at its **last row** that is **not yet looped**, while
  **every other active head has looped at least once or is stopped**,
  ends the Section. Refinement (agent, to confirm): a colleague that is
  itself at its last row on the same tick counts as satisfied — otherwise
  tracks of equal length (the common case) all arrive unlooped together and
  no one may go. The Player then overrides **every** head's next step to
  **row −1 of the next Section**; the events already armed still fire on
  their tick, the following advance lands all heads on row 0 of the new
  Section — the realignment — and clears every looped status. The
  all-notes-off at the transition is armed as an ordinary command on that
  crossing, due just before any (possibly early) row-0 note.
- **A track's last row is the end of its last clip, exactly** — no bar
  rounding. Today's rounding (`playCols`) stopped a one-beat clip from
  looping the whole section every beat; under this rule such a clip loops
  only its own track while the others carry on, which is the intent.
- Consequences: the transition is driven by heads, not by the tick count —
  a jump-back on the last unlooped track lengthens the Section in time, so
  the piece's total length and `pieceLayout`/`columnForTick` become nominal
  and the Player must be stateful (heads consume ticks in order; a stale
  tick advances the heads and fires nothing; `seek` of all heads is needed
  from phase 1 for play-from-a-block, external clock `continue` and stale
  ticks). **The per-track loop is the default and a behaviour change**
  (user, accepted: today a short track falls silent after its last clip;
  some songs will change). The way back for an author is a **stop**
  command at the end of the short track — so the Player's first two
  commands are *move this track's position* and *stop here* (agent, to
  confirm). A section loop restart is a transition like any other (every
  head's last row is the loop end): realign and all notes off.

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
- A short track's wrap target: the Section's row 0, or the start of the
  track's first clip when the track begins with a gap? Agent recommends
  row 0 (the head walks the Section's timeline; only the wrap point is
  per track).
- Humanize **early** notes: answered by the one-row window above — a note
  can move earlier by up to one row. Still open: should a pass sound the
  same every time (seeded) or differ?

### Ideas

- [ ] **Tracker as the single source of truth** (user, 2026-11-17): the
  Tracker view becomes the one home of timeline events; other views read
  it. Explicitly *not* a sudden pivot — a direction to drift towards.
- [ ] Import and export **MIDI** (patterns ↔ MIDI files; a section or the piece as a multi-track SMF).
- [ ] Export (and maybe import) the project as a **Reaper project** (.rpp): tracks, clips as MIDI items, tempo.
- [ ] Per section track configuration.
