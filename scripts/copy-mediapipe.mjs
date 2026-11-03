// Copies the MediaPipe wasm runtime from node_modules into public/ so it is self-hosted
// (no CDN requests — part of the privacy posture). Runs on postinstall and before build/dev.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
const src = 'node_modules/@mediapipe/tasks-vision/wasm';
const dst = 'public/mediapipe/wasm';
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) {
  if (f.includes('_module_')) continue; // ES-module variant unused (FilesetResolver default)
  cpSync(`${src}/${f}`, `${dst}/${f}`);
}
console.log('[copy-mediapipe] wasm runtime →', dst);
