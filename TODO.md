# TODO.md

Project backlog. Parent tasks with nested subtasks; `[ ]` pending, `[x]` done,
`[-]` superseded. Starting a parent task moves it into SESSION.md.

## Project

### Bugs

_(none open)_

### Features

- [ ] A **section list**: the model carries an ordered sequence of sections and `addSection`/`removeSection` exist, but the UI deliberately edits exactly one and offers no way to add, reorder or switch. Decided with the user on 2026-11-02 to defer; this is what unblocks it.
- [ ] **Whole-piece playback** — play the project section by section. The transport's modes are `section` and `pattern`; a third scope is the missing piece.
- [ ] **Tempo automation** (gradual rit./accel.). `effectiveBpm(project, section)` is the single seam it grows from, and the per-section override is the step-change case already working.
- [ ] **Deduplicate shared data across projects.** Patches are small, but duplicating a project copies its sections and patterns wholesale. The user flagged this on 2026-11-02 as worth doing eventually: keep repeated items in one place and reference them. `voiceKey()` already identifies a patch by its bytes.
- [ ] **Re-upload a missing WAV.** An imported project carries its jobs with `sourceMissing: true` and the original `fileName`, but there is no way to supply the file afterwards.


### Ideas

- [ ] **Section** tab pattern visualization: paint small dots inside each clip where the pattern's notes are. Generate an image blob, cache it, invalidate the cache when the pattern changes.
- [ ] **Pianoroll** let the user switch between patterns directly from Pianoroll. Rename Piano Roll tab to Pattern.
- [-] **Mixer** tab on desktop is 75% empty. _(Superseded 2026-11-05: Mixer, Edit and Log moved into a resizable, collapsible bottom pane under every main tab — a different cut at the same wasted-space complaint.)_
- [ ] Drag patches from the canvas onto Mixer slots to assign them.

