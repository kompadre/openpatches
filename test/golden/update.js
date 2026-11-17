// Rewrite the Player phase-0 goldens from today's sequencers:
//   node test/golden/update.js
// Only when a change in playback output is *intended* — say so in the commit.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fixtures, captureFixture } from '../golden-capture.js';

const here = dirname(fileURLToPath(import.meta.url));
for (const fx of fixtures()) {
    const golden = captureFixture(fx);
    writeFileSync(join(here, fx.name + '.json'), JSON.stringify(golden, null, 1) + '\n');
    console.log('wrote', fx.name + '.json');
}
