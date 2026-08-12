// Toolbar — bottom panel with tabs: Canvas | Piano Roll | Edit | Log
// Keyboard is integrated into the Piano Roll panel.
// Replaces piano-dock.js. Pianoroll/Log logic moved here; Edit tab delegates to edit-panel.js.

import { createPianoroll } from './pianoroll.js';
import { createVoiceBank } from './voicebank.js';
import { createEditPanel } from './edit-panel.js';

const PIANO_NOTES = [
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

export function createToolbar(opts) {
    const { matchedMidi, playNoteFn, pianorollNotes, activePatchId, activeVoiceData, initialTab, onNoteClick, editOpts } = opts;

    const wrapper = document.createElement('div');
    wrapper.className = 'piano-dock-inner';

    // Resolve effective initial tab — 'keyboard' now maps to 'pianoroll'
    const effectiveInitialTab = initialTab === 'keyboard' ? 'pianoroll' : initialTab;

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'dock-tabs';

    const tabCanvas = document.createElement('button');
    tabCanvas.className = 'dock-tab dock-tab-canvas' + (effectiveInitialTab === 'canvas' ? ' active' : '');
    tabCanvas.innerHTML = '<span>🖼️</span><span>Canvas</span>';

    const tabPianoroll = document.createElement('button');
    tabPianoroll.className = 'dock-tab' + (effectiveInitialTab === 'pianoroll' ? ' active' : '');
    tabPianoroll.innerHTML = '<span>🎹</span><span>Piano Roll</span>';

    const tabEdit = document.createElement('button');
    tabEdit.className = 'dock-tab' + (effectiveInitialTab === 'edit' ? ' active' : '');
    tabEdit.innerHTML = '<span>✏️</span><span>Edit</span>';

    const tabLog = document.createElement('button');
    tabLog.className = 'dock-tab dock-tab-log' + (effectiveInitialTab === 'log' ? ' active' : '');
    tabLog.innerHTML = '<span>📋</span><span>Log</span>';

    tabBar.appendChild(tabCanvas);
    tabBar.appendChild(tabPianoroll);
    tabBar.appendChild(tabEdit);
    tabBar.appendChild(tabLog);
    wrapper.appendChild(tabBar);

    // Panels
    const canvasPanel = document.createElement('div');
    canvasPanel.className = 'dock-panel dock-panel-canvas' + (effectiveInitialTab === 'canvas' ? ' active' : '');

    const pianorollPanel = document.createElement('div');
    pianorollPanel.className = 'dock-panel dock-panel-pianoroll' + (effectiveInitialTab === 'pianoroll' ? ' active' : '');

    const editPanel = document.createElement('div');
    editPanel.className = 'dock-panel' + (effectiveInitialTab === 'edit' ? ' active' : '');

    const logPanel = document.createElement('div');
    logPanel.className = 'dock-panel dock-panel-log' + (effectiveInitialTab === 'log' ? ' active' : '');

    wrapper.appendChild(canvasPanel);
    wrapper.appendChild(pianorollPanel);
    wrapper.appendChild(editPanel);
    wrapper.appendChild(logPanel);

    function activateTab(tab, panel) {
        [tabCanvas, tabPianoroll, tabEdit, tabLog].forEach(t => t.classList.remove('active'));
        [canvasPanel, pianorollPanel, editPanel, logPanel].forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        panel.classList.add('active');
    }

    tabCanvas.addEventListener('click', () => activateTab(tabCanvas, canvasPanel));
    tabPianoroll.addEventListener('click', () => {
        activateTab(tabPianoroll, pianorollPanel);
        requestAnimationFrame(positionBlackKeys);
    });
    tabEdit.addEventListener('click', () => activateTab(tabEdit, editPanel));
    tabLog.addEventListener('click', () => activateTab(tabLog, logPanel));

    // --- VoiceBank + Pianoroll (top section) ---
    const pianorollRow = document.createElement('div');
    pianorollRow.className = 'pianoroll-row';

    const pianorollPlayFn = playNoteFn || (() => {});
    let pianorollRef = null;
    let recording = false;
    let recordStartTime = 0;
    let activeRecordSlot = 0;
    let recordInterval = null;

    const voiceSelect = document.createElement('select');
    voiceSelect.className = 'kb-voice-select';
    voiceSelect.title = 'Active voice for playback and recording';

    function refreshVoiceSelect() {
        const entries = voiceBank ? voiceBank._getEntries() : [];
        voiceSelect.innerHTML = '';
        for (let i = 0; i < 8; i++) {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = entries[i] ? (i + 1) + '. ' + entries[i].name : (i + 1) + '. —';
            voiceSelect.appendChild(opt);
        }
        voiceSelect.value = activeRecordSlot;
    }

    function updateKeyboardVoice(slot) {
        activeRecordSlot = slot;
        voiceSelect.value = slot;
    }

    const voiceBank = createVoiceBank({
        onSelect: (entry, slot) => {
            if (pianorollRef) {
                pianorollRef.setActiveSlot(slot);
            }
            updateKeyboardVoice(slot);
        },
        onVolumeChange: opts.onVolumeChange || null,
        onPreview: (entry, slot) => {
            pianorollPlayFn(60, 600, entry.voiceData, slot);
        },
        onSnapshot: (entries) => {
            if (opts.onSnapshot) opts.onSnapshot(entries);
            if (pianorollRef && pianorollRef.renderLegend) pianorollRef.renderLegend();
            refreshVoiceSelect();
        },
    });
    // Fire initial snapshot after onSnapshot callback is wired
    if (voiceBank._notifySnapshot) voiceBank._notifySnapshot();
    pianorollRow.appendChild(voiceBank);

    pianorollRef = createPianoroll({
        playNoteFn: pianorollPlayFn,
        onNotesChange: updateHighlights,
        activeSlot: null,
        getSlotData: (slot) => {
            const entries = voiceBank._getEntries ? voiceBank._getEntries() : [];
            return entries[slot] || null;
        },
        onClear: () => { if (voiceBank._clear) voiceBank._clear(); },
    });
    pianorollRow.appendChild(pianorollRef.element);

    // Initialize active slot from voice bank's restored active entry
    const initActive = voiceBank._getActive ? voiceBank._getActive() : null;
    if (initActive) {
        const entries = voiceBank._getEntries ? voiceBank._getEntries() : [];
        const initSlot = entries.indexOf(initActive);
        if (initSlot >= 0) pianorollRef.setActiveSlot(initSlot);
    }
    pianorollPanel.appendChild(pianorollRow);

    // --- Recording controls (middle section) ---
    const kbControls = document.createElement('div');
    kbControls.className = 'kb-controls';

    const btnRecord = document.createElement('button');
    btnRecord.className = 'kb-btn kb-btn-record';
    btnRecord.textContent = 'Record ●';

    const btnPlayStop = document.createElement('button');
    btnPlayStop.className = 'kb-btn kb-btn-play';
    btnPlayStop.textContent = 'Play ▶';

    const kbVoices = document.createElement('div');
    kbVoices.className = 'kb-voices';
    kbVoices.appendChild(voiceSelect);

    voiceSelect.addEventListener('change', () => {
        activeRecordSlot = parseInt(voiceSelect.value);
        if (voiceBank && voiceBank._setActiveSlot) voiceBank._setActiveSlot(activeRecordSlot);
    });

    kbControls.appendChild(btnRecord);
    kbControls.appendChild(btnPlayStop);

    const btnUndo = document.createElement('button');
    btnUndo.className = 'kb-btn kb-btn-undo';
    btnUndo.textContent = '↩ Undo';
    btnUndo.style.display = 'none';
    kbControls.appendChild(btnUndo);

    const undoStack = [];
    const MAX_UNDO = 5;

    btnUndo.addEventListener('click', () => {
        if (undoStack.length === 0) return;
        const lastNote = undoStack.pop();
        if (pianorollRef && pianorollRef.removeNote) {
            pianorollRef.removeNote(lastNote);
        }
    });

    kbControls.appendChild(kbVoices);
    pianorollPanel.appendChild(kbControls);

    function stopAll() {
        // Finalize any active presses
        for (const [midi, press] of activePresses) {
            const bpm = pianorollRef && pianorollRef.getBpm ? pianorollRef.getBpm() : 120;
            const msPerSixteenth = (60000 / bpm) / 4;
            const elapsed = Date.now() - recordStartTime;
            const endCol = Math.round(elapsed / msPerSixteenth);
            addRecordedNote(midi, press.startCol, endCol, activeRecordSlot);
        }
        activePresses.clear();
        recording = false;
        undoStack.length = 0;
        btnUndo.style.display = 'none';
        btnRecord.classList.remove('active');
        btnRecord.textContent = 'Record ●';
        btnPlayStop.textContent = 'Play ▶';
        btnPlayStop.classList.remove('active');
        if (recordInterval) { clearInterval(recordInterval); recordInterval = null; }
        if (pianorollRef && pianorollRef.stopRecording) pianorollRef.stopRecording();
        if (pianorollRef && pianorollRef.stopPlayback) pianorollRef.stopPlayback();
    }

    btnRecord.addEventListener('click', () => {
        if (recording) {
            stopAll();
        } else {
            recording = true;
            recordStartTime = Date.now();
            btnRecord.classList.add('active');
            btnRecord.textContent = 'Stop ■';
            btnPlayStop.textContent = 'Stop ■';
            btnUndo.style.display = '';
            undoStack.length = 0;
            if (pianorollRef && pianorollRef.startRecording) pianorollRef.startRecording();
            // Tick recording: play notes, move playhead, scroll, handle seam splits
            recordInterval = setInterval(() => {
                if (!recording || !pianorollRef) return;
                const bpm = pianorollRef.getBpm ? pianorollRef.getBpm() : 120;
                const msPerSixteenth = (60000 / bpm) / 4;
                const tc = pianorollRef.totalCols ? pianorollRef.totalCols() : 16;
                const elapsed = Date.now() - recordStartTime;
                const rawCol = Math.floor(elapsed / msPerSixteenth);
                const wrappedCol = ((rawCol % tc) + tc) % tc;

                // Split notes held across the loop seam
                if (wrappedCol === 0 && rawCol > 0) {
                    for (const [midi, press] of activePresses) {
                        const pressWrappedCol = ((press.startCol % tc) + tc) % tc;
                        if (pressWrappedCol > 0) {
                            // Note started before the seam — add ending at seam
                            addRecordedNote(midi, press.startCol, rawCol, activeRecordSlot);
                            // Reset press to start of new loop
                            press.startCol = rawCol;
                        }
                    }
                }

                if (pianorollRef.tickRecording) pianorollRef.tickRecording(rawCol);
                if (pianorollRef.scrollToCol) pianorollRef.scrollToCol(rawCol);
            }, 100);
        }
    });

    btnPlayStop.addEventListener('click', () => {
        if (recording || (pianorollRef && pianorollRef.isPlaying && pianorollRef.isPlaying())) {
            stopAll();
        } else {
            if (pianorollRef && pianorollRef.startPlayback) {
                pianorollRef.startPlayback();
                btnPlayStop.textContent = 'Stop ■';
            }
        }
    });

    // --- Keyboard (bottom section) ---
    const kb = document.createElement('div');
    kb.className = 'keyboard';

    const keyElements = {};
    const activePresses = new Map(); // midi → { startTime, startCol }

    function addRecordedNote(midi, startCol, endCol, slot) {
        if (!pianorollRef || !pianorollRef.addNote) return;
        const tc = pianorollRef.totalCols ? pianorollRef.totalCols() : 16;
        const s = ((startCol % tc) + tc) % tc;
        const e = ((endCol % tc) + tc) % tc;
        let dur;
        if (e > s) {
            dur = e - s;
        } else if (e === s) {
            dur = tc; // full loop
        } else {
            dur = tc - s; // wraps to end
        }
        dur = Math.max(1, dur);
        const note = pianorollRef.addNote({ midi, start: s, dur, slot });
        if (note) {
            undoStack.push(note);
            if (undoStack.length > MAX_UNDO) undoStack.shift();
        }
    }

    PIANO_NOTES.forEach(n => {
        const key = document.createElement('div');
        key.className = 'key ' + (n.white ? 'white' : 'black');
        key.title = n.name;
        if (n.white) key.textContent = n.name;

        const playFn = playNoteFn || (() => {});

        function handleStart(e) {
            if (e.type === 'mousedown' && e.button !== 0) return;
            e.preventDefault();
            key.classList.add('pressed');

            const entries = voiceBank ? voiceBank._getEntries() : [];
            const activeEntry = entries[activeRecordSlot];
            playFn(n.midi, 600, activeEntry ? activeEntry.voiceData : null, activeRecordSlot);

            if (recording) {
                const bpm = pianorollRef.getBpm ? pianorollRef.getBpm() : 120;
                const msPerSixteenth = (60000 / bpm) / 4;
                const elapsed = Date.now() - recordStartTime;
                const rawCol = Math.round(elapsed / msPerSixteenth);
                activePresses.set(n.midi, { startTime: Date.now(), startCol: rawCol });
            }

            if (onNoteClick) onNoteClick(n.midi);
        }

        function handleEnd(e) {
            e.preventDefault();
            key.classList.remove('pressed');

            if (recording && activePresses.has(n.midi)) {
                const press = activePresses.get(n.midi);
                activePresses.delete(n.midi);
                const bpm = pianorollRef.getBpm ? pianorollRef.getBpm() : 120;
                const msPerSixteenth = (60000 / bpm) / 4;
                const elapsed = Date.now() - recordStartTime;
                const endCol = Math.round(elapsed / msPerSixteenth);
                addRecordedNote(n.midi, press.startCol, endCol, activeRecordSlot);
            }
        }

        key.addEventListener('mousedown', handleStart);
        key.addEventListener('mouseup', handleEnd);
        key.addEventListener('mouseleave', handleEnd);

        key.addEventListener('touchstart', handleStart, { passive: false });
        key.addEventListener('touchend', handleEnd, { passive: false });
        key.addEventListener('touchcancel', handleEnd, { passive: false });

        keyElements[n.midi] = key;
        kb.appendChild(key);
    });

    pianorollPanel.appendChild(kb);

    // Position black keys absolutely over white keys (mobile layout)
    function positionBlackKeys() {
        const isMobile = window.matchMedia('(max-width: 600px)').matches;
        if (!isMobile) {
            kb.querySelectorAll('.key.black').forEach(k => { k.style.left = ''; k.style.position = ''; });
            return;
        }
        const whiteKeys = kb.querySelectorAll('.key.white');
        const whiteKeyWidth = whiteKeys.length > 0 ? whiteKeys[0].offsetWidth : 0;
        let whiteIdx = 0;
        PIANO_NOTES.forEach(n => {
            const key = keyElements[n.midi];
            if (n.white) {
                whiteIdx++;
            } else {
                const prevWhite = whiteKeys[whiteIdx - 1];
                if (prevWhite) {
                    const left = prevWhite.offsetLeft + whiteKeyWidth * 0.55;
                    key.style.position = 'absolute';
                    key.style.left = left + 'px';
                }
            }
        });
    }
    positionBlackKeys();
    window.addEventListener('resize', positionBlackKeys);

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

    // --- Edit panel ---
    const edit = createEditPanel(editOpts || {});
    editPanel.appendChild(edit);

    // --- Log panel ---
    const logTextarea = document.createElement('textarea');
    logTextarea.id = 'log';
    logTextarea.readOnly = true;
    logTextarea.placeholder = 'Log output will appear here...';
    logTextarea.className = 'dock-log';
    logPanel.appendChild(logTextarea);

    // Expose internals
    wrapper._updateHighlights = updateHighlights;
    wrapper._pianoroll = pianorollRef;
    wrapper._voiceBank = voiceBank;
    wrapper._showCanvas = () => activateTab(tabCanvas, canvasPanel);
    wrapper._showPianoroll = () => activateTab(tabPianoroll, pianorollPanel);
    wrapper._showEdit = () => activateTab(tabEdit, editPanel);
    wrapper._showLog = () => activateTab(tabLog, logPanel);
    wrapper._logPanel = logPanel;
    return wrapper;
}
