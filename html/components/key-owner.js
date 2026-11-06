// Which editor the selection keys belong to.
//
// The piano roll and the Section editor both have a selection, and both
// answer Delete, Escape and Ctrl/Cmd+C at the document level (neither is a
// focusable widget). On desktop they are on screen together, so one Delete
// with notes selected in the roll and clips selected in the Section would
// remove both. The editor pressed last owns the keys: each claims them on
// a press inside itself and only acts while it is the owner. Nobody owns
// them at first, and then whoever has a selection acts — the behaviour
// before there were two.

let owner = null;

/** Claim the keys for `name` (call on a press inside the editor). */
export function claimKeys(name) { owner = name; }

/** May `name` act on a selection key now? */
export function ownsKeys(name) { return owner === null || owner === name; }

/** Tests: forget the owner. */
export function _resetKeyOwner() { owner = null; }
