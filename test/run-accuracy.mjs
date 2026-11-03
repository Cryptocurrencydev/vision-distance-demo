// Runs test/accuracy.html in headless Chromium and writes test/results/ACCURACY.md + accuracy.json
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const server = await createServer({ server: { port: 5191, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  await page.goto('http://127.0.0.1:5191/test/accuracy.html');
  await page.waitForFunction(() => typeof window.runAccuracy === 'function');
  const res = await page.evaluate(() => window.runAccuracy());
  mkdirSync('test/results', { recursive: true });
  writeFileSync('test/results/accuracy.json', JSON.stringify(res, null, 2));

  const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const sign = (n) => (n >= 0 ? '+' : '') + f(n);
  let md = `# Accuracy report\n\nGenerated ${new Date().toISOString()} by \`npm run test:accuracy\` (MediaPipe ${res.delegate} delegate, synthetic ${res.frame} portrait frames, JPEG q0.82, ${res.rows.length} frames, ${f(res.seconds, 0)} s).\n\n`;
  md += `Ground-truth iris width per fixture comes from classical limbus edge detection on the 2752 px source, independent of MediaPipe.\n\n| Fixture | Limbus GT (px) | MediaPipe iris (px) | Landmark vs limbus |\n|---|---|---|---|\n`;
  for (const x of res.fixtures) md += `| ${x.name} | ${f(x.gtIrisPx, 2)} | ${f(x.landmarkIrisPx, 2)} | ${sign(x.landmarkVsLimbusPct)} % |\n`;
  md += `\n## Summary (all distances 25–70 cm, both faces, 3 positions each)\n\n| Scenario | Bias | Mean abs. error | p95 abs. error | Max abs. error | Detected |\n|---|---|---|---|---|---|\n`;
  for (const s of res.summary) md += `| ${s.label} | ${sign(s.biasPct)} % | ${f(s.maePct)} % | ${f(s.p95AbsPct)} % | ${f(s.maxAbsPct)} % | ${s.detected}/${s.n} |\n`;
  md += `\n## Error by distance\n\n| Distance | Iris (px) | ${res.summary.map((s) => s.id).join(' | ')} |\n|---|---|${res.summary.map(() => '---').join('|')}|\n`;
  for (let i = 0; i < res.summary[0].byDist.length; i++) {
    const d = res.summary[0].byDist[i];
    md += `| ${d.cm} cm | ${f(d.irisPx)} | ${res.summary.map((s) => `${sign(s.byDist[i].meanErrPct)} % (MAE ${f(s.byDist[i].maePct)})`).join(' | ')} |\n`;
  }
  writeFileSync('test/results/ACCURACY.md', md);
  console.log(md);
} finally {
  await browser.close();
  await server.close();
}
