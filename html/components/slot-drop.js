// Dropping a patch onto a Mixer slot.
//
// Patches are dragged three ways — a container row by its star (HTML5
// drag and drop), a row by touch, and a floating patch by its header —
// and none of them knows the Mixer. They ask here instead: `slotAt(x, y)`
// says which voice bank slot is under a point, and `dropOnSlot()` hands the
// patch to whoever registered (the voice bank). The drag code stays
// ignorant of the bank and the bank of the canvas.

let handler = null;

/** The voice bank registers how to assign a patch to slot `idx`. */
export function onPatchDroppedOnSlot(fn) { handler = fn; return () => { if (handler === fn) handler = null; }; }

/** The slot index under a viewport point, or -1. */
export function slotAt(x, y) {
    if (typeof document === 'undefined') return -1;
    // Every element under the point, not the topmost: a floating patch
    // being dragged is itself under the pointer, over the slot.
    const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y)
        : document.elementFromPoint ? [document.elementFromPoint(x, y)] : [];
    let item = null;
    for (const el of stack) {
        item = el && el.closest ? el.closest('.voicebank-item') : null;
        if (item) break;
    }
    if (!item || item.dataset.vbIdx == null) return -1;
    return parseInt(item.dataset.vbIdx);
}

/** Assign `patch` to slot `idx`. Returns true if someone took it. */
export function dropOnSlot(patch, idx) {
    if (!handler || !patch || idx < 0) return false;
    return handler(patch, idx) !== false;
}
