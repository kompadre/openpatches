// Note output — the one interface the transport sounds through (Player
// phase 2). The Player speaks note-on and note-off; this turns them into
// the existing playNote chain, held open (`sustained`) and stopped
// explicitly, and keeps the stop functions so an off — or all-off — can
// always find its note.
//
// playNote may resolve its stop function later (the synth can still be
// starting); an off that arrives first marks the entry, and the stop runs
// the moment it lands — the same dance the toolbar does for a held key.

/**
 * @param {function} playNote  (midi, durMs, voiceData, slot, noteOpts) →
 *   stop function, or a promise of one, or nothing
 */
export function createNoteOutput(playNote) {
    const sounding = new Map();   // 'slot:midi' → { stop?, off? }

    return {
        /**
         * Sound an event. `durMs` is the nominal length — the chain uses it
         * as the safety net; the real end is the note-off. A second on for
         * the same slot and pitch supersedes the first (the MIDI layer and
         * the synth both retrigger), its entry simply replaced.
         */
        noteOn(ev, durMs, voiceData) {
            const key = ev.slot + ':' + ev.midi;
            const entry = {};
            sounding.set(key, entry);
            const opts = { sustained: true };
            if (ev.vel != null) opts.velocity = ev.vel;
            const r = playNote(ev.midi, durMs, voiceData, ev.slot, opts);
            if (r && typeof r.then === 'function') {
                r.then((stop) => {
                    if (typeof stop !== 'function') return;
                    if (entry.off) stop();
                    else entry.stop = stop;
                }).catch(() => {});
            } else if (typeof r === 'function') {
                entry.stop = r;
            }
        },

        noteOff(slot, midi) {
            const key = slot + ':' + midi;
            const entry = sounding.get(key);
            if (!entry) return;
            sounding.delete(key);
            if (entry.stop) entry.stop();
            else entry.off = true;     // the stop lands later and runs itself
        },

        /** Everything this output has sounding, off — the Section transition, and Stop. */
        allOff() {
            for (const key of [...sounding.keys()]) {
                const [slot, midi] = key.split(':').map(Number);
                this.noteOff(slot, midi);
            }
        },
    };
}
