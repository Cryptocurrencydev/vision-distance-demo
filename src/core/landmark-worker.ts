/// <reference lib="webworker" />
/**
 * Inference worker: owns the MediaPipe Face Landmarker so a slow phone's ~30–80 ms inference
 * never blocks the UI thread. Built as a classic (IIFE) worker because MediaPipe's wasm loader
 * uses importScripts().
 *
 * Protocol (all buffers transferred, never copied):
 *   → {type:'init', wasm, model, prefer}
 *   ← {type:'ready', delegate} | {type:'error', message}
 *   → {type:'frame', bitmap, ts, out: Float32Array(2*478*3 + 2*16)}   (bitmap is closed here)
 *   ← {type:'result', faces, out, inferMs}                               (out ping-pongs back)
 */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let lm: FaceLandmarker | null = null;
let delegate: 'GPU' | 'CPU' = 'CPU';
const PTS = 478;

async function init(wasm: string, model: string, prefer: 'GPU' | 'CPU'): Promise<void> {
  const fileset = await FilesetResolver.forVisionTasks(wasm);
  const make = (d: 'GPU' | 'CPU') => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: model, delegate: d },
    runningMode: 'VIDEO', numFaces: 2,
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    outputFaceBlendshapes: false, outputFacialTransformationMatrixes: true,
    // GPU in a worker needs an OffscreenCanvas with WebGL2.
    ...(d === 'GPU' ? { canvas: new OffscreenCanvas(1, 1) } : {}),
  });
  if (prefer === 'GPU') {
    try { lm = await make('GPU'); delegate = 'GPU'; return; } catch { /* fall through */ }
  }
  lm = await make('CPU');
  delegate = 'CPU';
}

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      await init(msg.wasm, msg.model, msg.prefer);
      // Warm-up: the first inference compiles GPU shaders / JITs the graph (0.5–3 s on phones).
      // Do it now on a blank frame, before the user has even opened the camera.
      try {
        const blank = new OffscreenCanvas(640, 480);
        const bctx = blank.getContext('2d')!;
        bctx.fillStyle = '#808080';
        bctx.fillRect(0, 0, 640, 480);
        lm!.detectForVideo(blank.transferToImageBitmap(), 1);
      } catch { /* warm-up is best-effort */ }
      ctx.postMessage({ type: 'ready', delegate });
    } catch (err) {
      ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
    }
    return;
  }
  if (msg.type === 'frame') {
    const bitmap: ImageBitmap = msg.bitmap;
    const out: Float32Array = msg.out;
    let faces = 0;
    let inferMs = 0;
    try {
      if (lm) {
        const t0 = performance.now();
        const res = lm.detectForVideo(bitmap, msg.ts);
        inferMs = performance.now() - t0;
        faces = Math.min(2, res.faceLandmarks.length);
        for (let f = 0; f < faces; f++) {
          const pts = res.faceLandmarks[f];
          const base = f * PTS * 3;
          for (let i = 0; i < PTS; i++) {
            out[base + i * 3] = pts[i].x;
            out[base + i * 3 + 1] = pts[i].y;
            out[base + i * 3 + 2] = pts[i].z;
          }
          const m = res.facialTransformationMatrixes?.[f]?.data;
          if (m) out.set(m.slice(0, 16), 2 * PTS * 3 + f * 16);
        }
      }
    } catch (err) {
      ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err), out }, [out.buffer]);
      bitmap.close();
      return;
    }
    bitmap.close();
    ctx.postMessage({ type: 'result', faces, out, inferMs }, [out.buffer]);
  }
};
