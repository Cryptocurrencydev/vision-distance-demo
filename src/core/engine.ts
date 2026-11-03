/**
 * Inference engines behind one async interface:
 *  - WorkerEngine (preferred): MediaPipe runs off the main thread; frames go over as transferred
 *    ImageBitmaps, landmarks come back in a single Float32Array that ping-pongs between threads.
 *  - MainThreadEngine (engine-main.ts, lazy-loaded fallback): same output shape, for browsers
 *    without OffscreenCanvas/worker support for the wasm loader.
 */
import { MODEL_PATH, WASM_PATH, type Delegate } from './paths';

export const PTS = 478;
export const OUT_LEN = 2 * PTS * 3 + 2 * 16;
export const MATRIX_OFFSET = 2 * PTS * 3;

export interface EngineResult { faces: number; out: Float32Array; inferMs: number }

export interface Engine {
  readonly delegate: Delegate;
  readonly kind: 'worker' | 'main';
  /** resolves with landmarks; `out` must be handed back via release() when done */
  detect(video: HTMLVideoElement, ts: number): Promise<EngineResult | null>;
  release(out: Float32Array): void;
  close(): void;
}

export class WorkerEngine implements Engine {
  readonly kind = 'worker' as const;
  delegate: Delegate = 'CPU';
  private worker: Worker;
  private spare: Float32Array | null = new Float32Array(OUT_LEN);
  private pending: ((r: EngineResult | null) => void) | null = null;

  private constructor() {
    this.worker = new Worker(new URL('./landmark-worker.ts', import.meta.url), { type: 'classic' });
  }

  static async create(prefer: Delegate): Promise<WorkerEngine> {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
      throw new Error('worker inference unsupported');
    }
    const eng = new WorkerEngine();
    const abs = (p: string) => new URL(p, location.href).href;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('worker init timeout')), 30000);
      eng.worker.onerror = (e) => { clearTimeout(t); reject(new Error(e.message || 'worker failed')); };
      eng.worker.onmessage = (e) => {
        clearTimeout(t);
        if (e.data.type === 'ready') { eng.delegate = e.data.delegate; resolve(); } else reject(new Error(e.data.message));
      };
      eng.worker.postMessage({ type: 'init', wasm: abs(WASM_PATH), model: abs(MODEL_PATH), prefer });
    });
    eng.worker.onmessage = (e) => {
      const cb = eng.pending;
      eng.pending = null;
      if (e.data.type === 'result') cb?.({ faces: e.data.faces, out: e.data.out, inferMs: e.data.inferMs });
      else { if (e.data.out) eng.spare = e.data.out; cb?.(null); }
    };
    return eng;
  }

  async detect(video: HTMLVideoElement, ts: number): Promise<EngineResult | null> {
    if (this.pending || !this.spare) return null; // back-pressure: one frame in flight
    const bitmap = await createImageBitmap(video);
    const out = this.spare;
    this.spare = null;
    return new Promise((resolve) => {
      this.pending = resolve;
      this.worker.postMessage({ type: 'frame', bitmap, ts, out }, [bitmap, out.buffer]);
    });
  }

  release(out: Float32Array): void { this.spare = out; }
  close(): void { this.worker.terminate(); }
}
