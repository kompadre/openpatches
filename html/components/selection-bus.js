// One selection on screen at a time, across editors.
//
// The piano roll and the Section editor each have a selection (notes;
// clips) and both answer Delete, Escape and Ctrl/Cmd+C at the document
// level. On desktop they are on screen together, so with notes selected
// in one and clips in the other, a single Delete removed both. Selecting
// in one editor now deselects the other: each says so here whenever it
// holds a selection (or an armed stamp), and every other editor drops
// its own. With only one selection alive, the keys are never ambiguous.

const listeners = new Map();   // editor name → drop-your-selection callback

/** `name` holds a selection now: the others drop theirs. */
export function selectionMade(name) {
    for (const [other, drop] of listeners) if (other !== name) drop();
}

/** Register `name`'s drop callback. Returns an unsubscribe. */
export function onSelectionElsewhere(name, drop) {
    listeners.set(name, drop);
    return () => { if (listeners.get(name) === drop) listeners.delete(name); };
}
