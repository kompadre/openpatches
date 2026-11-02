# TODO.md

Project backlog. Parent tasks with nested subtasks; `[ ]` pending, `[x]` done,
`[-]` superseded. Starting a parent task moves it into SESSION.md.

## Project

### Bugs and small improvements assorted

- [ ] **`.edit-panel-inner` is content-sized and can strand its own left edge.** Same class of bug as the Section-editor one fixed on 2026-10-30: the dock centres its panels, and a centred box wider than the dock overflows on both sides with the start side unreachable. Measured: inject wide content and the inner goes to `x=-2384`. **Latent today** — real Edit content tops out at 526 px (Params mode) against a 1216–1824 px panel, so nothing triggers it. Not a blind fix: the inner is deliberately `min-width: 400px` and centred, so `width: 100%` would change how the panel looks. Decide the intended look first, then pin it with a `e2e/layout.spec.js` case.
- [ ] **Audit the remaining dock panels for the same trap.** `.pianoroll-row`, `.kb-toggle`, `.keyboard-wrapper` and `.dock-log` all currently size to the dock, but nothing enforces it; a future wide child in any of them strands content silently. Worth a single generic e2e invariant over every `.dock-panel.active` child rather than four ad-hoc tests.
- [ ] Button **Clear** in the pianoroll should only affect the notes inside that pianoroll. (Still outstanding after the Project work: it currently empties the project's tracks and the section's clips.)
- [ ] A **section list**: the model carries an ordered sequence of sections and `addSection`/`removeSection` exist, but the UI deliberately edits exactly one and offers no way to add, reorder or switch. Decided with the user on 2026-11-02 to defer; this is what unblocks it.
- [ ] **Whole-piece playback** — play the project section by section. The transport's modes are `section` and `pattern`; a third scope is the missing piece.
- [ ] **Tempo automation** (gradual rit./accel.). `effectiveBpm(project, section)` is the single seam it grows from, and the per-section override is the step-change case already working.
- [ ] **Deduplicate shared data across projects.** Patches are small, but duplicating a project copies its sections and patterns wholesale. The user flagged this on 2026-11-02 as worth doing eventually: keep repeated items in one place and reference them. `voiceKey()` already identifies a patch by its bytes.
- [ ] **Re-upload a missing WAV.** An imported project carries its jobs with `sourceMissing: true` and the original `fileName`, but there is no way to supply the file afterwards.


### Ideas

_(The **Project** concept and **exporting a project** are **done** —
delivered 2026-11-02 as one six-phase task; see CHANGELOG.md.)_

- [ ] Multi-timbral tracks and multi-voice patterns. Pattern defines notes in Voice slots. Track defines specific patches for those slots: **Needs reconciling before it starts (noted 2026-11-02).** It assumes a Track that maps *several* slots to patches, which is not the Track the Project model settled on: a Track is now one slot, which is one synth/MIDI channel, one Mixer strip and one patch, and patterns are mono. Deciding how multi-voice fits that — a new level above Track? a Track that owns several channels? — is the first step, not an implementation detail.

   Pattern 1:
      Voice 1: C3 C3
      Voice 2: D5 

   Track 1:
      Voices: 1: Drum, 2: Piano
      Patterns: Pattern 1, Empty, Pattern 2

   - [ ] When assigning a multi-voice pattern to a track that doesn't define enough voices ask user to do it.
   - [ ] **Section** tab pattern visualization: paint small colored dots (different colors for different voices) where notes are inside that pattern. Generate an image blob. Cache that blob,  invalidate cache when pattern changes.

