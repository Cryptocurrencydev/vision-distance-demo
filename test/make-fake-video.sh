#!/usr/bin/env bash
# Builds a Motion-JPEG fake camera stream (1280x720, as phones deliver before rotation, 30 fps, 8 s loop) from a still
# fixture, scaling the face over time so the simulated distance sweeps ~34–49 cm and lingers
# near 40 cm. Chrome plays it via --use-file-for-fake-video-capture.
set -euo pipefail
cd "$(dirname "$0")"
SRC=${1:-fixtures/face1.jpg}
OUT=${2:-out/fake-camera.mjpeg}
mkdir -p "$(dirname "$OUT")"
# 1137 px width ⇒ iris ≈ 28.3 px ⇒ 40 cm for the default focal (0.755 × 1280 px).
ffmpeg -loglevel error -y \
  -f lavfi -i "color=c=0x9aa0a3:s=1280x720:r=30:d=8" \
  -loop 1 -framerate 30 -t 8 -i "$SRC" \
  -filter_complex "[1:v]scale=w='trunc(1137*(1+0.18*pow(sin(2*PI*t/8),3))/2)*2':h=-2:eval=frame[f];[0:v][f]overlay=x='640-0.425*w':y='330-0.41*h':shortest=1:eval=frame,format=yuvj420p" \
  -c:v mjpeg -q:v 3 -f mjpeg "$OUT"
ls -la "$OUT"
