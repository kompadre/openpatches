// MIDI settings modal + the guarded "send bank to device" flow.
//
// The send flow exists to stop the user shooting their hardware in the foot:
// a DX7 bulk dump silently overwrites all 32 voices, and there is no undo on
// the device. So the flow is always confirm → (optionally back up) → send, and
// a failed backup is a hard stop, never a "proceed anyway".
//
// The transport itself (receiveBank/sendBank) is stubbed until Phase 4; the
// dialogs, progress and error paths here are real.

import * as midi from '../synth/midi-manager.js';

const CHANNEL_COUNT = 16;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

// --- Generic modal shell, matching the static modals in index.html ---

function openModal(title, buildBody, { onClose } = {}) {
    const overlay = el('div', 'modal-overlay');
    overlay.style.zIndex = '620';

    const dialog = el('div', 'modal-dialog');
    const header = el('div', 'modal-header');
    header.appendChild(el('h3', null, title));
    const closeBtn = el('button', 'modal-close', '×');
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const body = el('div', 'modal-body');
    dialog.appendChild(body);
    overlay.appendChild(dialog);

    function close() {
        overlay.remove();
        if (onClose) onClose();
    }

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    buildBody(body, close, dialog);
    document.body.appendChild(overlay);
    return { overlay, close };
}

// --- Settings modal ---

/**
 * Open the MIDI settings modal.
 * @param {{appendLog?: function}} opts
 */
export function openMidiSettings(opts = {}) {
    const appendLog = opts.appendLog || (() => {});

    openModal('MIDI Devices', (body, close) => {
        if (!midi.isSupported()) {
            const p = el('p');
            p.innerHTML = 'This browser has no <strong>Web MIDI</strong> support. ' +
                'Chrome, Edge and Opera on desktop or Android work; Safari and all ' +
                'iOS browsers do not.';
            body.appendChild(p);
            return;
        }

        const intro = el('p', null,
            'MIDI access is requested only when you ask for it. Nothing is sent ' +
            'to or read from your devices until you enable it here.');
        body.appendChild(intro);

        const enableRow = el('div', 'midi-row');
        const enableBtn = el('button', 'midi-enable-btn', 'Enable MIDI');
        const statusText = el('span', 'midi-status-text');
        enableRow.appendChild(enableBtn);
        enableRow.appendChild(statusText);
        body.appendChild(enableRow);

        const deviceArea = el('div', 'midi-device-area');
        body.appendChild(deviceArea);

        const inputSel = el('select', 'midi-select');
        const outputSel = el('select', 'midi-select');
        const channelSel = el('select', 'midi-select');

        function labelled(labelText, control, hint) {
            const row = el('div', 'midi-field');
            row.appendChild(el('label', 'midi-label', labelText));
            row.appendChild(control);
            if (hint) row.appendChild(el('div', 'midi-hint', hint));
            return row;
        }

        deviceArea.appendChild(labelled('Input', inputSel, 'Used to record notes into the piano roll.'));
        deviceArea.appendChild(labelled('Output', outputSel, 'Used to play the piano roll on external gear.'));
        deviceArea.appendChild(labelled('Device channel', channelSel, 'Basic channel of the synth, for bulk SysEx dumps.'));

        const panicBtn = el('button', 'midi-panic-btn', '⚠ Panic (All Notes Off)');
        panicBtn.title = 'Send All Sound Off + All Notes Off on all 16 channels';
        panicBtn.addEventListener('click', () => {
            if (midi.panic()) appendLog('MIDI panic sent to ' + portName(midi.getOutputPort()));
            else appendLog('MIDI panic: no output device selected');
        });
        deviceArea.appendChild(panicBtn);

        for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
            const o = el('option', null, String(ch + 1));
            o.value = String(ch);
            channelSel.appendChild(o);
        }
        channelSel.value = String(midi.getDeviceChannel());
        channelSel.addEventListener('change', () => midi.setDeviceChannel(parseInt(channelSel.value, 10)));

        function fillPorts(sel, ports, selectedId, placeholder) {
            sel.innerHTML = '';
            const none = el('option', null, ports.length ? placeholder : 'No devices found');
            none.value = '';
            sel.appendChild(none);
            for (const p of ports) {
                const o = el('option', null, p.manufacturer ? `${p.name} — ${p.manufacturer}` : p.name);
                o.value = p.id;
                sel.appendChild(o);
            }
            sel.value = ports.some(p => p.id === selectedId) ? selectedId : '';
        }

        inputSel.addEventListener('change', () => midi.setSelectedInput(inputSel.value));
        outputSel.addEventListener('change', () => midi.setSelectedOutput(outputSel.value));

        function refresh() {
            const state = midi.getState();
            const ready = state === 'ready';
            deviceArea.style.display = ready ? '' : 'none';
            enableBtn.style.display = ready ? 'none' : '';
            enableBtn.disabled = state === 'requesting';
            statusText.textContent = {
                closed: 'Not enabled',
                requesting: 'Waiting for permission…',
                ready: 'Enabled' + (midi.hasSysex() ? ' (with SysEx)' : ''),
                denied: 'Permission denied — check the browser site settings',
                unsupported: 'Not supported',
            }[state] || state;
            statusText.className = 'midi-status-text midi-status-' + state;
            if (ready) {
                fillPorts(inputSel, midi.listInputs(), midi.getSelectedInputId(), 'None');
                fillPorts(outputSel, midi.listOutputs(), midi.getSelectedOutputId(), 'None');
            }
        }

        enableBtn.addEventListener('click', async () => {
            try {
                await midi.requestMidi({ sysex: false });
                appendLog('MIDI enabled');
            } catch (err) {
                appendLog('MIDI access denied: ' + err.message);
            }
            refresh();
        });

        midi.setOnPortsChange(refresh);
        midi.setOnStatusChange(refresh);
        refresh();
    }, {
        // The modal owns these callbacks while open; drop them on close so a
        // detached <select> is not written to.
        onClose: () => {
            midi.setOnPortsChange(null);
            midi.setOnStatusChange(opts.onStatusChange || null);
        },
    });
}

function portName(port) {
    return port ? port.name : '(none)';
}

// --- Send bank to device ---

/**
 * Confirm-then-send flow for writing a 32-voice bank to the device.
 *
 * @param {Array} patches  patches with voice_data, in slot order
 * @param {string} bankName
 * @param {{
 *   appendLog: function,
 *   showProgress: function,
 *   hideProgress: function,
 *   setProgressLabel: function,
 *   showError: function,
 *   onBackupReceived: function,  // (Uint8Array, string) => Promise|void
 * }} opts
 */
export async function sendBankToDevice(patches, bankName, opts) {
    const { appendLog, showProgress, hideProgress, setProgressLabel, showError, onBackupReceived } = opts;

    if (!midi.isSupported()) {
        showError('This browser has no Web MIDI support, so patches cannot be sent to a device. ' +
            'Use Export .SYX instead.');
        return;
    }

    const confirmed = await confirmSend(patches, bankName);
    if (!confirmed) return;

    // The click on "Send bank" is the user gesture the permission prompt needs.
    try {
        await midi.requestMidi({ sysex: true });
    } catch (err) {
        showError('SysEx permission is required to send patches to a device, and it was not granted. ' +
            '(' + err.message + ')');
        return;
    }

    const out = midi.getOutputPort();
    if (!out) {
        showError('No MIDI output device is selected. Open MIDI › Devices and pick one.');
        return;
    }

    // --- Backup leg. A failure here aborts the whole operation: overwriting
    // a bank we could not save a copy of is exactly the outcome the backup
    // option exists to prevent.
    if (confirmed.backup) {
        showProgress(0);
        setProgressLabel('Backing up the current bank from ' + out.name + '…');
        try {
            const bytes = await midi.receiveBank({ onProgress: showProgress });
            hideProgress();
            const name = `${out.name} backup`;
            await onBackupReceived(bytes, name);
            appendLog(`Backed up the current bank from ${out.name}`);
        } catch (err) {
            hideProgress();
            showError('Backup failed, so nothing was sent to the device — its current bank is untouched.\n\n' +
                err.message);
            appendLog(`Bank send aborted: backup failed — ${err.message}`);
            return;
        }
    }

    // --- Send leg.
    showProgress(0);
    setProgressLabel('Sending ' + bankName + ' to ' + out.name + '…');
    try {
        // The packed 4104-byte dump is built by the Phase 4 encoder; until it
        // exists there is no payload to hand the transport.
        await midi.sendBank(null, { onProgress: showProgress });
        hideProgress();
        appendLog(`Sent ${bankName} to ${out.name}`);
    } catch (err) {
        hideProgress();
        showError('Sending the bank failed.\n\n' + err.message);
        appendLog(`Bank send failed: ${err.message}`);
    }
}

// Resolves to { backup: boolean } on confirm, or null on cancel.
function confirmSend(patches, bankName) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const out = midi.getOutputPort();
        const target = out ? out.name : 'the selected MIDI device';
        const count = patches ? patches.length : 0;

        openModal('Send bank to device', (body, close) => {
            const warn = el('div', 'midi-warning');
            warn.innerHTML =
                '<strong>This overwrites all 32 voices on ' + escapeHtml(target) + '.</strong> ' +
                'A bulk dump replaces the whole bank, not just the ' + count + ' patch(es) being sent, ' +
                'and the synth has no undo.';
            body.appendChild(warn);

            const protect = el('div', 'midi-warning midi-warning-info');
            protect.innerHTML =
                '<strong>Turn memory protect off first.</strong> ' +
                'On a DX7 that is <em>Function › Memory Protect › Internal: OFF</em>. ' +
                'With protection on the synth ignores the dump silently — it will look like nothing happened.';
            body.appendChild(protect);

            const chRow = el('p', 'midi-hint',
                'Sending on device channel ' + (midi.getDeviceChannel() + 1) + '.');
            body.appendChild(chRow);

            const backupRow = el('label', 'midi-checkbox');
            const backupBox = document.createElement('input');
            backupBox.type = 'checkbox';
            backupBox.checked = true;
            backupRow.appendChild(backupBox);
            backupRow.appendChild(el('span', null,
                ' Back up the device’s current bank first (recommended)'));
            body.appendChild(backupRow);

            body.appendChild(el('div', 'midi-hint',
                'The backup is requested from the synth and saved to a new container on the canvas. ' +
                'If it fails, nothing is sent.'));

            const actions = el('div', 'midi-actions');
            const cancelBtn = el('button', 'midi-btn', 'Cancel');
            const sendBtn = el('button', 'midi-btn midi-btn-danger', 'Send bank');
            actions.appendChild(cancelBtn);
            actions.appendChild(sendBtn);
            body.appendChild(actions);

            cancelBtn.addEventListener('click', () => { finish(null); close(); });
            sendBtn.addEventListener('click', () => {
                finish({ backup: backupBox.checked });
                close();
            });
        }, { onClose: () => finish(null) });
    });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
