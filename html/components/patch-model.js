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

// --- Patch factory ---

export function createPatch(partial) {
    const voice_data = partial.voice_data || null;
    let id = partial.id;
    if (!id && voice_data) id = patchIdFromVoiceData(voice_data);
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
