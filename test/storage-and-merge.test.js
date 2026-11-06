// Phase 5 (revised): the on-demand storage sweep, and importing patches and
// patterns from another project into the open one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planStorage, referencedJobIds, formatBytes } from '../html/components/storage-gc.js';
import { importCandidates, planImport, freeName } from '../html/components/project-merge.js';

describe('storage', () => {
    const bodies = [
        { id: 'p1', name: 'One', jobs: { job_a: {} }, canvas: { containers: { c: { jobId: 'job_b' } } } },
        { id: 'p2', name: 'Two', jobs: {}, canvas: {} },
    ];
    test('a WAV is in use if any project has its job, or a container naming it', () => {
        assert.deepEqual([...referencedJobIds(bodies)].sort(), ['job_a', 'job_b']);
    });
    test('the plan lists the orphans and their bytes, and the per-project sizes', () => {
        const r = planStorage(bodies, [{ key: 'job_a', bytes: 100 }, { key: 'job_b', bytes: 50 }, { key: 'job_gone', bytes: 2048 }]);
        assert.deepEqual(r.orphans.map(o => o.key), ['job_gone']);
        assert.equal(r.orphanBytes, 2048);
        assert.equal(r.uploads.count, 3);
        assert.equal(r.uploads.bytes, 2198);
        assert.deepEqual(r.projects.map(p => p.id).sort(), ['p1', 'p2']);
        assert.ok(r.projects[0].bytes >= r.projects[1].bytes, 'biggest first');
    });
    test('formatBytes', () => {
        assert.equal(formatBytes(12), '12 B');
        assert.equal(formatBytes(2048), '2 KB');
        assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
    });
});

describe('import into this project', () => {
    const source = {
        name: 'Other',
        patches: { pa: { id: 'pa', name: 'Brass', voice_data: 'x' }, pb: { id: 'pb', name: 'Bass', voice_data: 'y' }, bad: { id: 'bad', name: 'No bytes' } },
        patchNames: { pa: 'My Brass' },
        patterns: { t1: { id: 't1', name: 'Verse', measures: 2, notes: [{ midi: 60, start: 0, dur: 1 }], created: 1 }, t2: { id: 't2', name: 'Hook', measures: 1, notes: [] } },
    };
    const target = { patches: { pb: { id: 'pb' } }, patterns: { q: { id: 'q', name: 'Verse' } } };

    test('candidates: patches with bytes, flagged when already here; every pattern', () => {
        const c = importCandidates(source, target);
        assert.deepEqual(c.patches.map(p => [p.name, p.present]), [['Bass', true], ['Brass', false]]);
        assert.deepEqual(c.patterns.map(p => [p.name, p.notes]), [['Hook', 0], ['Verse', 1]]);
    });

    test('the plan: only what was chosen, no doubles, patterns new and renamed past clashes', () => {
        const plan = planImport(source, target, { patchIds: ['pa', 'pb'], patternIds: ['t1'] });
        assert.deepEqual(plan.patches.map(p => p.id), ['pa'], 'pb is already here');
        assert.deepEqual(plan.patchNames, { pa: 'My Brass' });
        assert.equal(plan.patterns.length, 1);
        assert.equal(plan.patterns[0].name, 'Verse (2)');
        assert.equal(plan.patterns[0].id, undefined, 'the session mints a fresh id');
        assert.equal(plan.patterns[0].notes.length, 1);
        plan.patterns[0].notes[0].midi = 1;
        assert.equal(source.patterns.t1.notes[0].midi, 60, 'a copy, not the file\'s record');
    });

    test('freeName counts past every taken name', () => {
        assert.equal(freeName('A', new Set(['A', 'A (2)'])), 'A (3)');
        assert.equal(freeName('B', new Set(['A'])), 'B');
    });
});
