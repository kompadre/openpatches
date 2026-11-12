// collab-ops.js: atoms, ops, groups, applying, invariants (M2-1).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../html/components/project-model.js';
import {
    stable, readAtoms, readAtom, parseAtom, ownerOf, diffAtoms, groupOps, diffGroups,
    applyOps, checkInvariants, implicates,
} from '../html/components/collab-ops.js';

const project = () => createProject({
    name: 'Jam',
    tracks: [{ id: 't1', name: 'Keys', slot: 0 }, { id: 't2', name: 'Bass', slot: 1 }],
    patterns: {
        p1: { id: 'p1', name: 'Riff', measures: 1, notes: [{ midi: 60, start: 0, dur: 4 }] },
        p2: { id: 'p2', name: 'Low', measures: 1, notes: [] },
    },
    sections: [
        { id: 's1', name: 'Intro', clips: [{ id: 'c1', trackId: 't1', patternId: 'p1', startCol: 0, repeats: 1 }] },
        { id: 's2', name: 'Verse', bpm: 90 },
    ],
    patches: { a: { id: 'a', name: 'Bell', voice_data: 'AAAA' } },
    canvas: { containers: { k1: { id: 'k1', x: 10, y: 20 } }, zoom: 2 },
});
const clone = (p) => createProject(JSON.parse(JSON.stringify(p)));
const atomsOf = (groups) => groups.map(g => g.map(op => op.atom).sort());

describe('atoms', () => {
    test('stable text: sorted keys, null for absent', () => {
        assert.equal(stable({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
        assert.equal(stable(undefined), null);
        assert.equal(stable(null), 'null');
    });

    test('the catalogue', () => {
        const a = readAtoms(project());
        for (const k of [
            'name', 'bpm', 'tags', 'fx/reverbLevel',
            'pattern/p1', 'pattern/p1/name', 'pattern/p1/measures', 'pattern/p1/note/0:60',
            'track/t1', 'track/t1/slot', 'track/t1/volume', 'track/t1/mute',
            'section/s1', 'section/s1/name', 'section/s1/bpm',
            'section/s1/clip/c1', 'section/s1/clip/c1/startCol', 'section/s1/clip/c1/repeats',
            'sections/order', 'patch/a', 'canvas/containers/k1', 'canvas/containers/k1/x', 'canvas/zoom',
        ]) assert.ok(a.has(k), k);
        assert.equal(a.get('pattern/p1/note/0:60'), '4');
        assert.equal(a.get('section/s1/bpm'), 'null', 'nullable, not absent');
        assert.equal(a.get('sections/order'), '["s1","s2"]');
        assert.ok(!a.has('section/s1/clip/c1/lengthCols'));
        assert.ok([...a.keys()].every(k => !/lane|^(track|section|pattern)\/[^/]+(\/clip\/[^/]+)?\/id$|modified|schemaVersion/.test(k)));
        assert.ok([...a.keys()].some(k => k.startsWith('track/t1/fx/')));
    });

    test('readAtom agrees with readAtoms for every atom', () => {
        const p = project();
        for (const [k, v] of readAtoms(p)) assert.equal(readAtom(p, k), v, k);
        assert.equal(readAtom(p, 'pattern/p1/note/4:60'), null);
        assert.equal(readAtom(p, 'track/nope/name'), null);
    });

    test('parseAtom refuses what names nothing; ownerOf walks up', () => {
        for (const bad of ['', 'nope', 'pattern//name', 'pattern/p1/notes', 'pattern/p1/note/x:60', 'track/t1/id', 'canvas/containers'])
            assert.equal(parseAtom(bad), null, bad);
        assert.equal(ownerOf('pattern/p1/note/0:60'), 'pattern/p1');
        assert.equal(ownerOf('section/s1/clip/c1/startCol'), 'section/s1/clip/c1');
        assert.equal(ownerOf('section/s1/clip/c1'), 'section/s1');
        assert.equal(ownerOf('section/s1'), null);
        assert.equal(ownerOf('track/t1/fx/delayMix'), 'track/t1');
    });

    test('the lane is not an atom: relaning changes nothing', () => {
        const p = project();
        const before = readAtoms(p);
        p.patterns.p1.notes[0].lane = 2;
        assert.deepEqual(diffAtoms(before, p), []);
    });
});

describe('diff and groups', () => {
    test('nothing changed is nothing', () => {
        const p = project();
        assert.deepEqual(diffGroups(p, clone(p)), []);
    });

    test('ops carry before and after; a field is a group of one', () => {
        const p = project();
        const q = clone(p);
        q.tracks[0].volume = 64;
        q.patterns.p1.name = 'Hook';
        const g = diffGroups(p, q);
        assert.deepEqual(atomsOf(g), [['pattern/p1/name'], ['track/t1/volume']]);
        assert.deepEqual(g[1][0], { atom: 'track/t1/volume', before: '100', after: '64' });
    });

    test('two notes added to one pattern: two groups', () => {
        const p = project();
        const q = clone(p);
        q.patterns.p1.notes.push({ midi: 64, start: 4, dur: 4 }, { midi: 67, start: 8, dur: 2 });
        assert.equal(diffGroups(p, q).length, 2);
    });

    test('a note moved (same pitch out and in) is one group; a dur change alone is not a move', () => {
        const p = project();
        const q = clone(p);
        q.patterns.p1.notes[0].start = 8;
        q.patterns.p1.notes.push({ midi: 62, start: 0, dur: 1 });
        assert.deepEqual(atomsOf(diffGroups(p, q)), [
            ['pattern/p1/note/0:60', 'pattern/p1/note/8:60'],
            ['pattern/p1/note/0:62'],
        ]);
        const r = clone(p);
        r.patterns.p1.notes[0].dur = 16;
        assert.deepEqual(diffGroups(p, r), [[{ atom: 'pattern/p1/note/0:60', before: '4', after: '16' }]]);
    });

    test('a new pattern with its first clip is one group', () => {
        const p = project();
        const q = clone(p);
        q.patterns.p3 = { ...q.patterns.p2, id: 'p3', name: 'New', notes: [{ midi: 40, start: 0, dur: 2 }] };
        q.sections[1].clips.push({ id: 'c9', trackId: 't2', patternId: 'p3', startCol: 0, repeats: 1 });
        q.tracks[0].mute = true;
        const g = diffGroups(p, q);
        assert.equal(g.length, 2);
        const big = g.find(x => x.length > 1).map(op => op.atom);
        assert.ok(big.includes('pattern/p3') && big.includes('pattern/p3/note/0:40'));
        assert.ok(big.includes('section/s2/clip/c9') && big.includes('section/s2/clip/c9/patternId'));
    });

    test('a deleted pattern takes the clips that played it', () => {
        const p = project();
        const q = clone(p);
        delete q.patterns.p1;
        q.sections[0].clips = [];
        q.tracks[0].mute = true;
        const g = diffGroups(p, q);
        assert.equal(g.length, 2);
        const big = g.find(x => x.length > 1).map(op => op.atom);
        assert.ok(big.includes('pattern/p1') && big.includes('section/s1/clip/c1') && big.includes('section/s1/clip/c1/startCol'));
    });

    test('a clip of an existing pattern is its own group, apart from a new pattern', () => {
        const p = project();
        const q = clone(p);
        q.patterns.p3 = { ...q.patterns.p2, id: 'p3' };
        q.sections[1].clips.push({ id: 'c9', trackId: 't2', patternId: 'p2', startCol: 0, repeats: 1 });
        assert.equal(diffGroups(p, q).length, 2);
    });

    test('a deleted section takes its clips and the order with it', () => {
        const p = project();
        const q = clone(p);
        q.sections.shift();
        const g = diffGroups(p, q);
        assert.equal(g.length, 1);
        const atoms = g[0].map(op => op.atom);
        assert.ok(atoms.includes('sections/order') && atoms.includes('section/s1/clip/c1/startCol'));
        assert.ok(g[0].every(op => op.atom === 'sections/order' || op.after == null));
    });

    test('a clip moved and a pattern renamed: separate groups', () => {
        const p = project();
        const q = clone(p);
        q.sections[0].clips[0].startCol = 16;
        q.patterns.p1.name = 'X';
        assert.equal(diffGroups(p, q).length, 2);
    });

    test('groupOps keeps unrelated ops apart and op order inside groups', () => {
        const ops = [
            { atom: 'pattern/p9', before: null, after: '1' },
            { atom: 'bpm', before: '120', after: '100' },
            { atom: 'pattern/p9/name', before: null, after: '"N"' },
        ];
        assert.deepEqual(groupOps(ops).map(g => g.map(o => o.atom)), [['pattern/p9', 'pattern/p9/name'], ['bpm']]);
    });
});

describe('apply', () => {
    test('a diff applied to a copy of before gives after (atom for atom)', () => {
        const p = project();
        const q = clone(p);
        q.name = 'Jam 2';
        q.fx.reverbLevel = 0.5;
        q.patterns.p1.notes.push({ midi: 64, start: 4, dur: 4 });
        q.patterns.p1.notes[0].dur = 2;
        q.patterns.p3 = { id: 'p3', name: 'New', kind: 'mono', color: '#112233', measures: 2, notes: [{ midi: 40, start: 20, dur: 3 }], created: 5 };
        q.tracks.push({ ...q.tracks[1], id: 't3', name: 'Lead', slot: 4, compact: true });
        q.tracks[0].fx.delay = true;
        q.sections.reverse();
        q.sections[0].clips.push({ id: 'c9', trackId: 't3', patternId: 'p3', startCol: 32, lengthCols: 8 });
        q.sections[1].clips[0].startCol = 16;
        q.sections[1].bpm = 100;
        delete q.patterns.p2;
        delete q.patches.a;
        q.patches.b = { id: 'b', name: 'Pad' };
        q.canvas.containers.k1.x = 99;
        q.canvas.zoom = 3;
        const ops = diffAtoms(p, q);
        const target = clone(p);
        const out = applyOps(target, ops);
        assert.deepEqual(out.skipped, []);
        assert.deepEqual(diffAtoms(target, q), []);
        assert.ok(out.structure && out.bench);
        assert.deepEqual(out.patterns.sort(), ['p1', 'p2', 'p3']);
        assert.deepEqual(target.sections.map(s => s.id), ['s2', 's1']);
    });

    test('patterns keep their object and notes array; lanes re-derive', () => {
        const p = project();
        const pat = p.patterns.p1;
        const notes = pat.notes;
        applyOps(p, [{ atom: 'pattern/p1/note/0:64', before: null, after: '4' }]);
        assert.equal(p.patterns.p1, pat);
        assert.equal(p.patterns.p1.notes, notes);
        assert.equal(notes.length, 2);
        assert.equal(notes.filter(n => n.lane === 1).length, 1, 'the chord takes a second lane');
    });

    test('an op on something gone is skipped; malformed ops are refused', () => {
        const p = project();
        const out = applyOps(p, [
            { atom: 'pattern/zz/name', before: '"a"', after: '"b"' },
            { atom: 'nope', before: null, after: '1' },
            { atom: 'bpm', before: '120', after: '{bad' },
            { atom: 'track/t1/name', before: '"Keys"', after: '"Piano"' },
        ]);
        assert.deepEqual(out.skipped, ['nope', 'bpm', 'pattern/zz/name']);
        assert.equal(p.tracks[0].name, 'Piano');
        assert.equal(p.bpm, 120);
    });

    test('values come out in range', () => {
        const p = project();
        applyOps(p, [
            { atom: 'track/t1/volume', before: '100', after: '999' },
            { atom: 'section/s1/clip/c1/startCol', before: '0', after: '-5' },
        ]);
        assert.equal(p.tracks[0].volume, 127);
        assert.equal(p.sections[0].clips[0].startCol, 0);
    });
});

describe('invariants', () => {
    test('a valid project has none', () => {
        assert.deepEqual(checkInvariants(project()), []);
    });

    test('two tracks on one slot', () => {
        const p = project();
        applyOps(p, [{ atom: 'track/t2/slot', before: '1', after: '0' }]);
        const v = checkInvariants(p);
        assert.equal(v.length, 1);
        assert.match(v[0].reason, /slot 1/);
        assert.ok(implicates(v[0], [{ atom: 'track/t2/slot' }]));
        assert.ok(!implicates(v[0], [{ atom: 'track/t2/name' }]));
    });

    test('clip move vs repeats: each alone is fine, both overlap the next clip', () => {
        const p = project();
        applyOps(p, [{ atom: 'section/s1/clip/c2', before: null, after: '1' },
            ...['trackId:"t1"', 'patternId:"p2"', 'startCol:32', 'repeats:1'].map(s => {
                const [f, v] = s.split(/:(.*)/);
                return { atom: 'section/s1/clip/c2/' + f, before: null, after: v };
            })]);
        assert.deepEqual(checkInvariants(p), []);
        const move = [{ atom: 'section/s1/clip/c1/startCol', before: '0', after: '16' }];
        const reps = [{ atom: 'section/s1/clip/c1/repeats', before: '1', after: '2' }];
        const a = clone(p); applyOps(a, move); assert.deepEqual(checkInvariants(a), []);
        const b = clone(p); applyOps(b, reps); assert.deepEqual(checkInvariants(b), []);
        applyOps(p, [...move, ...reps]);
        const v = checkInvariants(p);
        assert.equal(v.length, 1);
        assert.match(v[0].reason, /overlap/);
        assert.ok(implicates(v[0], move) && implicates(v[0], reps));
    });

    test('a clip whose pattern was deleted under it', () => {
        const p = project();
        applyOps(p, [{ atom: 'pattern/p1', before: '1', after: null }]);
        const v = checkInvariants(p);
        assert.match(v[0].reason, /pattern is gone/);
        assert.ok(implicates(v[0], [{ atom: 'pattern/p1' }]));
    });

    test('a note outside its pattern: shrink vs add', () => {
        const p = project();
        applyOps(p, [
            { atom: 'pattern/p2/measures', before: '1', after: '2' },
        ]);
        applyOps(p, [{ atom: 'pattern/p2/note/20:40', before: null, after: '4' }]);
        assert.deepEqual(checkInvariants(p), []);
        applyOps(p, [{ atom: 'pattern/p2/measures', before: '2', after: '1' }]);
        const v = checkInvariants(p);
        assert.equal(v.length, 1);
        assert.ok(implicates(v[0], [{ atom: 'pattern/p2/note/20:40' }]));
        assert.ok(implicates(v[0], [{ atom: 'pattern/p2/measures' }]));
    });
});
