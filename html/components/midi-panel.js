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
import { buildBulkDump, VOICE_COUNT } from './syx-builder.js';
import { DEVICE_PROFILES, DEVICE_TYPE_AUTO, listDeviceTypes } from '../synth/midi-devices.js';

const CHANNEL_COUNT = 16;
const VOICE_BANK_SLOTS = 8;

// Output-latency calibration: a test tone every PROBE_PERIOD_MS, PROBE_MS
// long, and the indicator lit for FLASH_MS when the MIDI note-on leaves.
const PROBE_NOTE = 60;
const PROBE_MS = 150;
const PROBE_PERIOD_MS = 1000;
const FLASH_MS = 120;

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
 *
 * `playTestNote(midi, durMs)` sounds the calibration tone on the internal
 * synth and `prepareTestNote()` warms the synth up before the first tick,
 * so that tick is not late. Both are optional: without them the latency
 * control still works, there is just nothing local to compare against.
 *
 * @param {{appendLog?: function, onStatusChange?: function,
 *          playTestNote?: function, prepareTestNote?: function,
 *          testVoiceData?: Uint8Array}} opts
 */
export function openMidiSettings(opts = {}) {
    const appendLog = opts.appendLog || (() => {});
    let stopCalibration = () => {};

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
        const inputChSel = el('select', 'midi-select');
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
        deviceArea.appendChild(labelled('Input channel', inputChSel,
            'Notes are recorded to the voice slot selected in the piano roll, whichever channel they arrive on.'));
        deviceArea.appendChild(labelled('Output', outputSel, 'Used to play the piano roll on external gear.'));
        deviceArea.appendChild(labelled('Device channel', channelSel, 'Basic channel of the synth, for bulk SysEx dumps.'));

        // --- Device type ---
        // Picks the profile that shapes bank transfers (dump request or
        // front panel, backup possible or not, memory protect) and the
        // hints shown around them. Auto follows the output port's name.
        const typeSel = el('select', 'midi-select midi-device-type');
        for (const id of listDeviceTypes()) {
            const o = el('option', null, id === DEVICE_TYPE_AUTO ? 'Auto-detect' : DEVICE_PROFILES[id].name);
            o.value = id;
            typeSel.appendChild(o);
        }
        const typeNotes = el('ul', 'midi-device-notes');
        const typeWrap = labelled('Device type', typeSel);
        typeWrap.appendChild(typeNotes);
        deviceArea.appendChild(typeWrap);

        function refreshDeviceType() {
            typeSel.value = midi.getDeviceType();
            const profile = midi.getDeviceProfile();
            const autoOpt = typeSel.querySelector('option');
            if (autoOpt) {
                autoOpt.textContent = midi.getDeviceType() === DEVICE_TYPE_AUTO
                    ? 'Auto-detect (' + profile.name + ')'
                    : 'Auto-detect';
            }
            typeNotes.innerHTML = '';
            for (const note of profile.notes) typeNotes.appendChild(el('li', null, note));
            typeNotes.appendChild(el('li', null, profile.sysexChannelNote));
        }
        typeSel.addEventListener('change', () => {
            midi.setDeviceType(typeSel.value);
            refreshDeviceType();
        });

        // --- Output routing ---
        const modeSel = el('select', 'midi-select');
        for (const [value, text] of [
            ['internal', 'Internal synth only'],
            ['midi', 'MIDI device only'],
            ['both', 'Both'],
        ]) {
            const o = el('option', null, text);
            o.value = value;
            modeSel.appendChild(o);
        }
        modeSel.value = midi.getOutputMode();
        modeSel.addEventListener('change', () => midi.setOutputMode(modeSel.value));
        deviceArea.appendChild(labelled('Play notes through', modeSel,
            'Applies to the piano roll and keyboard. Patch previews always use the ' +
            'internal synth — the external device has no patch loaded to preview with.'));

        const mapWrap = el('div', 'midi-field');
        mapWrap.appendChild(el('label', 'midi-label', 'Voice slot → MIDI channel'));
        const mapGrid = el('div', 'midi-slot-map');
        for (let slot = 0; slot < VOICE_BANK_SLOTS; slot++) {
            const cell = el('div', 'midi-slot-cell');
            cell.appendChild(el('span', 'midi-slot-num', String(slot + 1)));
            const sel = el('select', 'midi-select midi-select-compact');
            for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
                const o = el('option', null, String(ch + 1));
                o.value = String(ch);
                sel.appendChild(o);
            }
            sel.value = String(midi.getSlotChannel(slot));
            sel.addEventListener('change', () => midi.setSlotChannel(slot, parseInt(sel.value, 10)));
            cell.appendChild(sel);
            mapGrid.appendChild(cell);
        }
        mapWrap.appendChild(mapGrid);
        mapWrap.appendChild(el('div', 'midi-hint',
            'Defaults to slot N → channel N. A monotimbral synth will only sound the ' +
            'channel it is set to and ignores the rest, which is harmless.'));
        deviceArea.appendChild(mapWrap);

        // --- MIDI clock out ---
        // Not part of "play notes through": clocking a drum machine while
        // listening to the internal synth is an ordinary thing to want.
        const clockRow = el('label', 'midi-checkbox');
        const clockBox = document.createElement('input');
        clockBox.type = 'checkbox';
        clockBox.className = 'midi-send-clock';
        clockBox.checked = midi.getSendClock();
        clockRow.appendChild(clockBox);
        clockRow.appendChild(el('span', null, ' Send MIDI clock'));
        deviceArea.appendChild(clockRow);
        deviceArea.appendChild(el('div', 'midi-hint',
            'Drives an external sequencer or drum machine from this app\u2019s transport: ' +
            'start, stop and 24 ticks to the quarter note, at the song\u2019s tempo. ' +
            'Starting anywhere but bar 1 sends the position first, so the device picks up ' +
            'where we are. It goes out with the same output latency as the notes, so the ' +
            'device stays in step with what you hear.'));
        clockBox.addEventListener('change', () => {
            midi.setSendClock(clockBox.checked);
            appendLog(clockBox.checked ? 'MIDI clock out enabled' : 'MIDI clock out disabled');
        });

        // --- Output latency ---
        // Every MIDI note is sent this much later than the internal synth is
        // told to play it, because the local engine has buffering of its own
        // and the hardware would otherwise sound first. The right value is
        // per machine, so it is tuned here by ear and eye: a test tone
        // repeats locally, the box flashes the instant the matching note-on
        // leaves for the device, and the user slides until they coincide.
        const latWrap = el('div', 'midi-field');
        latWrap.appendChild(el('label', 'midi-label', 'Output latency'));

        const latRow = el('div', 'midi-latency-row');
        const latSlider = document.createElement('input');
        latSlider.type = 'range';
        latSlider.className = 'midi-latency-slider';
        latSlider.min = '0';
        latSlider.max = String(midi.MAX_OUTPUT_LATENCY_MS);
        latSlider.step = '1';
        const latNum = document.createElement('input');
        latNum.type = 'number';
        latNum.className = 'midi-latency-num';
        latNum.min = '0';
        latNum.max = String(midi.MAX_OUTPUT_LATENCY_MS);
        latNum.step = '1';
        const latReset = el('button', 'midi-btn midi-btn-small midi-latency-reset', 'Default');
        latReset.title = 'Back to ' + midi.DEFAULT_OUTPUT_LATENCY_MS + ' ms';
        latRow.appendChild(latSlider);
        latRow.appendChild(latNum);
        latRow.appendChild(el('span', 'midi-latency-unit', 'ms'));
        latRow.appendChild(latReset);
        latWrap.appendChild(latRow);

        function showLatency() {
            const v = String(midi.getOutputLatency());
            latSlider.value = v;
            latNum.value = v;
        }
        function applyLatency(raw) {
            const n = parseInt(raw, 10);
            if (Number.isFinite(n)) midi.setOutputLatency(n);
            showLatency();
        }
        latSlider.addEventListener('input', () => applyLatency(latSlider.value));
        latNum.addEventListener('change', () => applyLatency(latNum.value));
        latReset.addEventListener('click', () => applyLatency(midi.DEFAULT_OUTPUT_LATENCY_MS));
        showLatency();

        const calRow = el('div', 'midi-latency-cal');
        const calBtn = el('button', 'midi-btn midi-latency-start', 'Start test tone');
        const flash = el('div', 'midi-latency-flash');
        flash.appendChild(el('span', null, 'MIDI out'));
        calRow.appendChild(calBtn);
        calRow.appendChild(flash);
        latWrap.appendChild(calRow);

        latWrap.appendChild(el('div', 'midi-hint',
            'A short tone repeats once a second on the internal synth, and the same ' +
            'note goes to the device on its basic channel with the delay above. ' +
            'The box flashes at the moment the MIDI note-on leaves. Drag the slider ' +
            'until the flash lands exactly on the tone you hear from your speakers — ' +
            'the device and the internal synth are then in step. With audition on, ' +
            'the device plays the same test tone, so you can also listen for the two ' +
            'notes fusing into one.'));
        deviceArea.appendChild(latWrap);

        let calTimer = null;
        let flashTimer = null;
        let calStop = null;
        let calGen = 0;     // bumped on stop so anything in flight stays dar
        let calNote = 0;
        const calNotes = [60, 62, 63, 65];

        function calTick() {
            const gen = calGen;
            let probeNote = calNotes[calNote % 4];
            calNote++;
            console.log(probeNote, "PROBE_NOTE");
            if (opts.playTestNote) opts.playTestNote(probeNote, PROBE_MS);
            calStop = midi.playLatencyProbe(probeNote, {
                durMs: PROBE_MS,
                voiceData: opts.testVoiceData || null,
                onWire: () => {
                    if (gen !== calGen) return;
                    flash.classList.add('on');
                    clearTimeout(flashTimer);
                    flashTimer = setTimeout(() => flash.classList.remove('on'), FLASH_MS);
                },
            });
        }

        stopCalibration = () => {
            calGen++;
            if (calTimer != null) clearInterval(calTimer);
            calTimer = null;
            clearTimeout(flashTimer);
            flash.classList.remove('on');
            if (calStop) { calStop(); calStop = null; }
            calBtn.textContent = 'Start test tone';
            calBtn.classList.remove('active');
        };

        calBtn.addEventListener('click', async () => {
            if (calTimer != null) {
                stopCalibration();
                return;
            }
            const gen = calGen;
            calBtn.disabled = true;
            try {
                if (opts.prepareTestNote) await opts.prepareTestNote();
            } catch (err) {
                appendLog('Internal synth unavailable for the latency test: ' + err.message);
            }
            calBtn.disabled = false;
            // Closed (or stopped) while the synth was warming up.
            if (gen !== calGen) return;
            calBtn.textContent = 'Stop test tone';
            calBtn.classList.add('active');
            calTick();
            calTimer = setInterval(calTick, PROBE_PERIOD_MS);
        });

        // --- Live audition ---
        const audRow = el('label', 'midi-checkbox');
        const audBox = document.createElement('input');
        audBox.type = 'checkbox';
        audBox.className = 'midi-audition';
        audBox.checked = midi.getAuditionEnabled();
        audRow.appendChild(audBox);
        audRow.appendChild(el('span', null, ' Audition patches on the device'));
        deviceArea.appendChild(audRow);

        const audHint = el('div', 'midi-hint',
            'Previewing a patch loads it into the device’s edit buffer and plays it there. ' +
            'Needs SysEx permission, and overwrites whatever is in the edit buffer — ' +
            'stored patches are untouched.');
        deviceArea.appendChild(audHint);

        // Audition is remembered across reloads but the SysEx permission is
        // not, so the box can come back ticked on top of a plain grant — in
        // which case auditioning silently does nothing. Enabling MIDI now
        // asks for the right tier up front; this row is the recovery path
        // for the cases that cannot (the prompt was dismissed, or MIDI was
        // enabled before audition was switched on). Without it the only way
        // out was to untick the box and tick it again.
        const sysexRow = el('div', 'midi-sysex-warning');
        sysexRow.appendChild(el('span', null,
            'Auditioning needs SysEx permission, which this session does not have yet.'));
        const sysexBtn = el('button', 'midi-btn midi-btn-small', 'Grant SysEx');
        sysexRow.appendChild(sysexBtn);
        deviceArea.appendChild(sysexRow);

        sysexBtn.addEventListener('click', async () => {
            // The click is the user gesture the permission prompt needs.
            try {
                await midi.requestMidi({ sysex: true });
                appendLog('MIDI SysEx access granted — auditioning is live');
            } catch (err) {
                appendLog('SysEx permission was not granted: ' + err.message);
            }
            refresh();
        });

        audBox.addEventListener('change', async () => {
            if (!audBox.checked) {
                midi.setAuditionEnabled(false);
                return;
            }
            // The click is the gesture the SysEx permission prompt needs.
            try {
                await midi.requestMidi({ sysex: true });
                midi.setAuditionEnabled(true);
                appendLog('MIDI audition enabled');
            } catch (err) {
                audBox.checked = false;
                midi.setAuditionEnabled(false);
                appendLog('Audition needs SysEx permission: ' + err.message);
            }
            refresh();
        });

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

        const omni = el('option', null, 'Omni (all channels)');
        omni.value = '-1';
        inputChSel.appendChild(omni);
        for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
            const o = el('option', null, String(ch + 1));
            o.value = String(ch);
            inputChSel.appendChild(o);
        }
        inputChSel.value = String(midi.getInputChannel());
        inputChSel.addEventListener('change', () => midi.setInputChannel(parseInt(inputChSel.value, 10)));

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
            audBox.checked = midi.getAuditionEnabled();
            sysexRow.style.display = midi.auditionNeedsSysex() ? '' : 'none';
            refreshDeviceType();
            if (ready) {
                fillPorts(inputSel, midi.listInputs(), midi.getSelectedInputId(), 'None');
                fillPorts(outputSel, midi.listOutputs(), midi.getSelectedOutputId(), 'None');
            }
        }

        enableBtn.addEventListener('click', async () => {
            // Ask for the weakest tier the *remembered* settings actually
            // need. Audition is off by default, so a first-time user still
            // gets the plain prompt; someone who left it on gets a single
            // SysEx prompt instead of a plain grant that cannot audition.
            const sysex = midi.getAuditionEnabled();
            try {
                await midi.requestMidi({ sysex });
                appendLog(sysex ? 'MIDI enabled (with SysEx, for auditioning)' : 'MIDI enabled');
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
            stopCalibration();
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
    const profile = midi.getDeviceProfile();
    if (confirmed.backup) {
        showProgress(0);
        setProgressLabel('Waiting for ' + out.name + ' to send its bank…' +
            (profile.bankReceive.manualHint ? ' ' + profile.bankReceive.manualHint : ''));
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
    setProgressLabel('Sending ' + bankName + ' to ' + out.name + '… (about 1.3 s over a MIDI cable)');
    try {
        const dump = buildBulkDump(patches, { channel: midi.getDeviceChannel() });
        await midi.sendBank(dump, { onProgress: showProgress });
        hideProgress();
        appendLog(`Sent ${bankName} to ${out.name} (${patches.length} voices, ` +
            `${VOICE_COUNT - patches.length} INIT)`);
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
        const profile = midi.getDeviceProfile();
        const canBackup = profile.bankReceive.supported;

        openModal('Send bank to device', (body, close) => {
            const warn = el('div', 'midi-warning');
            warn.innerHTML =
                '<strong>This overwrites ' + escapeHtml(profile.bankSend.target) + ' on ' +
                escapeHtml(target) + '.</strong> ' +
                'A bulk dump replaces the whole bank, and the synth has no undo.' +
                (count < VOICE_COUNT
                    ? ' Only ' + count + ' patch(es) are being sent, so the remaining ' +
                      (VOICE_COUNT - count) + ' slot(s) will be filled with <em>INIT VOICE</em> — ' +
                      'whatever is in them now is erased.'
                    : '');
            body.appendChild(warn);

            // Only synths that actually have a protect switch get told to
            // flip it; on Dexed or a volca the advice would just be noise.
            if (profile.bankSend.memoryProtect) {
                const protect = el('div', 'midi-warning midi-warning-info');
                protect.innerHTML = '<strong>Memory protect.</strong> ' + escapeHtml(profile.bankSend.memoryProtect);
                body.appendChild(protect);
            }

            const chRow = el('p', 'midi-hint',
                'Sending on device channel ' + (midi.getDeviceChannel() + 1) + ' as ' + escapeHtml(profile.name) + '.');
            body.appendChild(chRow);

            const backupRow = el('label', 'midi-checkbox');
            const backupBox = document.createElement('input');
            backupBox.type = 'checkbox';
            backupBox.className = 'midi-backup-box';
            backupBox.checked = canBackup;
            backupBox.disabled = !canBackup;
            backupRow.appendChild(backupBox);
            backupRow.appendChild(el('span', null, canBackup
                ? ' Back up the device’s current bank first (recommended)'
                : ' Back up first — not possible on this device'));
            body.appendChild(backupRow);

            body.appendChild(el('div', 'midi-hint midi-backup-hint', canBackup
                ? 'The backup is requested from the synth and saved to a new container on the canvas. ' +
                  'If it fails, nothing is sent.'
                : profile.bankReceive.reason));

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
