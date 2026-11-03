const BASE = import.meta.env.BASE_URL;
export const WASM_PATH = `${BASE}mediapipe/wasm`;
export const MODEL_PATH = `${BASE}models/face_landmarker.task`;
export type Delegate = 'GPU' | 'CPU';
