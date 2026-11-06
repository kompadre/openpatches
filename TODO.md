# TODO.md

Project backlog. Parent tasks with nested subtasks; `[ ]` pending, `[x]` done,
`[-]` superseded. Starting a parent task moves it into SESSION.md.

## Project

### Bugs

- [x] Pattern sub-measure placement in Section has been lost to recent changes. _(Not lost: Snap defaulted to Bar and was easy to miss. Default is now 1/2.)_
- [x] div.bpane-content.bpane-content-mixer is limited to .bpane-body viewport width. If .bpane-body scrolls to the right .bpane-content ends abruptly and doesn't cover the rest of Tracks.
- [x] In Chrome, when exporting a project while playing, the page's window looses its focus (the downloaded file list shows in the upper right corner). While the window is inactive the internal clock is still ticking. All the notes that should have played while the window was inactive play the instance it regains focus resulting in cocophonous cluster.

### Plan (agreed 2026-11-06) — phases in order; each phase moves to SESSION.md when started

**Phase 1 — Unified transport.** _Done 2026-11-06._ Play, Stop, Record and BPM once, to the left of the global tabs, with a Section/Pattern switch; the Section and Piano Roll toolbars and the mobile keyboard row lost their copies.

**Phase 2 — Thinner Section lanes, selection and stamp paste.**
- [ ] Head of two rows with two squares each: track number ([1]) and delete [x]; then Mute and Solo.
- [ ] Selection mode and stamp paste for clips, reusing the roll's marquee and stamp.

**Phase 3 — Working with patterns.**
- [ ] Pattern thumbnails: small dots inside each clip where the pattern's notes are. One cached image blob per pattern, invalidated when the pattern changes. Thin lanes cramp the clip name; the dots are how a clip is recognised.
- [ ] Pattern library: a collapsible sub-pane at the bottom of the Section pane with every pattern so far (thumbnails), draggable onto tracks. The list `+ Pattern` replaced, in a smaller form.
- [ ] Piano Roll: switch patterns directly from the roll (the library's list again); rename the tab to Pattern.

**Phase 4 — More than one section.**
- [ ] A **section list** in the left pane, sibling of the library: the model carries an ordered sequence of sections and `addSection`/`removeSection` exist, but the UI edits exactly one and offers no way to add, reorder or switch. Deferred with the user on 2026-11-02.
- [ ] **Whole-piece playback** — section by section. The transport's modes are `section` and `pattern`; a third scope, chosen from the unified transport.
- [ ] **Tempo automation** (gradual rit./accel.). `effectiveBpm(project, section)` is the seam it grows from; the per-section override is the step-change case already working.

**Phase 5 — Standalone, any time.**
- [ ] Drag patches from the canvas onto Mixer slots to assign them (after phase 3's drag code).
- [ ] **Re-upload a missing WAV.** An imported project carries its jobs with `sourceMissing: true` and the original `fileName`, but there is no way to supply the file afterwards.
- [ ] **Deduplicate shared data across projects.** Duplicating a project copies its sections and patterns wholesale; keep repeated items in one place and reference them (`voiceKey()` already identifies a patch by its bytes). Last, once the model stops moving.
