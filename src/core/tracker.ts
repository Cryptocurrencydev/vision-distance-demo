/**
 * Tracker: runs face landmark inference on the live <video> at a capped rate, independent of
 * the UI's requestAnimationFrame loop, and turns landmarks into a filtered distance.
 *
 * Perf notes (mid-range Android is the target):
 *  - inference runs in a Web Worker when possible (WorkerEngine), so a 40–80 ms inference on a
 *    slow phone costs the UI thread only a createImageBitmap() call. Main-thread fallback exists.
 *  - inference is capped at `targetFps` (default 24) with back-pressure (one frame in flight);
 *    a slow phone degrades detection rate, not UI frame rate.
 *  - requestVideoFrameCallback when available, so we never process the same camera frame twice.
 *  - landmarks arrive in one Float32Array that ping-pongs between threads; they're exposed
 *    through a fixed array of 478 reused point objects. Scratch canvases are allocated once.
 *  - loop is suspended (and the video paused) while the tab is hidden.
 */
import {
  DEFAULT_FOCAL_NORM, OneEuroFilter, POPULATION_IRIS_MM, Ring, confidence, distanceMm,
  focalPx, measureIris, yawPitchFromMatrix, type Pt,
} from './distance';
import { WorkerEngine, MATRIX_OFFSET, PTS, type Engine } from './engine';
import type { Delegate } from './paths';
import type { ModelAssets } from './preload';

export type { Delegate } from './paths';

export interface TrackerFrame {
  t: number;
  faces: number;
  hasFace: boolean;
  irisPx: number;
  asymmetry: number;
  rawMm: number;
  mm: number;
  conf: number;
  yaw: number;
  pitch: number;
  /** face centre offset from frame centre, in half-frame units (−1..1) */
  offX: number;
  offY: number;
  centered: boolean;
  luma: number; // 0..255 mean
  lumaOk: boolean;
  glare: boolean;
  inferMs: number;
  landmarks: Pt[] | null;
  frameW: number;
  frameH: number;
}

export interface TrackerStats {
  delegate: Delegate | 'none';
  engine: 'worker' | 'main' | 'none';
  detectFps: number;
  inferMsAvg: number;
  inferMsP95: number;
  frames: number;
}

export interface TrackerOptions {
  targetFps?: number;
  focalNorm: () => number | null;
  irisMm: () => number | null;
}

export class Tracker {
  targetFps: number;
  latest: TrackerFrame | null = null;
  private engine: Engine | null = null;
  private assets: ModelAssets | null = null;
  private running = false;
  private wasRunning = false;
  private busy = false;
  private credit = 1;
  private lastTick = 0;
  private lastVideoTime = -1;
  private rvfcId = 0;
  private timer = 0;
  private listeners = new Set<(f: TrackerFrame) => void>();
  private filter = new OneEuroFilter(0.8, 0.015, 1.0);
  private jitter = new Ring(20);
  private inferRing = new Ring(60);
  private inferSorted = new Float64Array(60);
  private stamps = new Ring(30);
  private lastStamp = 0;
  private frames = 0;
  private failures = 0;

  // reused buffers
  private pts: Pt[] = Array.from({ length: PTS }, () => ({ x: 0, y: 0, z: 0 }));
  private matrix = new Float32Array(16);
  private lumaCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private eyeCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private lastLuma = 128;
  private lastGlare = false;

  constructor(private video: HTMLVideoElement, private opts: TrackerOptions) {
    this.targetFps = opts.targetFps ?? 24;
    const mk = (w: number, h: number) =>
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    this.lumaCtx = mk(32, 24).getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    this.eyeCtx = mk(64, 16).getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** prefer: GPU/CPU delegate; mode: 'auto' tries the worker first, then the main thread. */
  async init(assets: ModelAssets, prefer: Delegate = 'GPU', mode: 'auto' | 'main' = 'auto'): Promise<Delegate> {
    this.assets = assets;
    if (mode === 'auto') {
      try {
        this.engine = await WorkerEngine.create(prefer, assets);
        return this.engine.delegate;
      } catch (e) {
        console.warn('[iriscale] worker inference unavailable, using main thread', e);
      }
    }
    const { MainThreadEngine } = await import('./engine-main');
    this.engine = await MainThreadEngine.create(prefer, assets);
    return this.engine.delegate;
  }

  get stats(): TrackerStats {
    // p95 from a reused buffer (no allocation in the hot path; this getter is called ≤ 4×/s)
    const n = this.inferRing.copyInto(this.inferSorted);
    const arr = this.inferSorted.subarray(0, n);
    arr.sort();
    const span = this.stamps.count > 1 ? this.stamps.mean() : 0;
    return {
      delegate: this.engine?.delegate ?? 'none',
      engine: this.engine?.kind ?? 'none',
      detectFps: span > 0 ? 1000 / span : 0,
      inferMsAvg: this.inferRing.mean(),
      inferMsP95: n ? arr[Math.min(n - 1, Math.floor(n * 0.95))] : 0,
      frames: this.frames,
    };
  }

  onFrame(cb: (f: TrackerFrame) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    if (this.running || !this.engine) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.rvfcId && 'cancelVideoFrameCallback' in this.video) this.video.cancelVideoFrameCallback(this.rvfcId);
    clearTimeout(this.timer);
    this.rvfcId = 0;
  }

  resetFilter(): void { this.filter.reset(); this.jitter.clear(); }

  dispose(): void {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.engine?.close();
    this.engine = null;
  }

  private onVisibility = () => {
    if (document.hidden) {
      this.wasRunning = this.running;
      this.stop();
      this.video.pause();
    } else if (this.wasRunning) {
      this.video.play().catch(() => undefined);
      this.resetFilter();
      this.start();
    }
  };

  private schedule(): void {
    if (!this.running) return;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      this.rvfcId = this.video.requestVideoFrameCallback(() => this.tick());
    } else {
      this.timer = window.setTimeout(() => this.tick(), 1000 / 60);
    }
  }

  private tick(): void {
    if (!this.running) return;
    const now = performance.now();
    // Credit-based rate cap: earns targetFps credits/s, so a 30 fps camera with a 24 fps cap
    // runs on 4 of every 5 frames instead of every other frame.
    if (this.lastTick) this.credit = Math.min(1.5, this.credit + ((now - this.lastTick) * this.targetFps) / 1000);
    this.lastTick = now;
    if (!this.busy && this.credit >= 1 && this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
      this.credit -= 1;
      this.lastVideoTime = this.video.currentTime;
      void this.process(now);
    }
    this.schedule();
  }

  private async process(now: number): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    this.busy = true;
    let res;
    try {
      res = await engine.detect(this.video, now);
    } catch (e) {
      console.warn('[iriscale] inference failed', e);
      res = null;
    } finally {
      this.busy = false;
    }
    if (!res) {
      // Some Android GPU drivers create the delegate fine and then fail at inference time.
      if (++this.failures >= 5 && engine.delegate === 'GPU') {
        this.failures = 0;
        this.stop();
        engine.close();
        this.engine = null;
        if (this.assets) void this.init(this.assets, 'CPU', engine.kind === 'worker' ? 'auto' : 'main').then(() => this.start());
      }
      return;
    }
    this.failures = 0;
    const { faces, out, inferMs } = res;
    this.inferRing.push(inferMs);
    const tDone = performance.now();
    if (this.lastStamp) this.stamps.push(tDone - this.lastStamp);
    this.lastStamp = tDone;
    this.frames++;

    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    // Pick the largest face (closest to the phone) if several are visible: cheek span 234↔454.
    let best = 0;
    if (faces > 1) {
      const span = (f: number) => Math.abs(out[f * PTS * 3 + 234 * 3] - out[f * PTS * 3 + 454 * 3]);
      best = span(1) > span(0) ? 1 : 0;
    }
    if (faces > 0) {
      const base = best * PTS * 3;
      for (let i = 0; i < PTS; i++) {
        const p = this.pts[i];
        p.x = out[base + i * 3]; p.y = out[base + i * 3 + 1]; p.z = out[base + i * 3 + 2];
      }
      for (let k = 0; k < 16; k++) this.matrix[k] = out[MATRIX_OFFSET + best * 16 + k];
    }
    engine.release(out);

    // Sample luminance / glare every 3rd inference — cheap, but not free on a slow phone.
    const sampleQuality = this.frames % 3 === 0;
    if (sampleQuality) this.lastLuma = this.sampleLuma(w, h);

    const frame: TrackerFrame = {
      t: now, faces, hasFace: faces > 0, irisPx: 0, asymmetry: 0, rawMm: 0,
      mm: this.latest?.mm ?? 0, conf: 0, yaw: 0, pitch: 0, offX: 0, offY: 0, centered: false,
      luma: this.lastLuma, lumaOk: this.lastLuma >= 60, glare: this.lastGlare, inferMs,
      landmarks: null, frameW: w, frameH: h,
    };

    const iris = faces > 0 ? measureIris(this.pts, w, h) : null;
    if (iris) {
      const pts = this.pts;
      const fN = this.opts.focalNorm() ?? DEFAULT_FOCAL_NORM;
      const irisMm = this.opts.irisMm() ?? POPULATION_IRIS_MM;
      const raw = distanceMm(focalPx(fN, w, h), irisMm, iris.irisPx);
      const mm = this.filter.filter(raw, now);
      // Noise, not motion: residual of the raw reading around the filtered track.
      this.jitter.push(Math.abs(raw - mm) / mm);
      const { yaw, pitch } = yawPitchFromMatrix(this.matrix);
      const cx = (pts[468].x + pts[473].x + pts[1].x) / 3;
      const cy = (pts[468].y + pts[473].y + pts[1].y) / 3;
      const offX = (cx - 0.5) * 2;
      const offY = (cy - 0.5) * 2;
      if (sampleQuality) this.lastGlare = this.sampleGlare(pts, w, h);
      const jitterRel = this.jitter.count > 4 ? this.jitter.mean() : 0;
      frame.irisPx = iris.irisPx; frame.asymmetry = iris.asymmetry; frame.rawMm = raw; frame.mm = mm;
      frame.yaw = yaw; frame.pitch = pitch; frame.offX = offX; frame.offY = offY;
      frame.centered = Math.abs(offX) < 0.3 && Math.abs(offY) < 0.35;
      frame.glare = this.lastGlare;
      frame.landmarks = pts;
      frame.conf = confidence({
        irisPx: iris.irisPx, asymmetry: iris.asymmetry, yawDeg: yaw, jitterRel,
        lumaOk: frame.lumaOk, glare: this.lastGlare, calibrated: this.opts.focalNorm() !== null,
      });
    } else {
      this.jitter.clear();
    }
    this.latest = frame;
    this.listeners.forEach((cb) => cb(frame));
  }

  /** Mean Rec.601 luma of a 32×24 thumbnail. */
  private sampleLuma(w: number, h: number): number {
    if (!w || !h) return this.lastLuma;
    const ctx = this.lumaCtx;
    ctx.drawImage(this.video, 0, 0, 32, 24);
    const d = ctx.getImageData(0, 0, 32, 24).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return s / (d.length / 4);
  }

  /**
   * Glasses-glare heuristic: crop a band across both eyes (outer canthi 33 ↔ 263) into a
   * 64×16 thumbnail and count near-saturated pixels. A corneal catch-light is a few pixels;
   * a lens reflection is a broad bright patch, so > ~5 % saturated ⇒ glare.
   */
  private sampleGlare(pts: Pt[], w: number, h: number): boolean {
    const a = pts[33], b = pts[263];
    const x0 = Math.min(a.x, b.x) * w, x1 = Math.max(a.x, b.x) * w;
    const bw = (x1 - x0) * 1.3;
    const bh = bw * 0.3;
    const cx = ((a.x + b.x) / 2) * w, cy = ((a.y + b.y) / 2) * h;
    const sx = Math.max(0, cx - bw / 2), sy = Math.max(0, cy - bh / 2);
    if (bw < 8) return false;
    const ctx = this.eyeCtx;
    ctx.drawImage(this.video, sx, sy, Math.min(bw, w - sx), Math.min(bh, h - sy), 0, 0, 64, 16);
    const d = ctx.getImageData(0, 0, 64, 16).data;
    let sat = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245) sat++;
    }
    return sat / (d.length / 4) > 0.05;
  }
}
