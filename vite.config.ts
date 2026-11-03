import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2020', sourcemap: true },
  server: { host: true },
  // MediaPipe's bundle is large and already minified — keep it out of dep pre-bundling churn.
  // MediaPipe's wasm loader calls importScripts(), so the inference worker must be classic (IIFE).
  worker: { format: 'iife' },
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
});
