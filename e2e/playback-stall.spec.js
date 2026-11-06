import { test, expect, openApp, openRollTab, openSectionPane } from './fixtures.js';
// A window held back mid-playback (Chrome unfocused by its download bubble
// after an export) gets its queued clock ticks in one burst when it comes
// back. Those late ticks must not play: the old code sounded every missed
// note at once. A busy main thread holds the ticks the same way.
test('ticks held back by a stalled page do not play as a burst on return', async ({ page }) => {
  await page.route('**/html/app.js', async route => {
    const r = await route.fetch(); let body = await r.text();
    body = body.replace('async function playNote(midi, voiceData, durationMs, channel, noteOpts = {}) {',
      'async function playNote(midi, voiceData, durationMs, channel, noteOpts = {}) { (window.__notes ||= []).push(performance.now());');
    await route.fulfill({ response: r, body });
  });
  await openApp(page); await openSectionPane(page);
  await page.locator('.section-toolbar button',{hasText:'+ Pattern'}).click();
  await openRollTab(page);
  await page.evaluate(() => window.__opProject.update(p => {
    const pat = Object.values(p.patterns)[0]; pat.notes = Array.from({length:16}, (_, i) => ({ midi: 60, start: i, dur: 1, slot: 0 }));
  }, 'e2e'));
  await page.locator('.pianoroll-play').click();
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => new Promise(res => {
    const before = window.__notes.length; const t = performance.now();
    while (performance.now() - t < 2000) {}          // main thread held, as when unfocused
    setTimeout(() => {
      const after = window.__notes.filter(x => x > t + 2000 && x < t + 2100).length;
      res({ before, burst: after, total: window.__notes.length });
    }, 150);
  }));
  expect(r.before).toBeGreaterThan(0);          // it really was playing
  expect(r.burst).toBeLessThanOrEqual(2);       // was 17 before the fix
});
