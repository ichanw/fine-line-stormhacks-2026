/**
 * Sketchy drawing primitives.
 *
 * Until real pencil art exists, everything is drawn procedurally in a
 * hand-made style: each stroke is laid down in a few jittered passes so
 * lines look like graphite on paper rather than crisp vectors. Keep these
 * helpers pure-ish — they only draw onto a Phaser Graphics you pass in.
 */

import Phaser from 'phaser';
import { COLOR_INK } from '@/config/constants';

export interface SketchStyle {
  color: number;
  /** Line thickness in px. */
  width: number;
  /** How far points wander from the ideal line, in px. */
  jitter: number;
  /** Number of overlapping passes (more = scratchier, darker). */
  passes: number;
  /** 0..1 per-pass alpha; stacks up where passes overlap. */
  alpha: number;
}

export const DEFAULT_SKETCH: SketchStyle = {
  color: COLOR_INK,
  width: 2,
  jitter: 2,
  passes: 3,
  alpha: 0.5,
};

/** Merge a partial style over the default. */
export function sketchStyle(partial: Partial<SketchStyle> = {}): SketchStyle {
  return { ...DEFAULT_SKETCH, ...partial };
}

function jittered(v: number, amount: number, rnd: () => number): number {
  return v + (rnd() * 2 - 1) * amount;
}

/**
 * A deterministic-ish small RNG so a given shape looks the same each frame
 * (otherwise static art would shimmer). Seeded by the shape's own geometry.
 */
function makeRng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Draw a wobbly line from (x1,y1) to (x2,y2). */
export function sketchLine(
  g: Phaser.GameObjects.Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  style: SketchStyle = DEFAULT_SKETCH,
): void {
  const seed = Math.floor(x1 * 7 + y1 * 13 + x2 * 17 + y2 * 23) || 1;
  const segments = Math.max(2, Math.floor(Phaser.Math.Distance.Between(x1, y1, x2, y2) / 18));

  for (let p = 0; p < style.passes; p++) {
    const rnd = makeRng(seed + p * 101);
    g.lineStyle(style.width, style.color, style.alpha);
    g.beginPath();
    g.moveTo(jittered(x1, style.jitter, rnd), jittered(y1, style.jitter, rnd));
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const x = Phaser.Math.Linear(x1, x2, t);
      const y = Phaser.Math.Linear(y1, y2, t);
      g.lineTo(jittered(x, style.jitter, rnd), jittered(y, style.jitter, rnd));
    }
    g.strokePath();
  }
}

/** Draw a closed polyline (points as [x,y] pairs) in the sketchy style. */
export function sketchPoly(
  g: Phaser.GameObjects.Graphics,
  points: Array<[number, number]>,
  closed: boolean,
  style: SketchStyle = DEFAULT_SKETCH,
): void {
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    sketchLine(g, x1, y1, x2, y2, style);
  }
  if (closed && points.length > 2) {
    const [x1, y1] = points[points.length - 1];
    const [x2, y2] = points[0];
    sketchLine(g, x1, y1, x2, y2, style);
  }
}

/** Draw a rectangle outline in the sketchy style. */
export function sketchRect(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  style: SketchStyle = DEFAULT_SKETCH,
): void {
  sketchPoly(
    g,
    [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
    true,
    style,
  );
}

/** Draw a circle outline in the sketchy style. */
export function sketchCircle(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  radius: number,
  style: SketchStyle = DEFAULT_SKETCH,
): void {
  const steps = Math.max(10, Math.floor(radius / 2));
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
  }
  sketchPoly(g, pts, true, style);
}

/**
 * Light pencil hatching inside a rectangle — a cheap way to suggest shadow
 * or a filled mass without breaking the monochrome, line-based look.
 */
export function sketchHatch(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  spacing = 10,
  style: SketchStyle = sketchStyle({ width: 1, jitter: 1, passes: 1, alpha: 0.3 }),
): void {
  for (let off = -h; off < w; off += spacing) {
    const x1 = x + Math.max(0, off);
    const y1 = y + Math.max(0, -off);
    const x2 = x + Math.min(w, off + h);
    const y2 = y + Math.min(h, h - (off + h - w > 0 ? off + h - w : 0));
    sketchLine(g, x1, y1, x2, y2, style);
  }
}
