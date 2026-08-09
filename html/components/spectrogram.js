export function createSpectrogram(audioSamples, sampleRate, playFn) {
    const container = document.createElement('div');
    container.className = 'spectrogram-container';

    const canvas = document.createElement('canvas');
    canvas.width = 460;
    canvas.height = 80;
    canvas.className = 'spectrogram-canvas';
    container.appendChild(canvas);

    const playBtn = document.createElement('button');
    playBtn.className = 'spectrogram-play';
    playBtn.textContent = '▶';
    playBtn.title = 'Play';
    container.appendChild(playBtn);

    if (playFn) {
        playBtn.addEventListener('click', playFn);
    }

    // Draw waveform on canvas
    if (audioSamples && audioSamples.length > 0) {
        drawWaveform(canvas, audioSamples);
    }

    return container;
}

function drawWaveform(canvas, samples) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;

    // Background
    ctx.fillStyle = '#0f0f23';
    ctx.fillRect(0, 0, w, h);

    // Center line
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    // Downsample to canvas width
    const step = Math.max(1, Math.floor(samples.length / w));

    // Find peak for normalization
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        const abs = Math.abs(samples[i]);
        if (abs > peak) peak = abs;
    }
    if (peak < 0.001) peak = 1;

    // Draw filled waveform
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let x = 0; x < w; x++) {
        const idx = Math.floor(x * step);
        if (idx >= samples.length) break;
        const val = samples[idx] / peak;
        const y = mid - val * (mid - 4);
        ctx.lineTo(x, y);
    }
    for (let x = w - 1; x >= 0; x--) {
        const idx = Math.floor(x * step);
        if (idx >= samples.length) continue;
        const val = samples[idx] / peak;
        const y = mid + val * (mid - 4);
        ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(76, 175, 80, 0.4)';
    ctx.fill();

    // Draw waveform outline
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
        const idx = Math.floor(x * step);
        if (idx >= samples.length) break;
        const val = samples[idx] / peak;
        const y = mid - val * (mid - 4);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#4caf50';
    ctx.lineWidth = 1;
    ctx.stroke();
}
