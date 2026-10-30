# TODO.md

Project backlog. Parent tasks with nested subtasks; `[ ]` pending, `[x]` done,
`[-]` superseded. Starting a parent task moves it into SESSION.md.

## Project

### Bugs and small improvements assorted


### e2e test suite (Playwright)

Phase 1 (config, fixtures, boot/audio/transport) is done — see SESSION.md.
Remaining phases, agreed with the user 2026-10-30:

- [x] Phase 1: `playwright.config.js`, `e2e/fixtures.js` with the console guard, boot smoke, real audio graph, transport + tick worker timing.
- [x] Phase 2:
  - [x] Pianoroll interaction — mouse-driven note draw, drag, resize, delete at DPR 2. (Loop-marker/foldX hit-testing deferred: it needs looping+follow playback state; revisit with phase 3 if it earns its keep.)
  - [x] Persistence round-trip — notes/tempo over reload; legacy `openpatches_pianoroll` blob migrated, idempotent on second boot.
  - [x] File I/O — `.syx` import via filechooser; builder/parser byte round-trip in-page; export UI download with the backend mocked (`/api/export-syx` needs the real server).
- [ ] Phase 3:
  - [ ] MIDI panel against a fake `navigator.requestMIDIAccess` injected with `addInitScript`: device list, clock-out checkbox persistence, clock bytes reaching the fake port (browser-level twin of `test/midi-clock.test.js`).
  - [ ] Small visual regression — `toHaveScreenshot` on 3-4 stable panels only (toolbar, edit panel, voicebank), canvases masked.
- [-] Out of scope by decision: real MIDI hardware, exact audio output comparison, full-page screenshots (the spectrogram and canvas animate).

### Ideas

- [ ] Add the concept of **Project** for global settings (tempo, voice bank, MIDI settings, the pattern and song libraries).
- [ ] Add the possibility of **exporting a project** (and importing it back).
- [ ] Multi-timbral tracks and multi-voice patterns. Pattern defines notes in Voice slots. Track defines specific patches for those slots: 

   Pattern 1:
      Voice 1: C3 C3
      Voice 2: D5 

   Track 1:
      Voices: 1: Drum, 2: Piano
      Patterns: Pattern 1, Empty, Pattern 2

   - [ ] When assigning a multi-voice pattern to a track that doesn't define enough voices ask user to do it.
   - [ ] "Song" tab pattern visualization: paint small colored dots (different colors for different voices) where notes are inside that pattern. Generate an image blob. Cache that blob,  invalidate cache when pattern changes.
