// The effects column's command registry (html/synth/tracker-commands.js):
// FT2 letters where FT2 has the effect, human-readable aliases for all.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, commandByLetter, commandByName, describeCommand, spell } from '../html/synth/tracker-commands.js';

describe('tracker commands', () => {
    test('the two FT2 effects keep their FT2 letters', () => {
        assert.equal(commandByLetter('B').name, 'jump');
        assert.match(commandByLetter('B').ft2, /position jump/);
        assert.equal(commandByLetter('D').name, 'break');
        assert.match(commandByLetter('D').ft2, /pattern break/);
    });

    test('our own commands take letters FT2 does not use', () => {
        for (const c of COMMANDS) if (!c.ft2) assert.ok(!['B', 'D', 'C', 'F', 'E', 'G', 'H', 'K', 'L', 'P', 'R', 'T', 'X'].includes(c.letter) || ['K', 'R'].includes(c.letter));
        assert.equal(commandByLetter('S').name, 'stop');
        assert.equal(commandByLetter('R').name, 'back');
        assert.equal(commandByLetter('K').name, 'skip');
    });

    test('the alias: a command by name or by letter, any case', () => {
        assert.equal(commandByName('jump').letter, 'B');
        assert.equal(commandByName('JUMP').letter, 'B');
        assert.equal(commandByName('b').letter, 'B');
        assert.equal(commandByName('stop').letter, 'S');
        assert.equal(commandByName('nothing'), null);
        assert.equal(commandByLetter('X'), null, 'an open letter has no meaning yet');
    });

    test('describe reads the cell for the status line', () => {
        assert.equal(spell({ cmd: 'B', arg: 10 }), 'B10');
        assert.equal(describeCommand({ cmd: 'B', arg: 10 }), 'B10 · jump to row 10');
        assert.equal(describeCommand({ cmd: 'R', arg: 1 }), 'R1 · back 1 row');
        assert.equal(describeCommand({ cmd: 'K', arg: 8 }), 'K8 · skip 8 rows');
        assert.match(describeCommand({ cmd: 'D', arg: 0 }), /break/);
        assert.match(describeCommand({ cmd: 'S', arg: 0 }), /stop/);
        assert.match(describeCommand({ cmd: 'X', arg: 5 }), /no meaning yet/);
    });
});
