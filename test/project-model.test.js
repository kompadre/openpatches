// The Project data model: Tracks, Patterns, Clips, Sections, Projects.
//
// Pure data, so this file needs no browser env at all. The invariants worth
// pinning are the ones no single factory can see — unique slots, no orphan
// clips, always a section — and the two rules the merge of Track and voice
// bank slot was meant to make unrepeatable: one mute/solo per strip, and
// one place that decides who is audible.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    createProject, createPattern, createTrack, createClip, createSection,
    normalizeProject, effectiveBpm, audibleTracks, effectiveVolume,
    addClip, updateClip, removeClip, addTrack, removeTrack,
    addPattern, removePattern, patternUsage, addSection, removeSection,
    findClipOverlap, clipCols, clipRepeats, sectionLengthCols, sectionLength,
    getTrackBySlot, getPattern,
    COLS_PER_MEASURE, MAX_SLOTS, MIN_BPM, MAX_BPM, DEFAULT_BPM, SCHEMA_VERSION,
} from '../html/components/project-model.js';

/** A project with `n` tracks, one pattern, and a clip at column 0. */
function build({ tracks = 2, measures = 1 } = {}) {
    const project = createProject({ name: 'Piece' });
    for (let i = 0; i < tracks; i++) addTrack(project, { name: `T${i + 1}` });
    const pattern = addPattern(project, { name: 'A', measures });
    const section = project.sections[0];
    addClip(project, section, {
        trackId: project.tracks[0].id,
        patternId: pattern.id,
        startCol: 0,
    });
    return { project, pattern, section };
}

describe('createProject', () => {
    test('an empty project is well formed and has one section', () => {
        const p = createProject();
        assert.equal(p.schemaVersion, SCHEMA_VERSION);
        assert.equal(p.bpm, DEFAULT_BPM);
        assert.deepEqual(p.tracks, []);
        assert.equal(p.sections.length, 1, 'a project with no section has nothing to show');
        assert.deepEqual(p.patterns, {});
        assert.ok(p.id && p.created && p.modified);
    });

    test('bpm is clamped to the playable range', () => {
        assert.equal(createProject({ bpm: 9 }).bpm, MIN_BPM);
        assert.equal(createProject({ bpm: 9000 }).bpm, MAX_BPM);
        assert.equal(createProject({ bpm: 'allegro' }).bpm, DEFAULT_BPM);
    });

    test('round-trips through JSON unchanged — bodies are stored as JSON', () => {
        const { project } = build();
        project.tracks[0] = createTrack({ ...project.tracks[0], voiceData: new Uint8Array([1, 2, 3]) });
        const again = createProject(JSON.parse(JSON.stringify(project)));
        assert.deepEqual(again, createProject(project));
    });

    test('voice data is normalised to a plain array, so a body stays JSON', () => {
        const t = createTrack({ voiceData: new Uint8Array([7, 8]) });
        assert.deepEqual(t.voiceData, [7, 8]);
        assert.equal(createTrack({ voiceData: 'nonsense' }).voiceData, null);
        assert.equal(createTrack({ voiceData: [1, 999] }).voiceData, null, 'out of byte range');
    });

    test('a Uint8Array assigned past the factory still survives the round trip', () => {
        // JSON.stringify turns a typed array into {"0":1,"1":2} — an object,
        // not an array. Without this the patch works in memory and silently
        // becomes null on the next load, which is the worst kind of bug to
        // find. The factory accepts the stringified shape so careless
        // assignment costs nothing.
        const { project } = build();
        project.tracks[0].voiceData = new Uint8Array([1, 2, 3]);
        const stored = JSON.parse(JSON.stringify(project));
        assert.deepEqual(stored.tracks[0].voiceData, { 0: 1, 1: 2, 2: 3 }, 'what JSON really writes');
        assert.deepEqual(createProject(stored).tracks[0].voiceData, [1, 2, 3]);
    });
});

describe('the invariants normalizeProject enforces', () => {
    test('one track per slot — a later duplicate is dropped, not renumbered', () => {
        // Renumbering would silently move a user's part to another
        // instrument, which is worse than losing the duplicate record.
        const p = createProject({
            tracks: [
                { id: 'a', name: 'Keeper', slot: 3 },
                { id: 'b', name: 'Dropped', slot: 3 },
            ],
        });
        assert.equal(p.tracks.length, 1);
        assert.equal(p.tracks[0].name, 'Keeper');
    });

    test('tracks are capped at MAX_SLOTS and sorted by slot', () => {
        const tracks = [];
        for (let i = 0; i < MAX_SLOTS + 4; i++) tracks.push({ slot: i, name: `T${i}` });
        const p = createProject({ tracks });
        assert.equal(p.tracks.length, MAX_SLOTS);
        assert.deepEqual(p.tracks.map(t => t.slot), [0, 1, 2, 3, 4, 5, 6, 7]);
    });

    test('a clip whose track or pattern is missing is dropped', () => {
        const p = createProject({
            tracks: [{ id: 'trk1', slot: 0 }],
            patterns: { pat1: { id: 'pat1', measures: 1 } },
            sections: [{
                id: 'sec1',
                clips: [
                    { id: 'ok', trackId: 'trk1', patternId: 'pat1' },
                    { id: 'no-track', trackId: 'ghost', patternId: 'pat1' },
                    { id: 'no-pattern', trackId: 'trk1', patternId: 'ghost' },
                ],
            }],
        });
        assert.deepEqual(p.sections[0].clips.map(c => c.id), ['ok']);
    });

    test('renormalizing after a direct edit drops what the edit orphaned', () => {
        const { project, section } = build();
        project.tracks.length = 0;          // rummaging in the body directly
        normalizeProject(project);
        assert.deepEqual(section.clips, []);
    });
});

describe('tempo', () => {
    test('a section with no bpm of its own plays at the project tempo', () => {
        const { project, section } = build();
        project.bpm = 140;
        assert.equal(section.bpm, null);
        assert.equal(effectiveBpm(project, section), 140);
    });

    test("a section's own bpm wins — the Allegro announcement", () => {
        const { project, section } = build();
        project.bpm = 140;
        section.bpm = 72;
        assert.equal(effectiveBpm(project, section), 72);
    });

    test('null and 0 are different: null defers, 0 clamps to the minimum', () => {
        const { project } = build();
        project.bpm = 140;
        assert.equal(effectiveBpm(project, createSection({ bpm: null })), 140);
        assert.equal(effectiveBpm(project, createSection({ bpm: 0 })), MIN_BPM);
    });

    test('an override survives the round trip as a number, not a default', () => {
        const { project, section } = build();
        section.bpm = 72;
        const again = createProject(JSON.parse(JSON.stringify(project)));
        assert.equal(again.sections[0].bpm, 72);
    });
});

describe('tracks', () => {
    test('addTrack takes the first free slot', () => {
        const p = createProject();
        assert.equal(addTrack(p).slot, 0);
        assert.equal(addTrack(p).slot, 1);
        p.tracks.splice(0, 1);              // free slot 0 again
        assert.equal(addTrack(p).slot, 0);
    });

    test('addTrack refuses a taken slot rather than silently moving it', () => {
        const p = createProject();
        addTrack(p, { slot: 2 });
        assert.equal(addTrack(p, { slot: 2 }), null);
    });

    test('addTrack refuses once the project is full', () => {
        const p = createProject();
        for (let i = 0; i < MAX_SLOTS; i++) assert.ok(addTrack(p));
        assert.equal(addTrack(p), null);
    });

    test('removing a track takes its clips in EVERY section', () => {
        // The whole point of project-level tracks: a removal cannot be
        // scoped to the arrangement that happens to be on screen.
        const { project, pattern } = build();
        const second = addSection(project);
        addClip(project, second, {
            trackId: project.tracks[0].id, patternId: pattern.id, startCol: 0,
        });
        assert.equal(project.sections[0].clips.length, 1);
        assert.equal(second.clips.length, 1);

        removeTrack(project, project.tracks[0].id);
        assert.deepEqual(project.sections[0].clips, []);
        assert.deepEqual(second.clips, []);
    });

    test('getTrackBySlot finds the one track on that channel', () => {
        const { project } = build({ tracks: 3 });
        assert.equal(getTrackBySlot(project, 1).name, 'T2');
        assert.equal(getTrackBySlot(project, 7), null);
    });
});

describe('mute and solo — one strip, one pair of flags', () => {
    // The pre-Project model carried mute/solo twice: on the song's track
    // (gating whether notes were *scheduled*) and on the voice bank entry
    // (gating the channel's *volume*). Neither showed the other and they
    // could disagree. There is one of each here, and one function deciding.

    test('nothing muted: everyone sounds', () => {
        const tracks = [createTrack({ slot: 0 }), createTrack({ slot: 1 })];
        assert.deepEqual(audibleTracks(tracks), tracks);
    });

    test('a muted track is dropped', () => {
        const a = createTrack({ slot: 0 });
        const b = createTrack({ slot: 1, mute: true });
        assert.deepEqual(audibleTracks([a, b]), [a]);
    });

    test('a solo silences everything else', () => {
        const a = createTrack({ slot: 0 });
        const b = createTrack({ slot: 1, solo: true });
        assert.deepEqual(audibleTracks([a, b]), [b]);
    });

    test('solo wins over mute on the same track — that is how you audition it', () => {
        const a = createTrack({ slot: 0, mute: true, solo: true });
        const b = createTrack({ slot: 1 });
        assert.deepEqual(audibleTracks([a, b]), [a]);
    });

    test('effectiveVolume agrees with audibleTracks by construction', () => {
        const a = createTrack({ slot: 0, volume: 0.8 });
        const b = createTrack({ slot: 1, volume: 0.5, mute: true });
        const c = createTrack({ slot: 2, volume: 0.9 });
        const tracks = [a, b, c];
        assert.equal(effectiveVolume(tracks, a), 0.8, 'the fader value is what is heard');
        assert.equal(effectiveVolume(tracks, b), 0, 'muted');

        c.solo = true;
        assert.equal(effectiveVolume(tracks, a), 0, 'another track is soloed');
        assert.equal(effectiveVolume(tracks, c), 0.9);
        // The fader never moved — mute and solo are overrides, not edits.
        assert.equal(a.volume, 0.8);
    });

    test('volume is clamped to 0..1', () => {
        assert.equal(createTrack({ volume: 5 }).volume, 1);
        assert.equal(createTrack({ volume: -1 }).volume, 0);
        assert.equal(createTrack({ volume: undefined }).volume, 1);
    });
});

describe('clips', () => {
    test('a clip follows its pattern by repeats, or carries its own length', () => {
        const pattern = createPattern({ measures: 2 });
        const following = createClip({ repeats: 3 });
        const ownLength = createClip({ lengthCols: 20 });
        assert.equal(clipCols(following, pattern).endCol, 2 * COLS_PER_MEASURE * 3);
        assert.equal(clipCols(ownLength, pattern).endCol, 20);
        // Exactly one spelling is ever stored.
        assert.equal(following.lengthCols, undefined);
        assert.equal(ownLength.repeats, undefined);
    });

    test('clipRepeats is fractional for a clip cut short', () => {
        const pattern = createPattern({ measures: 1 });
        assert.equal(clipRepeats(createClip({ lengthCols: 8 }), pattern), 0.5);
    });

    test('two clips cannot overlap on one track', () => {
        const { project, pattern, section } = build();
        assert.throws(
            () => addClip(project, section, {
                trackId: project.tracks[0].id, patternId: pattern.id, startCol: 8,
            }),
            /Clip overlaps/,
        );
    });

    test('the same columns on another track are fine', () => {
        const { project, pattern, section } = build();
        const clip = addClip(project, section, {
            trackId: project.tracks[1].id, patternId: pattern.id, startCol: 0,
        });
        assert.ok(clip);
        assert.equal(section.clips.length, 2);
    });

    test('a clip refuses a track or pattern that is not in the project', () => {
        const { project, pattern, section } = build();
        assert.throws(() => addClip(project, section, {
            trackId: 'ghost', patternId: pattern.id,
        }), /no track/);
        assert.throws(() => addClip(project, section, {
            trackId: project.tracks[0].id, patternId: 'ghost',
        }), /pattern is missing/);
    });

    test('asking for repeats drops a length the clip had of its own', () => {
        const { project, section } = build();
        const clip = section.clips[0];
        updateClip(project, section, clip.id, { lengthCols: 20 });
        assert.equal(clip.lengthCols, 20);
        updateClip(project, section, clip.id, { repeats: 2 });
        assert.equal(clip.lengthCols, undefined, 'a leftover would win silently');
        assert.equal(clip.repeats, 2);
    });

    test('a move onto another clip is refused and changes nothing', () => {
        const { project, pattern, section } = build();
        const other = addClip(project, section, {
            trackId: project.tracks[1].id, patternId: pattern.id, startCol: 0,
        });
        assert.throws(
            () => updateClip(project, section, other.id, { trackId: project.tracks[0].id }),
            /Clip overlaps/,
        );
        assert.equal(other.trackId, project.tracks[1].id, 'unchanged');
    });

    test('findClipOverlap ignores the clip being moved', () => {
        const { project, section } = build();
        const clip = section.clips[0];
        assert.equal(findClipOverlap(project, section, clip, clip.id), null);
    });

    test('removeClip reports whether it found one', () => {
        const { section } = build();
        assert.equal(removeClip(section, section.clips[0].id), true);
        assert.equal(removeClip(section, 'ghost'), false);
    });
});

describe('patterns', () => {
    test('a pattern is owned by the project and keyed by id', () => {
        const { project, pattern } = build();
        assert.equal(getPattern(project, pattern.id), pattern);
        assert.equal(getPattern(project, 'ghost'), null);
    });

    test('notes past the end are dropped; notes running over are cut', () => {
        const p = createPattern({
            measures: 1,
            notes: [
                { midi: 60, start: 0, dur: 99 },     // cut to the end
                { midi: 62, start: 16, dur: 1 },     // unreachable
                { midi: 200, start: 0, dur: 1 },     // not a note
            ],
        });
        assert.equal(p.notes.length, 1);
        assert.deepEqual(p.notes[0], { midi: 60, start: 0, dur: COLS_PER_MEASURE });
    });

    test('removing a pattern takes its clips in every section', () => {
        const { project, pattern, section } = build();
        const second = addSection(project);
        addClip(project, second, {
            trackId: project.tracks[0].id, patternId: pattern.id, startCol: 0,
        });
        assert.deepEqual(patternUsage(project, pattern.id), [section.id, second.id]);

        assert.equal(removePattern(project, pattern.id), true);
        assert.deepEqual(section.clips, []);
        assert.deepEqual(second.clips, []);
        assert.equal(removePattern(project, pattern.id), false, 'already gone');
    });

    test('the same pattern can be placed many times — that is the point', () => {
        const { project, pattern, section } = build({ measures: 1 });
        addClip(project, section, {
            trackId: project.tracks[1].id, patternId: pattern.id, startCol: 0,
        });
        addClip(project, section, {
            trackId: project.tracks[0].id, patternId: pattern.id, startCol: 32,
        });
        assert.equal(section.clips.length, 3);
        assert.equal(patternUsage(project, pattern.id).length, 1, 'one section, three clips');
    });
});

describe('sections', () => {
    test('a new section is named for its position and starts empty', () => {
        const { project } = build();
        const s = addSection(project);
        assert.equal(s.name, 'Section 2');
        assert.deepEqual(s.clips, []);
        assert.equal(s.bpm, null, 'it defers to the project until told otherwise');
    });

    test('the last section cannot be removed', () => {
        const { project } = build();
        assert.equal(project.sections.length, 1);
        assert.equal(removeSection(project, project.sections[0].id), false);

        const second = addSection(project);
        assert.equal(removeSection(project, second.id), true);
        assert.equal(project.sections.length, 1);
    });

    test('sections keep their order — they are a sequence, not a set', () => {
        const { project } = build();
        addSection(project, { name: 'Middle' });
        addSection(project, { name: 'End' });
        const again = createProject(JSON.parse(JSON.stringify(project)));
        assert.deepEqual(again.sections.map(s => s.name), ['Section 1', 'Middle', 'End']);
    });

    test('length is the furthest clip end, in columns and in whole bars', () => {
        const { project, pattern, section } = build({ measures: 1 });
        addClip(project, section, {
            trackId: project.tracks[1].id, patternId: pattern.id, startCol: 20,
        });
        assert.equal(sectionLengthCols(project, section), 36);
        assert.equal(sectionLength(project, section), 3, 'a clip ending mid-bar still gets its bar');
    });

    test('an empty section has no length', () => {
        const p = createProject();
        assert.equal(sectionLengthCols(p, p.sections[0]), 0);
        assert.equal(sectionLength(p, p.sections[0]), 0);
    });
});

describe('tags', () => {
    test('only the tags the project uses, deduped and sorted', () => {
        const p = createProject({ tags: ['warm', 'bass', 'warm', '  ', 'pad'] });
        assert.deepEqual(p.tags, ['bass', 'pad', 'warm']);
    });
});
