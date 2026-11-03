# Accuracy report

Generated 2026-11-03T07:58:32.839Z by `npm run test:accuracy` (MediaPipe CPU delegate, synthetic 720x1280 portrait frames, JPEG q0.82, 192 frames, 6 s).

Ground-truth iris width per fixture comes from classical limbus edge detection on the 2752 px source, independent of MediaPipe.

| Fixture | Limbus GT (px) | MediaPipe iris (px) | Landmark vs limbus |
|---|---|---|---|
| face1.jpg | 68.55 | 71.36 | +4.1 % |
| face2.jpg | 59.10 | 57.92 | -2.0 % |

## Summary (all distances 25–70 cm, both faces, 3 positions each)

| Scenario | Bias | Mean abs. error | p95 abs. error | Max abs. error | Detected |
|---|---|---|---|---|---|
| Camera & eye match defaults (pipeline error only) | -0.5 % | 2.1 % | 3.9 % | 4.0 % | 48/48 |
| Uncalibrated: camera focal +10 %, iris 12.2 mm | -13.4 % | 13.4 % | 16.3 % | 16.5 % | 48/48 |
| Card-at-face calibration only (same mismatch) | -9.7 % | 9.7 % | 11.3 % | 12.8 % | 48/48 |
| Known-distance calibration at 40 cm (same mismatch) | +0.6 % | 1.0 % | 2.7 % | 3.3 % | 48/48 |

## Error by distance

| Distance | Iris (px) | pipeline | uncal-mismatch | card-only | known-40 |
|---|---|---|---|---|---|
| 25 cm | 45.3 | -2.2 % (MAE 2.6) | -14.7 % (MAE 14.7) | -11.2 % (MAE 11.2) | -1.0 % (MAE 1.0) |
| 30 cm | 37.7 | -0.3 % (MAE 2.3) | -13.5 % (MAE 13.5) | -9.9 % (MAE 9.9) | +0.4 % (MAE 0.5) |
| 35 cm | 32.3 | -0.6 % (MAE 2.4) | -13.4 % (MAE 13.4) | -9.8 % (MAE 9.8) | +0.6 % (MAE 0.8) |
| 40 cm | 28.3 | -1.0 % (MAE 2.4) | -13.6 % (MAE 13.6) | -9.9 % (MAE 9.9) | +0.4 % (MAE 0.5) |
| 45 cm | 25.1 | -0.1 % (MAE 1.4) | -13.6 % (MAE 13.6) | -10.0 % (MAE 10.0) | +0.3 % (MAE 0.6) |
| 50 cm | 22.6 | +0.1 % (MAE 2.1) | -12.9 % (MAE 12.9) | -9.3 % (MAE 9.3) | +1.1 % (MAE 1.1) |
| 60 cm | 18.9 | +0.6 % (MAE 2.1) | -12.1 % (MAE 12.1) | -8.4 % (MAE 8.4) | +2.1 % (MAE 2.1) |
| 70 cm | 16.2 | -0.6 % (MAE 1.7) | -13.2 % (MAE 13.2) | -9.5 % (MAE 9.5) | +0.8 % (MAE 1.0) |
