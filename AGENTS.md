# AGENTS.md

## Rule 0 — Do not modify this file
- **NEVER edit AGENTS.md** unless the user explicitly asks for an AGENTS.md change *and* supplies the literal text to add or change. Do not paraphrase, reorder, "tidy up", or append rules you inferred on your own.
- Everything you learn, decide, or want to record goes in `SESSION.md`, not here. AGENTS.md is the stable contract; SESSION.md is the living state.

## Project State → SESSION.md
- `SESSION.md` holds the project state: current tasks, goals, open questions, and the architecture map. **Read it at the start of a session** before touching code.
- **Keep it current.** When you finish a task, change the architecture, or discover a gotcha the next agent needs, update `SESSION.md` in the same change — tasks and goals under "Current Tasks & Goals", structural facts under "Architecture".
- Prune as you go: SESSION.md is a working set, not a changelog. Git history is the changelog.

## Rules
- Read enough context before editing. Don't creep offsets line-by-line.
- If Edit fails twice, stop and explain the issue.
- Verify JS changes with `node --check html/app.js`, `node --check html/components/*.js`, `node --check html/synth/*.js`.
- Run the regression tests with `node --test test/`. They use `test/harness.js`, a dependency-free browser stub — extend it rather than adding a DOM library.
- WASM build: `make -f Makefile.msfa` in `html/synth/wasm/` (uses `zig c++ -target wasm32-wasi`). Do NOT use emscripten.
- Never export `malloc`/`free` from WASM. Use static pre-allocated buffers (`get_patch_buffer()`, `load_voice_from_buffer()`).
- AudioManager is a singleton — `initAudio()` runs once. Never re-call `addModule()` after initial setup.
- Shutdown is disabled for testing — `shutdownAll()`, `setPianorollStop()`, `extendIdle()` are no-ops.
- Commit on task completion, once the user has verified the fix is correct.
- Match existing code style in each file. Don't introduce conventions that conflict with neighbors.
- Use `pianoDockWrapper` (module-scoped in app.js) to access `_voiceBank`, `_pianoroll`, `_showLog` — NOT `document.getElementById('piano-dock')` which returns the outer container, not the inner wrapper.
- VoiceBank assigns colors by slot index (PATCH_COLORS[8]). Pianoroll receives color via `setActivePatch(id, data, color, channel)` — always pass `entry.color` from voicebank.
- VoiceBank channel = array index. Entries have no `channel` property. Slot IS the channel.
- Keep `HEARME.tts` up to date when making significant architectural changes. It's a spoken-word audio tour of the codebase optimized for TTS. Update the commit hash and date in the preamble.

## Git & Version Control Rules

- **NEVER alter Git history.** Under no circumstances should you run `git rebase`, `git commit --amend`, `git reset`, `git cherry-pick`, or perform any commit squashing/history modifications.
- **Append-only commits:** All changes must strictly be committed as NEW, additive commits on top of the current branch.
- **No speculative or broken commits:** Only commit when the code is verified, working, and builds/runs without errors.
- **Clear commit messages:** Write short, descriptive commit messages summarizing the actual functional changes made.

## Commands

```bash
# Dev server (with COOP/COEP headers for SharedArrayBuffer)
python3 server.py                    # Serves on port 8000

# WASM synth build
make -f Makefile.msfa                # Build msfa.wasm (in html/synth/wasm/)

# Regression tests (no dependencies — uses node:test + test/harness.js)
node --test test/
```
