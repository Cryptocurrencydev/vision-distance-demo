# TIMELOG — vision-distance-demo

All times local (WAT, UTC+1), 2026-11-03. Durations are wall-clock.

| # | Phase | Start | End | Duration | Notes |
|---|---|---|---|---|---|
| 0 | Setup & tooling check | 08:26:00 | 08:27:40 | 1m40s | Vite 8 + TS scaffold, @mediapipe/tasks-vision 1.2.0, wasm + face_landmarker.task self-hosted |
| 1 | Test fixtures | 08:27:40 | 08:31:38 | 4m | 2 AI-generated fictional portraits (Gemini 3 Pro Image via treg, $0.06 total), 4K → 2752 px JPEG |
| 2 | Core app (math, tracker, UI, 5 screens) | 08:31:38 | 08:37:40 | 6m | distance.ts, tracker.ts, camera.ts, storage.ts, optotype.ts, main.ts, styles.css, index.html |
| 3 | Build, CSP headers, accuracy harness + first run | 08:37:40 | 08:39:54 | 2m14s | pipeline MAE 2.1 %, known-distance calibrated MAE 1.0 %; limbus GT visually verified |
| 4 | Perf harness (fake camera, 390 px, CPU 4×) + fixes | 08:39:54 | 08:58:10 | 18m16s | found 720×720 crop of portrait fake video → switched to 1280×720 feed; moved inference to a Web Worker (UI 18–24 → 60 fps @ 4×, 0 long tasks); lazy main-thread fallback (main JS 188 → 33 kB); credit-based fps cap (15 → 22 fps); GPU warm-up gate; confidence jitter uses residual not motion; screen-card outline portrait |
| 5 | Layout fixes, accuracy re-run, README | 08:58:10 | 09:00:09 | | non-sticky calibration actions; README (architecture, method, limits, accuracy, perf, privacy, native mapping) |
