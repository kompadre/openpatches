// Transport bar — the one set of Play, Stop, Record and BPM controls.
//
// Until November 2026 the Section toolbar had a Play/Stop pair that played
// the arrangement and the piano roll's control row had another that looped
// the pattern, each with its own BPM box writing the same project tempo,
// and Record sat in the roll's row because that is where desktop users
// looked. Three places for one clock. This bar is the only one now: it
// sits to the left of the global tabs, above every panel, and the
// **mode switch** on it says what Play and Record act on — the whole
// section, or the pattern on screen (the transport's two modes; a third,
// the whole piece, is planned). Record itself is still the toolbar's
// button, inserted here through `insertControl`, because the recording
// session (takes, step record) lives there.
//
// Everything on the bar is a view of the transport: `transport.subscribe`
// drives the buttons' enabled/active/waiting states and the lit mode, and
// the session drives the BPM box.
import { MIN_BPM, MAX_BPM, DEFAULT_BPM } from './project-model.js';
import { MODES } from '../synth/transport.js';

export const MODE_LABELS = {
    piece: { label: 'Piece', title: 'Play runs every section in order; Record records the section on screen' },
    section: { label: 'Section', title: 'Play and Record act on the section on screen' },
    pattern: { label: 'Pattern', title: 'Play and Record loop the pattern open in the piano roll' },
};

/**
 * @param {object} opts
 * @param {object} opts.transport  the clock (see synth/transport.js)
 * @param {object} opts.session    the project session — owner of the BPM
 * @param {function} [opts.onPlay] what Play does; default `transport.play()`
 * @param {function} [opts.onStop] what Stop does; default `transport.stop()`
 */
export function createTransportBar(opts) {
    const { transport, session } = opts;
    const onPlay = opts.onPlay || (() => transport.play());
    const onStop = opts.onStop || (() => transport.stop());

    const el = document.createElement('div');
    el.className = 'transport-bar';

    const button = (className, label, title, onClick) => {
        const b = document.createElement('button');
        b.className = 'transport-btn ' + className;
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
        return b;
    };

    const PLAY_TITLE = 'Play';
    const WAIT_TITLE = 'Waiting for the external MIDI clock to start';
    const playBtn = button('transport-play', '▶ Play', PLAY_TITLE, onPlay);
    const stopBtn = button('transport-stop', '■ Stop', 'Stop', onStop);
    stopBtn.disabled = true;

    // What Play and Record act on. One lit segment, like the roll's
    // With section / Pattern only pair — but that one changes what is
    // *heard* inside the pattern window, this one changes the window.
    const modes = document.createElement('div');
    modes.className = 'transport-modes';
    modes.title = 'What Play and Record act on';
    const modeBtns = {};
    for (const mode of MODES) {
        const m = MODE_LABELS[mode] || { label: mode, title: mode };
        const b = button('transport-mode', m.label, m.title, () => transport.setMode(mode));
        b.dataset.mode = mode;
        modeBtns[mode] = b;
        modes.appendChild(b);
    }
    // First, so it reads as "Section ▶ Play": the scope, then the verb.
    el.appendChild(modes);
    el.appendChild(playBtn);
    el.appendChild(stopBtn);

    // The project's tempo. A section can override it (the Section editor
    // owns that), so what plays may differ from this box; it stays the
    // project's so there is one number to set.
    const bpmLabel = document.createElement('label');
    bpmLabel.className = 'transport-field';
    bpmLabel.textContent = 'BPM ';
    const bpm = document.createElement('input');
    bpm.type = 'number';
    bpm.className = 'transport-bpm';
    bpm.min = String(MIN_BPM);
    bpm.max = String(MAX_BPM);
    bpm.step = '1';
    bpm.title = 'Project tempo';
    bpm.addEventListener('change', () => {
        const v = parseInt(bpm.value);
        const project = session.get();
        const fallback = project && project.bpm != null ? project.bpm : DEFAULT_BPM;
        const clamped = Number.isFinite(v) ? Math.max(MIN_BPM, Math.min(MAX_BPM, v)) : fallback;
        session.update((p) => { p.bpm = clamped; }, 'transport-bar');
        // The worker is told its rate at start; a tempo typed mid-playback
        // has to be handed on or the columns keep arriving at the old one.
        if (transport.refresh) transport.refresh();
    });
    bpmLabel.appendChild(bpm);
    el.appendChild(bpmLabel);

    function syncBpm() {
        const project = session.get();
        const v = project && project.bpm != null ? project.bpm : DEFAULT_BPM;
        if (document.activeElement !== bpm) bpm.value = String(v);
    }

    function sync(pos) {
        // Armed for an external clock, or parked on an autosave, counts as
        // going for the buttons — Stop is how you take it back.
        const running = !!(pos.playing || pos.recording || pos.waiting || pos.pending);
        playBtn.disabled = running;
        stopBtn.disabled = !running;
        playBtn.classList.toggle('active', !!pos.playing);
        playBtn.classList.toggle('waiting', !!pos.waiting);
        playBtn.title = pos.waiting ? WAIT_TITLE : PLAY_TITLE;
        for (const [mode, b] of Object.entries(modeBtns)) b.classList.toggle('active', pos.mode === mode);
    }

    const unsubTransport = transport.subscribe(sync);
    const unsubSession = session.subscribe((ev) => {
        if (ev.kind === 'patches') return;
        syncBpm();
    });
    sync({
        playing: transport.isPlaying(), recording: transport.isRecording(), mode: transport.getMode(),
        waiting: transport.isWaiting ? transport.isWaiting() : false,
    });
    syncBpm();

    return {
        element: el,
        /** Put a control right after Stop — Record and its step length live in the toolbar. */
        insertControl(control) {
            el.insertBefore(control, stopBtn.nextSibling);
        },
        destroy() {
            if (unsubTransport) unsubTransport();
            if (unsubSession) unsubSession();
        },
    };
}
