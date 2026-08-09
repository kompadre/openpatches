export function createPiano(matchedMidi, job, playNoteFn, pianorollNotes) {
    const wrapper = document.createElement('div');
    wrapper.className = 'piano-wrapper';

    const label = document.createElement('div');
    label.className = 'keyboard-label';
    label.textContent = 'Click to preview note';
    wrapper.appendChild(label);

    const kb = document.createElement('div');
    kb.className = 'keyboard';

    const notes = [
        { midi: 36, name: 'C2',  white: true },
        { midi: 37, name: 'C#2', white: false },
        { midi: 38, name: 'D2',  white: true },
        { midi: 39, name: 'D#2', white: false },
        { midi: 40, name: 'E2',  white: true },
        { midi: 41, name: 'F2',  white: true },
        { midi: 42, name: 'F#2', white: false },
        { midi: 43, name: 'G2',  white: true },
        { midi: 44, name: 'G#2', white: false },
        { midi: 45, name: 'A2',  white: true },
        { midi: 46, name: 'A#2', white: false },
        { midi: 47, name: 'B2',  white: true },
        { midi: 48, name: 'C3',  white: true },
        { midi: 49, name: 'C#3', white: false },
        { midi: 50, name: 'D3',  white: true },
        { midi: 51, name: 'D#3', white: false },
        { midi: 52, name: 'E3',  white: true },
        { midi: 53, name: 'F3',  white: true },
        { midi: 54, name: 'F#3', white: false },
        { midi: 55, name: 'G3',  white: true },
        { midi: 56, name: 'G#3', white: false },
        { midi: 57, name: 'A3',  white: true },
        { midi: 58, name: 'A#3', white: false },
        { midi: 59, name: 'B3',  white: true },
        { midi: 60, name: 'C4',  white: true },
        { midi: 61, name: 'C#4', white: false },
        { midi: 62, name: 'D4',  white: true },
        { midi: 63, name: 'D#4', white: false },
        { midi: 64, name: 'E4',  white: true },
        { midi: 65, name: 'F4',  white: true },
        { midi: 66, name: 'F#4', white: false },
        { midi: 67, name: 'G4',  white: true },
        { midi: 68, name: 'G#4', white: false },
        { midi: 69, name: 'A4',  white: true },
        { midi: 70, name: 'A#4', white: false },
        { midi: 71, name: 'B4',  white: true },
        { midi: 72, name: 'C5',  white: true },
        { midi: 73, name: 'C#5', white: false },
        { midi: 74, name: 'D5',  white: true },
        { midi: 75, name: 'D#5', white: false },
        { midi: 76, name: 'E5',  white: true },
        { midi: 77, name: 'F5',  white: true },
        { midi: 78, name: 'F#5', white: false },
        { midi: 79, name: 'G5',  white: true },
        { midi: 80, name: 'G#5', white: false },
        { midi: 81, name: 'A5',  white: true },
        { midi: 82, name: 'A#5', white: false },
        { midi: 83, name: 'B5',  white: true },
    ];

    const keyElements = {};
    notes.forEach(n => {
        const key = document.createElement('div');
        key.className = 'key ' + (n.white ? 'white' : 'black');
        key.title = n.name;
        if (n.midi === matchedMidi) key.classList.add('matched');
        if (n.white) key.textContent = n.name;

        let pressed = false;
        key.addEventListener('mousedown', (e) => {
            e.preventDefault();
            pressed = true;
            key.classList.add('pressed');
            playNoteFn(n.midi, job);
        });
        key.addEventListener('mouseup', () => { pressed = false; key.classList.remove('pressed'); });
        key.addEventListener('mouseleave', () => { if (pressed) key.classList.remove('pressed'); });

        keyElements[n.midi] = key;
        kb.appendChild(key);
    });

    // Highlight keys that have pianoroll notes
    function updateHighlights() {
        const midiSet = new Set((pianorollNotes || []).map(n => n.midi));
        for (const [midi, key] of Object.entries(keyElements)) {
            const m = parseInt(midi);
            if (m >= 60 && m <= 77) {
                key.classList.toggle('pianoroll-active', midiSet.has(m));
            }
        }
    }
    updateHighlights();

    wrapper.appendChild(kb);
    wrapper._updateHighlights = updateHighlights;
    return wrapper;
}
