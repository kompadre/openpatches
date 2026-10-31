// Unified Patch data model and stores (localStorage-backed).
// Patches, canvas state, and jobs all live here.

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

// --- Storage keys ---

const PATCHES_KEY = 'openpatches_patches';
const CANVAS_KEY = 'openpatches_canvas';
const JOBS_KEY = 'openpatches_jobs';
const PATCH_NAMES_KEY = 'openpatches_patch_names';
const TAGS_KEY = 'openpatches_all_tags';

// --- patchStore ---

function loadPatches() {
    try {
        return JSON.parse(localStorage.getItem(PATCHES_KEY) || '{}');
    } catch { return {}; }
}

function savePatches(map) {
    try {
        localStorage.setItem(PATCHES_KEY, JSON.stringify(map));
    } catch (e) {
        console.warn('patchStore save failed:', e);
    }
}

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

function loadCanvas() {
    try {
        return JSON.parse(localStorage.getItem(CANVAS_KEY) || '{}');
    } catch { return {}; }
}

function saveCanvas(data) {
    try {
        localStorage.setItem(CANVAS_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn('canvasStore save failed:', e);
    }
}

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
        localStorage.removeItem(CANVAS_KEY);
    },
};

// --- jobStore ---

function loadJobs() {
    try {
        return JSON.parse(localStorage.getItem(JOBS_KEY) || '{}');
    } catch { return {}; }
}

function saveJobs(map) {
    try {
        localStorage.setItem(JOBS_KEY, JSON.stringify(map));
    } catch (e) {
        console.warn('jobStore save failed:', e);
    }
}

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

// --- Patch name persistence (renames) ---

export function loadPatchNames() {
    try {
        return JSON.parse(localStorage.getItem(PATCH_NAMES_KEY) || '{}');
    } catch { return {}; }
}

export function savePatchNames(names) {
    localStorage.setItem(PATCH_NAMES_KEY, JSON.stringify(names));
}

// --- tagStore (Global Tag Registry) ---

function loadGlobalTags() {
    try {
        return JSON.parse(localStorage.getItem(TAGS_KEY) || '[]');
    } catch { return []; }
}

function saveGlobalTags(tags) {
    try {
        localStorage.setItem(TAGS_KEY, JSON.stringify(tags));
    } catch (e) {
        console.warn('tagStore save failed:', e);
    }
}

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
