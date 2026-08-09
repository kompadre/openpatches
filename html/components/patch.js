// Waveform helpers — WAV decoding and mini waveform drawing.
// Shared by canvas.js, patch-row.js, and app.js.

export const wavSampleCache = new Map(); // url -> Float32Array samples

export function decodeWavSamples(arrayBuffer) {
    try {
        const view = new DataView(arrayBuffer);
        if (view.getUint32(0, false) !== 0x52494646) return null;
        let offset = 12;
        while (offset < view.byteLength - 8) {
            const chunkId = view.getUint32(offset, false);
            const chunkSize = view.getUint32(offset + 4, true);
            if (chunkId === 0x666d7420) {
                const channels = view.getUint16(offset + 10, true);
                const bitsPerSample = view.getUint16(offset + 22, true);
                const dataChunkOffset = offset + 8 + chunkSize;
                const dataId = view.getUint32(dataChunkOffset, false);
                const dataSize = view.getUint32(dataChunkOffset + 4, true);
                if (dataId === 0x64617461) {
                    const dataStart = dataChunkOffset + 8;
                    const numSamples = Math.floor(dataSize / (bitsPerSample / 8));
                    const samples = new Float32Array(numSamples);
                    for (let i = 0; i < numSamples; i++) {
                        samples[i] = view.getInt16(dataStart + i * 2, true) / 32768.0;
                    }
                    if (channels === 2) {
                        const mono = new Float32Array(numSamples / 2);
                        for (let i = 0; i < mono.length; i++) {
                            mono[i] = (samples[i * 2] + samples[i * 2 + 1]) / 2;
                        }
                        return mono;
                    }
                    return samples;
                }
                offset += 8 + chunkSize;
                if (chunkSize % 2 !== 0) offset++;
            } else {
                offset += 8 + chunkSize;
                if (chunkSize % 2 !== 0) offset++;
            }
        }
    } catch (e) {
        console.warn('WAV decode failed:', e);
    }
    return null;
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
