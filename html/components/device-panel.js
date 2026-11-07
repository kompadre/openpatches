// Device — the external MIDI-out synth, as a panel in the bottom pane.
//
// Everything here is read from midi-manager and redrawn on its out-change
// events: what the device is (the resolved profile, and the port it is
// on), the channel it listens on, the voice last loaded into its edit
// buffer, and whether we are sending to it at all. The one control is
// Stop / Resume, which pauses every musical message — notes, clock,
// audition — without touching the settings, so Resume puts things back
// exactly as they were.

import * as midi from '../synth/midi-manager.js';

// Short: the panel is a narrow column. The title carries the long form.
const MODE_TEXT = {
    internal: 'Internal only',
    midi: 'Device only',
    both: 'Device + internal',
};
const MODE_TITLE = {
    internal: 'Notes play on the internal synth only — the device gets none. Change in MIDI › Devices.',
    midi: 'Notes go to the device only; the internal synth is silent.',
    both: 'Notes go to the device and the internal synth.',
};

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function row(label, valueCls) {
    const r = el('div', 'device-row');
    r.appendChild(el('span', 'device-label', label));
    const v = el('span', 'device-value ' + valueCls);
    r.appendChild(v);
    return { row: r, value: v };
}

/**
 * @param {HTMLElement} container
 * @param {{onOpenSettings?: function, appendLog?: function}} opts
 * @returns {{refresh: function, destroy: function}}
 */
export function createDevicePanel(container, opts = {}) {
    const root = el('div', 'device-panel');

    const head = el('div', 'device-head');
    const name = el('div', 'device-name');
    const port = el('div', 'device-port');
    head.appendChild(name);
    head.appendChild(port);
    root.appendChild(head);

    const channel = row('Channel', 'device-channel');
    const patch = row('Patch', 'device-patch');
    const mode = row('Output', 'device-mode');
    root.appendChild(channel.row);
    root.appendChild(patch.row);
    root.appendChild(mode.row);

    const actions = el('div', 'device-actions');
    const toggle = el('button', 'device-toggle');
    const settings = el('button', 'device-settings', 'MIDI…');
    settings.title = 'MIDI › Devices';
    actions.appendChild(toggle);
    if (opts.onOpenSettings) actions.appendChild(settings);
    root.appendChild(actions);

    const hint = el('div', 'device-hint');
    root.appendChild(hint);

    container.appendChild(root);

    toggle.addEventListener('click', () => {
        const paused = midi.setOutputPaused(!midi.isOutputPaused());
        if (opts.appendLog) {
            opts.appendLog(paused
                ? 'MIDI out stopped — nothing is sent to the device until Resume'
                : 'MIDI out resumed');
        }
    });
    settings.addEventListener('click', () => { if (opts.onOpenSettings) opts.onOpenSettings(); });

    function refresh() {
        const supported = midi.isSupported();
        const out = supported ? midi.getOutputPort() : null;
        const paused = midi.isOutputPaused();
        const profile = midi.getDeviceProfile();
        const auto = midi.getDeviceType() === 'auto';

        name.textContent = profile.name + (auto ? ' (auto)' : '');
        port.textContent = out ? out.name : (supported ? 'Not connected' : 'No Web MIDI in this browser');

        channel.value.textContent = String(midi.getDeviceChannel() + 1);

        const voice = midi.getCurrentVoice();
        patch.value.textContent = voice ? voice.name : '—';
        patch.value.title = voice
            ? 'Last voice loaded into the device’s edit buffer'
            : 'Unknown: whatever is loaded on the device. Audition or send a patch to load one.';

        mode.value.textContent = MODE_TEXT[midi.getOutputMode()] || '';
        mode.value.title = MODE_TITLE[midi.getOutputMode()] || '';

        toggle.textContent = paused ? '▶ Resume' : '■ Stop';
        toggle.title = paused
            ? 'Resume sending MIDI to the device'
            : 'Stop sending MIDI to the device (notes, clock, audition)';
        toggle.disabled = !out && !paused;
        toggle.classList.toggle('paused', paused);
        root.classList.toggle('paused', paused);
        root.classList.toggle('disconnected', !out);

        hint.textContent = paused
            ? 'Stopped: nothing is sent to the device.'
              + (midi.getOutputMode() === 'midi' ? ' Notes play on the internal synth meanwhile.' : '')
            : !supported ? ''
            : !out ? 'Pick an output in MIDI › Devices.'
            : '';
    }

    const unsubscribe = midi.subscribeOutChange(refresh);
    refresh();

    return {
        refresh,
        destroy() { unsubscribe(); root.remove(); },
    };
}
