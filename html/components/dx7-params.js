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

const ALGO_ROUTING = [
    { carriers: [1,2], mods: [[6,5],[5,4],[4,3],[3,2]] },
    { carriers: [1,2,4], mods: [[6,5],[5,4],[3,2]] },
    { carriers: [1,3], mods: [[6,5],[5,4],[4,3],[2,1]] },
    { carriers: [1,2,5], mods: [[6,5],[4,3],[3,2]] },
    { carriers: [1,4], mods: [[6,5],[5,4],[3,2],[2,1]] },
    { carriers: [1,2,3,5], mods: [[6,5],[4,3]] },
    { carriers: [1], mods: [[6,5],[5,4],[4,3],[3,2],[2,1]] },
    { carriers: [1,3,5], mods: [[6,5],[4,3],[2,1]] },
    { carriers: [1,3], mods: [[6,5],[5,4],[4,3],[2,1]] },
    { carriers: [1,5], mods: [[6,5],[4,3],[3,2],[2,1]] },
    { carriers: [1,2,4], mods: [[6,5],[5,4],[3,2]] },
    { carriers: [1,3,5], mods: [[6,5],[4,3],[2,1]] },
    { carriers: [1,2], mods: [[6,5],[5,4],[4,3],[3,2]] },
    { carriers: [1,2,5], mods: [[6,5],[4,3],[3,2]] },
    { carriers: [1,4], mods: [[6,5],[5,4],[3,2],[2,1]] },
    { carriers: [1,5], mods: [[6,5],[4,3],[3,2],[2,1]] },
    { carriers: [1], mods: [[6,5],[5,4],[4,3],[3,2],[2,1]] },
    { carriers: [1,4], mods: [[6,5],[5,4],[3,2],[2,1]] },
    { carriers: [1,2,4], mods: [[6,5],[5,4],[3,2]] },
    { carriers: [1,4], mods: [[6,5],[5,4],[3,2],[2,1]] },
    { carriers: [1,5], mods: [[6,5],[4,3],[3,2],[2,1]] },
    { carriers: [1,3,5], mods: [[6,5],[4,3],[2,1]] },
    { carriers: [1], mods: [[6,5],[5,4],[4,3],[3,2],[2,1]] },
    { carriers: [1,2,4], mods: [[6,5],[5,4],[3,2]] },
    { carriers: [1,3], mods: [[6,5],[5,4],[4,3],[2,1]] },
    { carriers: [1,5], mods: [[6,5],[4,3],[3,2],[2,1]] },
    { carriers: [1,4], mods: [[6,5],[5,4],[3,2],[2,1]] },
    { carriers: [1,3,5], mods: [[6,5],[4,3],[2,1]] },
    { carriers: [1], mods: [[6,5],[5,4],[4,3],[3,2],[2,1]] },
    { carriers: [1,4], mods: [[6,5],[5,4],[3,2],[2,1]] },
    { carriers: [1,5], mods: [[6,5],[4,3],[3,2],[2,1]] },
    { carriers: [1,2,3,4,5,6], mods: [] },
];

// --- Algorithm SVG diagram ---

const OP_POS = [
    { x: 40, y: 30 },  // Op6
    { x: 140, y: 30 }, // Op5
    { x: 40, y: 90 },  // Op4
    { x: 140, y: 90 }, // Op3
    { x: 40, y: 150 }, // Op2
    { x: 140, y: 150 },// Op1
];

export function renderAlgoSvg(algorithm, container) {
    const algo = ALGO_ROUTING[algorithm] || ALGO_ROUTING[0];
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 180 190');
    svg.setAttribute('class', 'dx7-algo-svg');

    // Defs: arrow marker
    const defs = document.createElementNS(ns, 'defs');
    const marker = document.createElementNS(ns, 'marker');
    marker.setAttribute('id', 'algo-arrow');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '5');
    marker.setAttribute('markerHeight', '5');
    marker.setAttribute('orient', 'auto-start-reverse');
    const ap = document.createElementNS(ns, 'path');
    ap.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    ap.setAttribute('fill', '#666');
    marker.appendChild(ap);
    defs.appendChild(marker);

    // Feedback arrow marker (red)
    const fbMarker = document.createElementNS(ns, 'marker');
    fbMarker.setAttribute('id', 'algo-fb-arrow');
    fbMarker.setAttribute('viewBox', '0 0 10 10');
    fbMarker.setAttribute('refX', '8');
    fbMarker.setAttribute('refY', '5');
    fbMarker.setAttribute('markerWidth', '5');
    fbMarker.setAttribute('markerHeight', '5');
    fbMarker.setAttribute('orient', 'auto-start-reverse');
    const fbp = document.createElementNS(ns, 'path');
    fbp.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    fbp.setAttribute('fill', '#e94560');
    fbMarker.appendChild(fbp);
    defs.appendChild(fbMarker);

    svg.appendChild(defs);

    const carrierSet = new Set(algo.carriers);

    // Connections
    for (const [from, to] of algo.mods) {
        const fi = 6 - from, ti = 6 - to;
        const l = document.createElementNS(ns, 'line');
        l.setAttribute('x1', OP_POS[fi].x); l.setAttribute('y1', OP_POS[fi].y);
        l.setAttribute('x2', OP_POS[ti].x); l.setAttribute('y2', OP_POS[ti].y);
        l.setAttribute('stroke', '#555'); l.setAttribute('stroke-width', '1.5');
        l.setAttribute('marker-end', 'url(#algo-arrow)');
        svg.appendChild(l);
    }

    // Feedback loop on Op6 (curved arrow back to itself)
    const fb = document.createElementNS(ns, 'path');
    const op6 = OP_POS[0]; // Op6 is at index 0
    fb.setAttribute('d', `M${op6.x - 14},${op6.y - 10} C${op6.x - 30},${op6.y - 30} ${op6.x + 30},${op6.y - 30} ${op6.x + 14},${op6.y - 10}`);
    fb.setAttribute('fill', 'none');
    fb.setAttribute('stroke', '#e94560');
    fb.setAttribute('stroke-width', '1.5');
    fb.setAttribute('marker-end', 'url(#algo-fb-arrow)');
    svg.appendChild(fb);

    // Operator boxes
    for (let i = 0; i < 6; i++) {
        const opNum = 6 - i;
        const p = OP_POS[i];
        const isC = carrierSet.has(opNum);

        const r = document.createElementNS(ns, 'rect');
        r.setAttribute('x', p.x - 20); r.setAttribute('y', p.y - 14);
        r.setAttribute('width', '40'); r.setAttribute('height', '28');
        r.setAttribute('rx', '4');
        r.setAttribute('fill', isC ? '#1b5e20' : '#311b92');
        r.setAttribute('stroke', isC ? '#4caf50' : '#7c4dff');
        r.setAttribute('stroke-width', '1.5');
        svg.appendChild(r);

        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', p.x); t.setAttribute('y', p.y + 4);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('fill', '#fff'); t.setAttribute('font-size', '11');
        t.setAttribute('font-family', 'monospace');
        t.textContent = 'Op' + opNum;
        svg.appendChild(t);
    }

    container.innerHTML = '';
    container.appendChild(svg);
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
