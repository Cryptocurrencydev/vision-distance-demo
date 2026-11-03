import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

import { MODEL_PATH, WASM_PATH, type Delegate } from './paths';
import type { ModelAssets } from './preload';

export { MODEL_PATH, WASM_PATH, type Delegate };

/** Main-thread landmarker (used by the fallback engine and the accuracy harness). */
export async function createLandmarker(
  mode: 'VIDEO' | 'IMAGE', prefer: Delegate = 'GPU', numFaces = 2, assets?: ModelAssets,
): Promise<{ landmarker: FaceLandmarker; delegate: Delegate }> {
  const fileset = assets
    ? { wasmLoaderPath: assets.loaderUrl, wasmBinaryPath: URL.createObjectURL(new Blob([assets.wasm], { type: 'application/wasm' })) }
    : await FilesetResolver.forVisionTasks(WASM_PATH);
  const make = (delegate: Delegate) => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: assets ? { modelAssetBuffer: new Uint8Array(assets.model), delegate } : { modelAssetPath: MODEL_PATH, delegate },
    runningMode: mode,
    numFaces,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
  });
  if (prefer === 'GPU') {
    try {
      return { landmarker: await make('GPU'), delegate: 'GPU' };
    } catch (e) {
      console.warn('[iriscale] GPU delegate unavailable, falling back to CPU', e);
    }
  }
  return { landmarker: await make('CPU'), delegate: 'CPU' };
}
