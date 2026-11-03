/** Main-thread fallback engine — lazy-loaded so MediaPipe's JS isn't in the main bundle. */
import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import { createLandmarker, type Delegate } from './tracker-shared';
import { MATRIX_OFFSET, OUT_LEN, PTS, type Engine, type EngineResult } from './engine';

export class MainThreadEngine implements Engine {
  readonly kind = 'main' as const;
  private out = new Float32Array(OUT_LEN);
  private constructor(private lm: FaceLandmarker, readonly delegate: Delegate) {}

  static async create(prefer: Delegate): Promise<MainThreadEngine> {
    const { landmarker, delegate } = await createLandmarker('VIDEO', prefer);
    return new MainThreadEngine(landmarker, delegate);
  }

  async detect(video: HTMLVideoElement, ts: number): Promise<EngineResult | null> {
    const t0 = performance.now();
    const res = this.lm.detectForVideo(video, ts);
    const inferMs = performance.now() - t0;
    const faces = Math.min(2, res.faceLandmarks.length);
    const out = this.out;
    for (let f = 0; f < faces; f++) {
      const pts = res.faceLandmarks[f];
      for (let i = 0; i < PTS; i++) {
        const b = f * PTS * 3 + i * 3;
        out[b] = pts[i].x; out[b + 1] = pts[i].y; out[b + 2] = pts[i].z;
      }
      const m = res.facialTransformationMatrixes?.[f]?.data;
      if (m) for (let k = 0; k < 16; k++) out[MATRIX_OFFSET + f * 16 + k] = m[k];
    }
    return { faces, out, inferMs };
  }

  release(): void { /* single buffer, nothing to do */ }
  close(): void { this.lm.close(); }
}
