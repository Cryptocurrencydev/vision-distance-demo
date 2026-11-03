# Performance report

Generated 2026-11-03T08:43:55.989Z by `npm run test:perf`. Headless Chromium (Playwright), 390×844 viewport @ DPR 3, touch, Chrome fake camera fed a 1280×720 30 fps MJPEG of a face (test/make-fake-video.sh), production build via `vite preview`. CPU throttling via CDP `Emulation.setCPUThrottlingRate`. Detection cap 24 fps. Steady-state averages over 12 s after a 3 s warm-up.

| Config | Delegate | Inference thread | Detection fps | Inference avg / p95 (ms) | UI fps | Long tasks (>50 ms) | Full flow |
|---|---|---|---|---|---|---|---|
| main-auto-x4 | GPU | main | 13.0 | 67.5 / 71.0 | 17.3 | 200 (max 83 ms) | ✓ |
| main-cpu-x4 | CPU | main | 11.0 | 74.0 / 76.3 | 21.7 | 175 (max 89 ms) | ✓ |
| worker-auto-x4 | GPU | worker | 13.6 | 46.1 / 50.2 | 60.0 | 0 (max 0 ms) | ✓ |
| worker-cpu-x4 | CPU | worker | 22.3 | 15.9 / 16.9 | 59.8 | 0 (max 0 ms) | ✓ |
| worker-cpu-x1 | CPU | worker | 22.5 | 15.3 / 15.7 | 60.0 | 0 (max 0 ms) | ✓ |

**Caveats.** Headless Chromium has no hardware GPU, so the "GPU" delegate runs on SwiftShader (software WebGL) and is *slower* than CPU here; on real phones it is normally the faster option. CDP CPU throttling applies to the main thread; worker-thread inference does not appear to be throttled (compare main-thread vs worker inference ms at 4×), so the main-thread 4× row is the better proxy for inference cost on a mid-range Android phone (~45–75 ms). What the worker rows *do* show is the architectural point: inference off the main thread keeps the UI at 60 fps with zero long tasks, while main-thread inference drops the UI to roughly the detection rate.
