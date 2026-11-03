/**
 * Downloads the MediaPipe wasm binary and the face model ourselves, with byte-level progress,
 * so the welcome screen can show a real progress bar on a slow mobile connection. The bytes are
 * then handed straight to MediaPipe (blob URL for the wasm, a buffer for the model), so nothing
 * is downloaded twice and nothing depends on HTTP-cache behaviour.
 * Only this site's own static files are fetched; nothing is sent anywhere.
 */
import { MODEL_PATH, WASM_PATH } from './paths';

export interface ModelAssets {
  /** absolute URL of the wasm loader script (small; MediaPipe imports it itself) */
  loaderUrl: string;
  wasm: ArrayBuffer;
  model: ArrayBuffer;
  simd: boolean;
}

// Decompressed sizes (Vercel serves brotli, and content-length then reflects compressed bytes),
// used only to scale the progress bar.
const EXPECTED = { simd: 14_466_654, nosimd: 12_915_401, model: 3_758_596 };

/** Same feature test MediaPipe uses (wasm-feature-detect "simd"). */
function hasWasmSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch {
    return false;
  }
}

async function fetchWithProgress(url: string, expected: number, onBytes: (n: number, total: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const enc = res.headers.get('content-encoding');
  const len = Number(res.headers.get('content-length'));
  const total = !enc && len > 0 ? len : expected;
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onBytes(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    onBytes(got, Math.max(total, got));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  onBytes(got, got);
  return out.buffer;
}

export async function preloadModel(onProgress: (fraction: number, loadedBytes: number) => void): Promise<ModelAssets> {
  const simd = hasWasmSimd();
  const name = simd ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
  const abs = (p: string) => new URL(p, location.href).href;
  const prog = { wasm: [0, simd ? EXPECTED.simd : EXPECTED.nosimd], model: [0, EXPECTED.model] };
  const report = () => {
    const loaded = prog.wasm[0] + prog.model[0];
    const total = prog.wasm[1] + prog.model[1];
    onProgress(Math.min(1, loaded / total), loaded);
  };
  const [wasm, model] = await Promise.all([
    fetchWithProgress(abs(`${WASM_PATH}/${name}.wasm`), prog.wasm[1], (n, t) => { prog.wasm = [n, t]; report(); }),
    fetchWithProgress(abs(MODEL_PATH), prog.model[1], (n, t) => { prog.model = [n, t]; report(); }),
  ]);
  return { loaderUrl: abs(`${WASM_PATH}/${name}.js`), wasm, model, simd };
}
