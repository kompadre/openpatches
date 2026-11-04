// Render narration.js to demo/SCRIPT.md — the thing a person reads from.
//
// Generated, not hand-edited: narration.js is the source of truth, so the
// words on the page cannot drift from the words the tour is paced to.
//
//   node demo/make-script.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenes, sceneSeconds } from './narration.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const durFile = join(HERE, 'voice', 'durations.json');
const durations = existsSync(durFile)
    ? JSON.parse(readFileSync(durFile, 'utf8'))
    : null;

const out = ['# OpenPatches — feature video narration', ''];
out.push(durations
    ? '_Lengths measured from the espeak-ng scratch track. Regenerate with'
      + ' `node demo/make-voice.mjs && node demo/make-script.mjs`._'
    : '_Lengths estimated from word count — no scratch track rendered yet._');
out.push('');

let total = 0;
for (const s of scenes) {
    const secs = sceneSeconds(s, durations);
    total += secs;
    out.push(`## ${s.title} — ${secs.toFixed(1)}s`, '');
    out.push('> ' + s.text, '');
    out.push(`*On screen:* ${s.shows}`, '');
    if (s.insert) out.push(`*Insert:* ${s.insert}`, '');
}

out.push('---', '', `**Total ${total.toFixed(1)}s**, ${
    scenes.reduce((a, s) => a + s.text.trim().split(/\s+/).length, 0)} words.`);

writeFileSync(join(HERE, 'SCRIPT.md'), out.join('\n') + '\n');
console.log(`demo/SCRIPT.md — ${total.toFixed(1)}s`);
