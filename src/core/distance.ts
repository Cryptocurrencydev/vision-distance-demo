/**
 * Iris-based monocular distance estimation — pure math, no DOM.
 *
 * Pinhole model:  distance = f_px * irisMm / irisPx
 *
 *   f_px    focal length in pixels for the current video frame
 *   irisMm  physical horizontal visible iris diameter (HVID). Population mean ≈ 11.7 mm
 *           (SD ≈ 0.4–0.5 mm), so an uncalibrated estimate carries ~±4 % (1σ) anatomical error.
 *   irisPx  measured iris diameter in the image
 *
 * Focal length is stored *normalised* to the long side of the frame (f_px / max(w, h)) so a
 * single calibration survives resolution changes and portrait/landscape rotation.
 */

export const POPULATION_IRIS_MM = 11.7;
export const BANK_CARD_MM = 85.6; // ISO/IEC 7810 ID-1 long edge
export const BANK_CARD_SHORT_MM = 53.98;

/** Typical phone front camera: ~67° across the long side of a 16:9 / 4:3 video frame. */
export const DEFAULT_FOCAL_NORM = 0.5 / Math.tan((67 / 2) * (Math.PI / 180)); // ≈ 0.755

// MediaPipe Face Landmarker (478 points) iris indices.
// 468/473 = centres, ring = 4 points: [outer, top, inner, bottom] per eye.
export const RIGHT_IRIS = { center: 468, h: [469, 471] as const, v: [470, 472] as const };
export const LEFT_IRIS = { center: 473, h: [474, 476] as const, v: [475, 477] as const };

export interface Pt { x: number; y: number; z?: number }

export interface IrisMeasurement {
  /** horizontal diameter per eye, in px */
  rightPx: number;
  leftPx: number;
  /** combined estimate in px */
  irisPx: number;
  /** relative disagreement between eyes, 0 = identical */
  asymmetry: number;
}

function dist(a: Pt, b: Pt, w: number, h: number): number {
  const dx = (a.x - b.x) * w;
  const dy = (a.y - b.y) * h;
  return Math.hypot(dx, dy);
}

/**
 * Measures iris diameter from normalised landmarks.
 * Uses the horizontal ring chord (vertical is often clipped by eyelids in the real eye, and
 * the model's vertical points inherit that ambiguity), averaged with the vertical chord only
 * as a sanity floor.
 */
export function measureIris(lm: ArrayLike<Pt>, w: number, h: number): IrisMeasurement | null {
  if (lm.length < 478) return null;
  const r = dist(lm[RIGHT_IRIS.h[0]], lm[RIGHT_IRIS.h[1]], w, h);
  const l = dist(lm[LEFT_IRIS.h[0]], lm[LEFT_IRIS.h[1]], w, h);
  if (!(r > 0) || !(l > 0)) return null;
  // When the head yaws, the far eye's iris foreshortens horizontally. The larger chord is the
  // less-foreshortened one, so blend toward it as asymmetry grows.
  const asymmetry = Math.abs(r - l) / Math.max(r, l);
  const mean = (r + l) / 2;
  const larger = Math.max(r, l);
  const t = Math.min(1, asymmetry / 0.15);
  const irisPx = mean * (1 - t) + larger * t;
  return { rightPx: r, leftPx: l, irisPx, asymmetry };
}

export function focalPx(focalNorm: number, w: number, h: number): number {
  return focalNorm * Math.max(w, h);
}

/** distance in mm */
export function distanceMm(fPx: number, irisMm: number, irisPx: number): number {
  return (fPx * irisMm) / irisPx;
}

/** Option B calibration: known distance → normalised focal length. */
export function focalFromKnownDistance(
  knownMm: number, irisPx: number, irisMm: number, w: number, h: number,
): number {
  return (knownMm * irisPx) / irisMm / Math.max(w, h);
}

/** Option A calibration: card held at the same depth as the eyes → personal iris diameter. */
export function irisMmFromCard(irisPx: number, cardPx: number, cardMm = BANK_CARD_MM): number {
  return (cardMm * irisPx) / cardPx;
}

/** Physical letter height (mm) of a 5×5 optotype for a given logMAR at distance d (mm). */
export function optotypeHeightMm(logMAR: number, distanceMmValue: number): number {
  const marArcmin = Math.pow(10, logMAR);
  const totalArcmin = 5 * marArcmin;
  const rad = (totalArcmin / 60) * (Math.PI / 180);
  return 2 * distanceMmValue * Math.tan(rad / 2);
}

/** Snellen-style equivalent (20/x) for a logMAR value. */
export function snellen20(logMAR: number): string {
  return `20/${Math.round(20 * Math.pow(10, logMAR))}`;
}

// ───────────────────────────────── filters ─────────────────────────────────

class LowPass {
  private y = 0;
  private s = false;
  filter(x: number, alpha: number): number {
    this.y = this.s ? alpha * x + (1 - alpha) * this.y : x;
    this.s = true;
    return this.y;
  }
  last(): number { return this.y; }
  reset(): void { this.s = false; }
  get started(): boolean { return this.s; }
}

/** One-Euro filter (Casiez et al. 2012): low lag when moving, low jitter when still. */
export class OneEuroFilter {
  private x = new LowPass();
  private dx = new LowPass();
  private lastT = -1;
  constructor(
    public minCutoff = 1.0,
    public beta = 0.02,
    public dCutoff = 1.0,
  ) {}
  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value: number, tMs: number): number {
    const dt = this.lastT < 0 ? 1 / 30 : Math.max(1e-3, (tMs - this.lastT) / 1000);
    this.lastT = tMs;
    const prev = this.x.started ? this.x.last() : value;
    const edx = this.dx.filter((value - prev) / dt, this.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, this.alpha(cutoff, dt));
  }
  reset(): void { this.x.reset(); this.dx.reset(); this.lastT = -1; }
}

/** Fixed-size ring buffer of numbers for rolling stats, no allocation per push. */
export class Ring {
  private buf: Float64Array;
  private i = 0;
  private n = 0;
  constructor(size: number) { this.buf = new Float64Array(size); }
  push(v: number): void {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
  }
  get count(): number { return this.n; }
  mean(): number {
    let s = 0;
    for (let k = 0; k < this.n; k++) s += this.buf[k];
    return this.n ? s / this.n : 0;
  }
  std(): number {
    if (this.n < 2) return 0;
    const m = this.mean();
    let s = 0;
    for (let k = 0; k < this.n; k++) s += (this.buf[k] - m) ** 2;
    return Math.sqrt(s / (this.n - 1));
  }
  clear(): void { this.n = 0; this.i = 0; }
  /** copies the live values into `out` (no allocation); returns count */
  copyInto(out: Float64Array): number {
    out.set(this.buf.subarray(0, this.n));
    return this.n;
  }
}

// ─────────────────────────────── confidence ────────────────────────────────

export interface ConfidenceInputs {
  irisPx: number;        // small irises quantise badly
  asymmetry: number;     // eye disagreement (yaw / bad landmark)
  yawDeg: number;        // head yaw from face transform
  jitterRel: number;     // mean |raw − filtered| / filtered (frame-to-frame noise)
  lumaOk: boolean;
  glare: boolean;
  calibrated: boolean;
}

/** 0..1 heuristic score; buckets: ≥0.75 high, ≥0.5 medium, else low. */
export function confidence(c: ConfidenceInputs): number {
  let s = 1;
  // ±1 px landmark error is ±(1/irisPx) relative; below ~14 px that exceeds 7 %.
  s *= clamp01((c.irisPx - 8) / 14);
  s *= 1 - clamp01((c.asymmetry - 0.06) / 0.2);
  s *= 1 - clamp01((Math.abs(c.yawDeg) - 15) / 20);
  s *= 1 - clamp01((c.jitterRel - 0.015) / 0.06);
  if (!c.lumaOk) s *= 0.7;
  if (c.glare) s *= 0.8;
  if (!c.calibrated) s *= 0.85;
  return clamp01(s);
}

export function confidenceLabel(v: number): 'high' | 'medium' | 'low' {
  return v >= 0.75 ? 'high' : v >= 0.5 ? 'medium' : 'low';
}

export function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Yaw/pitch (degrees) from MediaPipe's 4×4 column-major facial transformation matrix. */
export function yawPitchFromMatrix(m: ArrayLike<number>): { yaw: number; pitch: number } {
  // Rotation part, column-major: r00=m[0], r10=m[1], r20=m[2], r01=m[4] ... r22=m[10]
  const r20 = m[2], r21 = m[6], r22 = m[10];
  const yaw = Math.asin(-clamp(r20, -1, 1));
  const pitch = Math.atan2(r21, r22);
  return { yaw: (yaw * 180) / Math.PI, pitch: (pitch * 180) / Math.PI };
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
