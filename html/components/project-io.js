// Exporting a project to a file, and reading one back.
//
// One JSON document, built and parsed here — no server, like everything
// else that can be done in the page. `download.js` does the saving.
//
// ## What travels
//
// Everything that makes the piece what it is: its sections and their
// clips, its patterns, its tracks (with the patch bytes inlined, so an
// imported project sounds even where its patches were never in this
// workspace), its canvas layout, and the tags it actually uses.
//
// ## What does not
//
// **The uploaded WAVs.** They are source material for the inference
// jobs, not results, and they are far and away the biggest thing in the
// workspace — a decision taken with the user. The *jobs* still travel,
// carrying their `fileName` and a `sourceMissing` marker, so an import
// can say "this came from kick.wav, which is not here" rather than
// silently showing a job that can never run. The patches a job produced
// are ordinary patches and travel normally: they are the valuable part.
//
// **The profile.** Which projects exist, which is open, the MIDI ports
// and the output latency are properties of a person and a machine. A
// port id means nothing on someone else's computer, and the 317 ms
// latency was measured against this user's hardware.
//
// ## Importing is always a new project
//
// A fresh id and a name nothing else is using, so the same file twice
// gives two independent projects and the one already on disk is never
// touched — it is the incoming name that moves out of the way.

import { createProject, SCHEMA_VERSION } from './project-model.js';

/** What project files say they are, so a stray JSON is caught early. */
export const FILE_KIND = 'openpatches.project';
export const FILE_EXTENSION = 'opproj';
// Exports are offered as `name.opproj.json` on every platform. The file is
// JSON and says so; it is also what Android's download manager would have
// renamed a bare `.opproj` (served as application/json) to anyway, so the
// name is the same everywhere instead of mutating in transit. A bare
// `.opproj` is still accepted on import — older exports carry it.
export const FILE_SUFFIX = FILE_EXTENSION + '.json';

/**
 * Every tag actually used by the project's patches.
 *
 * The full vocabulary belongs to the profile — it is the user's own
 * taxonomy across all their work — so an export carries only the words
 * this project needs, and an import unions those into whatever
 * vocabulary it lands in.
 */
export function usedTags(project) {
    const seen = new Set();
    for (const patch of Object.values(project.patches || {})) {
        for (const tag of Array.isArray(patch && patch.tags) ? patch.tags : []) {
            const s = String(tag == null ? '' : tag).trim();
            if (s) seen.add(s);
        }
    }
    return [...seen].sort();
}

/** Jobs, minus anything that depended on a WAV being present. */
function exportJobs(jobs) {
    const out = {};
    for (const [id, job] of Object.entries(jobs || {})) {
        if (!job || typeof job !== 'object') continue;
        out[id] = {
            ...job,
            // The blob lives in IndexedDB keyed by job id and is not in
            // the export, so nothing downstream should wait on it. A job
            // mid-flight would otherwise be imported as still running,
            // and poll a status URL belonging to someone else's server.
            sourceMissing: true,
            status: job.status === 'done' ? 'done' : 'missing-source',
            statusUrl: null,
            pollCount: 0,
        };
    }
    return out;
}

/**
 * The document to write to disk.
 *
 * @param {object} project  a project body (the store's, or one read back)
 * @returns {object} plain JSON
 */
export function exportProject(project) {
    const body = createProject(project);          // normalise, and copy
    return {
        kind: FILE_KIND,
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        project: {
            name: body.name,
            bpm: body.bpm,
            tracks: body.tracks,
            sections: body.sections,
            patterns: body.patterns,
            patches: body.patches,
            patchNames: body.patchNames,
            canvas: body.canvas,
            jobs: exportJobs(body.jobs),
            tags: usedTags(body),
            created: body.created,
        },
    };
}

/** The filename an export is offered under. */
export function exportFilename(project) {
    return `${project && project.name ? project.name : 'project'}.${FILE_SUFFIX}`;
}

/**
 * Thrown for a file we will not guess at. Carries a message meant to be
 * shown to the user rather than logged.
 */
export class ImportError extends Error {}

/**
 * Read an exported document back into a project body.
 *
 * Refuses rather than guesses. A file from a *newer* schema is the case
 * worth refusing loudly: this reader would drop whatever it does not
 * understand and the user would get a quietly lesser copy of their work
 * back. An older schema is fine — the factories are total, and anything
 * missing takes its default.
 *
 * The returned body has **no id**: the caller mints one, which is what
 * makes every import a new project.
 */
export function importProject(doc) {
    if (!doc || typeof doc !== 'object') {
        throw new ImportError('That file is not an OpenPatches project.');
    }
    if (doc.kind !== FILE_KIND) {
        throw new ImportError('That file is not an OpenPatches project.');
    }
    const version = Number(doc.schemaVersion);
    if (!Number.isFinite(version)) {
        throw new ImportError('That project file does not say which version it is.');
    }
    if (version > SCHEMA_VERSION) {
        throw new ImportError(
            `That project was saved by a newer version of OpenPatches (format ${version}, `
            + `this one reads ${SCHEMA_VERSION}). Update before opening it, or it would `
            + 'come back missing whatever this version cannot read.',
        );
    }
    const body = doc.project;
    if (!body || typeof body !== 'object') {
        throw new ImportError('That project file has no project in it.');
    }
    // No id: the session mints one, so importing the same file twice
    // gives two projects rather than one overwriting the other.
    return createProject({ ...body, id: undefined });
}

/** Parse the text of a project file, with a readable error for bad JSON. */
export function parseProjectFile(text) {
    let doc;
    try {
        doc = JSON.parse(text);
    } catch {
        throw new ImportError('That file is not readable JSON.');
    }
    return importProject(doc);
}
