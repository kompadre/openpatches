# TODO.md

Project backlog. Parent tasks with nested subtasks; `[ ]` pending, `[x]` done,
`[-]` superseded. Starting a parent task moves it into SESSION.md.

## Project

### Bugs

- [ ] **`.edit-panel-inner` is content-sized and can strand its own left edge.** Same class of bug as the Section-editor one fixed on 2026-10-30: the dock centres its panels, and a centred box wider than the dock overflows on both sides with the start side unreachable. Measured: inject wide content and the inner goes to `x=-2384`. **Latent today** — real Edit content tops out at 526 px (Params mode) against a 1216–1824 px panel, so nothing triggers it. Not a blind fix: the inner is deliberately `min-width: 400px` and centred, so `width: 100%` would change how the panel looks. Decide the intended look first, then pin it with a `e2e/layout.spec.js` case. _(Triaged 2026-11-05: the generic guard in `e2e/layout.spec.js` now catches this the moment it fires; the fix waits on the look decision — see the question in that session.)_

### Features

- [ ] A **section list**: the model carries an ordered sequence of sections and `addSection`/`removeSection` exist, but the UI deliberately edits exactly one and offers no way to add, reorder or switch. Decided with the user on 2026-11-02 to defer; this is what unblocks it.
- [ ] **Whole-piece playback** — play the project section by section. The transport's modes are `section` and `pattern`; a third scope is the missing piece.
- [ ] **Tempo automation** (gradual rit./accel.). `effectiveBpm(project, section)` is the single seam it grows from, and the per-section override is the step-change case already working.
- [ ] **Deduplicate shared data across projects.** Patches are small, but duplicating a project copies its sections and patterns wholesale. The user flagged this on 2026-11-02 as worth doing eventually: keep repeated items in one place and reference them. `voiceKey()` already identifies a patch by its bytes.
- [ ] **Re-upload a missing WAV.** An imported project carries its jobs with `sourceMissing: true` and the original `fileName`, but there is no way to supply the file afterwards.


### Ideas

- [ ] **Section** tab pattern visualization: paint small dots inside each clip where the pattern's notes are. Generate an image blob, cache it, invalidate the cache when the pattern changes.
- [ ] **Pianoroll** let the user switch between patterns directly from Pianoroll. Rename Piano Roll tab to Pattern.
- [ ] **Mixer** tab on desktop is 75% empty. Let's combine Patches with Mixer showing Mixer on the bottom part of Patches canvas and make it collapsable. 
   - Bonus points if we can drag patches onto Mixer slots. 

