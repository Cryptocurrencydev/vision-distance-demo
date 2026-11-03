import './styles.css';
import { openFrontCamera, CameraError, type CameraHandle } from './core/camera';
import { Tracker, type TrackerFrame } from './core/tracker';
import {
  BANK_CARD_MM, DEFAULT_FOCAL_NORM, POPULATION_IRIS_MM, Ring, confidenceLabel,
  focalFromKnownDistance, irisMmFromCard, optotypeHeightMm, snellen20,
} from './core/distance';
import { loadCalibration, saveCalibration, clearCalibration, type Calibration } from './core/storage';
import { drawE, EStaircase, LEVELS, type Dir } from './core/optotype';

// ───────────────────────────── setup ─────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const TARGET_MM = 400;
const BAND_LO = 380;
const BAND_HI = 420;

type Screen = 'welcome' | 'calibrate' | 'guide' | 'check' | 'results';
let screen: Screen = 'welcome';
let calib: Calibration = loadCalibration();
let cam: CameraHandle | null = null;
let tracker: Tracker | null = null;
const video = $<HTMLVideoElement>('cam');

/** camera-specific focal: ignore a stored focal length that belongs to another camera */
const focalNorm = (): number | null =>
  calib.focalNorm && (!calib.cameraLabel || !cam?.label || calib.cameraLabel === cam.label) ? calib.focalNorm : null;
const irisMm = (): number | null => calib.irisMm;
/** CSS px per mm. Uncalibrated fallback: ~160 CSS dpi on phones, 96 on desktop. */
const ppmm = (): number => calib.ppmm ?? (matchMedia('(pointer: coarse)').matches ? 6.2 : 96 / 25.4);

// ───────────────────────────── measurement log ─────────────────────────────
interface LogEntry {
  t: number; phase: Screen; mm: number; rawMm: number; conf: number; irisPx: number;
  luma: number; lumaOk: boolean; centered: boolean; faces: number; glare: boolean;
}
const log: LogEntry[] = [];
const LOG_MAX = 3000;
let t0 = 0;
let lastLogT = 0;
const rawIris = new Ring(15); // recent raw iris px for calibration captures

function onTrackerFrame(f: TrackerFrame): void {
  if (f.hasFace) rawIris.push(f.irisPx); else rawIris.clear();
  if (screen !== 'guide' && screen !== 'check') return;
  if (f.t - lastLogT < 200) return; // 5 Hz log
  lastLogT = f.t;
  if (log.length >= LOG_MAX) log.shift();
  log.push({
    t: (f.t - t0) / 1000, phase: screen, mm: f.hasFace ? f.mm : NaN, rawMm: f.hasFace ? f.rawMm : NaN,
    conf: f.conf, irisPx: f.irisPx, luma: f.luma, lumaOk: f.lumaOk, centered: f.hasFace && f.centered,
    faces: f.faces, glare: f.glare,
  });
}

// ───────────────────────────── navigation ─────────────────────────────
const slotFor: Partial<Record<Screen, string>> = { guide: 'slot-guide', check: 'slot-check' };

function show(next: Screen): void {
  screen = next;
  document.querySelectorAll<HTMLElement>('.screen').forEach((s) => { s.hidden = s.dataset.screen !== next; });
  const slotId = next === 'calibrate' ? (activeTab === 'card' ? 'slot-card' : 'slot-known') : slotFor[next];
  placeVideo(slotId);
  const h = document.querySelector<HTMLElement>(`[data-screen="${next}"] h1, [data-screen="${next}"] .eyebrow`);
  window.scrollTo(0, 0);
  h?.setAttribute('tabindex', '-1');
  h?.focus({ preventScroll: true });
  if (next === 'calibrate') renderCalStatus();
  if (next === 'guide') enterGuide();
  if (next === 'check') enterCheck();
  if (next === 'results') renderResults();
}

function placeVideo(slotId?: string): void {
  if (slotId) $(slotId).appendChild(video);
  else document.body.appendChild(video);
}

// ───────────────────────────── welcome ─────────────────────────────
// Start downloading + compiling + warming the model as soon as the page opens, while the user
// reads the welcome screen. Only our own static files are fetched; the camera stays off.
tracker = new Tracker(video, { focalNorm, irisMm, targetFps: Number(params.get('fps')) || 24 });
tracker.onFrame(onTrackerFrame);
let modelReady = false;
const trackerReady = tracker
  .init(params.get('cpu') === '1' ? 'CPU' : 'GPU', params.get('main') === '1' ? 'main' : 'auto')
  .then((d) => { modelReady = true; return d; });
trackerReady.catch(() => undefined); // surfaced when the user taps Start

$('btn-start').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('btn-start');
  const status = $('start-status');
  btn.disabled = true;
  status.textContent = modelReady ? 'Starting camera…' : 'Starting camera and finishing the on-device model…';
  try {
    const [camHandle, delegate] = await Promise.all([openFrontCamera(video), trackerReady]);
    cam = camHandle;
    tracker!.start();
    // The engine already ran a warm-up pass on a blank frame; wait for the first real result.
    status.textContent = 'Warming up the on-device model…';
    await new Promise<void>((res) => {
      const t = setTimeout(res, 15000);
      const off = tracker!.onFrame(() => { clearTimeout(t); off(); res(); });
    });
    status.textContent = `Ready · ${delegate} inference (${tracker!.stats.engine === 'worker' ? 'background thread' : 'main thread'})`;
    t0 = performance.now();
    startUiLoop();
    show('calibrate');
  } catch (e) {
    btn.disabled = false;
    const msg = e instanceof CameraError
      ? ({
        denied: 'Camera access was blocked. Allow camera access for this site in your browser settings, then try again.',
        notfound: 'No front camera was found on this device.',
        insecure: 'The camera only works over HTTPS.',
        unsupported: 'This browser cannot use the camera. Try Chrome on Android or Safari on iOS.',
        other: e.message,
      } as const)[e.kind]
      : `Could not load the face model: ${(e as Error).message}`;
    status.textContent = msg;
  }
});

// ───────────────────────────── calibration ─────────────────────────────
let activeTab: 'screen' | 'card' | 'known' = 'screen';
const tabs = ['screen', 'card', 'known'] as const;

function selectTab(name: typeof tabs[number]): void {
  activeTab = name;
  tabs.forEach((t) => {
    const tab = $(`tab-${t}`);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  });
  if (name === 'card') placeVideo('slot-card');
  if (name === 'known') placeVideo('slot-known');
}
tabs.forEach((t, i) => {
  const tab = $(`tab-${t}`);
  tab.addEventListener('click', () => selectTab(t));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    selectTab(n);
    $(`tab-${n}`).focus();
  });
});

function renderCalStatus(): void {
  const f = focalNorm();
  const items = [
    ['Screen', calib.ppmm ? `${calib.ppmm.toFixed(2)} px/mm` : 'Estimated', !!calib.ppmm],
    ['Iris size', calib.irisMm ? `${calib.irisMm.toFixed(1)} mm` : `${POPULATION_IRIS_MM} mm avg`, !!calib.irisMm],
    ['Camera', f ? `f = ${f.toFixed(3)}` : 'Typical phone', !!f],
  ] as const;
  $('cal-status').innerHTML = items
    .map(([k, v, ok]) => `<div class="${ok ? 'ok' : ''}"><span>${k}</span><b>${ok ? '✓ ' : ''}${v}</b></div>`)
    .join('');
}

// Screen calibration (card on glass)
const cardRange = $<HTMLInputElement>('card-range');
const cardOutline = $('card-outline');
/** The card is laid upright (phones are narrower than 85.6 mm); `px` is its long edge, vertical. */
function setOutline(px: number): void {
  px = Math.max(200, Math.min(900, px));
  cardRange.value = String(Math.round(px));
  cardOutline.style.height = `${px}px`;
  cardRange.setAttribute('aria-valuetext', `${Math.round(px)} pixels tall`);
}
setOutline(ppmm() * BANK_CARD_MM);
cardRange.addEventListener('input', () => setOutline(Number(cardRange.value)));
$('card-minus').addEventListener('click', () => setOutline(Number(cardRange.value) - 1));
$('card-plus').addEventListener('click', () => setOutline(Number(cardRange.value) + 1));
$('btn-save-screen').addEventListener('click', () => {
  calib.ppmm = Number(cardRange.value) / BANK_CARD_MM;
  calib.ppmmSource = 'card';
  const ok = saveCalibration(calib);
  renderCalStatus();
  $('btn-save-screen').textContent = ok ? 'Saved ✓' : 'Saved for this session (storage unavailable)';
});

// Option A — card at face
const capCanvas = $<HTMLCanvasElement>('capture-canvas');
const edgeL = $('edge-l');
const edgeR = $('edge-r');
let capIrisPx = 0;
let edgeXs = [0.35, 0.65]; // fraction of displayed width

function layoutEdges(): void {
  const w = capCanvas.clientWidth;
  edgeL.style.left = `${edgeXs[0] * w}px`;
  edgeR.style.left = `${edgeXs[1] * w}px`;
  edgeL.setAttribute('aria-valuenow', String(Math.round(edgeXs[0] * 100)));
  edgeR.setAttribute('aria-valuenow', String(Math.round(edgeXs[1] * 100)));
}
function dragEdge(el: HTMLElement, idx: 0 | 1): void {
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = capCanvas.getBoundingClientRect();
      edgeXs[idx] = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      layoutEdges();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true });
  });
  el.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 10 : 1) / Math.max(1, capCanvas.clientWidth);
    if (e.key === 'ArrowLeft') edgeXs[idx] -= step;
    else if (e.key === 'ArrowRight') edgeXs[idx] += step;
    else return;
    e.preventDefault();
    layoutEdges();
  });
}
dragEdge(edgeL, 0);
dragEdge(edgeR, 1);

$('btn-capture').addEventListener('click', () => {
  const msg = $('card-msg');
  if (!cam || !tracker?.latest?.hasFace || rawIris.count < 5) {
    msg.textContent = 'No face detected yet — hold the phone at arm\'s length, facing you.';
    return;
  }
  if (!capCanvas.hidden) { // retake
    capCanvas.hidden = true; edgeL.hidden = true; edgeR.hidden = true;
    $('slot-card').hidden = false;
    $('btn-capture').textContent = 'Capture';
    $<HTMLButtonElement>('btn-save-card').disabled = true;
    return;
  }
  capIrisPx = rawIris.mean();
  capCanvas.width = video.videoWidth;
  capCanvas.height = video.videoHeight;
  capCanvas.getContext('2d')!.drawImage(video, 0, 0);
  capCanvas.hidden = false; edgeL.hidden = false; edgeR.hidden = false;
  $('slot-card').hidden = true;
  edgeXs = [0.35, 0.65];
  layoutEdges();
  $('btn-capture').textContent = 'Retake';
  $<HTMLButtonElement>('btn-save-card').disabled = false;
  msg.textContent = `Iris measured at ${capIrisPx.toFixed(1)} px. Now line up the yellow lines with the card edges.`;
});
$('btn-save-card').addEventListener('click', () => {
  const displayedPx = Math.abs(edgeXs[1] - edgeXs[0]) * capCanvas.clientWidth;
  const cardPx = displayedPx * (capCanvas.width / capCanvas.clientWidth);
  const mm = irisMmFromCard(capIrisPx, cardPx);
  const msg = $('card-msg');
  if (!(mm > 9.5 && mm < 14)) {
    msg.textContent = `That gives an iris of ${mm.toFixed(1)} mm, outside the human range (≈10–13.5 mm). Check the card is beside your eye, not in front of it, and retake.`;
    return;
  }
  calib.irisMm = mm;
  calib.irisSource = 'card';
  saveCalibration(calib);
  renderCalStatus();
  // Clear the captured pixels immediately — nothing is kept.
  capCanvas.getContext('2d')!.clearRect(0, 0, capCanvas.width, capCanvas.height);
  capCanvas.width = 1; capCanvas.height = 1;
  capCanvas.hidden = true; edgeL.hidden = true; edgeR.hidden = true;
  $('slot-card').hidden = false;
  $('btn-capture').textContent = 'Capture';
  $<HTMLButtonElement>('btn-save-card').disabled = true;
  msg.textContent = `Saved: your iris ≈ ${mm.toFixed(1)} mm (average is ${POPULATION_IRIS_MM} mm). Captured frame discarded.`;
});
window.addEventListener('resize', () => { if (!capCanvas.hidden) layoutEdges(); });

// Option B — known distance
$('btn-known').addEventListener('click', async () => {
  const msg = $('known-msg');
  const cm = Number(($<HTMLInputElement>('known-cm')).value);
  if (!(cm >= 20 && cm <= 100)) { msg.textContent = 'Enter a distance between 20 and 100 cm.'; return; }
  if (!cam || !tracker) return;
  msg.textContent = 'Hold still…';
  // Collect ~1 s of face frames (up to 2.5 s on slow phones); a dropped frame doesn't reset it.
  const samples = new Ring(24);
  const off = tracker.onFrame((fr) => { if (fr.hasFace) samples.push(fr.irisPx); });
  const tStart = performance.now();
  while (performance.now() - tStart < 2500 && !(samples.count >= 12 && performance.now() - tStart > 1000)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  off();
  if (samples.count < 8) { msg.textContent = 'Face not detected steadily — try again with better light.'; return; }
  const jitter = samples.std() / samples.mean();
  const f = focalFromKnownDistance(cm * 10, samples.mean(), calib.irisMm ?? POPULATION_IRIS_MM, video.videoWidth, video.videoHeight);
  if (!(f > 0.35 && f < 2.0)) { msg.textContent = `Unexpected result (f = ${f.toFixed(2)}). Check the distance and try again.`; return; }
  calib.focalNorm = f;
  calib.focalSource = 'known-distance';
  calib.cameraLabel = cam.label;
  saveCalibration(calib);
  tracker.resetFilter();
  renderCalStatus();
  const delta = ((f / DEFAULT_FOCAL_NORM) - 1) * 100;
  msg.textContent = `Saved. This camera's focal length is ${delta >= 0 ? '+' : ''}${delta.toFixed(0)}% vs. the typical-phone default${jitter > 0.03 ? ' (measurement was a bit shaky — repeat for best accuracy)' : ''}.`;
});

$('btn-cal-next').addEventListener('click', () => show('guide'));
$('btn-cal-skip').addEventListener('click', () => show('guide'));
$('btn-cal-reset').addEventListener('click', () => {
  clearCalibration();
  calib = loadCalibration();
  setOutline(ppmm() * BANK_CARD_MM);
  tracker?.resetFilter();
  renderCalStatus();
});

// ───────────────────────────── live UI loop ─────────────────────────────
let uiRaf = 0;
let uiFrames = 0;
let uiFpsT = performance.now();
let uiFps = 0;
let noFaceSince = 0;

function startUiLoop(): void {
  const loop = (now: number) => {
    uiFrames++;
    if (now - uiFpsT >= 1000) { uiFps = (uiFrames * 1000) / (now - uiFpsT); uiFrames = 0; uiFpsT = now; }
    const f = tracker?.latest ?? null;
    if (f && !f.hasFace) { if (!noFaceSince) noFaceSince = now; } else noFaceSince = 0;
    if (screen === 'guide') renderGuide(f, now);
    else if (screen === 'check') renderCheck(f, now);
    uiRaf = requestAnimationFrame(loop);
  };
  cancelAnimationFrame(uiRaf);
  uiRaf = requestAnimationFrame(loop);
}

type Zone = 'none' | 'near' | 'ok' | 'far';
const zoneOf = (f: TrackerFrame | null): Zone =>
  !f?.hasFace || !f.mm ? 'none' : f.mm < BAND_LO ? 'near' : f.mm > BAND_HI ? 'far' : 'ok';

function warningsFor(f: TrackerFrame | null, now: number): Array<[string, 'warn' | 'bad']> {
  const w: Array<[string, 'warn' | 'bad']> = [];
  if (!f) return w;
  if (!f.hasFace && noFaceSince && now - noFaceSince > 800) w.push(['No face found — look at the screen with both eyes visible.', 'bad']);
  if (f.faces > 1) w.push(['More than one face in view — only the person being measured should be visible.', 'bad']);
  if (!f.lumaOk) w.push(['Low light — face a window or lamp for a reliable reading.', 'warn']);
  if (f.hasFace && !f.centered) w.push(['Centre your face in the circle.', 'warn']);
  if (f.hasFace && f.glare) w.push(['Glare on glasses — tilt the phone slightly or reduce overhead light.', 'warn']);
  if (f.hasFace && Math.abs(f.yaw) > 20) w.push(['Face the screen straight on.', 'warn']);
  return w;
}

let lastWarnKey = '';
function renderWarnings(el: HTMLElement, f: TrackerFrame | null, now: number): void {
  const w = warningsFor(f, now);
  const key = w.map((x) => x[0]).join('|');
  if (key === lastWarnKey) return;
  lastWarnKey = key;
  el.innerHTML = w.map(([m, lvl]) => `<li class="${lvl === 'bad' ? 'bad' : ''}">${m}</li>`).join('');
}

// ───────────────────────────── guide ─────────────────────────────
const RING_C = 2 * Math.PI * 112;
let inBandSince = 0;
let lastZone: Zone = 'none';
let lastAnnounce = 0;
let lastDistText = '';

function enterGuide(): void {
  inBandSince = 0;
  lastZone = 'none';
  lastWarnKey = '_';
  $('ring-zone').style.strokeDasharray = `${RING_C}`;
  const b = $<HTMLButtonElement>('btn-guide-next');
  b.disabled = true;
  b.textContent = 'Hold steady at 40 cm…';
}

function renderGuide(f: TrackerFrame | null, now: number): void {
  const zone = zoneOf(f);
  const mm = f?.hasFace ? f.mm : 0;
  const distText = mm ? (mm / 10).toFixed(mm < 1000 ? 1 : 0) : '--';
  if (distText !== lastDistText) { $('dist-num').textContent = distText; lastDistText = distText; }

  const ringWrap = $('ring-zone').closest('.ring-wrap') as HTMLElement;
  ringWrap.classList.toggle('ok', zone === 'ok');
  ringWrap.classList.toggle('near', zone === 'near');
  ringWrap.classList.toggle('far', zone === 'far');
  const fill = mm ? Math.max(0.04, 1 - Math.min(1, Math.abs(mm - TARGET_MM) / 200)) : 0;
  $('ring-zone').style.strokeDashoffset = String(RING_C * (1 - (zone === 'ok' ? 1 : fill)));

  const marker = $('ruler-marker');
  marker.style.left = `${Math.max(0, Math.min(100, ((mm / 10 - 20) / 40) * 100))}%`;
  marker.style.opacity = mm ? '1' : '0';

  const label = $('zone-label');
  const text = { none: 'Looking for your face…', near: 'Move the phone further away', far: 'Bring the phone closer', ok: 'Perfect — hold it there' }[zone];
  if (label.textContent !== text) { label.textContent = text; label.className = `zone-label ${zone}`; }

  const conf = $('conf');
  const cl = f?.hasFace ? confidenceLabel(f.conf) : null;
  const confText = cl ? `Confidence: ${cl}` : 'Confidence —';
  if ($('conf-text').textContent !== confText) { $('conf-text').textContent = confText; conf.className = `conf ${cl ?? ''}`; }

  drawIrisOverlay(f);
  renderWarnings($('warnings-guide'), f, now);

  if (zone !== lastZone) {
    if (zone === 'ok') {
      inBandSince = now;
      try { navigator.vibrate?.(reducedMotion.matches ? 0 : 25); } catch { /* unsupported */ }
    }
    if (now - lastAnnounce > 1500 || zone === 'ok') { $('guide-live').textContent = `${text}. ${distText} centimetres.`; lastAnnounce = now; }
    lastZone = zone;
  }
  const b = $<HTMLButtonElement>('btn-guide-next');
  // Latches once the user has held 38–42 cm for 1.2 s; the check itself re-scales letters to the
  // live distance and pauses if the user drifts too far, so the gate needn't re-lock.
  const ready = zone === 'ok' && now - inBandSince > 1200;
  if (zone !== 'ok') inBandSince = 0;
  if (ready && b.disabled) { b.disabled = false; b.textContent = 'Start the near-vision check'; }
}

/** Draws the detected iris circles on the circular preview (mirrored, object-fit: cover). */
const overlay = $('overlay-guide') as unknown as SVGSVGElement;
const irisEls: SVGCircleElement[] = [];
function drawIrisOverlay(f: TrackerFrame | null): void {
  if (!irisEls.length) {
    for (let i = 0; i < 2; i++) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', '#38e0c0');
      c.setAttribute('stroke-width', '0.7');
      overlay.appendChild(c);
      irisEls.push(c);
    }
  }
  const lm = f?.landmarks;
  if (!lm || !f) { irisEls.forEach((c) => c.setAttribute('r', '0')); return; }
  // viewBox is 0..100 square with "slice" → cover. Map normalised video coords into it.
  const aspect = f.frameW / f.frameH;
  const sx = aspect >= 1 ? 100 * aspect : 100;
  const sy = aspect >= 1 ? 100 : 100 / aspect;
  const ox = (100 - sx) / 2;
  const oy = (100 - sy) / 2;
  [[468, 469, 471], [473, 474, 476]].forEach(([c, a, b], i) => {
    const x = 100 - (ox + lm[c].x * sx); // mirrored
    const y = oy + lm[c].y * sy;
    const r = (Math.hypot((lm[a].x - lm[b].x) * sx, (lm[a].y - lm[b].y) * sy)) / 2;
    irisEls[i].setAttribute('cx', x.toFixed(2));
    irisEls[i].setAttribute('cy', y.toFixed(2));
    irisEls[i].setAttribute('r', r.toFixed(2));
  });
}

$('btn-guide-next').addEventListener('click', () => show('check'));

// ───────────────────────────── near-vision check ─────────────────────────────
const optCanvas = $<HTMLCanvasElement>('optotype');
const optCtx = optCanvas.getContext('2d', { alpha: false })!;
let stair = new EStaircase();
let drawnKey = '';
let blankUntil = 0;
let checkPaused = false;

function enterCheck(): void {
  stair = new EStaircase();
  drawnKey = '';
  sizeOptCanvas();
  updateProgress();
  $('optotype-stage').focus({ preventScroll: true });
}

function sizeOptCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const r = optCanvas.getBoundingClientRect();
  optCanvas.width = Math.round(r.width * dpr);
  optCanvas.height = Math.round(r.height * dpr);
  drawnKey = '';
}
window.addEventListener('resize', () => { if (screen === 'check') sizeOptCanvas(); });

function liveDistanceMm(f: TrackerFrame | null): number { return f?.hasFace ? f.mm : 0; }

function renderCheck(f: TrackerFrame | null, now: number): void {
  const mm = liveDistanceMm(f);
  const zone = zoneOf(f);
  $('check-dist').textContent = mm ? (mm / 10).toFixed(1) : '--';
  $('check-dot').className = `dot ${zone === 'ok' ? 'high' : zone === 'none' ? 'low' : 'medium'}`;

  // Allow a wider band during the check (letters are rescaled live), pause outside it.
  const pause = !mm || mm < 300 || mm > 550;
  if (pause !== checkPaused) {
    checkPaused = pause;
    $('check-paused').hidden = !pause;
    $('check-paused-msg').textContent = !mm ? 'Face not visible — look at the screen' : mm < 300 ? 'Too close — move the phone back to about 40 cm' : 'Too far — bring the phone to about 40 cm';
  }
  if (pause || stair.done) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = optCanvas.width / dpr;
  const cssH = optCanvas.height / dpr;
  const letterMm = optotypeHeightMm(stair.level, mm);
  const sizeCss = letterMm * ppmm();
  const blank = now < blankUntil;
  // Redraw only when the physical size changes by > 0.5 % (or the letter changes).
  const key = `${stair.trials.length}|${blank}|${Math.round(sizeCss * 200)}`;
  if (key === drawnKey) return;
  drawnKey = key;
  drawE(optCtx, cssW, cssH, dpr, blank ? 0 : sizeCss, stair.dir);
  optCanvas.setAttribute('aria-label', `Letter E, level ${stair.letterInLevel} of up to 3 at logMAR ${stair.level.toFixed(1)}`);
}

function answer(a: Dir | 'unsure'): void {
  if (screen !== 'check' || stair.done || checkPaused || performance.now() < blankUntil) return;
  const mm = liveDistanceMm(tracker?.latest ?? null);
  stair.answer(a, mm, optotypeHeightMm(stair.level, mm), (performance.now() - t0) / 1000);
  blankUntil = performance.now() + 300; // brief blank between letters
  updateProgress();
  if (stair.done) setTimeout(() => show('results'), 350);
}

function updateProgress(): void {
  const idx = LEVELS.indexOf(stair.level);
  $('check-progress').textContent = stair.done ? 'Done' : `Size ${idx + 1} of ${LEVELS.length} · letter ${stair.letterInLevel}`;
}

document.querySelectorAll<HTMLButtonElement>('.dpad [data-dir]').forEach((b) =>
  b.addEventListener('click', () => answer(b.dataset.dir as Dir)));
$('btn-check-unsure').addEventListener('click', () => answer('unsure'));
$('btn-check-end').addEventListener('click', () => { stair.done = true; show('results'); });
document.addEventListener('keydown', (e) => {
  if (screen !== 'check') return;
  const map: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  if (map[e.key]) { e.preventDefault(); answer(map[e.key]); }
});
// Swipe
(() => {
  const stage = $('optotype-stage');
  let sx = 0, sy = 0, active = false;
  stage.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; active = true; });
  stage.addEventListener('pointerup', (e) => {
    if (!active) return;
    active = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 30) return;
    answer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  });
  stage.addEventListener('pointercancel', () => { active = false; });
})();

// ───────────────────────────── results ─────────────────────────────
function stats(xs: number[]): { mean: number; sd: number } {
  const v = xs.filter(Number.isFinite);
  if (!v.length) return { mean: NaN, sd: NaN };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1));
  return { mean, sd };
}
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

function renderResults(): void {
  const checkLog = log.filter((e) => e.phase === 'check');
  const sessionLog = log.filter((e) => e.phase === 'guide' || e.phase === 'check');
  const ref = checkLog.length >= 5 ? checkLog : sessionLog;
  const withFace = ref.filter((e) => Number.isFinite(e.mm));
  const { mean, sd } = stats(withFace.map((e) => e.mm / 10));
  const inBand = withFace.filter((e) => e.mm >= BAND_LO && e.mm <= BAND_HI).length;
  const lit = ref.filter((e) => e.lumaOk).length;
  const lumaMean = stats(ref.map((e) => e.luma)).mean;
  const centred = ref.filter((e) => e.centered).length;
  const confMean = stats(withFace.map((e) => e.conf)).mean;
  const glare = ref.filter((e) => e.glare).length;
  const multi = ref.filter((e) => e.faces > 1).length;

  const best = stair.bestPassed;
  const trials = stair.trials;
  const correct = trials.filter((t) => t.correct).length;
  $('result-hero').innerHTML = trials.length
    ? `<div class="sub">Smallest letters read at ${Number.isFinite(mean) ? mean.toFixed(0) : '40'} cm</div>
       <div class="big">${best === null ? 'logMAR &gt; 0.7' : `logMAR ${best.toFixed(1)}`}</div>
       <div class="sub">${best === null ? 'Largest letters not read reliably' : `≈ ${snellen20(best)} near-vision equivalent`} · ${correct}/${trials.length} letters correct</div>`
    : `<div class="big">No letters answered</div><div class="sub">Distance metrics below are from the guide step.</div>`;

  const lightLabel = lumaMean >= 100 ? ['Good', 'good'] : lumaMean >= 60 ? ['Fair', 'fair'] : ['Poor', 'poor'];
  const stabLabel = sd <= 1 ? ['good', 'Very steady'] : sd <= 2.5 ? ['fair', 'Some movement'] : ['poor', 'Unsteady'];
  const centLabel = pct(centred, ref.length) >= 85 ? 'good' : pct(centred, ref.length) >= 60 ? 'fair' : 'poor';
  const calLabel = [focalNorm() ? 'camera' : null, calib.irisMm ? 'iris' : null, calib.ppmm ? 'screen' : null].filter(Boolean).join(' + ');
  $('metrics').innerHTML = [
    ['Distance stability', Number.isFinite(sd) ? `±${sd.toFixed(1)} cm` : '—', `${stabLabel[1]} · ${pct(inBand, withFace.length)}% within 38–42 cm`, stabLabel[0]],
    ['Lighting quality', lightLabel[0], `${pct(lit, ref.length)}% of samples well lit`, lightLabel[1]],
    ['Face centred', `${pct(centred, ref.length)}%`, 'of samples', centLabel],
    ['Measurement confidence', Number.isFinite(confMean) ? confidenceLabel(confMean) : '—', `${glare ? `glare in ${pct(glare, ref.length)}% · ` : ''}${multi ? `extra faces in ${pct(multi, ref.length)}%` : 'single face'}`, Number.isFinite(confMean) ? (confMean >= 0.75 ? 'good' : confMean >= 0.5 ? 'fair' : 'poor') : ''],
    ['Mean distance', Number.isFinite(mean) ? `${mean.toFixed(1)} cm` : '—', 'target 40 cm', ''],
    ['Calibration', calLabel || 'None', calLabel ? 'saved on this device' : 'typical phone + average eye', calLabel ? 'good' : 'fair'],
  ].map(([k, v, s, c]) => `<div class="metric"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`).join('');

  renderSpark(ref);
  const tbody = $('log-table').querySelector('tbody')!;
  tbody.innerHTML = log.map((e) => `<tr><td>${e.t.toFixed(1)}</td><td>${e.phase}</td><td>${Number.isFinite(e.mm) ? (e.mm / 10).toFixed(1) + ' cm' : '—'}</td><td>${e.conf.toFixed(2)}</td><td>${e.irisPx.toFixed(1)}</td><td>${e.luma.toFixed(0)}</td><td>${e.centered ? '✓' : '·'}</td></tr>`).join('');
}

function renderSpark(entries: LogEntry[]): void {
  const svg = $('spark') as unknown as SVGSVGElement;
  const W = 320, H = 90, lo = 25, hi = 55;
  const y = (cm: number) => H - ((Math.max(lo, Math.min(hi, cm)) - lo) / (hi - lo)) * H;
  if (entries.length < 2) { svg.innerHTML = ''; return; }
  const ta = entries[0].t, tb = entries[entries.length - 1].t || ta + 1;
  let d = '';
  let pen = false;
  entries.forEach((e) => {
    if (!Number.isFinite(e.mm)) { pen = false; return; }
    const x = ((e.t - ta) / Math.max(0.001, tb - ta)) * W;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y(e.mm / 10).toFixed(1)}`;
    pen = true;
  });
  svg.innerHTML = `<rect class="band" x="0" width="${W}" y="${y(42)}" height="${y(38) - y(42)}"/><path class="line" d="${d}"/>`;
}

$('btn-csv').addEventListener('click', () => {
  const head = 't_s,phase,distance_mm,raw_mm,confidence,iris_px,luma,centered,faces,glare\n';
  const rows = log.map((e) => [e.t.toFixed(2), e.phase, e.mm.toFixed(1), e.rawMm.toFixed(1), e.conf.toFixed(3), e.irisPx.toFixed(2), e.luma.toFixed(0), e.centered ? 1 : 0, e.faces, e.glare ? 1 : 0].join(','));
  const url = URL.createObjectURL(new Blob([head + rows.join('\n')], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'iriscale-session.csv' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('btn-again').addEventListener('click', () => { log.length = 0; t0 = performance.now(); show('guide'); });
$('btn-recal').addEventListener('click', () => show('calibrate'));

// ───────────────────────────── debug overlay (?debug=1) ─────────────────────────────
if (DEBUG) {
  const el = $('debug');
  el.hidden = false;
  setInterval(() => {
    const s = tracker?.stats;
    const f = tracker?.latest;
    el.textContent = [
      `delegate  ${s?.delegate ?? '-'} · ${s?.engine ?? '-'} thread`,
      `detect    ${s ? s.detectFps.toFixed(1) : '-'} fps (cap ${tracker?.targetFps ?? '-'})`,
      `ui        ${uiFps.toFixed(1)} fps`,
      `infer     ${s ? s.inferMsAvg.toFixed(1) : '-'} ms avg · p95 ${s ? s.inferMsP95.toFixed(1) : '-'}`,
      `video     ${video.videoWidth}×${video.videoHeight}`,
      `iris      ${f?.irisPx.toFixed(2) ?? '-'} px  asym ${f ? (f.asymmetry * 100).toFixed(1) : '-'}%`,
      `dist      raw ${f?.rawMm.toFixed(0) ?? '-'} · filt ${f?.mm.toFixed(0) ?? '-'} mm`,
      `conf      ${f?.conf.toFixed(2) ?? '-'}  yaw ${f?.yaw.toFixed(0) ?? '-'}°`,
      `luma      ${f?.luma.toFixed(0) ?? '-'}  glare ${f?.glare ?? '-'}  faces ${f?.faces ?? '-'}`,
      `focal     ${(focalNorm() ?? DEFAULT_FOCAL_NORM).toFixed(3)}${focalNorm() ? '' : ' (default)'}`,
      `irisMm    ${(calib.irisMm ?? POPULATION_IRIS_MM).toFixed(2)}  ppmm ${ppmm().toFixed(2)}`,
    ].join('\n');
  }, 250);
}

// Test/perf hook (read-only numbers; never frames).
Object.defineProperty(window, '__iriscale', {
  value: {
    stats: () => ({ ...(tracker?.stats ?? {}), uiFps }),
    latest: () => { const f = tracker?.latest; return f ? { ...f, landmarks: null } : null; },
    screen: () => screen,
  },
});

show('welcome');
