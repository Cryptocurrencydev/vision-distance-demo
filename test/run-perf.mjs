// Perf + end-to-end smoke test on the production build.
//  - 390×844 mobile viewport (DPR 3, touch), Chrome fake camera fed with test/out/fake-camera.mjpeg
//  - CPU throttled via CDP (default 4×), measures detection fps / inference ms / UI fps / long tasks
//  - walks the full flow (skip calibration → guide → E check → results) and saves screenshots
// Usage: node test/run-perf.mjs [--throttle 4] [--cpu] [--main] [--seconds 15] [--url http://...] [--shots]
import { preview } from 'vite';
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const THROTTLE = Number(arg('throttle', 4));
const SECONDS = Number(arg('seconds', 15));
const FORCE_CPU = flag('cpu');
const MAIN = flag('main');
const SHOTS = flag('shots');
const video = resolve('test/out/fake-camera.mjpeg');
if (!existsSync(video)) execSync('./test/make-fake-video.sh', { stdio: 'inherit' });

let server = null;
let base = arg('url', '');
if (!base) {
  server = await preview({ preview: { port: 4191, host: '127.0.0.1' }, logLevel: 'error' });
  base = 'http://127.0.0.1:4191';
}

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${video}`,
    '--enable-unsafe-swiftshader',
  ],
});
const label = `${MAIN ? 'main' : 'worker'}-${FORCE_CPU ? 'cpu' : 'auto'}-x${THROTTLE}`;
try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    permissions: ['camera'],
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  });
  await ctx.addInitScript(() => {
    window.__longTasks = [];
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__longTasks.push(e.duration)))
        .observe({ type: 'longtask', buffered: true });
    } catch { /* unsupported */ }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  const tLoad = Date.now();
  await page.goto(`${base}/?debug=1${FORCE_CPU ? '&cpu=1' : ''}${MAIN ? '&main=1' : ''}`);
  await page.click('#btn-start');
  await page.waitForSelector('#screen-calibrate:not([hidden])', { timeout: 120000 });
  const readyMs = Date.now() - tLoad;
  mkdirSync('test/results/screens', { recursive: true });
  if (SHOTS) await page.screenshot({ path: 'test/results/screens/1-calibrate.png' });
  // Functional check of option B (known distance), then reset so measurements use defaults.
  await page.click('#tab-known');
  await page.fill('#known-cm', '40');
  await page.click('#btn-known');
  await page.waitForFunction(() => /Saved|again|Unexpected/.test(document.getElementById('known-msg').textContent), null, { timeout: 15000 });
  const knownMsg = await page.textContent('#known-msg');
  if (SHOTS) await page.screenshot({ path: 'test/results/screens/1b-calibrate-known.png' });
  await page.click('#btn-cal-reset');
  await page.click('#btn-cal-skip');
  await page.waitForSelector('#screen-guide:not([hidden])');
  await page.evaluate(() => { window.__longTasks.length = 0; });

  const samples = [];
  const dists = [];
  for (let s = 0; s < SECONDS; s++) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => ({ ...window.__iriscale.stats(), latest: window.__iriscale.latest() }));
    samples.push(st);
    if (st.latest?.hasFace) dists.push(st.latest.mm / 10);
    if (SHOTS && s === 4) await page.screenshot({ path: 'test/results/screens/2-guide-debug.png' });
  }
  const longTasks = await page.evaluate(() => window.__longTasks.slice());

  // Flow: wait for the guide's "hold steady" gate, then run the E check with keyboard answers.
  let flowOk = false;
  try {
    await page.waitForSelector('#btn-guide-next:not([disabled])', { timeout: 30000 });
    if (SHOTS) await page.screenshot({ path: 'test/results/screens/3-guide-ok.png' });
    await page.click('#btn-guide-next');
    await page.waitForSelector('#screen-check:not([hidden])');
    await page.waitForTimeout(800);
    if (SHOTS) await page.screenshot({ path: 'test/results/screens/4-check.png' });
    for (let i = 0; i < 40; i++) {
      if (await page.isVisible('#screen-results')) break;
      // "Answer" by reading the drawn direction is cheating; we answer 'right' — a ~25 % hit rate
      // ends the staircase quickly, which is all this smoke test needs.
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(450);
    }
    await page.waitForSelector('#screen-results:not([hidden])', { timeout: 15000 });
    await page.click('.log summary');
    if (SHOTS) await page.screenshot({ path: 'test/results/screens/5-results.png', fullPage: true });
    flowOk = true;
  } catch (e) {
    errors.push(`flow: ${e.message}`);
  }

  const steady = samples.slice(3); // skip warm-up
  const avg = (k) => steady.reduce((a, s) => a + (s[k] ?? 0), 0) / steady.length;
  const result = {
    label, throttle: THROTTLE, delegate: samples.at(-1)?.delegate, engine: samples.at(-1)?.engine, readyMs,
    detectFps: avg('detectFps'), inferMsAvg: avg('inferMsAvg'), inferMsP95: avg('inferMsP95'), uiFps: avg('uiFps'),
    longTasks: { count: longTasks.length, maxMs: Math.max(0, ...longTasks), perSec: longTasks.length / SECONDS },
    distanceRangeCm: dists.length ? [Math.min(...dists), Math.max(...dists)] : null,
    faceFrames: dists.length, flowOk, knownMsg, errors,
  };
  console.log(JSON.stringify(result, null, 2));
  writeFileSync(`test/results/perf-${label}.json`, JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  server?.httpServer.close();
}
