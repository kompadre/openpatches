// Pianoroll: 3 octaves (C3–C6) × 1 measure of 4/4 (16 sixteenth notes)
// Click+drag creates notes, double-click removes, sequencer plays all notes.
// Notes reference VoiceBank slot index. Data looked up via getSlotData(slot).

const NOTES = [
    { midi: 84, name: 'C6',  white: true },
    { midi: 83, name: 'B5',  white: true },
    { midi: 82, name: 'A#5', white: false },
    { midi: 81, name: 'A5',  white: true },
    { midi: 80, name: 'G#5', white: false },
    { midi: 79, name: 'G5',  white: true },
    { midi: 78, name: 'F#5', white: false },
    { midi: 77, name: 'F5',  white: true },
    { midi: 76, name: 'E5',  white: true },
    { midi: 75, name: 'D#5', white: false },
    { midi: 74, name: 'D5',  white: true },
    { midi: 73, name: 'C#5', white: false },
    { midi: 72, name: 'C5',  white: true },
    { midi: 71, name: 'B4',  white: true },
    { midi: 70, name: 'A#4', white: false },
    { midi: 69, name: 'A4',  white: true },
    { midi: 68, name: 'G#4', white: false },
    { midi: 67, name: 'G4',  white: true },
    { midi: 66, name: 'F#4', white: false },
    { midi: 65, name: 'F4',  white: true },
    { midi: 64, name: 'E4',  white: true },
    { midi: 63, name: 'D#4', white: false },
    { midi: 62, name: 'D4',  white: true },
    { midi: 61, name: 'C#4', white: false },
    { midi: 60, name: 'C4',  white: true },
    { midi: 59, name: 'B3',  white: true },
    { midi: 58, name: 'A#3', white: false },
    { midi: 57, name: 'A3',  white: true },
    { midi: 56, name: 'G#3', white: false },
    { midi: 55, name: 'G3',  white: true },
    { midi: 54, name: 'F#3', white: false },
    { midi: 53, name: 'F3',  white: true },
    { midi: 52, name: 'E3',  white: true },
    { midi: 51, name: 'D#3', white: false },
    { midi: 50, name: 'D3',  white: true },
    { midi: 49, name: 'C#3', white: false },
    { midi: 48, name: 'C3',  white: true },
];

const COLS_PER_MEASURE = 16; // 16 sixteenth notes = 1 measure of 4/4
const ROW_H = 20;
const COL_W = 30;
const LABEL_W = 36;

const STORAGE_KEY = 'openpatches_pianoroll';
const DEFAULT_BPM = 120;
const DEFAULT_COLORS = ['#e94560', '#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4', '#ff5722', '#607d8b'];

export function createPianoroll(opts) {
    const { playNoteFn, onNotesChange, onClear } = opts;
    const notes = [];
    let measures = 1;
    const CANVAS_H = NOTES.length * ROW_H;
    let looping = false;

    function totalCols() { return measures * COLS_PER_MEASURE; }
    function gridWidth() { return totalCols() * COL_W; }
    function baseWidth() { return LABEL_W + gridWidth(); }
    function canvasWidth() { return looping ? LABEL_W + gridWidth() * 2 : baseWidth(); }

    // --- Helpers to look up voice bank data by slot ---
    function getSlotData(slot) {
        if (opts.getSlotData) return opts.getSlotData(slot);
        return null;
    }

    function slotColor(slot) {
        const entry = getSlotData(slot);
        if (entry && entry.color) return entry.color;
        return DEFAULT_COLORS[slot % DEFAULT_COLORS.length];
    }

    function slotName(slot) {
        const entry = getSlotData(slot);
        return entry ? entry.name : 'Slot ' + slot;
    }

    const container = document.createElement('div');
    container.className = 'pianoroll-container';

    // Controls row
    const controls = document.createElement('div');
    controls.className = 'pianoroll-controls';

    const playBtn = document.createElement('button');
    playBtn.className = 'pianoroll-btn pianoroll-play';
    playBtn.textContent = '\u25B6 Play';
    controls.appendChild(playBtn);

    const stopBtn = document.createElement('button');
    stopBtn.className = 'pianoroll-btn pianoroll-stop';
    stopBtn.textContent = '\u25A0 Stop';
    stopBtn.disabled = true;
    controls.appendChild(stopBtn);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'pianoroll-btn';
    clearBtn.textContent = '\u{1F9F9} Clear';
    controls.appendChild(clearBtn);

    const addMeasureBtn = document.createElement('button');
    addMeasureBtn.className = 'pianoroll-btn';
    addMeasureBtn.textContent = '+ Msr';
    addMeasureBtn.title = 'Add measure';
    controls.appendChild(addMeasureBtn);

    const cloneMeasureBtn = document.createElement('button');
    cloneMeasureBtn.className = 'pianoroll-btn';
    cloneMeasureBtn.textContent = '\u29C9 Clone';
    cloneMeasureBtn.title = 'Clone last measure to new';
    controls.appendChild(cloneMeasureBtn);

    const removeMeasureBtn = document.createElement('button');
    removeMeasureBtn.className = 'pianoroll-btn';
    removeMeasureBtn.textContent = '\u2715 Msr';
    removeMeasureBtn.title = 'Remove last measure';
    removeMeasureBtn.disabled = true;
    controls.appendChild(removeMeasureBtn);

    function updateMeasureButtons() {
        removeMeasureBtn.disabled = measures <= 1;
    }

    const bpmLabel = document.createElement('span');
    bpmLabel.className = 'pianoroll-bpm-label';
    bpmLabel.textContent = 'BPM';
    controls.appendChild(bpmLabel);

    const bpmInput = document.createElement('input');
    bpmInput.type = 'number';
    bpmInput.className = 'pianoroll-bpm';
    bpmInput.value = String(DEFAULT_BPM);
    bpmInput.min = '32';
    bpmInput.max = '255';
    bpmInput.step = '1';
    controls.appendChild(bpmInput);

    const hint = document.createElement('span');
    hint.className = 'pianoroll-hint';
    hint.textContent = 'Click+drag to add notes \u00B7 Double-click to remove';
    controls.appendChild(hint);

    // --- Measure management ---
    addMeasureBtn.addEventListener('click', () => {
        measures++;
        updateMeasureButtons();
        draw();
        saveState();
    });

    cloneMeasureBtn.addEventListener('click', () => {
        const offset = (measures - 1) * COLS_PER_MEASURE;
        const cloned = notes
            .filter(n => n.start >= offset && n.start < offset + COLS_PER_MEASURE)
            .map(n => ({ midi: n.midi, start: n.start + COLS_PER_MEASURE, dur: n.dur, slot: n.slot }));
        measures++;
        notes.push(...cloned);
        updateMeasureButtons();
        draw();
        renderLegend();
        onNotesChange();
        saveState();
    });

    removeMeasureBtn.addEventListener('click', () => {
        if (measures <= 1) return;
        const cutoff = (measures - 1) * COLS_PER_MEASURE;
        for (let i = notes.length - 1; i >= 0; i--) {
            if (notes[i].start >= cutoff) notes.splice(i, 1);
        }
        measures--;
        updateMeasureButtons();
        draw();
        renderLegend();
        onNotesChange();
        saveState();
    });

    container.appendChild(controls);

    // Scrollable canvas area
    const scroll = document.createElement('div');
    scroll.className = 'pianoroll-scroll';

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth();
    canvas.height = CANVAS_H;
    canvas.className = 'pianoroll-canvas';
    scroll.appendChild(canvas);
    container.appendChild(scroll);

    // Legend
    const legend = document.createElement('div');
    legend.className = 'pianoroll-legend';
    container.appendChild(legend);

    const ctx = canvas.getContext('2d');
    let playing = false;
    let playTimer = null;
    let playCol = -1;
    let dragging = false;
    let dragStart = null;

    // Note move/resize state
    let movingNote = null;
    let resizingNote = null;
    let resizeSide = null; // 'left' or 'right'
    let moveStartPos = null;
    let moveOriginal = null;
    let moveCommitted = false;

    const MOVE_THRESHOLD = 5;
    const RESIZE_MARGIN = 8;
    const TOUCH_RESIZE_MARGIN = 20;
    function saveState() {
        try {
            const data = {
                notes: notes.map(n => ({ midi: n.midi, start: n.start, dur: n.dur, slot: n.slot })),
                bpm: parseInt(bpmInput.value) || DEFAULT_BPM,
                measures,
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) { /* ignore */ }
    }

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
            if (data.measures && typeof data.measures === 'number' && data.measures >= 1) {
                measures = data.measures;
            }
            if (data.notes && Array.isArray(data.notes)) {
                for (const n of data.notes) {
                    if (typeof n.midi === 'number' && typeof n.start === 'number' && typeof n.dur === 'number') {
                        notes.push({ midi: n.midi, start: n.start, dur: n.dur, slot: n.slot != null ? n.slot : 0 });
                    }
                }
            }
            if (data.bpm) bpmInput.value = String(Math.max(32, Math.min(255, data.bpm)));
            updateMeasureButtons();
        } catch (e) { /* ignore */ }
    }

    // --- Drawing ---
    function resizeCanvas() {
        canvas.width = canvasWidth();
    }

    // --- Drawing helpers (parameterized by context and offset) ---

    function drawLabels(ctx) {
        ctx.font = '10px monospace';
        ctx.textBaseline = 'middle';
        for (let r = 0; r < NOTES.length; r++) {
            const y = r * ROW_H + ROW_H / 2;
            ctx.fillStyle = NOTES[r].white ? '#aaa' : '#666';
            ctx.textAlign = 'right';
            ctx.fillText(NOTES[r].name, LABEL_W - 4, y);
        }
    }

    function drawGrid(ctx, ox) {
        const cols = totalCols();
        const gridW = cols * COL_W;

        // Row backgrounds
        for (let r = 0; r < NOTES.length; r++) {
            const y = r * ROW_H;
            ctx.fillStyle = NOTES[r].white ? '#1a1a2e' : '#12121f';
            ctx.fillRect(ox + LABEL_W, y, gridW, ROW_H);
        }

        // Column lines
        for (let c = 0; c <= cols; c++) {
            const x = ox + LABEL_W + c * COL_W;
            const isMeasureStart = c % COLS_PER_MEASURE === 0;
            const isBeat = c % 4 === 0;
            ctx.strokeStyle = isMeasureStart ? '#666' : isBeat ? '#444' : '#2a2a3a';
            ctx.lineWidth = isMeasureStart ? 2 : isBeat ? 1.5 : 0.5;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, CANVAS_H);
            ctx.stroke();
        }

        // Measure numbers
        ctx.font = '9px monospace';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';
        for (let m = 0; m < measures; m++) {
            const x = ox + LABEL_W + m * COLS_PER_MEASURE * COL_W + (COLS_PER_MEASURE * COL_W) / 2;
            ctx.fillStyle = m === 0 ? '#e94560' : '#555';
            ctx.fillText(String(m + 1), x, 2);
        }

        // Row lines
        for (let r = 0; r <= NOTES.length; r++) {
            const y = r * ROW_H;
            ctx.strokeStyle = '#2a2a3a';
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(ox + LABEL_W, y);
            ctx.lineTo(ox + baseWidth(), y);
            ctx.stroke();
        }

        // Loop boundary markers
        if (looping) {
            // Start marker (left edge of first copy)
            ctx.strokeStyle = '#e94560';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(ox + LABEL_W, 0);
            ctx.lineTo(ox + LABEL_W, CANVAS_H);
            ctx.stroke();

            // End marker (right edge of first copy = left edge of second copy)
            ctx.strokeStyle = '#e94560';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(ox + baseWidth(), 0);
            ctx.lineTo(ox + baseWidth(), CANVAS_H);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    function drawNotes(ctx, ox) {
        const activeSlot = opts.activeSlot;
        for (const n of notes) {
            const r = NOTES.findIndex(nn => nn.midi === n.midi);
            if (r < 0) continue;
            const x = ox + LABEL_W + n.start * COL_W;
            const y = r * ROW_H;
            const w = n.dur * COL_W - 1;
            const isActive = activeSlot == null || n.slot === activeSlot;
            ctx.fillStyle = slotColor(n.slot);
            ctx.globalAlpha = isActive ? 0.85 : 0.25;
            ctx.fillRect(x + 1, y + 1, w, ROW_H - 2);
            ctx.globalAlpha = 1.0;
            if (isActive) {
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 0.5;
                ctx.strokeRect(x + 1, y + 1, w, ROW_H - 2);
                const handleW = Math.min(4, w / 4);
                ctx.fillStyle = 'rgba(255,255,255,0.5)';
                ctx.fillRect(x + 1, y + 1, handleW, ROW_H - 2);
                ctx.fillRect(x + w - handleW, y + 1, handleW, ROW_H - 2);
            }
        }

        // Ghost note
        if (movingNote && moveCommitted && moveOriginal) {
            const origRow = NOTES.findIndex(nn => nn.midi === moveOriginal.midi);
            if (origRow >= 0) {
                const gx = ox + LABEL_W + moveOriginal.start * COL_W;
                const gy = origRow * ROW_H;
                const gw = movingNote.dur * COL_W - 1;
                ctx.fillStyle = slotColor(movingNote.slot);
                ctx.globalAlpha = 0.12;
                ctx.fillRect(gx + 1, gy + 1, gw, ROW_H - 2);
                ctx.globalAlpha = 1.0;
                ctx.strokeStyle = 'rgba(255,255,255,0.2)';
                ctx.lineWidth = 0.5;
                ctx.setLineDash([3, 3]);
                ctx.strokeRect(gx + 1, gy + 1, gw, ROW_H - 2);
                ctx.setLineDash([]);
            }
        }

        // Playback cursor
        if (playCol >= 0) {
            const x = ox + LABEL_W + playCol * COL_W;
            ctx.fillStyle = 'rgba(255,255,255,0.15)';
            ctx.fillRect(x, 0, COL_W, CANVAS_H);
        }

        // Drag preview
        if (dragging && dragStart) {
            const cur = lastMousePos;
            if (cur) {
                const endCol = pixelToCol(cur.x);
                const endRow = pixelToRow(cur.y);
                if (endRow === dragStart.row) {
                    const minC = Math.min(dragStart.col, endCol);
                    const maxC = Math.max(dragStart.col, endCol);
                    const x = ox + LABEL_W + minC * COL_W;
                    const w = (maxC - minC + 1) * COL_W;
                    ctx.fillStyle = 'rgba(255,255,255,0.1)';
                    ctx.fillRect(x, dragStart.row * ROW_H, w, ROW_H);
                }
            }
        }
    }

    function draw() {
        resizeCanvas();
        ctx.clearRect(0, 0, canvasWidth(), CANVAS_H);

        drawLabels(ctx);
        drawGrid(ctx, 0);
        drawNotes(ctx, 0);

        if (looping) {
            drawGrid(ctx, gridWidth());
            drawNotes(ctx, gridWidth());
        }
    }

    function pixelToCol(px) {
        const col = Math.floor((px - LABEL_W) / COL_W);
        return Math.max(0, Math.min(totalCols() - 1, col % totalCols()));
    }

    function pixelToRow(py) {
        return Math.max(0, Math.min(NOTES.length - 1, Math.floor(py / ROW_H)));
    }

    function noteAt(row, col) {
        const midi = NOTES[row].midi;
        return notes.find(n => n.midi === midi && col >= n.start && col < n.start + n.dur);
    }

    function activeNoteAt(row, col) {
        const midi = NOTES[row].midi;
        return notes.find(n => n.midi === midi && col >= n.start && col < n.start + n.dur
            && (opts.activeSlot == null || n.slot === opts.activeSlot));
    }

    function findInteractionTarget(x, y) {
        const row = pixelToRow(y);
        if (row < 0 || row >= NOTES.length) return null;
        const midi = NOTES[row].midi;
        const activeSlot = opts.activeSlot;

        // Proximity check for notes in this row
        const candidates = notes.filter(n => n.midi === midi && (activeSlot == null || n.slot === activeSlot));
        for (const n of candidates) {
            const startX = LABEL_W + n.start * COL_W;
            const endX = LABEL_W + (n.start + n.dur) * COL_W;
            if (Math.abs(x - endX) <= RESIZE_MARGIN) return { note: n, side: 'right' };
            if (Math.abs(x - startX) <= RESIZE_MARGIN) return { note: n, side: 'left' };
            if (x > startX && x < endX) return { note: n, side: 'move' };
        }
        return null;
    }

    let lastMousePos = null;
    let lastClickTime = 0;
    let lastClickRow = -1;
    let lastClickCol = -1;

    canvas.addEventListener('mousedown', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const row = pixelToRow(y);
        const col = pixelToCol(x);

        if (col < 0) return;

        const now = Date.now();
        const target = findInteractionTarget(x, y);

        // Double-click detection
        if (target && target.note && now - lastClickTime < 350 && row === lastClickRow && Math.abs(col - lastClickCol) <= 1) {
            const idx = notes.indexOf(target.note);
            if (idx >= 0) notes.splice(idx, 1);
            draw();
            renderLegend();
            onNotesChange();
            saveState();
            lastClickTime = 0;
            return;
        }

        lastClickTime = now;
        lastClickRow = row;
        lastClickCol = col;

        if (target) {
            if (target.side === 'left' || target.side === 'right') {
                resizingNote = target.note;
                resizeSide = target.side;
                moveStartPos = { x, y };
                moveOriginal = { start: target.note.start, dur: target.note.dur };
                moveCommitted = false;
                return;
            }
            movingNote = target.note;
            moveStartPos = { x, y };
            moveOriginal = { start: target.note.start, midi: target.note.midi, dur: target.note.dur };
            moveCommitted = false;
            return;
        }

        // Start drag to create note
        dragging = true;
        dragStart = { row, col };
        lastMousePos = { x, y };
        draw();
    });

    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        lastMousePos = { x, y };

        if (resizingNote && moveStartPos) {
            const dx = x - moveStartPos.x;
            if (!moveCommitted && Math.abs(dx) < MOVE_THRESHOLD) return;
            if (!moveCommitted) canvas.style.cursor = 'ew-resize';
            moveCommitted = true;

            const colDelta = Math.round(dx / COL_W);
            if (resizeSide === 'right') {
                resizingNote.dur = Math.max(1, moveOriginal.dur + colDelta);
            } else {
                const maxStart = moveOriginal.start + moveOriginal.dur - 1;
                const newStart = Math.max(0, Math.min(maxStart, moveOriginal.start + colDelta));
                const actualDelta = newStart - moveOriginal.start;
                resizingNote.start = newStart;
                resizingNote.dur = moveOriginal.dur - actualDelta;
            }
            draw();
            return;
        }

        if (movingNote && moveStartPos) {
            const dx = x - moveStartPos.x;
            const dy = y - moveStartPos.y;
            if (!moveCommitted && Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) {
                return;
            }
            if (!moveCommitted) {
                canvas.style.cursor = 'grabbing';
            }
            moveCommitted = true;

            const colOffset = Math.round(dx / COL_W);
            const rowOffset = Math.round(dy / ROW_H);

            const newStart = Math.max(0, Math.min(totalCols() - movingNote.dur, moveOriginal.start + colOffset));
            const newRow = Math.max(0, Math.min(NOTES.length - 1, NOTES.findIndex(nn => nn.midi === moveOriginal.midi) + rowOffset));
            const newMidi = NOTES[newRow].midi;

            movingNote.start = newStart;
            movingNote.midi = newMidi;
            draw();
            return;
        }

        if (dragging) {
            draw();
            return;
        }

        // Hover cursor
        const target = findInteractionTarget(x, y);
        if (target) {
            if (target.side === 'left' || target.side === 'right') {
                canvas.style.cursor = 'ew-resize';
            } else {
                canvas.style.cursor = 'grab';
            }
        } else {
            canvas.style.cursor = 'crosshair';
        }
    });

    canvas.addEventListener('mouseup', (e) => {
        canvas.style.cursor = '';

        if (resizingNote) {
            if (moveCommitted) {
                draw();
                onNotesChange();
                saveState();
            } else {
                // Click preview
                const entry = getSlotData(resizingNote.slot);
                const voiceData = entry ? entry.voiceData : null;
                const bpm = Math.max(32, Math.min(255, parseInt(bpmInput.value) || 120));
                const msPerSixteenth = 60000 / bpm / 4;
                playNoteFn(resizingNote.midi, resizingNote.dur * msPerSixteenth, voiceData, resizingNote.slot);
            }
            resizingNote = null;
            resizeSide = null;
            moveStartPos = null;
            moveOriginal = null;
            moveCommitted = false;
            return;
        }

        if (movingNote) {
            if (moveCommitted) {
                draw();
                renderLegend();
                onNotesChange();
                saveState();
            } else {
                // Click preview — look up voice data from slot
                const entry = getSlotData(movingNote.slot);
                const voiceData = entry ? entry.voiceData : null;
                const bpm = Math.max(32, Math.min(255, parseInt(bpmInput.value) || 120));
                const msPerSixteenth = 60000 / bpm / 4;
                playNoteFn(movingNote.midi, movingNote.dur * msPerSixteenth, voiceData, movingNote.slot);
            }
            movingNote = null;
            moveStartPos = null;
            moveOriginal = null;
            moveCommitted = false;
            return;
        }

        if (!dragging || !dragStart) {
            dragging = false;
            return;
        }

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const endCol = pixelToCol(x);
        const endRow = pixelToRow(y);

        if (endRow === dragStart.row) {
            const minC = Math.min(dragStart.col, endCol);
            const maxC = Math.max(dragStart.col, endCol);
            const dur = maxC - minC + 1;
            const midi = NOTES[dragStart.row].midi;

            const slot = opts.activeSlot != null ? opts.activeSlot : 0;
            notes.push({
                midi,
                start: minC,
                dur,
                slot,
            });
            draw();
            renderLegend();
            onNotesChange();
            saveState();
        }

        dragging = false;
        dragStart = null;
        lastMousePos = null;
        draw();
    });

    canvas.addEventListener('mouseleave', () => {
        canvas.style.cursor = '';
        if (resizingNote && moveOriginal) {
            resizingNote.dur = moveOriginal.dur;
            resizingNote.start = moveOriginal.start;
            resizingNote = null;
            resizeSide = null;
            moveStartPos = null;
            moveOriginal = null;
            moveCommitted = false;
            draw();
        }
        if (movingNote && moveOriginal) {
            movingNote.start = moveOriginal.start;
            movingNote.midi = moveOriginal.midi;
            movingNote = null;
            moveStartPos = null;
            moveOriginal = null;
            moveCommitted = false;
            draw();
        }
        if (dragging) {
            dragging = false;
            dragStart = null;
            lastMousePos = null;
            draw();
        }
    });

    // --- Touch events for mobile ---
    function findInteractionTargetTouch(x, y) {
        const row = pixelToRow(y);
        if (row < 0 || row >= NOTES.length) return null;
        const midi = NOTES[row].midi;
        const activeSlot = opts.activeSlot;
        const candidates = notes.filter(n => n.midi === midi && (activeSlot == null || n.slot === activeSlot));
        for (const n of candidates) {
            const startX = LABEL_W + n.start * COL_W;
            const endX = LABEL_W + (n.start + n.dur) * COL_W;
            if (Math.abs(x - endX) <= TOUCH_RESIZE_MARGIN) return { note: n, side: 'right' };
            if (Math.abs(x - startX) <= TOUCH_RESIZE_MARGIN) return { note: n, side: 'left' };
            if (x > startX && x < endX) return { note: n, side: 'move' };
        }
        return null;
    }

    let lastTapTime = 0;

    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const touch = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;
        const row = pixelToRow(y);
        const col = pixelToCol(x);

        if (col < 0) return;

        const now = Date.now();
        const target = findInteractionTargetTouch(x, y);

        // Double-tap detection
        if (target && target.note && now - lastTapTime < 400 && row === lastClickRow && Math.abs(col - lastClickCol) <= 1) {
            const idx = notes.indexOf(target.note);
            if (idx >= 0) notes.splice(idx, 1);
            draw();
            renderLegend();
            onNotesChange();
            saveState();
            lastTapTime = 0;
            return;
        }
        lastTapTime = now;
        lastClickRow = row;
        lastClickCol = col;

        if (target) {
            if (target.side === 'left' || target.side === 'right') {
                resizingNote = target.note;
                resizeSide = target.side;
                moveStartPos = { x, y };
                moveOriginal = { start: target.note.start, dur: target.note.dur };
                moveCommitted = false;
                return;
            }
            movingNote = target.note;
            moveStartPos = { x, y };
            moveOriginal = { start: target.note.start, midi: target.note.midi, dur: target.note.dur };
            moveCommitted = false;
            return;
        }

        // Start drag to create note
        dragging = true;
        dragStart = { row, col };
        lastMousePos = { x, y };
        draw();
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const touch = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;
        lastMousePos = { x, y };

        if (resizingNote && moveStartPos) {
            const dx = x - moveStartPos.x;
            if (!moveCommitted && Math.abs(dx) < MOVE_THRESHOLD) return;
            moveCommitted = true;
            const colDelta = Math.round(dx / COL_W);
            if (resizeSide === 'right') {
                resizingNote.dur = Math.max(1, moveOriginal.dur + colDelta);
            } else {
                const maxStart = moveOriginal.start + moveOriginal.dur - 1;
                const newStart = Math.max(0, Math.min(maxStart, moveOriginal.start + colDelta));
                const actualDelta = newStart - moveOriginal.start;
                resizingNote.start = newStart;
                resizingNote.dur = moveOriginal.dur - actualDelta;
            }
            draw();
            return;
        }

        if (movingNote && moveStartPos) {
            const dx = x - moveStartPos.x;
            const dy = y - moveStartPos.y;
            if (!moveCommitted && Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return;
            moveCommitted = true;
            const colOffset = Math.round(dx / COL_W);
            const rowOffset = Math.round(dy / ROW_H);
            const newStart = Math.max(0, Math.min(totalCols() - movingNote.dur, moveOriginal.start + colOffset));
            const newRow = Math.max(0, Math.min(NOTES.length - 1, NOTES.findIndex(nn => nn.midi === moveOriginal.midi) + rowOffset));
            movingNote.start = newStart;
            movingNote.midi = NOTES[newRow].midi;
            draw();
            return;
        }

        if (dragging) {
            draw();
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
        e.preventDefault();

        if (resizingNote) {
            if (moveCommitted) {
                draw();
                onNotesChange();
                saveState();
            }
            resizingNote = null;
            resizeSide = null;
            moveStartPos = null;
            moveOriginal = null;
            moveCommitted = false;
            return;
        }

        if (movingNote) {
            if (moveCommitted) {
                draw();
                renderLegend();
                onNotesChange();
                saveState();
            }
            movingNote = null;
            moveStartPos = null;
            moveOriginal = null;
            moveCommitted = false;
            return;
        }

        if (!dragging || !dragStart) {
            dragging = false;
            return;
        }

        const endCol = lastMousePos ? pixelToCol(lastMousePos.x) : dragStart.col;
        const endRow = lastMousePos ? pixelToRow(lastMousePos.y) : dragStart.row;

        if (endRow === dragStart.row) {
            const minC = Math.min(dragStart.col, endCol);
            const maxC = Math.max(dragStart.col, endCol);
            const dur = maxC - minC + 1;
            const midi = NOTES[dragStart.row].midi;
            const slot = opts.activeSlot != null ? opts.activeSlot : 0;
            notes.push({ midi, start: minC, dur, slot });
            draw();
            renderLegend();
            onNotesChange();
            saveState();
        }

        dragging = false;
        dragStart = null;
        lastMousePos = null;
        draw();
    }, { passive: false });

    // --- Sequencer ---
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    function startPlayback() {
        if (playing) stopPlayback();
        if (notes.length === 0) return;

        playing = true;
        looping = true;
        playCol = 0;
        consecutiveErrors = 0;
        playBtn.disabled = true;
        stopBtn.disabled = false;

        const bpm = Math.max(32, Math.min(255, parseInt(bpmInput.value) || 120));
        const msPerSixteenth = 60000 / bpm / 4;
        const gw = gridWidth();

        function tick() {
            if (!playing) return;

            for (const n of notes) {
                if (n.start === playCol) {
                    try {
                        const entry = getSlotData(n.slot);
                        const voiceData = entry ? entry.voiceData : null;
                        playNoteFn(n.midi, n.dur * msPerSixteenth, voiceData, n.slot);
                        consecutiveErrors = 0;
                    } catch (e) {
                        consecutiveErrors++;
                        console.warn(`[pianoroll] Note error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, e);
                        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                            console.warn('[pianoroll] Too many errors, stopping playback');
                            stopPlayback();
                            return;
                        }
                    }
                }
            }

            draw();

            // Scroll to follow playhead
            const scrollX = LABEL_W + playCol * COL_W;
            scroll.scrollLeft = scrollX;

            // Wrap: if scroll has passed one full grid width, jump back
            if (scroll.scrollLeft >= LABEL_W + gw) {
                scroll.scrollLeft -= gw;
            }

            const current = playCol;
            playCol = (current + 1) % totalCols();

            playTimer = setTimeout(tick, msPerSixteenth);
        }

        draw();
        scroll.scrollLeft = LABEL_W;
        playTimer = setTimeout(tick, msPerSixteenth);
    }

    function stopPlayback() {
        playing = false;
        looping = false;
        playCol = -1;
        if (playTimer) clearTimeout(playTimer);
        playTimer = null;
        playBtn.disabled = false;
        stopBtn.disabled = true;

        // Normalize scroll position within single copy
        scroll.scrollLeft = scroll.scrollLeft % gridWidth();
        draw();
    }

    playBtn.addEventListener('click', startPlayback);
    stopBtn.addEventListener('click', stopPlayback);
    clearBtn.addEventListener('click', () => {
        notes.length = 0;
        draw();
        renderLegend();
        onNotesChange();
        saveState();
        if (onClear) onClear();
    });

    bpmInput.addEventListener('change', saveState);

    function renderLegend() {
        legend.innerHTML = '';
        const slots = [...new Set(notes.map(n => n.slot))];
        if (slots.length === 0) {
            legend.style.display = 'none';
            return;
        }
        legend.style.display = '';
        for (const slot of slots) {
            const item = document.createElement('span');
            item.className = 'pianoroll-legend-item';
            const dot = document.createElement('span');
            dot.className = 'pianoroll-legend-dot';
            dot.style.background = slotColor(slot);
            item.appendChild(dot);
            const name = document.createElement('span');
            name.textContent = slotName(slot);
            item.appendChild(name);
            legend.appendChild(item);
        }
    }

    // Load persisted state
    loadState();
    draw();
    renderLegend();

    return {
        element: container,
        draw,
        startPlayback,
        stopPlayback,
        isPlaying() { return playing; },
        setActiveSlot(slot) {
            opts.activeSlot = slot;
            draw();
        },
        addNote({ midi, start, dur, slot }) {
            notes.push({ midi, start, dur, slot });
            draw();
            renderLegend();
            if (onNotesChange) onNotesChange();
            saveState();
            // Auto-scroll to new note only when not recording (recording interval handles scroll)
            if (!looping) this.scrollTo(start, midi);
        },
        scrollTo(col, midi) {
            const row = NOTES.findIndex(n => n.midi === midi);
            const x = LABEL_W + col * COL_W;
            const y = row >= 0 ? row * ROW_H : 0;
            if (looping) {
                scroll.scrollLeft = x;
            } else {
                scroll.scrollTo({
                    left: Math.max(0, x - scroll.clientWidth / 2),
                    top: Math.max(0, y - scroll.clientHeight / 2),
                    behavior: 'smooth',
                });
            }
        },
        scrollToCol(col) {
            if (!looping) {
                const x = LABEL_W + col * COL_W;
                scroll.scrollTo({
                    left: Math.max(0, x - scroll.clientWidth / 2),
                    behavior: 'smooth',
                });
                return;
            }
            const gw = gridWidth();
            const target = LABEL_W + (col * COL_W % gw);
            scroll.scrollLeft = target;
        },
        startRecording() {
            looping = true;
            playCol = 0;
            draw();
        },
        stopRecording() {
            looping = false;
            playCol = -1;
            scroll.scrollLeft = scroll.scrollLeft % gridWidth();
            draw();
        },
        tickRecording(col) {
            // Play notes at this column and advance playhead
            const tc = totalCols();
            const wrappedCol = ((col % tc) + tc) % tc;
            const bpm = Math.max(32, Math.min(255, parseInt(bpmInput.value) || 120));
            const msPerSixteenth = 60000 / bpm / 4;
            for (const n of notes) {
                if (n.start === wrappedCol) {
                    try {
                        const entry = getSlotData(n.slot);
                        const voiceData = entry ? entry.voiceData : null;
                        playNoteFn(n.midi, n.dur * msPerSixteenth, voiceData, n.slot);
                    } catch (e) { /* ignore */ }
                }
            }
            playCol = wrappedCol;
            draw();
        },
        getNotes() { return notes; },
        getBpm() { return parseInt(bpmInput.value) || DEFAULT_BPM; },
        renderLegend,
        saveState,
    };
}
