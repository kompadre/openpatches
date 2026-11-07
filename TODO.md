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

### Ideas

- [ ] Import and export **MIDI** (patterns ↔ MIDI files; a section or the piece as a multi-track SMF).
- [ ] Export (and maybe import) the project as a **Reaper project** (.rpp): tracks, clips as MIDI items, tempo.
