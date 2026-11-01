# TODO.md

Project backlog. Parent tasks with nested subtasks; `[ ]` pending, `[x]` done,
`[-]` superseded. Starting a parent task moves it into SESSION.md.

## Project

### Bugs and small improvements assorted

- [ ] **`.edit-panel-inner` is content-sized and can strand its own left edge.** Same class of bug as the song-editor one fixed on 2026-10-30: the dock centres its panels, and a centred box wider than the dock overflows on both sides with the start side unreachable. Measured: inject wide content and the inner goes to `x=-2384`. **Latent today** — real Edit content tops out at 526 px (Params mode) against a 1216–1824 px panel, so nothing triggers it. Not a blind fix: the inner is deliberately `min-width: 400px` and centred, so `width: 100%` would change how the panel looks. Decide the intended look first, then pin it with a `e2e/layout.spec.js` case.
- [ ] **Audit the remaining dock panels for the same trap.** `.pianoroll-row`, `.kb-toggle`, `.keyboard-wrapper` and `.dock-log` all currently size to the dock, but nothing enforces it; a future wide child in any of them strands content silently. Worth a single generic e2e invariant over every `.dock-panel.active` child rather than four ad-hoc tests.
- [ ] Button **Clear** in the pianoroll should only affect the notes inside that pianoroll.


### Ideas

_(The **Project** concept and **exporting a project** moved to SESSION.md on
2026-11-02 — planned with the user as one six-phase task.)_

- [ ] Multi-timbral tracks and multi-voice patterns. Pattern defines notes in Voice slots. Track defines specific patches for those slots: **Note (2026-11-02): this assumes a Track that maps several slots to patches, which is not the Track the Project plan agrees on (Track = one slot = one channel, patterns mono). Reword or reconcile before starting — see the Project task in SESSION.md.** 

   Pattern 1:
      Voice 1: C3 C3
      Voice 2: D5 

   Track 1:
      Voices: 1: Drum, 2: Piano
      Patterns: Pattern 1, Empty, Pattern 2

   - [ ] When assigning a multi-voice pattern to a track that doesn't define enough voices ask user to do it.
   - [ ] "Song" tab pattern visualization: paint small colored dots (different colors for different voices) where notes are inside that pattern. Generate an image blob. Cache that blob,  invalidate cache when pattern changes.

