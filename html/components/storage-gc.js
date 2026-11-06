// Storage report and garbage collection — on demand only (File → Storage…).
//
// Project bodies are self-contained and stay that way: no sharing or
// compaction between projects (decided with the user, 2026-11-06). What can
// leak is the upload store: a WAV blob is keyed by the job id that made it,
// and a blob whose job no longer exists in *any* project — deleted, cleared,
// lost to an old bug — is unreachable. This finds those and nothing else.
//
// Pure: hand it the bodies and the upload keys with their sizes; it returns
// what is used and what may go. The deleting is the caller's.

/** Every job id referenced by any project body. */
export function referencedJobIds(bodies) {
    const ids = new Set();
    for (const body of bodies) {
        if (!body) continue;
        for (const id of Object.keys(body.jobs || {})) ids.add(id);
        // A container names its job too; count it even if the job record went.
        const containers = (body.canvas && body.canvas.containers) || {};
        for (const c of Object.values(containers)) if (c && c.jobId) ids.add(c.jobId);
    }
    return ids;
}

/** Bytes a body takes as JSON — near enough what IndexedDB stores. */
export function bodyBytes(body) {
    try { return JSON.stringify(body).length; } catch { return 0; }
}

/**
 * @param {object[]} bodies     every stored project body
 * @param {Array<{key:string, bytes:number}>} uploads   the upload store
 * @returns {{projects: Array<{id, name, bytes}>, projectBytes:number,
 *            uploads:{count:number, bytes:number},
 *            orphans: Array<{key, bytes}>, orphanBytes:number}}
 */
export function planStorage(bodies, uploads) {
    const projects = bodies.filter(Boolean).map(b => ({ id: b.id, name: b.name, bytes: bodyBytes(b) }))
        .sort((a, b) => b.bytes - a.bytes);
    const used = referencedJobIds(bodies);
    const orphans = uploads.filter(u => !used.has(u.key));
    const sum = (list) => list.reduce((n, x) => n + (x.bytes || 0), 0);
    return {
        projects,
        projectBytes: sum(projects),
        uploads: { count: uploads.length, bytes: sum(uploads) },
        orphans,
        orphanBytes: sum(orphans),
    };
}

/** "1.2 MB", "340 KB", "12 B". */
export function formatBytes(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
}
