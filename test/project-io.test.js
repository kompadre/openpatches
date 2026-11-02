// Exporting a project to a file, and reading one back.
//
// Pure, so no browser env. What matters: the round trip is lossless for
// everything that is supposed to travel, the WAVs deliberately do not,
// importing is always a *new* project, and a file from a newer version is
// refused loudly rather than silently returned missing its unknown parts.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    exportProject, importProject, parseProjectFile, usedTags,
    ImportError, FILE_KIND, FILE_EXTENSION, exportFilename,
} from '../html/components/project-io.js';
import {
    createProject, addTrack, addPattern, addClip, addSection, SCHEMA_VERSION,
} from '../html/components/project-model.js';

/** A project with something of everything in it. */
function build() {
    const project = createProject({ name: 'Nocturne', bpm: 96 });
    addTrack(project, { name: 'Piano', voiceData: 'cGlhbm8=', patchId: 'p1', volume: 90 });
    addTrack(project, { name: 'Bass', voiceData: 'YmFzcw==', patchId: 'p2', mute: true });
    const pattern = addPattern(project, {
        name: 'Riff', measures: 2, notes: [{ midi: 60, start: 0, dur: 4 }],
    });
    addClip(project, project.sections[0], {
        trackId: project.tracks[0].id, patternId: pattern.id, startCol: 0,
    });
    const second = addSection(project, { name: 'Bridge', bpm: 72 });
    addClip(project, second, {
        trackId: project.tracks[1].id, patternId: pattern.id, startCol: 16,
    });
    project.patches = {
        p1: { id: 'p1', name: 'Piano', voice_data: 'cGlhbm8=', tags: ['warm', 'keys'] },
        p2: { id: 'p2', name: 'Bass', voice_data: 'YmFzcw==', tags: ['warm'] },
    };
    project.patchNames = { p1: 'Piano (mine)' };
    project.canvas = { patches: { p1: { left: 10, top: 20 } }, containers: {} };
    project.jobs = {
        j1: { id: 'j1', type: 'wav_import', status: 'polling', fileName: 'kick.wav', statusUrl: 'http://x/1', pollCount: 7 },
        j2: { id: 'j2', type: 'wav_import', status: 'done', fileName: 'snare.wav', resultData: { ok: true } },
    };
    return project;
}

const roundTrip = (project) => importProject(JSON.parse(JSON.stringify(exportProject(project))));

describe('the document', () => {
    test('says what it is and which format it speaks', () => {
        const doc = exportProject(build());
        assert.equal(doc.kind, FILE_KIND);
        assert.equal(doc.schemaVersion, SCHEMA_VERSION);
        assert.match(doc.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    test('is plain JSON all the way down', () => {
        const doc = exportProject(build());
        assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
    });

    test('the filename carries the project name', () => {
        assert.equal(exportFilename({ name: 'Nocturne' }), 'Nocturne.' + FILE_EXTENSION);
        assert.equal(exportFilename(null), 'project.' + FILE_EXTENSION);
    });

    test('no id travels — the importer mints one', () => {
        assert.equal(exportProject(build()).project.id, undefined);
    });
});

describe('what survives the round trip', () => {
    test('the music: sections, their clips, the patterns and the tempos', () => {
        const before = build();
        const after = roundTrip(before);

        assert.equal(after.name, 'Nocturne');
        assert.equal(after.bpm, 96);
        assert.deepEqual(after.sections.map(s => s.name), ['Section 1', 'Bridge']);
        assert.equal(after.sections[1].bpm, 72, 'the per-section override');
        assert.equal(after.sections[0].bpm, null, 'and the absence of one');
        assert.deepEqual(after.sections.map(s => s.clips.length), [1, 1]);
        assert.deepEqual(
            Object.values(after.patterns).map(p => [p.name, p.measures, p.notes.length]),
            [['Riff', 2, 1]],
        );
    });

    test('the band, with the patch bytes inlined so it still sounds', () => {
        const after = roundTrip(build());
        assert.deepEqual(
            after.tracks.map(t => [t.slot, t.name, t.voiceData, t.volume, t.mute]),
            [[0, 'Piano', 'cGlhbm8=', 90, false], [1, 'Bass', 'YmFzcw==', 100, true]],
        );
    });

    test('the patches, their renames and the canvas layout', () => {
        const after = roundTrip(build());
        assert.deepEqual(Object.keys(after.patches).sort(), ['p1', 'p2']);
        assert.equal(after.patchNames.p1, 'Piano (mine)');
        assert.deepEqual(after.canvas.patches.p1, { left: 10, top: 20 });
    });

    test('clips still point at tracks and patterns that exist', () => {
        // normalizeProject drops orphans, so a round trip that broke the
        // references would show up as empty sections rather than an error.
        const after = roundTrip(build());
        const trackIds = new Set(after.tracks.map(t => t.id));
        for (const section of after.sections) {
            for (const clip of section.clips) {
                assert.ok(trackIds.has(clip.trackId), 'track');
                assert.ok(after.patterns[clip.patternId], 'pattern');
            }
        }
    });
});

describe('tags', () => {
    test('only the ones the project actually uses', () => {
        assert.deepEqual(usedTags(build()), ['keys', 'warm']);
    });

    test('a project with no tagged patches exports none', () => {
        assert.deepEqual(usedTags(createProject()), []);
    });

    test('they ride in the document', () => {
        assert.deepEqual(exportProject(build()).project.tags, ['keys', 'warm']);
    });
});

describe('the WAVs deliberately do not travel', () => {
    test('a job in flight arrives marked, not running', () => {
        // Its blob is not in the file, so nothing downstream should wait
        // on it — and it must not poll a status URL on someone else's
        // machine.
        const job = roundTrip(build()).jobs.j1;
        assert.equal(job.sourceMissing, true);
        assert.equal(job.status, 'missing-source');
        assert.equal(job.statusUrl, null);
        assert.equal(job.pollCount, 0);
        assert.equal(job.fileName, 'kick.wav', 'but it still says what it came from');
    });

    test('a finished job keeps its result — that is the valuable part', () => {
        const job = roundTrip(build()).jobs.j2;
        assert.equal(job.status, 'done');
        assert.deepEqual(job.resultData, { ok: true });
        assert.equal(job.sourceMissing, true);
    });

    test('the patches a job produced are ordinary patches and travel normally', () => {
        const after = roundTrip(build());
        assert.equal(Object.keys(after.patches).length, 2);
    });
});

describe('importing', () => {
    test('is always a new project — no id comes back', () => {
        const a = roundTrip(build());
        const b = roundTrip(build());
        assert.ok(a.id && b.id);
        assert.notEqual(a.id, b.id, 'two imports of one file are two projects');
    });

    test('a hand-edited file is normalised rather than trusted', () => {
        const body = importProject({
            kind: FILE_KIND,
            schemaVersion: SCHEMA_VERSION,
            project: {
                name: '  ',
                tracks: [{ id: 'a', slot: 0 }, { id: 'b', slot: 0 }],
                sections: [],
            },
        });
        assert.equal(body.name, 'Untitled project');
        assert.equal(body.tracks.length, 1, 'one track per slot');
        assert.equal(body.sections.length, 1, 'always a section');
    });

    test('an older format is read — the factories fill the gaps', () => {
        const body = importProject({
            kind: FILE_KIND,
            schemaVersion: SCHEMA_VERSION - 1,
            project: { name: 'Old', bpm: 90 },
        });
        assert.equal(body.name, 'Old');
        assert.equal(body.bpm, 90);
    });
});

describe('what is refused', () => {
    const refuses = (doc, pattern) => {
        assert.throws(() => importProject(doc), (e) => {
            assert.ok(e instanceof ImportError, 'an ImportError, so the message can be shown');
            assert.match(e.message, pattern);
            return true;
        });
    };

    test('a newer format, loudly', () => {
        // The one case worth refusing: this reader would drop whatever it
        // does not understand and hand back a quietly lesser copy.
        refuses(
            { kind: FILE_KIND, schemaVersion: SCHEMA_VERSION + 1, project: { name: 'Future' } },
            /newer version/,
        );
    });

    test('some other JSON file', () => {
        refuses({ hello: 'world' }, /not an OpenPatches project/);
        refuses(null, /not an OpenPatches project/);
        refuses('a string', /not an OpenPatches project/);
    });

    test('our kind, but with no version or no project', () => {
        refuses({ kind: FILE_KIND, project: {} }, /which version/);
        refuses({ kind: FILE_KIND, schemaVersion: SCHEMA_VERSION }, /no project in it/);
    });

    test('text that is not JSON at all', () => {
        assert.throws(() => parseProjectFile('<html>nope'), (e) => {
            assert.ok(e instanceof ImportError);
            assert.match(e.message, /readable JSON/);
            return true;
        });
    });

    test('parseProjectFile reads a real exported file', () => {
        const text = JSON.stringify(exportProject(build()));
        assert.equal(parseProjectFile(text).name, 'Nocturne');
    });
});
