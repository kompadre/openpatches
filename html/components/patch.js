// Waveform helpers — WAV decoding and mini waveform drawing.
// Shared by canvas.js, patch-row.js, and app.js.

export const wavSampleCache = new Map(); // url -> Float32Array samples

// Object URLs handed back by onPlay (offline-rendered previews) are owned by
// whoever drew the waveform — revoke once consumed. Server URLs pass through.
export function releaseWavUrl(url) {
    if (typeof url === 'string' && url.startsWith('blob:')) {
        try { URL.revokeObjectURL(url); } catch { /* not a URL we own */ }
    }
}

export function decodeWavSamples(arrayBuffer) {
    try {
        const view = new DataView(arrayBuffer);
        if (view.byteLength < 12 || view.getUint32(0, false) !== 0x52494646) return null;
        // Walk the RIFF chunk list. `fmt ` and `data` may be in any order and
        // other chunks (LIST, fact, cue) may sit between them, so remember
        // the format and decode once both have been seen.
        let fmt = null;
        let offset = 12;
        while (offset + 8 <= view.byteLength) {
            const chunkId = view.getUint32(offset, false);
            const chunkSize = view.getUint32(offset + 4, true);
            const body = offset + 8;
            if (chunkId === 0x666d7420 && body + 16 <= view.byteLength) { // 'fmt '
                fmt = {
                    format: view.getUint16(body, true),
                    channels: view.getUint16(body + 2, true),
                    bitsPerSample: view.getUint16(body + 14, true),
                };
            } else if (chunkId === 0x64617461) { // 'data'
                if (!fmt) return null;
                return decodePcm(view, body, Math.min(chunkSize, view.byteLength - body), fmt);
            }
            offset = body + chunkSize + (chunkSize % 2);
        }
    } catch (e) {
        console.warn('WAV decode failed:', e);
    }
    return null;
}

// 16-bit PCM (the only format the server and the offline renderer emit) and
// 32-bit float, mixed down to mono.
function decodePcm(view, start, byteLen, fmt) {
    const { format, channels, bitsPerSample } = fmt;
    const ch = Math.max(1, channels || 1);
    let read;
    if (bitsPerSample === 16) {
        read = (i) => view.getInt16(start + i * 2, true) / 32768.0;
    } else if (bitsPerSample === 32 && format === 3) {
        read = (i) => view.getFloat32(start + i * 4, true);
    } else {
        return null;
    }
    const frameBytes = (bitsPerSample / 8) * ch;
    const frames = Math.floor(byteLen / frameBytes);
    const mono = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
        let acc = 0;
        for (let c = 0; c < ch; c++) acc += read(f * ch + c);
        mono[f] = acc / ch;
    }
    return mono;
}

export function drawMiniWaveform(canvas, samples) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;

    ctx.fillStyle = '#0f0f23';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    const step = Math.max(1, Math.floor(samples.length / w));
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        const abs = Math.abs(samples[i]);
        if (abs > peak) peak = abs;
    }
    if (peak < 0.001) peak = 1;

    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let x = 0; x < w; x++) {
        const idx = Math.floor(x * step);
        if (idx >= samples.length) break;
        const val = samples[idx] / peak;
        ctx.lineTo(x, mid - val * (mid - 2));
    }
    for (let x = w - 1; x >= 0; x--) {
        const idx = Math.floor(x * step);
        if (idx >= samples.length) continue;
        const val = samples[idx] / peak;
        ctx.lineTo(x, mid + val * (mid - 2));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(76, 175, 80, 0.35)';
    ctx.fill();

    ctx.beginPath();
    for (let x = 0; x < w; x++) {
        const idx = Math.floor(x * step);
        if (idx >= samples.length) break;
        const val = samples[idx] / peak;
        const y = mid - val * (mid - 2);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#4caf50';
    ctx.lineWidth = 1;
    ctx.stroke();
}
