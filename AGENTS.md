# AGENTS.md

## Rule 0 — Do not modify this file
- **NEVER edit AGENTS.md** unless the user explicitly asks for an AGENTS.md change *and* supplies the literal text to add or change. Do not paraphrase, reorder, "tidy up", or append rules you inferred on your own.
- Everything you learn, decide, or want to record goes in `SESSION.md`, not here. AGENTS.md is the stable contract; SESSION.md is the living state.

## Project State → SESSION.md
- Holds active project state: current working tasks, goals, open questions, and the architecture map.
- **Read it at the start of every session** before touching code.
- **Keep it current:** Update tasks, goals, and architectural gotchas in the same commit/change.
- **Prune constantly:** `SESSION.md` is active RAM, not history. Finished items move to `CHANGELOG.md`.

## Project Backlog → TODO.md
- Structure: Parent tasks with nested subtasks.
- Task/Subtask statuses: pending `[ ]`, completed `[x]`, superseded/canceled `[-]`.
- When the user mentions a potential future task or feature, append it to `TODO.md`.
- Do not append agent-originated ideas directly to `TODO.md`: propose them to the user in chat first.

## Project Log → CHANGELOG.md
- Append-only record of completed work and structural changes.
- Format by date/session for scannability (`## YYYY-MM-DD: Task Name`).

## Task & Subtask Lifecycle
1. **Backlog:** Ideas and future tasks originate in `TODO.md`.
2. **Activation:** When starting a parent task, **move** (cut) it out of `TODO.md` into `SESSION.md`.
3. **Self-Resolving Subtasks/Tasks:**
   - If work in `SESSION.md` checks off a subtask belonging to a task still in `TODO.md`, mark that subtask `[x]` (or `[-]`) directly in `TODO.md`.
   - If all subtasks under a parent task in `TODO.md` become `[x]` or `[-]`, the parent task is complete and moves directly from `TODO.md` to `CHANGELOG.md`.
4. **Completion:** Once a task in `SESSION.md` and all its subtasks are complete, remove it from `SESSION.md` and record the completed feature/fix in `CHANGELOG.md`.

## Rules
- Read enough context before editing. Don't creep offsets line-by-line.
- If Edit fails twice, stop and explain the issue.
- Verify JS changes with `node --check html/app.js`, `node --check html/components/*.js`, `node --check html/synth/*.js`.
- Run the regression tests with `node --test test/`. They use `test/harness.js`, a dependency-free browser stub — extend it rather than adding a DOM library.
- WASM build: `make -f Makefile.msfa` in `html/synth/wasm/` (uses `zig c++ -target wasm32-wasi`). Do NOT use emscripten.
- Never export `malloc`/`free` from WASM. Use static pre-allocated buffers (`get_patch_buffer()`, `load_voice_from_buffer()`).
- AudioManager is a singleton — `initAudio()` runs once. Never re-call `addModule()` after initial setup.
- Shutdown is disabled for testing — `shutdownAll()`, `setPianorollStop()`, `extendIdle()` are no-ops.
- Match existing code style in each file. Don't introduce conventions that conflict with neighbors.
- Use `pianoDockWrapper` (module-scoped in app.js) to access `_voiceBank`, `_pianoroll`, `_showLog` — NOT `document.getElementById('piano-dock')` which returns the outer container, not the inner wrapper.
- VoiceBank assigns colors by slot index (PATCH_COLORS[8]). Pianoroll receives color via `setActivePatch(id, data, color, channel)` — always pass `entry.color` from voicebank.
- VoiceBank channel = array index. Entries have no `channel` property. Slot IS the channel.
- Keep `HEARME.tts` up to date when making significant architectural changes. It's a spoken-word audio tour of the codebase optimized for TTS. Update the commit hash and date in the preamble.
- Use npx playwright to render Web UI or hunting for an illusive JavaScript behavioral bug. 

## Git & Version Control Rules

### History Integrity
- **NEVER alter Git history:** Do not run `git rebase`, `git commit --amend`, `git reset`, `git cherry-pick`, or perform any commit squashing/history modifications.
- **Append-only commits:** All changes must strictly be committed as NEW, additive commits on top of the current branch.

### Commit Execution & Boundaries
- **Commit on Task Completion:** Create a git commit only when a task or sub-goal is fully complete and verified (code builds/runs without errors).
- **Turn Boundaries:** If a turn ends without having completed a task, **do not commit**. Leave the working tree dirty until the task definition in `SESSION.md` is met, compartmentalizing development cycles cleanly by completed tasks.
- **Commit Messages:** Write short, descriptive commit messages summarizing the actual functional changes made and referencing the completed task name.

## Commands

```bash
# Dev server (with COOP/COEP headers for SharedArrayBuffer)
python3 server.py                    # Serves on port 8000

# WASM synth build
make -f Makefile.msfa                # Build msfa.wasm (in html/synth/wasm/)

# Regression tests (no dependencies — uses node:test + test/harness.js)
node --test test/
```

## Pane-Scoped Ports & Server Reuse Guidelines for e2e and browser checks
- Derive Ports Dynamically: Calculate your port on every turn using the worktree's git dir (git rev-parse --git-dir) and tmux pane ($TMUX_PANE) to stay within the safe 10000–29990 range.
- Run npm run -s e2e:port to get your exact port.
- Never fall back to a shared default port if $TMUX_PANE is unset.
- Safe Server Reuse: any running background server on your derived port is actively serving the correct files. Do not kill it unnecessarily. If a server is already listening on your port, use it.
- Focus on Playwright Cache: To prevent stale content, rely on Playwright-level cache prevention rather than restarting servers. Ensure Playwright bypasses network caching or blocks Service Workers (e.g., via transparent route pass-through or disabling the cache via CDP) so it always pulls fresh responses from the background server.
