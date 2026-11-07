// Dropping a patch onto a voice: a Mixer slot, a Section lane or head, or
// the Section's empty grid (a new track).
//
// Patches are dragged three ways — a container row by its star (HTML5
// drag and drop), a row by touch, and a floating patch by its header —
// and none of them knows the Mixer or the Section. They ask here instead:
// `targetAt(x, y)` names the voice under a point, `dropAt()` hands the
// patch to whoever registered (the voice bank, which owns assigning). For
// HTML5 drags, `wireDropZone(el)` makes an element accept them.
import { getDraggedPatch } from './patch-row.js';

let handler = null;

/**
 * The voice bank registers how to assign a patch: to slot `idx`, or, for
 * `'new'`, to a new track on the first free slot — a second one if the
 * voice is already in the bank.
 */
export function onPatchDroppedOnSlot(fn) { handler = fn; return () => { if (handler === fn) handler = null; }; }

/**
 * What is under a viewport point: `{ slot: n }` for a Mixer slot or a
 * Section lane/head, `{ slot: 'new', el }` for the Section grid's empty
 * space, or null. Every element under the point is looked at, not just the
 * topmost: a floating patch being dragged is itself under the pointer.
 */
export function targetAt(x, y) {
    if (typeof document === 'undefined') return null;
    const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y)
        : document.elementFromPoint ? [document.elementFromPoint(x, y)] : [];
    return targetIn(stack);
}

function targetIn(stack) {
    for (const node of stack) {
        if (!node || !node.closest) continue;
        const item = node.closest('.voicebank-item');
        if (item && item.dataset.vbIdx != null) return { slot: parseInt(item.dataset.vbIdx), el: item };
        const lane = node.closest('.section-lane, .section-track-head');
        if (lane && lane.dataset.slot != null) return { slot: parseInt(lane.dataset.slot), el: lane };
        const grid = node.closest('.section-grid');
        if (grid) return { slot: 'new', el: grid };
    }
    return null;
}

/** Back-compat: the Mixer slot index under a point, or -1. */
export function slotAt(x, y) {
    const t = targetAt(x, y);
    return t && typeof t.slot === 'number' ? t.slot : -1;
}

/** Assign `patch` to `slot` (a number, or 'new'). True if someone took it. */
export function dropOnSlot(patch, slot) {
    if (!handler || !patch || slot == null || slot === -1) return false;
    return handler(patch, slot) !== false;
}

/** Drop `patch` at a viewport point. True if it landed on a voice. */
export function dropAt(patch, x, y) {
    const t = targetAt(x, y);
    return !!t && dropOnSlot(patch, t.slot);
}

/**
 * Accept HTML5 patch drags (a container row dragged by its star) on `el`
 * and everything in it. The voice under the pointer is outlined while
 * hovering. dropEffect is 'move' to match the row's effectAllowed — a
 * mismatch and Chromium silently never fires the drop.
 */
export function wireDropZone(el) {
    let lit = null;
    const light = (t) => {
        const next = t ? t.el : null;
        if (next === lit) return;
        if (lit) lit.classList.remove('drop-target');
        lit = next;
        if (lit) lit.classList.add('drop-target');
    };
    el.addEventListener('dragover', (e) => {
        if (!getDraggedPatch()) return;
        const t = targetIn([e.target]);
        if (!t) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        light(t);
    });
    el.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget || !el.contains(e.relatedTarget)) light(null);
    });
    el.addEventListener('drop', (e) => {
        const patch = getDraggedPatch();
        const t = targetIn([e.target]);
        light(null);
        if (!patch || !t) return;
        e.preventDefault();
        e.stopPropagation();
        dropOnSlot(patch, t.slot);
    });
}
