// collab-model.js: the project as parts, their diff, and applying them.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createTrack } from '../html/components/project-model.js';
import {
    PROTOCOL, hintFor, joinHints, readParts, diffParts, recordChanges, applyParts, divergence,
    message, readMessage, makeCode, readCode,
} from '../html/components/collab-model.js';

const project = () => createProject({
    name: 'Jam',
    tracks: [{ id: 't1', name: 'Keys', slot: 0 }],
    patterns: { p1: { id: 'p1', name: 'Riff', measures: 1, notes: [{ midi: 60, start: 0, dur: 4 }] } },
    patches: { a: { id: 'a', name: 'Bell', voice_data: 'AAAA' } },
});
const clone = (p) => createProject(JSON.parse(JSON.stringify(p)));

describe('parts', () => {
    test('patterns and patches by id, the rest by key; identity and bookkeeping never', () => {
        const keys = [...readParts(project()).keys()];
        assert.ok(keys.includes('patterns/p1'));
        assert.ok(keys.includes('patches/a'));
        for (const k of ['tracks', 'sections', 'bpm', 'fx', 'name', 'canvas']) assert.ok(keys.includes(k), k);
        for (const k of ['id', 'modified', 'created', 'schemaVersion', 'patterns', 'patches']) assert.ok(!keys.includes(k), k);
    });

    test('a pattern hint looks at that pattern only', () => {
        const p = project();
        const known = readParts(p);
        p.patterns.p1.notes.push({ midi: 62, start: 4, dur: 4 });
        p.tracks[0].name = 'Not looked at';
        const changes = diffParts(known, p, hintFor({ kind: 'pattern', patternId: 'p1' }));
        assert.deepEqual(Object.keys(changes), ['patterns/p1']);
        assert.equal(JSON.parse(changes['patterns/p1']).notes.length, 2);
        assert.deepEqual(diffParts(known, p, hintFor({ kind: 'pattern', patternId: 'p1' })), {}, 'known is up to date');
    });

    test('a full look finds changes and removals; nothing changed is nothing', () => {
        const p = project();
        const known = readParts(p);
        assert.deepEqual(diffParts(known, p), {});
        p.tracks[0].name = 'Bass';
        delete p.patterns.p1;
        p.bpm = 99;
        const changes = diffParts(known, p, hintFor({ kind: 'tracks' }));
        assert.deepEqual(Object.keys(changes).sort(), ['bpm', 'patterns/p1', 'tracks']);
        assert.equal(changes['patterns/p1'], null);
    });

    test('a patches hint covers the bench, removals included, and not the arrangement', () => {
        const p = project();
        const known = readParts(p);
        delete p.patches.a;
        p.canvas = { c1: { x: 3 } };
        p.bpm = 99;
        const changes = diffParts(known, p, hintFor({ kind: 'patches' }));
        assert.deepEqual(Object.keys(changes).sort(), ['canvas', 'patches/a']);
    });

    test('hints join', () => {
        assert.deepEqual(joinHints({ patterns: ['a'] }, { patterns: ['b'], keys: ['canvas'] }),
            { patterns: ['a', 'b'], keys: ['canvas'] });
        assert.deepEqual(joinHints({ patterns: ['a'] }, { all: true }), { all: true });
        assert.deepEqual(joinHints(null, { patterns: ['a'] }), { patterns: ['a'] });
    });
});

describe('applyParts', () => {
    test('a pattern changes in place: the same object, the same notes array', () => {
        const host = project();
        const guest = clone(host);
        const obj = guest.patterns.p1;
        const notes = obj.notes;
        const known = readParts(host);
        host.patterns.p1.notes.push({ midi: 64, start: 8, dur: 2 });
        host.patterns.p1.name = 'Riff 2';
        const moved = applyParts(guest, diffParts(known, host));
        assert.equal(guest.patterns.p1, obj);
        assert.equal(guest.patterns.p1.notes, notes);
        assert.equal(notes.length, 2);
        assert.equal(obj.name, 'Riff 2');
        assert.deepEqual(moved, { patterns: ['p1'], structure: false, bench: false });
    });

    test('a new or removed pattern, and tracks, are structure; patches are the bench', () => {
        const host = project();
        const guest = clone(host);
        const known = readParts(host);
        host.patterns.p2 = { ...host.patterns.p1, id: 'p2', name: 'Two' };
        host.tracks.push(createTrack({ id: 't2', name: 'Bass', slot: 1 }));
        host.patches.b = { id: 'b', name: 'Pad', voice_data: 'BBBB' };
        const moved = applyParts(guest, diffParts(known, host));
        assert.equal(guest.patterns.p2.name, 'Two');
        assert.deepEqual(guest.tracks.map(t => t.name), ['Keys', 'Bass']);
        assert.equal(guest.patches.b.name, 'Pad');
        assert.equal(moved.structure, true);
        assert.equal(moved.bench, true);
        assert.deepEqual(readParts(guest), readParts(host), 'the guest now matches');

        const k2 = readParts(host);
        delete host.patterns.p2;
        applyParts(guest, diffParts(k2, host));
        assert.equal(guest.patterns.p2, undefined);
    });

    test('what arrives is not trusted: bad JSON, unknown maps and identity keys are skipped', () => {
        const guest = project();
        const before = JSON.stringify(guest);
        applyParts(guest, {
            'patterns/p1': '{not json',
            'secrets/x': '{}',
            'id': '"stolen"',
            'modified': '1',
            'patterns': '{}',
        });
        assert.equal(JSON.stringify(guest), before);
    });

    test('malformed values go through the model factories', () => {
        const guest = project();
        applyParts(guest, { tracks: JSON.stringify([{ id: 't9', slot: 0, name: 'X' }, { id: 't10', slot: 0, name: 'Dup slot' }]) });
        assert.deepEqual(guest.tracks.map(t => t.id), ['t9'], 'one track per slot, as normalizeProject has it');
    });

    test('divergence: what puts a copy back as the host has it', () => {
        const host = project();
        const known = readParts(host);
        const guest = clone(host);
        guest.patterns.p1.notes.length = 0;
        guest.patches.z = { id: 'z' };
        const back = divergence(known, guest);
        assert.deepEqual(Object.keys(back).sort(), ['patches/z', 'patterns/p1']);
        assert.equal(back['patches/z'], null);
        applyParts(guest, back);
        assert.deepEqual(divergence(known, guest), {});
    });

    test('recordChanges keeps a mirror current', () => {
        const known = new Map([['a', '1'], ['b', '2']]);
        recordChanges(known, { a: '3', b: null, c: '4' });
        assert.deepEqual([...known], [['a', '3'], ['c', '4']]);
    });
});

describe('messages and codes', () => {
    test('readMessage takes only well-formed messages for this room and protocol', () => {
        const ok = message('ROOM', 'join', { peer: 'x' });
        assert.equal(ok.p, PROTOCOL);
        assert.equal(readMessage(ok, 'ROOM'), ok);
        assert.equal(readMessage(ok, 'OTHER'), null);
        assert.equal(readMessage({ ...ok, p: PROTOCOL + 1 }, 'ROOM'), null);
        assert.equal(readMessage({ ...ok, t: 'rm -rf' }, 'ROOM'), null);
        assert.equal(readMessage(message('ROOM', 'join', {}), 'ROOM'), null, 'no peer');
        assert.equal(readMessage(message('ROOM', 'parts', { v: 1 }), 'ROOM'), null, 'no changes');
        assert.equal(readMessage(message('ROOM', 'snapshot', { v: 1, body: {} }), 'ROOM'), null, 'body is text');
        assert.equal(readMessage(null, 'ROOM'), null);
        assert.equal(readMessage('join', 'ROOM'), null);
    });

    test('codes: six readable characters; typed ones tidied', () => {
        let i = 0;
        const code = makeCode(() => (i++ % 10) / 10);
        assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
        assert.equal(readCode(' abc-123 '), 'ABC123');
        assert.equal(readCode('ab'), null);
        assert.equal(readCode('ab!cd'), null);
    });
});
