// The voiceover for the 90-second feature video.
//
// This is the single source of truth for both halves of the tour: `text` is
// spoken, and `demo/feature-tour.mjs` paces each scene to the length of that
// scene's narration. Change the words here and the on-screen timing follows.
//
// Written to be *read aloud*, the same way HEARME.tts is: numbers spelled
// out, "DX seven" not "DX7", no symbols or parentheses. The scratch track in
// demo/voice/ is espeak-ng, only there to fix the timing — the final voice is
// the user's own.
//
// `hold` is dead air after the narration ends, in seconds: room for a sound
// to ring out, or for footage to be cut in later. `insert` marks a scene
// where external footage goes over the top.

export const scenes = [
    {
        id: 'intro',
        title: 'The night sky',
        text: 'OpenPatches turns the DX seven into a searchable library of sound. '
            + 'It runs entirely in your browser.',
        hold: 1.0,
        shows: 'Empty night-sky canvas, then a bank of patches lands on it.',
    },
    {
        id: 'archeology',
        title: 'Sound archeology',
        text: 'Drop in a recording, and it works backwards from the audio to the '
            + 'patch that made it. Real DX seven parameters, out of a sound.',
        hold: 1.5,
        shows: 'File, Import WAV. Progress modal, then a container of matched patches.',
    },
    {
        id: 'curation',
        title: 'Curation',
        text: 'Collect what you find into cartridges of your own, and export them '
            + 'as sysex banks, ready for Dexed or for the hardware.',
        hold: 0.5,
        shows: 'Drag a patch out of the cartridge onto the canvas, assign the '
            + 'cartridge to the voice slots, then the Export-as-SYX button.',
    },
    {
        id: 'edit',
        title: 'Morph and mutate',
        text: 'Edit the operators by hand, morph between two patches to find what '
            + 'sits between them, or mutate one and keep its character.',
        hold: 1.5,
        shows: 'Edit tab: Params, then Morph with the distance slider, then Random.',
    },
    {
        id: 'mixer',
        title: 'The mixer',
        text: 'Eight slots, eight voices, each one a patch you chose.',
        hold: 0.5,
        shows: 'Mixer tab, patches assigned to slots, each with its colour.',
    },
    {
        id: 'pianoroll',
        title: 'Patterns',
        text: 'Write a pattern in the piano roll, or play it in from the keyboard. '
            + 'A pattern is just notes, so the same phrase can be a bass, or a bell.',
        hold: 2.5,
        shows: 'Draw notes, Play, the loop running. Hold while it plays.',
    },
    {
        id: 'section',
        title: 'Arranging',
        text: 'Lay those patterns out as clips across the tracks of a section, and '
            + 'the whole thing plays together.',
        hold: 3.0,
        shows: 'Section tab, clips on several tracks, section Play. Long hold: this is the music.',
    },
    {
        id: 'project',
        title: 'Projects',
        text: 'It is all one project, saved in your browser and never sent anywhere. '
            + 'Export it as a single file to pass it on.',
        hold: 0.5,
        shows: 'File menu open, Export Project.',
    },
    {
        id: 'midi',
        title: 'Hardware',
        text: 'And it talks to the real thing: send a bank to your synth over MIDI, '
            + 'and share a clock with it.',
        hold: 4.0,
        insert: 'Volca FM footage goes here, over the hold.',
        shows: 'MIDI, Devices. Enable MIDI, the channel map, the clock switches.',
    },
    {
        id: 'outro',
        title: 'Outro',
        text: 'OpenPatches. Open the browser and start digging.',
        hold: 2.0,
        shows: 'Back to the canvas, full of patches. Title card: openpatch dot e s.',
    },
];

/** Rough spoken length, for pacing before a scratch track exists. */
export const WORDS_PER_MINUTE = 150;

export function estimateSeconds(text) {
    return (text.trim().split(/\s+/).length / WORDS_PER_MINUTE) * 60;
}

export function sceneSeconds(scene, durations) {
    const spoken = durations?.[scene.id] ?? estimateSeconds(scene.text);
    return spoken + (scene.hold ?? 0);
}
