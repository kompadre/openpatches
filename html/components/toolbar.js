// Toolbar — bottom panel with tabs: Canvas | Piano Roll | Song | Edit | Log
// Keyboard is integrated into the Piano Roll panel.
// Replaces piano-dock.js. Pianoroll/Log logic moved here; Edit tab delegates to edit-panel.js.

import { createPianoroll } from './pianoroll.js';
import { createSongSession } from './song-session.js';
import { createSongEditor } from './song-editor.js';
import { createVoiceBank } from './voicebank.js';
import { createEditPanel } from './edit-panel.js';
// Namespaced as midiManager, not midi: `midi` is the note-number parameter
// name throughout this file and would shadow the import.
import * as midiManager from '../synth/midi-manager.js';

const logRecord = () => {};

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
    { midi: 84, name: 'C6',  white: true },
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

    const tabSong = document.createElement('button');
    tabSong.className = 'dock-tab dock-tab-song' + (effectiveInitialTab === 'song' ? ' active' : '');
    tabSong.innerHTML = '<span>🎼</span><span>Song</span>';
    tabSong.title = 'Song';

    const tabEdit = document.createElement('button');
    tabEdit.className = 'dock-tab' + (effectiveInitialTab === 'edit' ? ' active' : '');
    tabEdit.innerHTML = '<span>✏️</span><span>Edit</span>';

    const tabLog = document.createElement('button');
    tabLog.className = 'dock-tab dock-tab-log' + (effectiveInitialTab === 'log' ? ' active' : '');
    tabLog.innerHTML = '<span>📋</span><span>Log</span>';

    const tabStop = document.createElement('button');
    tabStop.className = 'dock-tab dock-tab-stop';
    tabStop.innerHTML = '<span>🔇</span><span>Mute</span>';
    tabStop.addEventListener('click', () => {
        if (opts.onEmergencyStop) opts.onEmergencyStop();
    });

    const tabCollapse = document.createElement('button');
    tabCollapse.className = 'dock-tab dock-tab-collapse';
    tabCollapse.innerHTML = '<span>▼</span>';

    tabBar.appendChild(tabCanvas);
    tabBar.appendChild(tabPianoroll);
    tabBar.appendChild(tabSong);
    tabBar.appendChild(tabEdit);
    tabBar.appendChild(tabLog);
    tabBar.appendChild(tabStop);
    if (!window.matchMedia('(max-width: 600px)').matches) {
        tabBar.appendChild(tabCollapse);
    }
    wrapper.appendChild(tabBar);

    // Panels
    const canvasPanel = document.createElement('div');
    canvasPanel.className = 'dock-panel dock-panel-canvas' + (effectiveInitialTab === 'canvas' ? ' active' : '');

    const pianorollPanel = document.createElement('div');
    pianorollPanel.className = 'dock-panel dock-panel-pianoroll' + (effectiveInitialTab === 'pianoroll' ? ' active' : '');

    const songPanel = document.createElement('div');
    songPanel.className = 'dock-panel dock-panel-song' + (effectiveInitialTab === 'song' ? ' active' : '');

    const editPanel = document.createElement('div');
    editPanel.className = 'dock-panel' + (effectiveInitialTab === 'edit' ? ' active' : '');

    const logPanel = document.createElement('div');
    logPanel.className = 'dock-panel dock-panel-log' + (effectiveInitialTab === 'log' ? ' active' : '');

    wrapper.appendChild(canvasPanel);
    wrapper.appendChild(pianorollPanel);
    wrapper.appendChild(songPanel);
    wrapper.appendChild(editPanel);
    wrapper.appendChild(logPanel);

    function activateTab(tab, panel) {
        [tabCanvas, tabPianoroll, tabSong, tabEdit, tabLog].forEach(t => t.classList.remove('active'));
        [canvasPanel, pianorollPanel, songPanel, editPanel, logPanel].forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        panel.classList.add('active');
    }

    // Desktop-only collapse: clicking active tab collapses, clicking any tab while collapsed expands
    const isDesktop = !window.matchMedia('(max-width: 600px)').matches;
    const pianoDock = document.getElementById('piano-dock');

    function collapseDock() {
        if (pianoDock) pianoDock.classList.add('collapsed');
        const pageContent = document.getElementById('page-content');
        if (pageContent) pageContent.classList.add('dock-collapsed');
    }

    function expandDock() {
        if (pianoDock) pianoDock.classList.remove('collapsed');
        const pageContent = document.getElementById('page-content');
        if (pageContent) pageContent.classList.remove('dock-collapsed');
    }

    function handleTabClick(tab, panel) {
        if (isDesktop && pianoDock && pianoDock.classList.contains('collapsed')) {
            expandDock();
        }
        activateTab(tab, panel);
    }

    tabCanvas.addEventListener('click', () => handleTabClick(tabCanvas, canvasPanel));
    tabPianoroll.addEventListener('click', () => {
        handleTabClick(tabPianoroll, pianorollPanel);
        requestAnimationFrame(positionBlackKeys);
    });
    tabSong.addEventListener('click', () => handleTabClick(tabSong, songPanel));
    tabEdit.addEventListener('click', () => handleTabClick(tabEdit, editPanel));
    tabLog.addEventListener('click', () => handleTabClick(tabLog, logPanel));
    tabCollapse.addEventListener('click', () => {
        if (pianoDock && pianoDock.classList.contains('collapsed')) {
            expandDock();
        } else {
            collapseDock();
        }
    });

    // --- VoiceBank + Pianoroll (top section) ---
    const pianorollRow = document.createElement('div');
    pianorollRow.className = 'pianoroll-row';

    const pianorollPlayFn = playNoteFn || (() => {});
    let pianorollRef = null;
    let recording = false;
    let recordStartTime = 0;
    let activeRecordSlot = 0;

    // Set once the session exists; the voice bank is built before it and
    // fires its first snapshot immediately.
    let sessionRef = null;

    /** Voice bank entries as plain JSON (typed arrays do not survive it). */
    function serializeBank(entries) {
        return (entries || []).filter(Boolean).map(e => ({
            name: e.name,
            patchId: e.patchId,
            volume: e.volume,
            voiceData: e.voiceData instanceof Uint8Array ? Array.from(e.voiceData) : e.voiceData,
        }));
    }

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
            // Keep the current song's copy of the voices current. Marked
            // 'voicebank' so the roll knows the arrangement did not change.
            if (sessionRef) {
                sessionRef.update((song) => { song.voiceBank = serializeBank(entries); }, 'voicebank');
            }
            if (pianorollRef && pianorollRef.renderLegend) pianorollRef.renderLegend();
            if (wrapper._songEditor) wrapper._songEditor.render();
            refreshVoiceSelect();
        },
    });
    // Fire initial snapshot after onSnapshot callback is wired
    if (voiceBank._notifySnapshot) voiceBank._notifySnapshot();
    pianorollRow.appendChild(voiceBank);

    // One current song, shared by the piano roll (which edits a pattern in
    // it) and the song editor (which arranges it). Runs the migration.
    const session = createSongSession();
    session.init();
    sessionRef = session;

    // Switching song restores the voices it was written for — what loading
    // from the old song bar used to do. (Project, in TODO.md, takes over
    // ownership of the voice bank and this goes with it.)
    let lastSongId = session.get().id;
    session.subscribe((ev) => {
        if (ev.kind !== 'song' || ev.songId === lastSongId) return;
        lastSongId = ev.songId;
        const bank = session.get().voiceBank;
        if (Array.isArray(bank) && bank.length > 0 && voiceBank._setEntries) {
            stopAll();
            voiceBank._setEntries(bank);
        }
    });

    pianorollRef = createPianoroll({
        session,
        playNoteFn: pianorollPlayFn,
        onNotesChange: updateHighlights,
        activeSlot: null,
        tickWorker: opts.tickWorker,
        startWorker: opts.startWorker,
        stopWorker: opts.stopWorker,
        getSlotData: (slot) => {
            const entries = voiceBank._getEntries ? voiceBank._getEntries() : [];
            return entries[slot] || null;
        },
        onClear: () => { if (voiceBank._clear) voiceBank._clear(); },
        onStopPlayback: opts.onPlaybackStop || null,
    });
    pianorollRow.appendChild(pianorollRef.element);

    // The clock. The roll made it (or was handed one); the toolbar drives
    // takes with it and the song editor draws its playhead from it.
    const transport = pianorollRef.getTransport();

    // Recording: the transport runs the clock and sounds the arrangement;
    // the toolbar only has to finalise notes held across the loop seam.
    transport.subscribe((pos) => {
        if (!pos.recording || !pos.seam) return;
        logRecord(`[record] seam at rawCol=${pos.rawCol}, finalizing ${activePresses.size} held note(s)`);
        for (const [midi, press] of [...activePresses]) {
            const mapped = transport.mapRecordColumn(press.startCol, activeRecordSlot);
            const tc = pianorollRef.totalCols ? pianorollRef.totalCols() : 16;
            const col = mapped && (mapped.fresh ? ((press.startCol % tc) + tc) % tc : mapped.patternCol);
            if (mapped && col > 0) {
                logRecord(`[record] seam-split midi=${midi} startCol=${press.startCol} endCol=${pos.rawCol}`);
                addRecordedNote(midi, press.startCol, pos.rawCol, activeRecordSlot);
                activePresses.delete(midi);
            }
        }
        if (pianorollRef.clearRecordingFlags) pianorollRef.clearRecordingFlags();
    });

    // Initialize active slot from voice bank's restored active entry
    const initActive = voiceBank._getActive ? voiceBank._getActive() : null;
    if (initActive) {
        const entries = voiceBank._getEntries ? voiceBank._getEntries() : [];
        const initSlot = entries.indexOf(initActive);
        if (initSlot >= 0) pianorollRef.setActiveSlot(initSlot);
    }
    // --- Song editor (Song tab) ---
    const songEditor = createSongEditor({
        session,
        transport,
        log: opts.appendLog || (() => {}),
        getSlotData: (slot) => {
            const entries = voiceBank._getEntries ? voiceBank._getEntries() : [];
            return entries[slot] || null;
        },
        // Opening a clip: make its voice the active one (that is what the
        // roll edits), hand the clip to the roll, show the roll.
        onOpenPattern: (clipId, trackId) => {
            const track = session.get().tracks.find(t => t.id === trackId);
            if (track && voiceBank._setActiveSlot) voiceBank._setActiveSlot(track.slot);
            pianorollRef.openClip(clipId);
            handleTabClick(tabPianoroll, pianorollPanel);
            requestAnimationFrame(positionBlackKeys);
        },
    });
    songPanel.appendChild(songEditor.element);
    // The voice bank's names and colours are read at render time; re-render
    // when they change so track heads and clips keep up.
    wrapper._session = session;
    wrapper._songEditor = songEditor;

    pianorollPanel.appendChild(pianorollRow);

    // --- Recording controls (middle section) ---
    const kbControls = document.createElement('div');
    kbControls.className = 'kb-controls';

    const btnRecord = document.createElement('button');
    btnRecord.className = 'kb-btn kb-btn-record';
    btnRecord.textContent = 'Record ●';

    // The kb-controls row above is mobile-only (hidden on desktop by CSS),
    // which is how Record disappeared from desktop. The piano roll's own
    // transport row is what desktop users see, so a second button lives
    // there; both drive the same toggleRecording() below.
    const btnRecordDesktop = document.createElement('button');
    btnRecordDesktop.className = 'pianoroll-btn pianoroll-record';
    btnRecordDesktop.textContent = '\u25CF Rec';
    btnRecordDesktop.title = 'Record from the on-screen keyboard or a MIDI controller into the piano roll';
    if (pianorollRef && pianorollRef.insertControl) pianorollRef.insertControl(btnRecordDesktop);

    function syncRecordButtons() {
        btnRecord.classList.toggle('active', recording);
        btnRecord.textContent = recording ? 'Stop ■' : 'Record ●';
        btnRecordDesktop.classList.toggle('active', recording);
        btnRecordDesktop.textContent = recording ? '\u25A0 Stop Rec' : '\u25CF Rec';
    }

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

    const btnUndo = document.createElement('button');
    btnUndo.className = 'kb-btn kb-btn-undo';
    btnUndo.textContent = '↩ Undo';

    const undoStack = [];
    const MAX_UNDO = 5;

    btnUndo.addEventListener('click', () => {
        if (undoStack.length === 0) return;
        const lastNote = undoStack.pop();
        if (pianorollRef && pianorollRef.removeNote) {
            pianorollRef.removeNote(lastNote);
        }
    });

    // MIDI input activity lamp — the only feedback that an external
    // controller is actually reaching the app.
    const midiIndicator = document.createElement('span');
    midiIndicator.className = 'kb-midi-indicator';
    midiIndicator.textContent = '◆';
    midiIndicator.title = 'MIDI input activity';
    if (!midiManager.isSupported()) midiIndicator.style.display = 'none';

    let midiFlashTimer = null;
    function flashMidiActivity() {
        midiIndicator.classList.add('active');
        clearTimeout(midiFlashTimer);
        midiFlashTimer = setTimeout(() => midiIndicator.classList.remove('active'), 150);
    }

    kbControls.appendChild(btnUndo);
    kbControls.appendChild(btnRecord);
    kbControls.appendChild(btnPlayStop);
    kbControls.appendChild(kbVoices);
    kbControls.appendChild(midiIndicator);
    pianorollPanel.appendChild(kbControls);

    // --- Note dispatch -----------------------------------------------------
    // One entry point for every note source: the on-screen keyboard and (when
    // enabled) an external MIDI controller. Routing both through the same pair
    // is what makes recording, key highlighting and note-off bookkeeping
    // identical for the two, instead of the MIDI path reimplementing them.

    const keyElements = {};
    const activePresses = new Map(); // midi → { startCol } — recording only
    const activeSounds = new Map();  // midi → stopFn
    const heldNotes = new Set();     // midi currently down, from any source

    // performance.now() throughout, because MIDIMessageEvent.timeStamp is on
    // the same clock: an incoming note can be placed at the moment the
    // hardware sent it rather than the moment our handler happened to run.
    const now = () => performance.now();

    function colAt(when) {
        const bpm = pianorollRef && pianorollRef.getBpm ? pianorollRef.getBpm() : 120;
        const msPerSixteenth = (60000 / bpm) / 4;
        return Math.round((when - recordStartTime) / msPerSixteenth);
    }

    const LOWEST_KEY = PIANO_NOTES[0].midi;
    const HIGHEST_KEY = PIANO_NOTES[PIANO_NOTES.length - 1].midi;
    let foldWarned = false;

    // The grid only spans C2–C6, but controllers routinely play outside it.
    // Fold by octaves rather than dropping the note: a 49-key controller
    // starting at C1 would otherwise lose its whole bottom octave in silence.
    function foldIntoRange(midi) {
        let m = midi;
        while (m < LOWEST_KEY) m += 12;
        while (m > HIGHEST_KEY) m -= 12;
        if (m !== midi && !foldWarned) {
            foldWarned = true;
            logRecord(`[midi] notes outside C2-C6 are folded into range (first: ${midi} → ${m})`);
        }
        return m;
    }

    function noteOn(midi, velocity = 100, when = now()) {
        // A controller can re-send note-on for a key it never released.
        if (heldNotes.has(midi)) noteOff(midi, when);
        heldNotes.add(midi);

        const key = keyElements[midi];
        if (key) key.classList.add('pressed');

        const entries = voiceBank ? voiceBank._getEntries() : [];
        const activeEntry = entries[activeRecordSlot];
        // sustained: the 30 s here is a safety net, not a real duration, so
        // the MIDI path must not schedule a note-off that far ahead.
        const result = (playNoteFn || (() => {}))(
            midi, 30000, activeEntry ? activeEntry.voiceData : null, activeRecordSlot,
            { sustained: true, velocity });

        if (result && typeof result.then === 'function') {
            result.then(stopFn => {
                if (typeof stopFn !== 'function') return;
                // The key can be back up before the synth finishes starting.
                // Releasing immediately here is what stops a short tap during
                // audio warm-up from ringing for the full 30 s safety timeout.
                if (heldNotes.has(midi)) activeSounds.set(midi, stopFn);
                else stopFn();
            }).catch(() => {});
        } else if (typeof result === 'function') {
            activeSounds.set(midi, result);
        }

        if (recording) {
            activePresses.set(midi, { startCol: colAt(when) });
            logRecord(`[record] note-on midi=${midi} vel=${velocity} slot=${activeRecordSlot}`);
        }

        if (onNoteClick) onNoteClick(midi);
    }

    function noteOff(midi, when = now()) {
        // Not held — nothing to do. This is the guard that stops a mouse
        // sweeping across the keyboard (mouseleave fires on every key it
        // crosses) from firing note-offs that cut sequencer notes on the
        // active channel.
        if (!heldNotes.has(midi)) return;
        heldNotes.delete(midi);

        const key = keyElements[midi];
        if (key) key.classList.remove('pressed');

        const stopFn = activeSounds.get(midi);
        if (stopFn) {
            activeSounds.delete(midi);
            stopFn();
        } else if (opts.stopNoteFn) {
            // The synth never handed us a stop function; fall back to a direct
            // note-off. Only reachable for a genuinely held note now.
            opts.stopNoteFn(midi, activeRecordSlot);
        }

        if (recording && activePresses.has(midi)) {
            const press = activePresses.get(midi);
            activePresses.delete(midi);
            const endCol = colAt(when);
            logRecord(`[record] note-off midi=${midi} startCol=${press.startCol} endCol=${endCol}`);
            addRecordedNote(midi, press.startCol, endCol, activeRecordSlot);
        }
    }

    function releaseAllHeld(when = now()) {
        for (const midi of [...heldNotes]) noteOff(midi, when);
    }

    // --- External MIDI input ---

    function handleMidiMessage(e) {
        const data = e.data;
        if (!data || data.length < 2) return;
        const status = data[0];
        if (status >= 0xF0) return; // system messages carry no channel

        const type = status & 0xF0;
        const channel = status & 0x0F;
        const filter = midiManager.getInputChannel();
        if (filter >= 0 && channel !== filter) return;

        // timeStamp is 0 in some implementations; fall back to "now".
        const when = e.timeStamp > 0 ? e.timeStamp : now();

        if (type === 0x90 && data[2] > 0) {
            flashMidiActivity();
            noteOn(foldIntoRange(data[1]), data[2], when);
        } else if (type === 0x80 || (type === 0x90 && data[2] === 0)) {
            // Note-on with velocity 0 is a note-off — most controllers use
            // this form so they can stay in running status.
            flashMidiActivity();
            noteOff(foldIntoRange(data[1]), when);
        } else if (type === 0xB0 && (data[1] === 120 || data[1] === 123)) {
            releaseAllHeld(when);
        }
    }

    if (midiManager.isSupported()) midiManager.setOnMidiMessage(handleMidiMessage);

    function stopAll() {
        // Finalizes held presses into recorded notes and stops their sounds.
        releaseAllHeld();
        midiManager.releaseAllOut();
        activePresses.clear();
        activeSounds.clear();
        heldNotes.clear();
        recording = false;
        undoStack.length = 0;
        syncRecordButtons();
        btnPlayStop.textContent = 'Play ▶';
        btnPlayStop.classList.remove('active');
        // One stop: the transport owns the worker and releases the notes.
        if (pianorollRef && pianorollRef.stopRecording) pianorollRef.stopRecording();
    }

    function toggleRecording() {
        if (recording) {
            stopAll();
            return;
        }
        recording = true;
        recordStartTime = performance.now();
        syncRecordButtons();
        btnPlayStop.textContent = 'Stop ■';
        undoStack.length = 0;
        // Starting a take stops any playback first — the transport refuses
        // to run two things on one clock.
        if (pianorollRef && pianorollRef.startRecording) pianorollRef.startRecording();
    }

    btnRecord.addEventListener('click', toggleRecording);
    btnRecordDesktop.addEventListener('click', toggleRecording);

    btnPlayStop.addEventListener('click', () => {
        if (recording || (pianorollRef && pianorollRef.isPlaying && pianorollRef.isPlaying())) {
            stopAll();
        } else {
            if (pianorollRef && pianorollRef.startPlayback) {
                pianorollRef.startPlayback();
                // startPlayback is a no-op on an empty roll (and while
                // recording) — only show Stop if it actually started.
                if (pianorollRef.isPlaying && pianorollRef.isPlaying()) {
                    btnPlayStop.textContent = 'Stop ■';
                }
            }
        }
    });

    // --- Keyboard (bottom section) ---
    const kb = document.createElement('div');
    kb.className = 'keyboard';

    function addRecordedNote(midi, startCol, endCol, slot) {
        if (!pianorollRef || !pianorollRef.addNote) return;
        // Where does this column land? In song mode that depends on which
        // clip is under the playhead on this voice; with none, the note was
        // heard but there is nothing to write it into.
        const mapped = transport.mapRecordColumn(startCol, slot);
        if (!mapped) return;              // placed elsewhere: heard, not recorded
        const tc = pianorollRef.totalCols ? pianorollRef.totalCols() : 16;
        // Calculate duration from raw columns (before wrapping)
        const rawDur = Math.max(1, endCol - startCol);
        const dur = Math.min(rawDur, tc); // cap at total cols
        // `fresh` means this voice has nothing placed yet — wrap on the grid
        // and let addNote() start a track and a clip at bar 1, as before.
        const start = mapped.fresh ? ((startCol % tc) + tc) % tc : mapped.patternCol;
        const note = pianorollRef.addNote({ midi, start, dur, slot, clipId: mapped.fresh ? null : mapped.clipId });
        if (note) {
            note._recordedInSession = true;
            undoStack.push(note);
            if (undoStack.length > MAX_UNDO) undoStack.shift();
        }
    }

    const isMobileKb = window.matchMedia('(max-width: 600px)').matches;
    let kbOctave = isMobileKb ? 2 : -1; // -1 = all octaves (desktop), 2 = C3-B3

    function getKbNotes() {
        if (kbOctave < 0) return PIANO_NOTES; // desktop: all octaves
        const lo = (kbOctave + 1) * 12; // C of octave
        const hi = lo + 11;             // B of octave
        return PIANO_NOTES.filter(n => n.midi >= lo && n.midi <= hi);
    }

    function rebuildKeyboard() {
        kb.innerHTML = '';
        for (const midi of Object.keys(keyElements)) delete keyElements[midi];
        const notes = getKbNotes();
        notes.forEach(n => {
            const key = document.createElement('div');
            key.className = 'key ' + (n.white ? 'white' : 'black');
            key.title = n.name;
            if (n.white) key.textContent = n.name;

            function handleStart(e) {
                if (e.type === 'mousedown' && e.button !== 0) return;
                e.preventDefault();
                noteOn(n.midi);
            }

            // noteOff ignores keys that are not held, so mouseleave is safe to
            // wire unconditionally — sweeping across the keyboard no longer
            // emits note-offs for keys that were never pressed.
            function handleEnd(e) {
                e.preventDefault();
                noteOff(n.midi);
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
        positionBlackKeys();
    }

    rebuildKeyboard();

    // Collapsible: the keys and the octave row sit in a wrapper that a thin
    // header bar toggles. The wrapper is what gets hidden — the mobile
    // stylesheet forces `.keyboard` to display:flex !important, so hiding
    // the keyboard element itself would not take.
    const KB_COLLAPSED_KEY = 'openpatches_kb_collapsed';
    const kbWrapper = document.createElement('div');
    kbWrapper.className = 'keyboard-wrapper';

    const kbToggle = document.createElement('button');
    kbToggle.className = 'kb-toggle';
    kbToggle.title = 'Show or hide the on-screen keyboard';

    function setKeyboardCollapsed(collapsed, { persist = true } = {}) {
        kbWrapper.classList.toggle('collapsed', collapsed);
        kbToggle.classList.toggle('collapsed', collapsed);
        kbToggle.textContent = (collapsed ? '\u25B8' : '\u25BE') + ' Keyboard';
        kbToggle.setAttribute('aria-expanded', String(!collapsed));
        if (persist) {
            try { localStorage.setItem(KB_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* private mode */ }
        }
        // Black keys are positioned from measured widths, which are zero
        // while hidden — re-measure once the keys are visible again.
        if (!collapsed) requestAnimationFrame(positionBlackKeys);
    }
    kbToggle.addEventListener('click', () => {
        setKeyboardCollapsed(!kbWrapper.classList.contains('collapsed'));
    });

    pianorollPanel.appendChild(kbToggle);
    kbWrapper.appendChild(kb);
    pianorollPanel.appendChild(kbWrapper);

    // Octave selector (mobile)
    let octaveBtns = [];
    if (isMobileKb) {
        const octaveRow = document.createElement('div');
        octaveRow.className = 'kb-octave-row';
        for (let i = 2; i <= 7; i++) {
            const btn = document.createElement('button');
            btn.className = 'kb-octave-btn' + (i === kbOctave ? ' active' : '');
            btn.textContent = i;
            btn.addEventListener('click', () => {
                kbOctave = i;
                octaveBtns.forEach((b, idx) => b.classList.toggle('active', idx + 2 === i));
                rebuildKeyboard();
            });
            octaveBtns.push(btn);
            octaveRow.appendChild(btn);
        }
        kbWrapper.appendChild(octaveRow);
    }

    let kbStartCollapsed = false;
    try { kbStartCollapsed = localStorage.getItem(KB_COLLAPSED_KEY) === '1'; } catch { /* private mode */ }
    setKeyboardCollapsed(kbStartCollapsed, { persist: false });

    // Position black keys absolutely over white keys (mobile layout)
    function positionBlackKeys() {
        const isMobile = window.matchMedia('(max-width: 600px)').matches;
        if (!isMobile) {
            kb.querySelectorAll('.key.black').forEach(k => { k.style.left = ''; k.style.position = ''; });
            return;
        }
        const whiteKeys = kb.querySelectorAll('.key.white');
        const whiteKeyWidth = whiteKeys.length > 0 ? whiteKeys[0].offsetWidth : 0;
        const blackKeyWidth = 32; // matches CSS
        let whiteIdx = 0;
        const notes = getKbNotes();
        notes.forEach(n => {
            const key = keyElements[n.midi];
            if (n.white) {
                whiteIdx++;
            } else {
                const prevWhite = whiteKeys[whiteIdx - 1];
                if (prevWhite) {
                    const left = prevWhite.offsetLeft + whiteKeyWidth - blackKeyWidth / 2;
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
            if (m >= 36 && m <= 83) {
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
    wrapper._showCanvas = () => { expandDock(); activateTab(tabCanvas, canvasPanel); };
    wrapper._showPianoroll = () => { expandDock(); activateTab(tabPianoroll, pianorollPanel); };
    wrapper._showEdit = () => { expandDock(); activateTab(tabEdit, editPanel); };
    wrapper._showLog = () => { expandDock(); activateTab(tabLog, logPanel); };
    wrapper._logPanel = logPanel;
    wrapper._setKeyboardCollapsed = setKeyboardCollapsed;
    wrapper._isKeyboardCollapsed = () => kbWrapper.classList.contains('collapsed');
    return wrapper;
}
