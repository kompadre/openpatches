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

### Ideas

- [ ] **Tracker as the single source of truth** (user, 2026-11-17): the
  Tracker view becomes the one home of timeline events; other views read
  it. Explicitly *not* a sudden pivot — a direction to drift towards.
- [ ] Import and export **MIDI** (patterns ↔ MIDI files; a section or the piece as a multi-track SMF).
- [ ] Export (and maybe import) the project as a **Reaper project** (.rpp): tracks, clips as MIDI items, tempo.
- [ ] Per section track configuration.
