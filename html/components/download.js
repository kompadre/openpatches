// Saving a file from the browser, without asking a server to make it.
//
// Everything this app can do on the client, it does on the client: the
// inference server is optional and the editor must work with it switched
// off. Exporting a `.syx` used to POST the patches to `/api/export-syx`
// and download the URL that came back — for bytes `syx-builder.js` can
// already produce in front of us.
//
// The object URL is revoked on the next frame rather than immediately:
// the click has to have been dispatched and the download started, and
// revoking inside the same task cancels it in some browsers.

const REVOKE_DELAY_MS = 1000;

/**
 * Offer `blob` to the user as `filename`.
 *
 * @returns {boolean} whether the download could be started
 */
export function downloadBlob(filename, blob) {
    if (typeof URL === 'undefined' || !URL.createObjectURL) return false;
    const url = URL.createObjectURL(blob);
    try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
    }
    return true;
}

/** Raw bytes — a SysEx dump, say. */
export function downloadBytes(filename, bytes, type = 'application/octet-stream') {
    // A copy, because a Blob over a view of a reused buffer would capture
    // whatever that buffer holds later.
    return downloadBlob(filename, new Blob([Uint8Array.from(bytes)], { type }));
}

/** A JSON document — what a project export is. */
export function downloadJson(filename, value) {
    return downloadBlob(filename, new Blob([JSON.stringify(value)], { type: 'application/json' }));
}

/**
 * Trim a user-supplied name down to something safe to put in a download,
 * and strip a trailing extension so callers can add their own without
 * producing `bank.syx.syx`.
 */
export function safeFilename(name, { fallback = 'export', strip = null } = {}) {
    let out = String(name == null ? '' : name);
    if (strip) out = out.replace(new RegExp('\\.' + strip + '$', 'i'), '');
    out = out.replace(/[^a-zA-Z0-9 _\-.]/g, '').replace(/\s+/g, ' ').trim();
    return out || fallback;
}
