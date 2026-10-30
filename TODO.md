# TODO.md

Project backlog. Parent tasks with nested subtasks; `[ ]` pending, `[x]` done,
`[-]` superseded. Starting a parent task moves it into SESSION.md.

## Project

### Bugs and small improvements assorted


### Ideas

- [ ] Add the concept of **Project** for global settings (tempo, voice bank, MIDI settings, the pattern and song libraries).
- [ ] Add the possibility of **exporting a project** (and importing it back).
- [ ] Sub-measure placement and extension of patterns in Song editor.
- [ ] Multi-timbral tracks and multi-voice patterns. Pattern defines notes in Voice slots. Track defines specific patches for those slots: 

   Pattern 1:
      Voice 1: C3 C3
      Voice 2: D5 

   Track 1:
      Voices: 1: Drum, 2: Piano
      Patterns: Pattern 1, Empty, Pattern 2

   - [ ] When assigning a multi-voice pattern to a track that doesn't define enough voices ask user to do it.
   - [ ] "Song" tab pattern visualization: paint small colored dots (different colors for different voices) where notes are inside that pattern. Generate an image blob. Cache that blob,  invalidate cache when pattern changes.
- [ ] Basic internal clock sending / syncing with external.
