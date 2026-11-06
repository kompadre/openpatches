# TODO.md

Project backlog. Parent tasks with nested subtasks; `[ ]` pending, `[x]` done,
`[-]` superseded. Starting a parent task moves it into SESSION.md.

## Project

### Bugs

- [x] Pattern sub-measure placement in Section has been lost to recent changes. _(Not lost: Snap defaulted to Bar and was easy to miss. Default is now 1/2.)_
- [x] div.bpane-content.bpane-content-mixer is limited to .bpane-body viewport width. If .bpane-body scrolls to the right .bpane-content ends abruptly and doesn't cover the rest of Tracks.
- [x] In Chrome, when exporting a project while playing, the page's window looses its focus (the downloaded file list shows in the upper right corner). While the window is inactive the internal clock is still ticking. All the notes that should have played while the window was inactive play the instance it regains focus resulting in cocophonous cluster.

### Features

- [ ] A **section list**: the model carries an ordered sequence of sections and `addSection`/`removeSection` exist, but the UI deliberately edits exactly one and offers no way to add, reorder or switch. Decided with the user on 2026-11-02 to defer; this is what unblocks it.
- [ ] **Whole-piece playback** — play the project section by section. The transport's modes are `section` and `pattern`; a third scope is the missing piece.
- [ ] **Tempo automation** (gradual rit./accel.). `effectiveBpm(project, section)` is the single seam it grows from, and the per-section override is the step-change case already working.
- [ ] **Deduplicate shared data across projects.** Patches are small, but duplicating a project copies its sections and patterns wholesale. The user flagged this on 2026-11-02 as worth doing eventually: keep repeated items in one place and reference them. `voiceKey()` already identifies a patch by its bytes.
- [ ] **Re-upload a missing WAV.** An imported project carries its jobs with `sourceMissing: true` and the original `fileName`, but there is no way to supply the file afterwards.


### Ideas

- [ ] **Section** tab pattern visualization: paint small dots inside each clip where the pattern's notes are. 
   Generate an image blob, cache it, invalidate the cache when the pattern changes.
- [ ] **Pianoroll** let the user switch between patterns directly from Pianoroll. Rename Piano Roll tab to Pattern.
- [ ] Drag patches from the canvas onto Mixer slots to assign them.
- [ ] Patches library - a collapsable sub-pane on the bottom of "Section" pane containing all patterns created so far. Draggable into Section tracks.
- [ ] Section: make the lanes (Tracks) thinner. 
   - Header with two rows with two squares each: top number of the track ([1]) and delete [x]. Second row - Mute and Solo
   - Add selection mode and stamp paste 
- [ ] Unify transport interface (Play, Stop, Record and BPM) putting it to the left of global tabs (Patches, Piano Roll...)



