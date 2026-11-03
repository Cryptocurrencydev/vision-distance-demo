/**
 * Synthetic known-distance accuracy test.
 *
 * Ground truth: for each fixture portrait (AI-generated, fictional people), the visible iris
 * diameter is measured at full 4K-derived resolution by an independent classical method
 * (horizontal limbus edge detection on the luminance profile), NOT by MediaPipe.
 *
 * We then simulate a phone front camera (720×1280 portrait, focal f_true) and render the face
 * so that its iris spans exactly f_true × iris_true / d pixels for each test distance d,
 * with JPEG compression like a real camera stream. The production code (measureIris +
 * distanceMm) then estimates d from MediaPipe landmarks.
 *
 * What this measures: landmark + pipeline error vs. scale, and the effect of calibration
 * under deliberately mismatched camera/eye parameters. What it can't measure: real-world
 * optics (lens distortion, autofocus breathing), head pose, motion blur, real sensor noise.
 */
import {
  BANK_CARD_MM, DEFAULT_FOCAL_NORM, POPULATION_IRIS_MM, distanceMm, focalFromKnownDistance,
  focalPx, irisMmFromCard, measureIris, type Pt,
} from '../src/core/distance';
import { createLandmarker } from '../src/core/tracker-shared';
import type { FaceLandmarker } from '@mediapipe/tasks-vision';

const FRAME_W = 720;
const FRAME_H = 1280;
const DISTANCES_CM = [25, 30, 35, 40, 45, 50, 60, 70];
const OFFSETS = [[0, 0], [37.3, -21.6], [-28.7, 44.1]]; // sub-pixel + positional jitter per distance
const FIXTURES = ['face1.jpg', 'face2.jpg'];

interface Fixture { name: string; bmp: ImageBitmap; gtIrisPx: number; lmIrisPx: number; eyeMid: { x: number; y: number }; eyes: { l: number; r: number } }

function lumaRow(img: ImageData, y0: number, x0: number, x1: number, rows: number): Float64Array {
  const out = new Float64Array(x1 - x0);
  for (let dy = -rows; dy <= rows; dy++) {
    const y = Math.round(y0) + dy;
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      out[x - x0] += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    }
  }
  // 5-tap box smooth
  const sm = new Float64Array(out.length);
  for (let i = 2; i < out.length - 2; i++) sm[i] = (out[i - 2] + out[i - 1] + out[i] + out[i + 1] + out[i + 2]) / 5;
  return sm;
}

/** Independent ground truth: strongest dark→bright edges either side of the iris centre. */
function limbusDiameter(img: ImageData, cx: number, cy: number, rGuess: number): number {
  const x0 = Math.max(2, Math.floor(cx - 2 * rGuess));
  const x1 = Math.min(img.width - 2, Math.ceil(cx + 2 * rGuess));
  const p = lumaRow(img, cy, x0, x1, Math.max(1, Math.round(rGuess * 0.15)));
  const g = (i: number) => p[i + 1] - p[i - 1];
  const sub = (i: number, s: number) => { // parabolic sub-pixel peak
    const a = s * g(i - 1), b = s * g(i), c = s * g(i + 1);
    const den = a - 2 * b + c;
    return den !== 0 ? i + 0.5 * (a - c) / den : i;
  };
  let bestR = -Infinity, iR = 0, bestL = -Infinity, iL = 0;
  const c = cx - x0;
  for (let i = Math.round(c + 0.6 * rGuess); i <= Math.round(c + 1.5 * rGuess) && i < p.length - 3; i++) {
    if (g(i) > bestR) { bestR = g(i); iR = i; }
  }
  for (let i = Math.round(c - 1.5 * rGuess); i <= Math.round(c - 0.6 * rGuess); i++) {
    if (i < 3) continue;
    if (-g(i) > bestL) { bestL = -g(i); iL = i; }
  }
  return sub(iR, 1) - sub(iL, -1);
}

async function loadFixture(lm: FaceLandmarker, name: string): Promise<Fixture> {
  const blob = await (await fetch(`/test/fixtures/${name}`)).blob();
  const bmp = await createImageBitmap(blob);
  const res = lm.detect(bmp);
  if (!res.faceLandmarks.length) throw new Error(`no face in ${name}`);
  const pts = res.faceLandmarks[0] as Pt[];
  const m = measureIris(pts, bmp.width, bmp.height)!;
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  const r = limbusDiameter(img, pts[468].x * bmp.width, pts[468].y * bmp.height, m.rightPx / 2);
  const l = limbusDiameter(img, pts[473].x * bmp.width, pts[473].y * bmp.height, m.leftPx / 2);
  return {
    name, bmp, gtIrisPx: (r + l) / 2, lmIrisPx: m.irisPx, eyes: { r, l },
    eyeMid: { x: ((pts[468].x + pts[473].x) / 2) * bmp.width, y: ((pts[468].y + pts[473].y) / 2) * bmp.height },
  };
}

const frameCanvas = new OffscreenCanvas(FRAME_W, FRAME_H);
const frameCtx = frameCanvas.getContext('2d')!;

/** Render the fixture so its iris spans `irisPx` pixels, then JPEG-roundtrip it like a camera. */
async function renderFrame(fx: Fixture, irisPx: number, off: number[]): Promise<ImageBitmap> {
  const s = irisPx / fx.gtIrisPx;
  frameCtx.fillStyle = '#9aa0a3';
  frameCtx.fillRect(0, 0, FRAME_W, FRAME_H);
  frameCtx.imageSmoothingEnabled = true;
  frameCtx.imageSmoothingQuality = 'high';
  const dx = FRAME_W / 2 + off[0] - fx.eyeMid.x * s;
  const dy = FRAME_H * 0.42 + off[1] - fx.eyeMid.y * s;
  frameCtx.drawImage(fx.bmp, dx, dy, fx.bmp.width * s, fx.bmp.height * s);
  const jpg = await frameCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  return createImageBitmap(jpg);
}

interface Row { face: string; scenario: string; trueCm: number; estCm: number; errPct: number; irisPx: number }

async function measureAt(lm: FaceLandmarker, fx: Fixture, irisPxTrue: number, off: number[]): Promise<number | null> {
  const frame = await renderFrame(fx, irisPxTrue, off);
  const res = lm.detect(frame);
  frame.close();
  if (!res.faceLandmarks.length) return null;
  const m = measureIris(res.faceLandmarks[0] as Pt[], FRAME_W, FRAME_H);
  return m ? m.irisPx : null;
}

async function run(): Promise<unknown> {
  const out = document.getElementById('out')!;
  const t0 = performance.now();
  const { landmarker: lm, delegate } = await createLandmarker('IMAGE', 'CPU', 1);
  const fixtures: Fixture[] = [];
  for (const n of FIXTURES) fixtures.push(await loadFixture(lm, n));
  out.textContent = fixtures.map((f) => `${f.name}: limbus GT ${f.gtIrisPx.toFixed(2)} px (R ${f.eyes.r.toFixed(1)} / L ${f.eyes.l.toFixed(1)}), landmark ${f.lmIrisPx.toFixed(2)} px`).join('\n') + '\n';

  // Scenarios: (true camera focal, true iris) vs. what the app assumes.
  const scenarios = [
    { id: 'pipeline', label: 'Camera & eye match defaults (pipeline error only)', fTrue: DEFAULT_FOCAL_NORM, irisTrue: POPULATION_IRIS_MM, cal: 'none' },
    { id: 'uncal-mismatch', label: 'Uncalibrated: camera focal +10 %, iris 12.2 mm', fTrue: DEFAULT_FOCAL_NORM * 1.10, irisTrue: 12.2, cal: 'none' },
    { id: 'card-only', label: 'Card-at-face calibration only (same mismatch)', fTrue: DEFAULT_FOCAL_NORM * 1.10, irisTrue: 12.2, cal: 'card' },
    { id: 'known-40', label: 'Known-distance calibration at 40 cm (same mismatch)', fTrue: DEFAULT_FOCAL_NORM * 1.10, irisTrue: 12.2, cal: 'known' },
  ] as const;

  const rows: Row[] = [];
  for (const fx of fixtures) {
    for (const sc of scenarios) {
      const fTruePx = focalPx(sc.fTrue, FRAME_W, FRAME_H);
      let fAssumed = DEFAULT_FOCAL_NORM;
      let irisAssumed = POPULATION_IRIS_MM;
      if (sc.cal === 'known') {
        // user holds the phone at a tape-measured 40 cm (±5 mm human error is modelled as 0 here)
        const px = await measureAt(lm, fx, (fTruePx * sc.irisTrue) / 400, [0, 0]);
        if (px) fAssumed = focalFromKnownDistance(400, px, irisAssumed, FRAME_W, FRAME_H);
      } else if (sc.cal === 'card') {
        // card held beside the eye at ~45 cm; user aligns the edge lines to within ±1.5 px
        const d = 450;
        const px = await measureAt(lm, fx, (fTruePx * sc.irisTrue) / d, [0, 0]);
        const cardPx = (fTruePx * BANK_CARD_MM) / d + 1.5;
        if (px) irisAssumed = irisMmFromCard(px, cardPx);
      }
      for (const cm of DISTANCES_CM) {
        for (const off of OFFSETS) {
          const truePx = (fTruePx * sc.irisTrue) / (cm * 10);
          const px = await measureAt(lm, fx, truePx, off);
          if (!px) { rows.push({ face: fx.name, scenario: sc.id, trueCm: cm, estCm: NaN, errPct: NaN, irisPx: truePx }); continue; }
          const est = distanceMm(focalPx(fAssumed, FRAME_W, FRAME_H), irisAssumed, px) / 10;
          rows.push({ face: fx.name, scenario: sc.id, trueCm: cm, estCm: est, errPct: ((est - cm) / cm) * 100, irisPx: truePx });
        }
      }
      out.textContent += `done ${fx.name} / ${sc.id}\n`;
    }
  }

  const summary = scenarios.map((sc) => {
    const r = rows.filter((x) => x.scenario === sc.id);
    const ok = r.filter((x) => Number.isFinite(x.errPct));
    const abs = ok.map((x) => Math.abs(x.errPct)).sort((a, b) => a - b);
    const mean = ok.reduce((a, x) => a + x.errPct, 0) / ok.length;
    const byDist = DISTANCES_CM.map((cm) => {
      const d = ok.filter((x) => x.trueCm === cm);
      return { cm, meanErrPct: d.reduce((a, x) => a + x.errPct, 0) / d.length, maePct: d.reduce((a, x) => a + Math.abs(x.errPct), 0) / d.length, irisPx: d[0]?.irisPx };
    });
    return {
      id: sc.id, label: sc.label, n: r.length, detected: ok.length,
      biasPct: mean, maePct: abs.reduce((a, b) => a + b, 0) / abs.length,
      p95AbsPct: abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.95))], maxAbsPct: abs[abs.length - 1], byDist,
    };
  });
  lm.close();
  const result = {
    delegate, frame: `${FRAME_W}x${FRAME_H}`, focalDefault: DEFAULT_FOCAL_NORM,
    fixtures: fixtures.map((f) => ({ name: f.name, gtIrisPx: f.gtIrisPx, landmarkIrisPx: f.lmIrisPx, landmarkVsLimbusPct: ((f.lmIrisPx / f.gtIrisPx) - 1) * 100 })),
    summary, rows, seconds: (performance.now() - t0) / 1000,
  };
  out.textContent += JSON.stringify(summary.map(({ byDist: _b, ...s }) => s), null, 2);
  return result;
}

(window as unknown as { runAccuracy: typeof run }).runAccuracy = run;
