// A container whose WAV did not come with an imported project offers to
// re-upload it; supplying one stores it and the waveform appears.
import { test, expect, openApp, openPatchesTab } from './fixtures.js';

function wav() {
    // 0.1 s of silence-ish mono 16-bit PCM at 8 kHz.
    const n = 800, buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(i / 5)), 44 + i * 2);
    return buf;
}

test('re-upload a missing WAV', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => {
        const pm = await import('/html/components/patch-model.js');
        const cv = await import('/html/components/canvas.js');
        pm.jobStore.put({ id: 'job_missing', type: 'wav', status: 'done', fileName: 'kick.wav', sourceMissing: true });
        cv.addContainer('kick', { jobId: 'job_missing', patchIds: [] });
        cv.refreshCanvas();
    });
    await openPatchesTab(page);
    const btn = page.locator('.sky-container-reupload');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute('title', /kick\.wav/);
    const chooser = page.waitForEvent('filechooser');
    await btn.click();
    await (await chooser).setFiles({ name: 'kick.wav', mimeType: 'audio/wav', buffer: wav() });
    await expect(page.locator('.container-spectrogram')).toBeVisible();
    await expect(page.locator('.sky-container-reupload')).toHaveCount(0);
    expect(await page.evaluate(async () => {
        const pm = await import('/html/components/patch-model.js');
        return pm.jobStore.get('job_missing').sourceMissing;
    })).toBe(false);
});
