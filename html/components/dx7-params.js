// DX7 Parameter definitions, encoding/decoding, and algorithm data.
// 128-byte bulk voice format: 6 operators × 17 bytes + 26 global bytes.

export const OP_BLOCK_SIZE = 17;

// --- Per-operator read/write (opIndex 0-5 = Op6..Op1 in DX7 numbering) ---

export function readOp(bytes, opIndex) {
    const base = opIndex * OP_BLOCK_SIZE;
    const b11 = bytes[base + 11];
    const b12 = bytes[base + 12];
    const b13 = bytes[base + 13];
    const b15 = bytes[base + 15];

    return {
        r1: bytes[base], r2: bytes[base + 1], r3: bytes[base + 2], r4: bytes[base + 3],
        l1: bytes[base + 4], l2: bytes[base + 5], l3: bytes[base + 6], l4: bytes[base + 7],
        breakPoint: bytes[base + 8],
        lDepth: bytes[base + 9], rDepth: bytes[base + 10],
        lCurve: b11 & 0x03, rCurve: (b11 >> 2) & 0x03,
        rateScaling: b12 & 0x07, detune: (b12 >> 3) & 0x07,
        velSens: b13 & 0x03, amSens: (b13 >> 2) & 0x03,
        outputLevel: bytes[base + 14],
        oscMode: b15 & 0x01, freqCoarse: (b15 >> 1) & 0x1F,
        freqFine: bytes[base + 16],
    };
}

export function writeOp(bytes, opIndex, op) {
    const base = opIndex * OP_BLOCK_SIZE;
    bytes[base] = op.r1 & 0x7F;
    bytes[base + 1] = op.r2 & 0x7F;
    bytes[base + 2] = op.r3 & 0x7F;
    bytes[base + 3] = op.r4 & 0x7F;
    bytes[base + 4] = op.l1 & 0x7F;
    bytes[base + 5] = op.l2 & 0x7F;
    bytes[base + 6] = op.l3 & 0x7F;
    bytes[base + 7] = op.l4 & 0x7F;
    bytes[base + 8] = op.breakPoint & 0x7F;
    bytes[base + 9] = op.lDepth & 0x7F;
    bytes[base + 10] = op.rDepth & 0x7F;
    bytes[base + 11] = (op.lCurve & 0x03) | ((op.rCurve & 0x03) << 2);
    bytes[base + 12] = (op.rateScaling & 0x07) | ((op.detune & 0x07) << 3);
    bytes[base + 13] = (op.velSens & 0x03) | ((op.amSens & 0x03) << 2);
    bytes[base + 14] = op.outputLevel & 0x7F;
    bytes[base + 15] = (op.oscMode & 0x01) | ((op.freqCoarse & 0x1F) << 1);
    bytes[base + 16] = op.freqFine & 0x7F;
}

// --- Global read/write ---

export function readGlobal(bytes) {
    return {
        pitchR1: bytes[102], pitchR2: bytes[103], pitchR3: bytes[104], pitchR4: bytes[105],
        pitchL1: bytes[106], pitchL2: bytes[107], pitchL3: bytes[108], pitchL4: bytes[109],
        algorithm: bytes[110] & 0x1F,
        feedback: bytes[111] & 0x07,
        keySync: (bytes[111] >> 3) & 0x01,
        lfoSpeed: bytes[112], lfoDelay: bytes[113],
        lfoPmDepth: bytes[114], lfoAmd: bytes[115],
        lfoSync: bytes[116] & 0x01, lfoWaveform: (bytes[116] >> 1) & 0x07,
        lfoPmSens: bytes[117] & 0x07,
        transpose: bytes[117],
        name: String.fromCharCode(...bytes.slice(118, 128)).replace(/\0/g, ''),
    };
}

export function writeGlobal(bytes, g) {
    bytes[102] = g.pitchR1 & 0x7F; bytes[103] = g.pitchR2 & 0x7F;
    bytes[104] = g.pitchR3 & 0x7F; bytes[105] = g.pitchR4 & 0x7F;
    bytes[106] = g.pitchL1 & 0x7F; bytes[107] = g.pitchL2 & 0x7F;
    bytes[108] = g.pitchL3 & 0x7F; bytes[109] = g.pitchL4 & 0x7F;
    bytes[110] = g.algorithm & 0x1F;
    bytes[111] = (g.feedback & 0x07) | ((g.keySync & 0x01) << 3);
    bytes[112] = g.lfoSpeed & 0x7F; bytes[113] = g.lfoDelay & 0x7F;
    bytes[114] = g.lfoPmDepth & 0x7F; bytes[115] = g.lfoAmd & 0x7F;
    bytes[116] = (g.lfoSync & 0x01) | ((g.lfoWaveform & 0x07) << 1);
    bytes[117] = (g.lfoPmSens & 0x07);
    bytes[117] = g.transpose & 0x7F;
    const n = (g.name || '').padEnd(10, '\0').slice(0, 10);
    for (let i = 0; i < 10; i++) bytes[118 + i] = n.charCodeAt(i);
}

// --- Base64 helpers ---

export function decodeVoiceData(base64) {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
}

export function encodeVoiceData(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

// --- Lookup tables ---

export const CURVE_NAMES = ['-Lin', '-Exp', '+Lin', '+Exp'];
export const WAVEFORM_NAMES = ['Tri', 'Saw↓', 'Saw↑', 'Sqr', 'Sin', 'S&H'];

export function freqDisplay(oscMode, coarse, fine) {
    if (oscMode === 1) return (coarse * 100 + fine) + ' Hz';
    return (coarse + fine / 100).toFixed(2) + '×';
}

// --- DX732 Algorithm routing ---
// Op numbering 1-6 (DX7 convention). Op6 = byte index 0.

// --- Algorithm grid diagram ---
// 6 columns × 5 rows: operators in rows 0,2,4; connections in rows 1,3

const ALGO_CARRIER_SETS = [
    new Set([1,2]), new Set([1,2,4]), new Set([1,3]), new Set([1,2,5]),
    new Set([1,4]), new Set([1,2,3,5]), new Set([1]), new Set([1,3,5]),
    new Set([1,3]), new Set([1,5]), new Set([1,2,4]), new Set([1,3,5]),
    new Set([1,2]), new Set([1,2,5]), new Set([1,4]), new Set([1,5]),
    new Set([1]), new Set([1,4]), new Set([1,2,4]), new Set([1,4]),
    new Set([1,5]), new Set([1,3,5]), new Set([1]), new Set([1,2,4]),
    new Set([1,3]), new Set([1,5]), new Set([1,4]), new Set([1,3,5]),
    new Set([1]), new Set([1,4]), new Set([1,5]), new Set([1,2,3,4,5,6]),
];

export function renderAlgoSvg(algorithm, container) {
    const carriers = ALGO_CARRIER_SETS[algorithm] || ALGO_CARRIER_SETS[0];
    const grid = document.createElement('div');
    grid.className = 'dx7-algo-grid';

    const layout = [
        ['op6','vconn','space','space','vconn','op5'],
        ['hconn','hconn','space','space','hconn','hconn'],
        ['op4','vconn','space','space','vconn','op3'],
        ['hconn','hconn','space','space','hconn','hconn'],
        ['op2','vconn','space','space','vconn','op1'],
    ];

    for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 6; c++) {
            const cell = document.createElement('div');
            cell.className = 'dx7-algo-cell';
            const t = layout[r][c];

            if (t.startsWith('op')) {
                const opNum = parseInt(t.slice(2));
                cell.classList.add('dx7-op');
                cell.classList.add(carriers.has(opNum) ? 'carrier' : 'modulator');
                cell.textContent = opNum;
                if (opNum === 6) cell.classList.add('fb-source');
            } else if (t === 'vconn') {
                cell.classList.add('vconn');
            } else if (t === 'hconn') {
                cell.classList.add('hconn');
            }

            grid.appendChild(cell);
        }
    }

    container.innerHTML = '';
    container.appendChild(grid);
}

// --- Envelope graph renderer ---

export function renderEnvGraph(canvas, rates, levels) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const pad = 4;
    const gw = w - pad * 2, gh = h - pad * 2;
    const rateToTime = (r) => r === 0 ? 0 : Math.max(1, 100 - r);
    const times = rates.map(rateToTime);
    const total = times.reduce((a, b) => a + b, 0) || 1;

    const pts = [{ x: 0, y: 1 - levels[0] / 99 }];
    let acc = 0;
    for (let i = 0; i < 4; i++) {
        acc += times[i];
        pts.push({ x: acc / total, y: 1 - levels[i] / 99 });
    }

    ctx.beginPath();
    ctx.moveTo(pad + pts[0].x * gw, pad + pts[0].y * gh);
    for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pad + pts[i].x * gw, pad + pts[i].y * gh);
    }
    ctx.strokeStyle = '#4caf50';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#4caf50';
    for (const pt of pts) {
        ctx.beginPath();
        ctx.arc(pad + pt.x * gw, pad + pt.y * gh, 2, 0, Math.PI * 2);
        ctx.fill();
    }
}
