# demo/ — the feature video

A ninety-second tour of OpenPatches: a narration script, and a Playwright
script that drives the app through it in a real Chrome window so the screen
and the synth can be recorded together.

Nothing in here is a test. `demo/` is outside `e2e/`, so `npm run e2e` never
picks it up, and no scene asserts anything — a scene that cannot find its
control logs a warning and moves on, because losing one scene is better than
losing the take.

## The pieces

| File | What it is |
|---|---|
| `narration.js` | The voiceover, scene by scene. Source of truth for *both* the words and the pacing. |
| `feature-tour.mjs` | Drives the browser. One function per scene, each paced to its narration. |
| `cursor.js` | A visible mouse pointer with a click ripple — neither a screen capture nor Playwright's video shows the real one. |
| `make-voice.mjs` | Renders the narration to a scratch track with espeak-ng, and measures it. |
| `out/cues.json` | Written by each run: where every scene starts. Line the voiceover up against this. |
| `out/shots/` | One frame per scene, with `--shots`. |

## Recording a take

1. **Start the inference server** on port 8080, so the WAV scene is real.
   `html/app.js:27` already points there on localhost.

2. **Fix the timing.** Edit the words in `narration.js`, then:
   ```bash
   node demo/make-voice.mjs
   ```
   This writes `demo/voice/*.wav` and `demo/voice/durations.json`. The tour
   gives every scene exactly as long as its narration takes to say, plus its
   `hold` — so the pacing follows the script automatically.

3. **Rehearse** without taking over the screen:
   ```bash
   node demo/feature-tour.mjs --headless --speed 4 --shots
   ```
   Then look through `demo/out/shots/`. This is worth doing after any change:
   a run can report ten clean scenes while filming an empty panel.

4. **Record.** Start your screen and audio capture, then:
   ```bash
   node demo/feature-tour.mjs --wav ~/path/to/source.wav
   ```
   It opens real Chrome at 1920×1080 and counts down three seconds before the
   first scene. Audio goes to your normal output, so the synth is captured
   with the picture.

5. **Cut.** `demo/out/cues.json` has the start and end of every scene. The
   `midi` scene carries an `insert` note — its four-second hold is where the
   Volca FM footage goes.

## Options

```
--wav <path>       include the WAV-import scene (needs the server on :8080)
--headless         rehearse without a window. No audio — never use for a take
--speed 4          run faster, for rehearsing
--shots            save a frame per scene to demo/out/shots/
--only a,b         run just these scenes. Note: scenes depend on earlier ones
                   loading the bank, so most fail in isolation
--video            also record Playwright's own (silent) video
--countdown 5      seconds before the first scene
```

## Things that will bite

- **Scenes depend on each other.** `curation` clicks the cartridge's 🎵
  button, which fills the Mixer *and* sets the active patch. Without it,
  clicks on the piano roll draw nothing and the Section stays empty, so four
  later scenes film blank panels. `--only` skips that setup.
- **Stop the transport before touching the Section.** A running playhead
  re-renders the lanes constantly and Playwright's "element is stable" check
  never passes, so every click there times out.
- **The piano roll grid is clipped.** The canvas is ~1000px tall but
  `.pianoroll-scroll` shows a short band of it. Clicks aimed at the canvas's
  own box land below the fold and do nothing.
- **The pattern chip's centre is a colour input.** Click
  `.section-pattern-name`, not the chip.
- **Replacing the scratch voice.** Drop your takes in as
  `demo/voice/<scene>.wav` and run `node demo/make-voice.mjs --measure` to
  re-measure without overwriting them.
