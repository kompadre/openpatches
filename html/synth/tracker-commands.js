// Tracker commands — what the effects column's letters mean (Player
// phase 4). One registry, two names per command:
//
//   - the **letter** stored in the cell (`section.fx[trackId][].cmd`), which
//     is FastTracker II's where FT2 has the same effect — so an FT2 hand
//     types what it always typed, and an XM import can map its effects
//     straight across (`ft2`);
//   - a human-readable **name** (`jump`, `break`, `back`, `skip`, `stop`),
//     the alias the status line, tooltips and any import/export speak.
//
// Letters FT2 does not use are ours. A letter not in the registry is still
// stored (the column is an open set, decided 2026-11-17) and the Player
// ignores it.
//
// Arguments count **rows** (sixteenths), the Tracker's unit; a beat is
// four. Everything a command does is scoped to the Section and to the
// track it sits on — a jump never leaves the Section.

export const COMMANDS = [
    {
        letter: 'B', name: 'jump', ft2: 'Bxx (position jump)', arg: 'row',
        help: 'this track jumps to row N of the Section; backwards counts as a loop',
    },
    {
        letter: 'D', name: 'break', ft2: 'Dxx (pattern break)', arg: 'none',
        help: 'end the Section after this row: every track realigns on the next one',
    },
    {
        letter: 'R', name: 'back', ft2: null, arg: 'rows',
        help: 'this track moves back N rows (a loop, as far as the Section is concerned)',
    },
    {
        letter: 'K', name: 'skip', ft2: null, arg: 'rows',
        help: 'this track moves forward N rows; past its end it wraps',
    },
    {
        letter: 'S', name: 'stop', ft2: null, arg: 'none',
        help: 'this track stops here for the rest of the Section',
    },
];

const byLetter = new Map(COMMANDS.map(c => [c.letter, c]));
const byName = new Map(COMMANDS.map(c => [c.name, c]));

/** The command a stored letter means, or null for a letter with no meaning yet. */
export function commandByLetter(letter) {
    return byLetter.get(String(letter || '').toUpperCase()) || null;
}

/**
 * The alias: a command by its human-readable name — or by its letter, so
 * one lookup serves both spellings (`'jump'`, `'JUMP'`, `'B'`).
 */
export function commandByName(name) {
    const key = String(name || '').trim().toLowerCase();
    return byName.get(key) || commandByLetter(key) || null;
}

/** The cell's text: `B10`, `S0`. */
export function spell(entry) {
    return entry.cmd + entry.arg;
}

/** For the status line: `B10 · jump to row 10`, or what an unknown letter is. */
export function describeCommand(entry) {
    const c = commandByLetter(entry.cmd);
    if (!c) return spell(entry) + ' · no meaning yet (the Player ignores it)';
    switch (c.name) {
    case 'jump': return spell(entry) + ' · jump to row ' + entry.arg;
    case 'break': return spell(entry) + ' · break: the Section ends after this row';
    case 'back': return spell(entry) + ' · back ' + entry.arg + ' row' + (entry.arg === 1 ? '' : 's');
    case 'skip': return spell(entry) + ' · skip ' + entry.arg + ' row' + (entry.arg === 1 ? '' : 's');
    case 'stop': return spell(entry) + ' · stop: this track rests until the next Section';
    default: return spell(entry) + ' · ' + c.name;
    }
}
