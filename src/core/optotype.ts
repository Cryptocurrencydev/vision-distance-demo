/** Tumbling-E optotype rendered at a physical size. */

export type Dir = 'right' | 'down' | 'left' | 'up';
export const DIRS: Dir[] = ['right', 'down', 'left', 'up'];
const ANGLE: Record<Dir, number> = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };

/** logMAR levels for a short near check, large → small. */
export const LEVELS = [0.7, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0];

/**
 * Draw an E whose arms point `dir`, `sizeCssPx` tall, centred in the canvas.
 * The E sits on a 5×5 grid (stroke = gap = 1/5 of the letter height) per ISO 8596 / Sloan.
 * Canvas backing store must already be sized to cssW*dpr × cssH*dpr.
 */
export function drawE(
  ctx: CanvasRenderingContext2D, cssW: number, cssH: number, dpr: number,
  sizeCssPx: number, dir: Dir, ink = '#000', paper = '#fff',
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, cssW * dpr, cssH * dpr);
  const s = sizeCssPx * dpr; // device px — draw at exact physical size, let AA handle sub-pixel
  const u = s / 5;
  ctx.translate((cssW * dpr) / 2, (cssH * dpr) / 2);
  ctx.rotate(ANGLE[dir]);
  ctx.translate(-s / 2, -s / 2);
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.rect(0, 0, u, s);          // spine
  ctx.rect(0, 0, s, u);          // top arm
  ctx.rect(0, 2 * u, s, u);      // middle arm
  ctx.rect(0, 4 * u, s, u);      // bottom arm
  ctx.fill();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function randomDir(prev?: Dir): Dir {
  let d: Dir;
  do { d = DIRS[Math.floor(Math.random() * 4)]; } while (d === prev);
  return d;
}

export interface Trial {
  level: number;
  dir: Dir;
  answer: Dir | 'unsure';
  correct: boolean;
  distanceMm: number;
  letterMm: number;
  t: number;
}

/** Simple staircase: per level, pass on 2 correct, fail on 2 wrong (max 3 letters/level). */
export class EStaircase {
  levelIdx = 0;
  private right = 0;
  private wrong = 0;
  trials: Trial[] = [];
  bestPassed: number | null = null;
  done = false;
  dir: Dir = randomDir();

  get level(): number { return LEVELS[this.levelIdx]; }
  get letterInLevel(): number { return this.right + this.wrong + 1; }

  answer(a: Dir | 'unsure', distanceMm: number, letterMm: number, t: number): void {
    if (this.done) return;
    const correct = a === this.dir;
    this.trials.push({ level: this.level, dir: this.dir, answer: a, correct, distanceMm, letterMm, t });
    if (correct) this.right++; else this.wrong++;
    if (this.right >= 2) {
      this.bestPassed = this.level;
      if (this.levelIdx === LEVELS.length - 1) this.done = true;
      else { this.levelIdx++; this.right = 0; this.wrong = 0; }
    } else if (this.wrong >= 2) {
      this.done = true;
    }
    this.dir = randomDir(this.dir);
  }
}
