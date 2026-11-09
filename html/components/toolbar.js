// Toolbar — bottom panel with tabs: Canvas | Piano Roll | Section | Mixer | Edit | Device | Log
// Keyboard is integrated into the Piano Roll panel.
// Replaces piano-dock.js. Pianoroll/Log logic moved here; Edit tab delegates to edit-panel.js.

import { createPianoroll } from './pianoroll.js';
import { createSectionEditor } from './section-editor.js';
import { createTransportBar } from './transport-bar.js';
import { createVoiceBank } from './voicebank.js';
import { createEditPanel } from './edit-panel.js';
import { createDevicePanel } from './device-panel.js';
import { createTracker } from './tracker.js';
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
    tabCanvas.innerHTML = '<span>🖼️</span><span>Patches</span>';
    tabCanvas.title = 'Patches';

    const tabPianoroll = document.createElement('button');
    tabPianoroll.className = 'dock-tab dock-tab-pianoroll' + (effectiveInitialTab === 'pianoroll' ? ' active' : '');
    // Named for what it edits; the component inside is still the piano roll.
    tabPianoroll.innerHTML = '<span>🎹</span><span>Pattern</span>';
    tabPianoroll.title = 'Pattern — the piano roll';

    const tabTracker = document.createElement('button');
    tabTracker.className = 'dock-tab dock-tab-tracker' + (effectiveInitialTab === 'tracker' ? ' active' : '');
    tabTracker.innerHTML = '<span>📟</span><span>Tracker</span>';
    tabTracker.title = 'Tracker — the section, row by row';

    const tabSection = document.createElement('button');
    tabSection.className = 'dock-tab dock-tab-section' + (effectiveInitialTab === 'section' ? ' active' : '');
    tabSection.innerHTML = '<span>🎼</span><span>Section</span>';
    tabSection.title = 'Section';

    const tabMixer = document.createElement('button');
    tabMixer.className = 'dock-tab dock-tab-mixer' + (effectiveInitialTab === 'mixer' ? ' active' : '');
    tabMixer.innerHTML = '<span>🎚️</span><span>Mixer</span>';
    tabMixer.title = 'Mixer';

    const tabEdit = document.createElement('button');
    tabEdit.className = 'dock-tab dock-tab-edit' + (effectiveInitialTab === 'edit' ? ' active' : '');
    tabEdit.innerHTML = '<span>✏️</span><span>Edit</span>';

    const tabDevice = document.createElement('button');
    tabDevice.className = 'dock-tab dock-tab-device' + (effectiveInitialTab === 'device' ? ' active' : '');
    tabDevice.innerHTML = '<span>🎛️</span><span>Device</span>';
    tabDevice.title = 'Device — the external MIDI synth';

    const tabLog = document.createElement('button');
    tabLog.className = 'dock-tab dock-tab-log' + (effectiveInitialTab === 'log' ? ' active' : '');
    tabLog.innerHTML = '<span>📋</span><span>Log</span>';

    const tabStop = document.createElement('button');
    tabStop.className = 'dock-tab dock-tab-stop';
    tabStop.innerHTML = '<span>🔇</span><span>Mute</span>';
    tabStop.addEventListener('click', () => {
        if (opts.onEmergencyStop) opts.onEmergencyStop();
    });

    tabBar.appendChild(tabCanvas);
    tabBar.appendChild(tabPianoroll);
    tabBar.appendChild(tabTracker);
    tabBar.appendChild(tabSection);
    tabBar.appendChild(tabMixer);
    tabBar.appendChild(tabEdit);
    tabBar.appendChild(tabDevice);
    tabBar.appendChild(tabLog);
    tabBar.appendChild(tabStop);
    // The top strip: the transport bar on the left, the tabs centred. The
    // bar is mounted once the clock exists, below.
    const dockTop = document.createElement('div');
    dockTop.className = 'dock-top';
    dockTop.appendChild(tabBar);
    wrapper.appendChild(dockTop);

    // Panels
    const canvasPanel = document.createElement('div');
    canvasPanel.className = 'dock-panel dock-panel-canvas' + (effectiveInitialTab === 'canvas' ? ' active' : '');

    const pianorollPanel = document.createElement('div');
    pianorollPanel.className = 'dock-panel dock-panel-pianoroll' + (effectiveInitialTab === 'pianoroll' ? ' active' : '');

    const trackerPanel = document.createElement('div');
    trackerPanel.className = 'dock-panel dock-panel-tracker' + (effectiveInitialTab === 'tracker' ? ' active' : '');

    const sectionPanel = document.createElement('div');
    sectionPanel.className = 'dock-panel dock-panel-section' + (effectiveInitialTab === 'section' ? ' active' : '');

    const mixerPanel = document.createElement('div');
    mixerPanel.className = 'dock-panel dock-panel-mixer' + (effectiveInitialTab === 'mixer' ? ' active' : '');

    const editPanel = document.createElement('div');
    editPanel.className = 'dock-panel' + (effectiveInitialTab === 'edit' ? ' active' : '');

    const devicePanel = document.createElement('div');
    devicePanel.className = 'dock-panel dock-panel-device' + (effectiveInitialTab === 'device' ? ' active' : '');

    const logPanel = document.createElement('div');
    logPanel.className = 'dock-panel dock-panel-log' + (effectiveInitialTab === 'log' ? ' active' : '');

    // Two layouts, decided at build time like the rest of the mobile/desktop
    // split. Mobile keeps one full-page panel per tab. Desktop keeps
    // Patches / Piano Roll as pages, puts the Section in a resizable left
    // pane (it grows downward without end, so it wants height) and houses
    // Mixer, Edit and Log in a resizable bottom pane — full-page, each of
    // them was mostly empty space.
    const isMobileLayout = window.matchMedia('(max-width: 600px)').matches;

    const mainTabs = [tabCanvas, tabPianoroll, tabTracker];
    const mainPanels = [canvasPanel, pianorollPanel, trackerPanel];
    if (isMobileLayout) {
        mainTabs.push(tabSection, tabMixer, tabEdit, tabDevice, tabLog);
        mainPanels.push(sectionPanel, mixerPanel, editPanel, devicePanel, logPanel);
    }

    // Desktop: tabs / [ left pane | centre column ( panels / bottom pane ) ].
    // `centre` is where the main panels and the bottom pane go; on mobile it
    // is simply the wrapper itself.
    let centre = wrapper;
    if (!isMobileLayout) {
        const split = document.createElement('div');
        split.className = 'dock-split';
        centre = document.createElement('div');
        centre.className = 'dock-centre';
        wrapper.appendChild(split);
        wrapper._split = split;      // the left pane is mounted here below
        split.appendChild(centre);
    }

    centre.appendChild(canvasPanel);
    centre.appendChild(pianorollPanel);
    centre.appendChild(trackerPanel);
    // Desktop: the on-screen keyboard is a strip of its own under whichever
    // main panel is showing (Patches, Pattern, Tracker), above the bottom
    // pane — not one of the pane's items. Filled further down, where the
    // keys are built. Mobile keeps it in the Pattern panel.
    //
    // The two rows share one block: `bottomCol` stacks the keyboard, the
    // pane's handle and the pane, and the collapse button runs down the
    // right of both (`bottomWrap`). Collapsed, both rows go and the button
    // is a bar across the bottom that brings them back — the pane's own
    // edge button used to vanish with it, leaving only the top tabs.
    let kbDock = null;
    let bottomWrap = null;
    let bottomCol = null;
    if (!isMobileLayout) {
        bottomWrap = document.createElement('div');
        bottomWrap.className = 'dock-bottom';
        bottomCol = document.createElement('div');
        bottomCol.className = 'dock-bottom-col';
        kbDock = document.createElement('div');
        kbDock.className = 'dock-keyboard';
        bottomCol.appendChild(kbDock);
        bottomWrap.appendChild(bottomCol);
        centre.appendChild(bottomWrap);
    }
    if (isMobileLayout) {
        centre.appendChild(sectionPanel);
        centre.appendChild(mixerPanel);
        centre.appendChild(editPanel);
        centre.appendChild(devicePanel);
        centre.appendChild(logPanel);
    }

    let trackerRef = null;      // created below, once the section editor exists
    function activateTab(tab, panel) {
        mainTabs.forEach(t => t.classList.remove('active'));
        mainPanels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        panel.classList.add('active');
        // A hidden canvas measures zero, so the tracker draws on arrival —
        // and tells the Section pane whether its viewport is on screen.
        if (trackerRef) trackerRef.setShown(panel === trackerPanel);
    }

    tabTracker.addEventListener('click', () => activateTab(tabTracker, trackerPanel));

    tabCanvas.addEventListener('click', () => activateTab(tabCanvas, canvasPanel));
    tabPianoroll.addEventListener('click', () => {
        activateTab(tabPianoroll, pianorollPanel);
        requestAnimationFrame(positionBlackKeys);
    });

    // `showSection()` reveals the Section: a tab switch on mobile, an
    // unfold of the left pane on desktop.
    let showSection;
    if (isMobileLayout) {
        tabSection.addEventListener('click', () => activateTab(tabSection, sectionPanel));
        showSection = () => activateTab(tabSection, sectionPanel);
    } else {
        // --- Left pane (desktop) ---
        // The Section editor beside the main panel, ~28% wide and draggable
        // by the handle on its right. It folds toward the left into a thin
        // vertical bookmark; the Section tab toggles it the same way.
        const LPANE_KEY = 'openpatches_lpane';
        let lpaneState = { w: 0.28, collapsed: false };
        try {
            const saved = JSON.parse(localStorage.getItem(LPANE_KEY));
            if (saved && typeof saved === 'object') lpaneState = { ...lpaneState, ...saved };
        } catch { /* corrupt state: fall back to the default */ }

        sectionPanel.className = 'lpane-content lpane-content-section';

        const lpane = document.createElement('div');
        lpane.className = 'lpane';
        const lbookmark = document.createElement('button');
        lbookmark.className = 'lpane-bookmark';
        lbookmark.innerHTML = '<span>Section</span>';
        lbookmark.title = 'Collapse/expand the Section';
        const lbody = document.createElement('div');
        lbody.className = 'lpane-body';
        lbody.appendChild(sectionPanel);
        lpane.appendChild(lbookmark);
        lpane.appendChild(lbody);
        const lhandle = document.createElement('div');
        lhandle.className = 'lpane-handle';
        lhandle.title = 'Drag to resize · double-click to collapse';
        wrapper._split.insertBefore(lhandle, centre);
        wrapper._split.insertBefore(lpane, lhandle);

        const saveLpane = () => {
            try { localStorage.setItem(LPANE_KEY, JSON.stringify(lpaneState)); } catch { /* storage full/blocked */ }
        };
        const syncLpane = () => {
            lpane.classList.toggle('collapsed', lpaneState.collapsed);
            lhandle.classList.toggle('collapsed', lpaneState.collapsed);
            tabSection.classList.toggle('active', !lpaneState.collapsed);
            lpane.style.width = lpaneState.collapsed ? '' : (lpaneState.w * 100).toFixed(1) + '%';
        };
        const setLpane = (collapsed) => { lpaneState.collapsed = collapsed; saveLpane(); syncLpane(); };
        lbookmark.addEventListener('click', () => setLpane(!lpaneState.collapsed));
        tabSection.addEventListener('click', () => setLpane(!lpaneState.collapsed));
        showSection = () => setLpane(false);

        lhandle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            lhandle.setPointerCapture(e.pointerId);
            const startX = e.clientX;
            const startW = lpane.getBoundingClientRect().width;
            const total = wrapper._split.getBoundingClientRect().width || 1;
            const onMove = (ev) => {
                lpaneState.w = Math.min(0.6, Math.max(0.15, (startW + ev.clientX - startX) / total));
                syncLpane();
            };
            const stop = () => {
                lhandle.removeEventListener('pointermove', onMove);
                saveLpane();
            };
            lhandle.addEventListener('pointermove', onMove);
            lhandle.addEventListener('pointerup', stop, { once: true });
            lhandle.addEventListener('pointercancel', stop, { once: true });
        });
        lhandle.addEventListener('dblclick', () => setLpane(true));

        syncLpane();
    }

    // `showBottom(key)` is how the rest of the app reveals Mixer / Edit /
    // Log: a tab switch on mobile, an expand-in-pane on desktop.
    let showBottom;
    if (isMobileLayout) {
        tabMixer.addEventListener('click', () => activateTab(tabMixer, mixerPanel));
        tabEdit.addEventListener('click', () => activateTab(tabEdit, editPanel));
        tabDevice.addEventListener('click', () => activateTab(tabDevice, devicePanel));
        tabLog.addEventListener('click', () => activateTab(tabLog, logPanel));
        showBottom = (key) => {
            if (key === 'mixer') activateTab(tabMixer, mixerPanel);
            else if (key === 'edit') activateTab(tabEdit, editPanel);
            else if (key === 'device') activateTab(tabDevice, devicePanel);
            else activateTab(tabLog, logPanel);
        };
    } else {
        // --- Bottom pane (desktop) ---
        // Mixer | Edit | Device | Log side by side under the main panel, ~25% tall and
        // draggable by its handle. Each item folds toward the left into a
        // thin vertical bookmark; the top tabs toggle the same items. The
        // pane as a whole collapses from the strip on its right edge, and
        // collapses itself when every item inside it is folded.
        const BPANE_KEY = 'openpatches_bpane';
        let bpaneState = { h: 0.25, paneCollapsed: false, items: { mixer: true, edit: true, device: true, log: true } };
        try {
            const saved = JSON.parse(localStorage.getItem(BPANE_KEY));
            if (saved && saved.items) bpaneState = { ...bpaneState, ...saved, items: { ...bpaneState.items, ...saved.items } };
        } catch { /* corrupt state: fall back to the default */ }

        mixerPanel.className = 'bpane-content bpane-content-mixer';
        editPanel.className = 'bpane-content bpane-content-edit';
        devicePanel.className = 'bpane-content bpane-content-device';
        logPanel.className = 'bpane-content bpane-content-log';

        const bpaneHandle = document.createElement('div');
        bpaneHandle.className = 'bpane-handle';
        bpaneHandle.title = 'Drag to resize · double-click to collapse';

        const bpane = document.createElement('div');
        bpane.className = 'bpane';

        const bottomTabs = { mixer: tabMixer, edit: tabEdit, device: tabDevice, log: tabLog };
        const bpaneItems = {};
        const makeItem = (key, label, content) => {
            const item = document.createElement('div');
            item.className = `bpane-item bpane-item-${key}`;
            const bookmark = document.createElement('button');
            bookmark.className = 'bpane-bookmark';
            bookmark.innerHTML = `<span>${label}</span>`;
            bookmark.title = `Collapse/expand ${label}`;
            bookmark.addEventListener('click', () => toggleItem(key));
            const body = document.createElement('div');
            body.className = 'bpane-body';
            body.appendChild(content);
            item.appendChild(bookmark);
            item.appendChild(body);
            bpaneItems[key] = item;
            bpane.appendChild(item);
        };
        makeItem('mixer', 'Mixer', mixerPanel);
        makeItem('edit', 'Edit', editPanel);
        makeItem('device', 'Device', devicePanel);
        makeItem('log', 'Log', logPanel);

        // Right of the keyboard and the pane, spanning both: fold them
        // away; collapsed, the same button is the bar that restores them.
        const paneCollapseBtn = document.createElement('button');
        paneCollapseBtn.className = 'bpane-pane-collapse';
        paneCollapseBtn.addEventListener('click', () => {
            if (!bpaneState.paneCollapsed) {
                bpaneState.paneCollapsed = true;
            } else {
                bpaneState.paneCollapsed = false;
                // Restoring a pane whose items are all folded would bring
                // back the keyboard alone: open the Mixer, the one that
                // matters most, as the bar below does.
                if (!Object.values(bpaneState.items).some(Boolean)) bpaneState.items.mixer = true;
            }
            saveBpane();
            syncBpane();
        });

        // Every item folded but the keyboard still up: the pane has hidden
        // itself, so a bar under the keyboard names what is down there and
        // brings back the Mixer.
        const paneRestoreBtn = document.createElement('button');
        paneRestoreBtn.className = 'bpane-restore';
        paneRestoreBtn.innerHTML = '<span>▴ Mixer · Edit · Device · Log</span>';
        paneRestoreBtn.title = 'Show the bottom pane (opens the Mixer)';
        paneRestoreBtn.addEventListener('click', () => expandItem('mixer'));

        bottomCol.appendChild(bpaneHandle);
        bottomCol.appendChild(bpane);
        bottomCol.appendChild(paneRestoreBtn);
        bottomWrap.appendChild(paneCollapseBtn);

        const saveBpane = () => {
            try { localStorage.setItem(BPANE_KEY, JSON.stringify(bpaneState)); } catch { /* storage full/blocked */ }
        };
        const syncBpane = () => {
            let anyOpen = false;
            for (const key of ['mixer', 'edit', 'device', 'log']) {
                const open = !!bpaneState.items[key];
                anyOpen = anyOpen || open;
                bpaneItems[key].classList.toggle('collapsed', !open);
                // The tab reads as "this is on screen", so pane-collapsed
                // dims all three even though the items remember their state.
                bottomTabs[key].classList.toggle('active', open && !bpaneState.paneCollapsed);
            }
            // All items folded → nothing to show → the pane folds itself.
            const paneHidden = bpaneState.paneCollapsed || !anyOpen;
            bpane.classList.toggle('collapsed', paneHidden);
            bpaneHandle.classList.toggle('collapsed', paneHidden);
            // cqh: a share of the centre column (a size container), which
            // the pane is no longer a direct child of.
            bpane.style.height = (bpaneState.h * 100).toFixed(1) + 'cqh';
            // Pane-collapsed hides the keyboard too; the button stays.
            const folded = bpaneState.paneCollapsed;
            bottomWrap.classList.toggle('collapsed', folded);
            paneCollapseBtn.innerHTML = folded ? '<span>▴ Keyboard · Mixer · Edit · Device · Log</span>' : '<span>▾</span>';
            paneCollapseBtn.title = folded ? 'Show the keyboard and the bottom pane' : 'Collapse the keyboard and the bottom pane';
            paneCollapseBtn.setAttribute('aria-expanded', String(!folded));
            paneRestoreBtn.classList.toggle('shown', !folded && !anyOpen);
        };
        const toggleItem = (key) => {
            bpaneState.items[key] = !bpaneState.items[key];
            saveBpane();
            syncBpane();
        };
        const expandItem = (key) => {
            bpaneState.items[key] = true;
            bpaneState.paneCollapsed = false;
            saveBpane();
            syncBpane();
        };
        // Top tab: reopen when hidden, toggle when the pane is on screen.
        const tabToggle = (key) => {
            if (bpaneState.paneCollapsed || !bpaneState.items[key]) expandItem(key);
            else toggleItem(key);
        };
        tabMixer.addEventListener('click', () => tabToggle('mixer'));
        tabEdit.addEventListener('click', () => tabToggle('edit'));
        tabDevice.addEventListener('click', () => tabToggle('device'));
        tabLog.addEventListener('click', () => tabToggle('log'));
        showBottom = expandItem;

        // Resize: drag the handle; the height is a fraction of the dock so
        // it survives a window resize. Double-click folds the pane.
        bpaneHandle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            bpaneHandle.setPointerCapture(e.pointerId);
            const startY = e.clientY;
            const startH = bpane.getBoundingClientRect().height;
            const total = centre.getBoundingClientRect().height || 1;
            const onMove = (ev) => {
                const h = startH + (startY - ev.clientY);
                bpaneState.h = Math.min(0.6, Math.max(0.1, h / total));
                syncBpane();
            };
            const stop = () => {
                bpaneHandle.removeEventListener('pointermove', onMove);
                saveBpane();
            };
            bpaneHandle.addEventListener('pointermove', onMove);
            bpaneHandle.addEventListener('pointerup', stop, { once: true });
            bpaneHandle.addEventListener('pointercancel', stop, { once: true });
        });
        bpaneHandle.addEventListener('dblclick', () => { bpaneState.paneCollapsed = true; saveBpane(); syncBpane(); });

        syncBpane();
    }

    // --- VoiceBank + Pianoroll (top section) ---
    const pianorollRow = document.createElement('div');
    pianorollRow.className = 'pianoroll-row';

    const pianorollPlayFn = playNoteFn || (() => {});
    let pianorollRef = null;
    let recording = false;        // a live take: the transport's clock is running
    let recordStartTime = 0;
    let stepping = false;         // a step record: the clock is stopped, see below
    let stepCol = 0;              // where the next step lands, in sixteenths from the window start
    let stepMaxDur = 0;           // the longest note of the step in progress

    let stepTimer = null;
    let takeRunning = false;      // the transport's view, for re-basing recordStartTime
    let activeRecordSlot = 0;

    // The open project, shared by the piano roll (which edits a pattern in
    // it), the Section editor (which arranges one of its sections) and the
    // Mixer (which is a view of its tracks). app.js owns it and has
    // already opened it — the store is async, so it cannot be initialised
    // from here.
    const session = opts.session;

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
        // The bank *is* the project's tracks now: it reads and writes them
        // directly, so there is no separate copy to keep in step.
        session,
        onSelect: (entry, slot) => {
            if (pianorollRef) {
                pianorollRef.setActiveSlot(slot);
            }
            if (trackerRef) trackerRef.setActiveSlot(slot);
            updateKeyboardVoice(slot);
        },
        onVolumeChange: opts.onVolumeChange || null,
        // Effect sliders, while dragging: straight to the engine. The
        // release commits to the project, which is what everyone re-reads.
        onFxLive: opts.onFxLive || null,
        onFxGlobalLive: opts.onFxGlobalLive || null,
        onPreview: (entry, slot) => {
            pianorollPlayFn(60, 600, entry.voiceData, slot);
        },
        onSnapshot: (entries) => {
            if (opts.onSnapshot) opts.onSnapshot(entries);
            if (pianorollRef && pianorollRef.renderLegend) pianorollRef.renderLegend();
            if (wrapper._sectionEditor) wrapper._sectionEditor.render();
            refreshVoiceSelect();
        },
    });
    // Fire initial snapshot after onSnapshot callback is wired
    if (voiceBank._notifySnapshot) voiceBank._notifySnapshot();
    // The bank lives in the Mixer tab — desktop and mobile alike. The
    // pattern editor reaches it through the kb-voice-select and the legend.
    mixerPanel.appendChild(voiceBank);

    // Switching project brings its own band with it. The bank re-reads the
    // tracks itself (it subscribes too); all that is needed here is to cut
    // whatever the old project's voices were still sounding.
    let lastProjectId = session.get() ? session.get().id : null;
    session.subscribe((ev) => {
        if (ev.kind !== 'project' || ev.projectId === lastProjectId) return;
        lastProjectId = ev.projectId;
        stopAll();
    });

    pianorollRef = createPianoroll({
        session,
        // The roll's Pattern select: open the clip the way the Section's
        // Open does — its voice becomes the active one, the clip's place
        // is what the pattern loop plays.
        onOpenClip: (clipId, trackId) => {
            const track = session.get().tracks.find(t => t.id === trackId);
            if (track && voiceBank._setActiveSlot) voiceBank._setActiveSlot(track.slot);
            pianorollRef.openClip(clipId);
            const clip = session.getSection().clips.find(c => c.id === clipId);
            if (clip && transport && transport.setSectionPosition) transport.setSectionPosition(clip.startCol);
        },
        playNoteFn: pianorollPlayFn,
        onNotesChange: updateHighlights,
        activeSlot: null,
        tickWorker: opts.tickWorker,
        startWorker: opts.startWorker,
        stopWorker: opts.stopWorker,
        tempoWorker: opts.tempoWorker,
        getSlotData: (slot) => {
            const entries = voiceBank._getEntries ? voiceBank._getEntries() : [];
            return entries[slot] || null;
        },
        onStopPlayback: opts.onPlaybackStop || null,
        // Play during a step record becomes a live take (the one way to
        // start a take on an empty section, which Play alone refuses).
        onBeforePlay: () => {
            if (!stepping) return false;
            startTake();
            return true;
        },
        // The step cursor dragged by its header marker: follow it, so the
        // next step lands where the playhead was put.
        onStepSeek: (col) => {
            if (stepping) stepCol = col;
        },
    });
    pianorollRow.appendChild(pianorollRef.element);

    // The clock. The roll made it (or was handed one); the toolbar drives
    // takes with it and the Section editor draws its playhead from it.
    const transport = pianorollRef.getTransport();

    // The one Play / Stop / Record / BPM, left of the tabs. Play acts on
    // the mode its switch shows: the roll's own start for the pattern (it
    // rewinds a following view), the transport's for the section. Either
    // way a press during a step record turns it into a live take. Stop
    // ends whatever is going — a take, a step record, or playback.
    const transportBar = createTransportBar({
        transport,
        session,
        onPlay: () => {
            if (stepping) { startTake(); return; }
            if (transport.getMode() === 'pattern') pianorollRef.startPlayback();
            else transport.play();
        },
        onStop: () => {
            if (recording || stepping) stopAll();
            else transport.stop();
        },
    });
    dockTop.insertBefore(transportBar.element, tabBar);
    wrapper._transportBar = transportBar;

    // Recording: the transport runs the clock and sounds the arrangement;
    // the toolbar only has to finalise notes held across the loop seam.
    transport.subscribe((pos) => {
        // The clock starting under a step record (the Section tab's Play,
        // say) ends it: the playhead takes the cursor's place.
        if (stepping && (pos.playing || pos.recording)) endStepRecord();
        // The take's time base is the moment the transport actually began
        // recording, not the moment Rec was pressed: under an external
        // clock the two can be seconds apart.
        if (pos.recording && !takeRunning) recordStartTime = performance.now();
        takeRunning = pos.recording;
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
    // Opening a clip (Section pane, Tracker ✎ → Edit): make its voice the
    // active one (that is what the roll edits), hand the clip to the roll,
    // show the roll.
    const openClipInRoll = (clipId, trackId) => {
        const track = session.get().tracks.find(t => t.id === trackId);
        if (track && voiceBank._setActiveSlot) voiceBank._setActiveSlot(track.slot);
        pianorollRef.openClip(clipId);
        activateTab(tabPianoroll, pianorollPanel);
        requestAnimationFrame(positionBlackKeys);
    };

    // --- Section editor (Section tab) ---
    const sectionEditor = createSectionEditor({
        session,
        transport,
        log: opts.appendLog || (() => {}),
        getSlotData: (slot) => {
            const entries = voiceBank._getEntries ? voiceBank._getEntries() : [];
            return entries[slot] || null;
        },
        onOpenPattern: openClipInRoll,
        // The library: open a pattern by id (the roll's own switch picks
        // the clip, placing it first if it is placed nowhere), show the tab.
        onShowPattern: (patternId) => {
            pianorollRef.switchToPattern(patternId);
            activateTab(tabPianoroll, pianorollPanel);
            requestAnimationFrame(positionBlackKeys);
        },
        // A library drag released here opens the pattern instead of placing
        // it. Only while the Pattern tab is on screen.
        // ...and released over the Tracker, it is placed on the track and
        // row under the pointer. Only while the Tracker tab is on screen.
        dropOnTracker: (x, y, patternId) => !!trackerRef && trackerPanel.classList.contains('active')
            && trackerRef.dropPattern(x, y, patternId),
        isOverPatternEditor: (x, y) => {
            if (!pianorollPanel.classList.contains('active')) return false;
            const r = pianorollRef.element.getBoundingClientRect();
            return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
        },
    });
    sectionPanel.appendChild(sectionEditor.element);
    // The voice bank's names and colours are read at render time; re-render
    // when they change so track heads and clips keep up.
    wrapper._session = session;
    wrapper._sectionEditor = sectionEditor;

    // --- Tracker (Tracker tab): the section, row by row ---
    trackerRef = createTracker({
        session,
        transport,
        log: opts.appendLog || (() => {}),
        getSlotData: (slot) => {
            const entries = voiceBank._getEntries ? voiceBank._getEntries() : [];
            return entries[slot] || null;
        },
        // A column picked here is the voice everything else follows; the
        // bank's onSelect fans it back out to the roll and the keyboard.
        onSelectTrack: (slot) => {
            if (voiceBank._setActiveSlot) voiceBank._setActiveSlot(slot);
        },
        // A note typed into the tracker is heard on its track's voice.
        playNote: (midi, slot) => pianorollPlayFn(midi, 300, null, slot),
        // ✎ → Edit opens the clip in the Pattern editor.
        onOpenPattern: openClipInRoll,
        // The Section pane outlines the rows the tracker has on screen.
        onViewport: (range) => {
            if (sectionEditor.setTrackerViewport) sectionEditor.setTrackerViewport(range);
        },
    });
    trackerPanel.appendChild(trackerRef.element);
    wrapper._tracker = trackerRef;

    pianorollPanel.appendChild(pianorollRow);

    // --- Recording controls (middle section) ---
    const kbControls = document.createElement('div');
    kbControls.className = 'kb-controls';

    // Record lives on the transport bar, on every viewport. (This row
    // used to carry a mobile twin of it, and a Play, when the only other
    // transport was the piano roll's desktop-only control row.)
    const btnRecordDesktop = document.createElement('button');
    btnRecordDesktop.className = 'transport-btn transport-record';
    btnRecordDesktop.textContent = '\u25CF Rec';
    btnRecordDesktop.title = 'Record from the on-screen keyboard or a MIDI controller into the piano roll. '
        + 'Stopped: step by step — a tap places a note of the chosen length at the cursor the moment the key goes down, '
        + 'and every further second held doubles it. For a rest, move the cursor with the « Step / Step » buttons or drag the playhead. '
        + 'Playing: a live take.';

    // The step length: how long a note the next step places (and the unit
    // further held seconds grow it by). Only shown while a step record is
    // armed — it means nothing otherwise. Inserted before the Rec button:
    // insertControl always lands right after Stop, so the row reads
    // Stop | Rec | step length.
    const STEP_LEN_KEY = 'openpatches_step_len';
    const stepLenSelect = document.createElement('select');
    stepLenSelect.className = 'transport-step-len';
    stepLenSelect.title = 'Step length: the note each step places';
    for (const [label, cols] of [['1/16', 1], ['1/8', 2], ['1/4', 4], ['1/2', 8], ['1/1', 16]]) {
        const opt = document.createElement('option');
        opt.value = cols;
        opt.textContent = label;
        stepLenSelect.appendChild(opt);
    }
    stepLenSelect.value = parseInt(localStorage.getItem(STEP_LEN_KEY)) || 1;
    stepLenSelect.style.display = 'none';
    stepLenSelect.addEventListener('change', () => {
        localStorage.setItem(STEP_LEN_KEY, stepLenSelect.value);
    });
    transportBar.insertControl(stepLenSelect);
    transportBar.insertControl(btnRecordDesktop);

    function stepLen() {
        return parseInt(stepLenSelect.value) || 1;
    }

    // Nudge the step cursor: the mobile twin of dragging the playhead by its
    // header marker, which a touch screen does badly. Only a step record has
    // a cursor to move (with the clock running the playhead is the
    // transport's), so they are disabled otherwise. Labelled "Step" so
    // neither reads as Play.
    const btnStepBack = document.createElement('button');
    btnStepBack.className = 'kb-btn kb-btn-step-nudge';
    btnStepBack.textContent = '« Step';
    btnStepBack.title = 'Move the record cursor back one step length';
    btnStepBack.disabled = true;

    const btnStepFwd = document.createElement('button');
    btnStepFwd.className = 'kb-btn kb-btn-step-nudge';
    btnStepFwd.textContent = 'Step »';
    btnStepFwd.title = 'Move the record cursor forward one step length';
    btnStepFwd.disabled = true;

    function syncRecordButtons() {
        const on = recording || stepping;
        btnRecordDesktop.classList.toggle('active', on);
        btnRecordDesktop.classList.toggle('step', stepping);   // lit but not pulsing: no clock
        btnRecordDesktop.textContent = on ? '\u25A0 Stop Rec' : '\u25CF Rec';
        stepLenSelect.style.display = stepping ? '' : 'none';
        btnStepBack.disabled = btnStepFwd.disabled = !stepping;
    }

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
    kbControls.appendChild(btnStepBack);
    kbControls.appendChild(btnStepFwd);
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
    const stepPresses = new Map();   // midi → { note|null, startTime } — step record only
    const activeSounds = new Map();  // midi → stopFn
    const heldNotes = new Set();     // midi currently down, from any source

    // performance.now() throughout, because MIDIMessageEvent.timeStamp is on
    // the same clock: an incoming note can be placed at the moment the
    // hardware sent it rather than the moment our handler happened to run.
    const now = () => performance.now();

    function colAt(when) {
        // The transport's tempo, not the project's: under an external clock
        // they differ, and the columns must match what is being heard.
        const bpm = transport && transport.getEffectiveBpm ? transport.getEffectiveBpm()
            : pianorollRef && pianorollRef.getBpm ? pianorollRef.getBpm() : 120;
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

        if (stepping) {
            stepNoteOn(midi, when);
        } else if (recording) {
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

        if (stepping && stepPresses.has(midi)) {
            stepNoteOff(midi, when);
        } else if (recording && activePresses.has(midi)) {
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
        endStepRecord();
        midiManager.releaseAllOut();
        activePresses.clear();
        activeSounds.clear();
        heldNotes.clear();
        recording = false;
        undoStack.length = 0;
        syncRecordButtons();
        // One stop: the transport owns the worker and releases the notes.
        if (pianorollRef && pianorollRef.stopRecording) pianorollRef.stopRecording();
    }

    function toggleRecording() {
        if (recording || stepping) {
            stopAll();
            return;
        }
        // Rec means two things: with the clock running, a live take from
        // the top of the window; with it stopped, a step record.
        if (transport.isRunning()) startTake();
        else startStepRecord();
    }

    function startTake() {
        endStepRecord();
        recording = true;
        recordStartTime = performance.now();
        syncRecordButtons();
        undoStack.length = 0;
        // Starting a take stops any playback first — the transport refuses
        // to run two things on one clock.
        if (pianorollRef && pianorollRef.startRecording) pianorollRef.startRecording();
    }

    // --- Step record -------------------------------------------------------
    // Rec with the clock stopped. A key going down puts a note of the chosen
    // step length (the `stepLenSelect` above, visible only here) on the grid
    // at the step cursor *at once*, and every further full second held
    // doubles it — what is on the grid when the key comes up is what is
    // kept, so the grid is the only clock to watch. There is no tap-rest:
    // every tap is a note. A rest is the cursor moved by hand — the
    // « Step / Step » buttons, or the playhead dragged in the roll
    // (`onStepSeek`). Keys down together make a chord; when the last of
    // them comes up the step is done and the cursor moves on past its
    // longest note, wrapping at the pattern's end.
    //
    // Notes go into the pattern on screen (the roll's edit target), not
    // through the take's slot mapping: the voice select and the roll can
    // disagree (a clip opened on a track whose slot holds no patch leaves
    // the record slot where it was), and a step must land where the
    // cursor is drawn. With nothing on screen the note starts a track on
    // the record slot, as a take does.

    const STEP_MS_PER_UNIT = 1000;   // each further second held doubles the note
    const STEP_GROW_INTERVAL_MS = 100;

    function startStepRecord() {
        stepping = true;
        stepCol = 0;
        stepMaxDur = 0;
        stepPresses.clear();
        undoStack.length = 0;
        // The step lands in the pattern window, exactly as a take does.
        transport.setMode('pattern');
        transport.refresh();
        syncRecordButtons();
        if (pianorollRef && pianorollRef.setStepCursor) pianorollRef.setStepCursor(stepCol);
    }

    function endStepRecord() {
        if (!stepping) return;
        stepping = false;
        stepPresses.clear();       // whatever is still held keeps its length so far
        stepMaxDur = 0;
        stopStepTimer();
        syncRecordButtons();
        if (pianorollRef && pianorollRef.setStepCursor) pianorollRef.setStepCursor(-1);
    }

    function stopStepTimer() {
        if (stepTimer) clearInterval(stepTimer);
        stepTimer = null;
    }

    function stepTotalCols() {
        return pianorollRef && pianorollRef.totalCols ? pianorollRef.totalCols() : 16;
    }

    /** Put one step length at the cursor, in the pattern on screen. */
    function addStepNote(midi) {
        if (!pianorollRef || !pianorollRef.addNote) return null;
        const t = pianorollRef.getEditTarget ? pianorollRef.getEditTarget() : null;
        const note = pianorollRef.addNote({
            midi, start: stepCol, dur: Math.min(stepLen(), stepTotalCols() - stepCol),
            slot: t ? t.slot : activeRecordSlot,
            clipId: t ? t.clipId : null,
            reveal: 'row',
        });
        if (!note) return null;
        // No echo guard (that is for a running take): a step note must
        // sound on the first pass of the take that may follow.
        undoStack.push(note);
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        return note;
    }

    /**
     * Bring a held key's note up to date at time `at`: one step length the
     * moment it went down, doubled for every full second held since, never
     * past the end of the pattern.
     */
    function syncStepNote(midi, press, at) {
        if (!press.note) return;
        const held = Math.max(0, Math.floor((at - press.startTime) / STEP_MS_PER_UNIT));
        const dur = Math.max(1, Math.min(stepLen() * (2 ** held), stepTotalCols() - press.note.start));
        if (dur !== press.note.dur && pianorollRef.setNoteDur) pianorollRef.setNoteDur(press.note, dur);
    }

    function growHeldSteps() {
        const at = now();
        for (const [midi, press] of stepPresses) syncStepNote(midi, press, at);
    }

    function stepNoteOn(midi, when) {
        // On the grid at once: the step is visible from the first instant.
        stepPresses.set(midi, { note: addStepNote(midi), startTime: when });
        if (!stepTimer) stepTimer = setInterval(growHeldSteps, STEP_GROW_INTERVAL_MS);
    }

    function stepNoteOff(midi, when) {
        const press = stepPresses.get(midi);
        stepPresses.delete(midi);
        syncStepNote(midi, press, when);
        if (press.note) stepMaxDur = Math.max(stepMaxDur, press.note.dur);
        if (stepPresses.size > 0) return;
        // Last key up: the step is done, the cursor moves past its longest
        // note. (A press that put nothing on the grid — no pattern to land
        // in — leaves the cursor where it was.)
        stopStepTimer();
        if (stepMaxDur > 0) stepCol = (stepCol + stepMaxDur) % stepTotalCols();
        stepMaxDur = 0;
        if (pianorollRef.setStepCursor) pianorollRef.setStepCursor(stepCol);
    }

    // One step length per press, wrapping at the pattern's ends the way a
    // finished step does. Not while keys are down: the step in progress would
    // land at the old column and then advance from the new one.
    function nudgeStep(dir) {
        if (!stepping || stepPresses.size > 0) return;
        const total = stepTotalCols();
        stepCol = ((stepCol + dir * stepLen()) % total + total) % total;
        if (pianorollRef.setStepCursor) pianorollRef.setStepCursor(stepCol);
    }
    btnStepBack.addEventListener('click', () => nudgeStep(-1));
    btnStepFwd.addEventListener('click', () => nudgeStep(1));

    btnRecordDesktop.addEventListener('click', toggleRecording);

    // --- Keyboard (bottom section) ---
    const kb = document.createElement('div');
    kb.className = 'keyboard';

    function addRecordedNote(midi, startCol, endCol, slot) {
        if (!pianorollRef || !pianorollRef.addNote) return;
        // Where does this column land? In section mode that depends on which
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

    const kbHome = kbDock || pianorollPanel;
    kbHome.appendChild(kbToggle);
    kbWrapper.appendChild(kb);
    kbHome.appendChild(kbWrapper);

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

    // --- Device panel: the external MIDI-out synth ---
    wrapper._devicePanel = createDevicePanel(devicePanel, {
        appendLog: opts.appendLog,
        onOpenSettings: opts.onOpenMidiSettings,
    });

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
    wrapper._showCanvas = () => { activateTab(tabCanvas, canvasPanel); };
    wrapper._showPianoroll = () => { activateTab(tabPianoroll, pianorollPanel); };
    wrapper._showEdit = () => { showBottom('edit'); };
    wrapper._showMixer = () => { showBottom('mixer'); };
    wrapper._showLog = () => { showBottom('log'); };
    wrapper._showDevice = () => { showBottom('device'); };
    wrapper._showSection = () => { showSection(); };
    wrapper._logPanel = logPanel;
    wrapper._setKeyboardCollapsed = setKeyboardCollapsed;
    wrapper._isKeyboardCollapsed = () => kbWrapper.classList.contains('collapsed');
    return wrapper;
}
