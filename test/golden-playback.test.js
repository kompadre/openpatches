// Player phase 0 — the golden playback capture (SESSION.md › Player and
// per-track Playheads). Today's sequencers, column by column, against the
// checked-in goldens in test/golden/. Phases 1–3 of the Player must keep
// `today` byte for byte (except the delta fixtures, whose `player` object
// is phase 1's target under the per-track loop rule); a failure here means
// playback changed — regenerate with `node test/golden/update.js` only
// when that change is intended, and say so in the commit.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fixtures, captureFixture } from './golden-capture.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('golden playback (Player phase 0)', () => {
    for (const fx of fixtures()) {
        test(fx.name, () => {
            const golden = JSON.parse(readFileSync(join(here, 'golden', fx.name + '.json'), 'utf8'));
            assert.deepEqual(captureFixture(fx), golden);
        });
    }

    test('the delta fixtures diverge from today exactly where the loop rule says', () => {
        // Not a tautology of the capture: pin the *shape* of the change so
        // the reference simulation itself is reviewed, not just stored.
        const mixed = JSON.parse(readFileSync(join(here, 'golden', 'delta-mixed-length.json'), 'utf8'));
        // Today: the short track (slot 0, one bar) is silent in bar 2.
        const todayCols = Object.keys(mixed.today.events).map(Number).filter(c => c >= 16 && c < 32);
        assert.ok(todayCols.every(c => mixed.today.events[c].every(e => e[1] !== 0)),
            'today, nothing fires on slot 0 after its clip');
        // Under the Player it loops: its row-0 notes fire again at column 16.
        assert.ok(mixed.player.events[16].some(e => e[1] === 0),
            'the player wraps the short track to its row 0');
        assert.deepEqual(mixed.player.wraps[16], ['tA']);
        assert.equal(mixed.player.transitionAt, 31, 'the long track, unlooped at its last row, ends the Section');

        const poly = JSON.parse(readFileSync(join(here, 'golden', 'delta-polyrhythm.json'), 'utf8'));
        assert.deepEqual(poly.player.wraps, { 12: ['tA'], 24: ['tA'] }, 'a 12-column cut against 32: 3 over 4');
        assert.equal(poly.player.transitionAt, 31);
    });
});
