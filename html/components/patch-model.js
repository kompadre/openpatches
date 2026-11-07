// Unified Patch data model and stores.
//
// Patches, the canvas layout and the inference jobs are all **owned by the
// open project** and written with its body; see "Storage" below. The tag
// vocabulary is the one exception and stays on the profile.

import { profileStore } from './profile-store.js';

// --- Hash ---

function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash = hash & hash;
    }
    return (hash >>> 0).toString(36);
}

export function patchIdFromVoiceData(voiceData) {
    return hashString(voiceData);
}

export function patchIdFromRaw(raw) {
    return hashString(String.fromCharCode.apply(null, raw));
}

// --- Voice identity ---

// Pure base64 decoder — this module runs under node:test where atob is not
// guaranteed by the harness.
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64ToBytes(b64) {
    const clean = b64.replace(/=+$/, '');
    const out = [];
    let buffer = 0, bits = 0;
    for (const ch of clean) {
        const v = B64_CHARS.indexOf(ch);
        if (v < 0) return null;
        buffer = (buffer << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buffer >> bits) & 0xFF);
        }
    }
    return out;
}

/**
 * Name-independent identity of a voice: the patch bytes hashed with the
 * embedded name characters zeroed, so a renamed copy of the same patch gets
 * the same key. Unlike patch ids (which deliberately include the name so two
 * records can coexist), one voiceKey means one VoiceBank slot.
 *
 * Accepts base64 strings, Uint8Array, or plain arrays — the three encodings
 * voice data travels in. Name offsets: 118-127 in the 128-byte packed
 * format, 145-154 in 155-byte unpacked VCED. Unknown lengths hash as-is.
 */
export function voiceKey(voiceData) {
    let bytes = null;
    if (typeof voiceData === 'string') {
        if (voiceData.length === 0) return null;
        bytes = base64ToBytes(voiceData);
        // Not base64: still a usable identity — hash the string itself
        // rather than silently disabling dedup for this voice.
        if (!bytes) return hashString(voiceData);
    } else if (voiceData && typeof voiceData.length === 'number') {
        bytes = Array.from(voiceData);
    }
    if (!bytes || bytes.length === 0) return null;
    if (bytes.length === 128) {
        for (let i = 118; i < 128; i++) bytes[i] = 0;
    } else if (bytes.length === 155) {
        for (let i = 145; i < 155; i++) bytes[i] = 0;
    }
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return hashString(s);
}

// --- Patch factory ---

export function createPatch(partial) {
    const voice_data = partial.voice_data || null;
    let id = partial.id;
    // Same bytes under a different name (one voice returned in several match
    // groups, a renamed copy) must not collapse into one record.
    if (!id && voice_data) id = patchIdFromVoiceData(partial.name ? voice_data + '|' + partial.name : voice_data);
    if (!id && partial.raw) id = patchIdFromRaw(partial.raw);
    if (!id) id = hashString(`${partial.algorithm}_${partial.feedback}_${partial.name || ''}`);
    return {
        id,
        name: partial.name || 'Untitled',
        algorithm: partial.algorithm || 0,
        feedback: partial.feedback || 0,
        voice_data,
        source: partial.source || 'unknown',
        created: partial.created || Date.now(),
        tags: partial.tags || [],
        midi_note: partial.midi_note || null,
    };
}

// --- Storage ---
//
// Patches, the canvas layout and the inference jobs all belong to the open
// **project**, so they live in its body and are written with it. The store
// APIs below are unchanged; only what sits underneath them moved.
//
// The session is injected rather than imported so this file stays free of
// the project machinery (and so the tests can bind one of their own).
// Unbound — before boot has opened a project, or in a test that does not
// care — reads give nothing and writes are dropped, which is right: there
// is no project for them to belong to.
//
// The **tag vocabulary is the exception**: it is the user's own taxonomy,
// reused across projects, so it stays on the profile. An export carries
// only the tags a project actually uses.

let session = null;

/** Called once by app.js, after the project is open. */
export function bindProjectSession(next) {
    session = next;
}

/** One of the project's own maps — patches, canvas, jobs. */
function slice(key) {
    const project = session && session.get();
    const value = project && project[key];
    return value && typeof value === 'object' ? value : {};
}

/**
 * Replace one of those maps and mark the project dirty.
 *
 * Announced as `kind: 'patches'` so the sequencer-side editors can ignore
 * it: dragging a patch across the canvas must not make the piano roll
 * re-read its arrangement on every pointer move.
 */
function putSlice(key, value) {
    if (!session || !session.get()) return;
    session.update((project) => { project[key] = value; }, 'patches', 'patches');
}

// --- patchStore ---

const loadPatches = () => slice('patches');
const savePatches = (map) => putSlice('patches', map);

export const patchStore = {
    getAll() {
        return Object.values(loadPatches());
    },
    get(id) {
        const map = loadPatches();
        return map[id] || null;
    },
    put(patch) {
        const map = loadPatches();
        map[patch.id] = patch;
        savePatches(map);
    },
    remove(id) {
        const map = loadPatches();
        delete map[id];
        savePatches(map);
    },
    bulkPut(patches) {
        const map = loadPatches();
        for (const p of patches) map[p.id] = p;
        savePatches(map);
    },
};

// --- canvasStore ---

const loadCanvas = () => slice('canvas');
const saveCanvas = (data) => putSlice('canvas', data);

export const canvasStore = {
    getCanvasPatches() {
        const data = loadCanvas();
        return data.patches || {};
    },
    getCanvasPatch(patchId) {
        const patches = this.getCanvasPatches();
        return patches[patchId] || null;
    },
    putCanvasPatch(patchId, entry) {
        const data = loadCanvas();
        if (!data.patches) data.patches = data.patches || {};
        data.patches[patchId] = { ...(data.patches[patchId] || {}), ...entry };
        saveCanvas(data);
    },
    removeCanvasPatch(patchId) {
        const data = loadCanvas();
        if (data.patches) {
            delete data.patches[patchId];
            saveCanvas(data);
        }
    },
    getContainers() {
        const data = loadCanvas();
        return data.containers || {};
    },
    getContainer(id) {
        const ctrs = this.getContainers();
        return ctrs[id] || null;
    },
    putContainer(ctr) {
        const data = loadCanvas();
        if (!data.containers) data.containers = {};
        data.containers[ctr.id] = ctr;
        saveCanvas(data);
    },
    removeContainer(id) {
        const data = loadCanvas();
        if (data.containers) {
            delete data.containers[id];
            saveCanvas(data);
        }
    },
    clear() {
        putSlice('canvas', {});
    },
};

// --- jobStore ---

const loadJobs = () => slice('jobs');
const saveJobs = (map) => putSlice('jobs', map);

export const jobStore = {
    getAll() {
        return Object.values(loadJobs());
    },
    get(id) {
        const map = loadJobs();
        return map[id] || null;
    },
    put(job) {
        const map = loadJobs();
        map[job.id] = job;
        saveJobs(map);
    },
    remove(id) {
        const map = loadJobs();
        delete map[id];
        saveJobs(map);
    },
};

/**
 * Did this job come from inferring a WAV? Only those have a source audio
 * blob to show, play or ask for again. A `.syx` load or the demo bank also
 * leaves a job record (type `syx_import` / `demo_import`) so its container
 * has a jobId, but there was never a WAV behind it. A record with no type
 * predates the field and is a WAV job — the Job class defaults it the same.
 * An allow-list, so a future job type is not mistaken for one.
 */
export function isWavJob(job) {
    return !!job && (job.type == null || job.type === 'wav_import');
}

// --- Patch name persistence (renames) ---
//
// A rename overlay keyed by patch id. Project-owned like the patches it
// renames — a name is part of the patch as this project knows it.

export function loadPatchNames() {
    return slice('patchNames');
}

export function savePatchNames(names) {
    putSlice('patchNames', names);
}

// --- tagStore (Global Tag Registry) ---

// The vocabulary is the user's own taxonomy, reused across projects, so it
// lives on the profile rather than in any one project body. An export
// carries only the tags its project actually uses, and an import unions
// those back in — tags carry no meaning beyond the word, so that is always
// safe.
const loadGlobalTags = () => profileStore.tags();
const saveGlobalTags = (tags) => {
    const before = new Set(profileStore.tags());
    profileStore.addTags(tags);
    for (const gone of [...before].filter(t => !tags.includes(t))) profileStore.removeTag(gone);
};

export const tagStore = {
    getTags() {
        return loadGlobalTags();
    },
    addTag(tag) {
        if (!tag) return;
        const tags = loadGlobalTags();
        if (!tags.includes(tag)) {
            tags.push(tag);
            tags.sort();
            saveGlobalTags(tags);
        }
    },
    removeTag(tag) {
        const tags = loadGlobalTags();
        const idx = tags.indexOf(tag);
        if (idx > -1) {
            tags.splice(idx, 1);
            saveGlobalTags(tags);
        }
    }
};
