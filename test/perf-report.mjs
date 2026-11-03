// Collects test/results/perf-*.json into test/results/PERF.md
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const rows = readdirSync('test/results').filter((f) => /^perf-.*\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(`test/results/${f}`, 'utf8')))
  .sort((a, b) => b.throttle - a.throttle || a.label.localeCompare(b.label));
const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');
let md = `# Performance report\n\nGenerated ${new Date().toISOString()} by \`npm run test:perf\`. Headless Chromium (Playwright), 390×844 viewport @ DPR 3, touch, Chrome fake camera fed a 1280×720 30 fps MJPEG of a face (test/make-fake-video.sh), production build via \`vite preview\`. CPU throttling via CDP \`Emulation.setCPUThrottlingRate\`. Detection cap 24 fps. Steady-state averages over 12 s after a 3 s warm-up.\n\n`;
md += `| Config | Delegate | Inference thread | Detection fps | Inference avg / p95 (ms) | UI fps | Long tasks (>50 ms) | Full flow |\n|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) md += `| ${r.label} | ${r.delegate} | ${r.engine} | ${f(r.detectFps)} | ${f(r.inferMsAvg)} / ${f(r.inferMsP95)} | ${f(r.uiFps)} | ${r.longTasks.count} (max ${f(r.longTasks.maxMs, 0)} ms) | ${r.flowOk ? '✓' : '✗'} |\n`;
md += `\n**Caveats.** Headless Chromium has no hardware GPU, so the "GPU" delegate runs on SwiftShader (software WebGL) and is *slower* than CPU here; on real phones it is normally the faster option. CDP CPU throttling applies to the main thread; worker-thread inference does not appear to be throttled (compare main-thread vs worker inference ms at 4×), so the main-thread 4× row is the better proxy for inference cost on a mid-range Android phone (~45–75 ms). What the worker rows *do* show is the architectural point: inference off the main thread keeps the UI at 60 fps with zero long tasks, while main-thread inference drops the UI to roughly the detection rate.\n`;
writeFileSync('test/results/PERF.md', md);
console.log(md);
