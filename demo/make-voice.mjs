// Render the narration to a scratch voice track with espeak-ng.
//
// Two outputs, both under demo/voice/:
//   <scene>.wav     one file per scene
//   durations.json  { sceneId: seconds } — what feature-tour.mjs paces to
//
// The point is *timing*, not performance. espeak is a placeholder for the
// user's own read; when that read exists, drop the real takes in as
// <scene>.wav and re-run with --measure to refresh durations.json without
// overwriting them.
//
//   node demo/make-voice.mjs              render scratch takes
//   node demo/make-voice.mjs --measure    keep the wavs, re-measure only
//   node demo/make-voice.mjs --wpm 140    slower read

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenes } from './narration.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VOICE_DIR = join(HERE, 'voice');

const argv = process.argv.slice(2);
const measureOnly = argv.includes('--measure');
const wpmArg = argv.indexOf('--wpm');
const WPM = wpmArg > -1 ? Number(argv[wpmArg + 1]) : 150;

mkdirSync(VOICE_DIR, { recursive: true });

/** Seconds of audio in a wav, via ffprobe. */
function durationOf(file) {
    const out = execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], { encoding: 'utf8' });
    return Math.round(parseFloat(out) * 100) / 100;
}

const durations = {};
let total = 0;

for (const scene of scenes) {
    const wav = join(VOICE_DIR, `${scene.id}.wav`);

    if (!measureOnly) {
        // -s is words per minute; -g adds a little gap between words so the
        // scratch track lands nearer a human pace than espeak's default.
        execFileSync('espeak-ng', [
            '-v', 'en-gb', '-s', String(WPM), '-g', '4',
            '-w', wav, scene.text,
        ]);
    } else if (!existsSync(wav)) {
        console.error(`missing: ${wav} — run without --measure first`);
        process.exit(1);
    }

    const spoken = durationOf(wav);
    durations[scene.id] = spoken;
    const scene_total = spoken + (scene.hold ?? 0);
    total += scene_total;
    console.log(
        `${scene.id.padEnd(12)} ${spoken.toFixed(1).padStart(5)}s`
        + ` + ${String(scene.hold ?? 0).padStart(4)}s hold`
        + ` = ${scene_total.toFixed(1).padStart(5)}s`,
    );
}

writeFileSync(join(VOICE_DIR, 'durations.json'), JSON.stringify(durations, null, 2) + '\n');
console.log(`\ntotal ${total.toFixed(1)}s (${(total / 60).toFixed(1)} min)`);
console.log(`durations → ${join(VOICE_DIR, 'durations.json')}`);
