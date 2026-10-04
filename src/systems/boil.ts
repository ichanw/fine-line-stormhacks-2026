/**
 * Line boil.
 *
 * Every hand-drawn shape pre-generates a small number of jittered variants of a
 * SINGLE stroke and cycles them at a few frames per second, the way a rough
 * animation's outline wobbles. Two rules matter:
 *
 *   - One stroke per variant. No multi-pass outlines, no double borders — the
 *     wobble comes from swapping variants over time, not from stacking passes.
 *   - Every shape gets a random start offset, so nothing boils in sync.
 *
 * Shapes register with the scene's Boiler, which ticks them from update().
 */

import Phaser from 'phaser';
import { BOIL_FPS_IDLE, BOIL_VARIANTS } from '@/systems/constants';

export interface Pt { x: number; y: number }
export type Polyline = Pt[];
/** A shape is one or more polylines in world space. */
export type ShapeDef = Polyline[];

export interface BoilStyle {
  color: number;
  width: number;
  alpha: number;
}

export const defaultBoilStyle = (p: Partial<BoilStyle> = {}): BoilStyle => ({
  color: 0x8a8a8a, width: 1, alpha: 1, ...p,
});

// --- shape builders (base geometry, before jitter) ------------------------

/** A rectangle as a single closed polyline, sampled so jitter has something to bite. */
export function boxShape(x: number, y: number, w: number, h: number, step = 26): ShapeDef {
  const pts: Polyline = [];
  const edge = (x1: number, y1: number, x2: number, y2: number) => {
    const d = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(1, Math.round(d / step));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      pts.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
    }
  };
  edge(x, y, x + w, y);
  edge(x + w, y, x + w, y + h);
  edge(x + w, y + h, x, y + h);
  edge(x, y + h, x, y);
  pts.push({ x, y }); // close
  return [pts];
}

export function lineShape(x1: number, y1: number, x2: number, y2: number, step = 24): ShapeDef {
  const d = Math.hypot(x2 - x1, y2 - y1);
  const n = Math.max(1, Math.round(d / step));
  const pts: Polyline = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
  }
  return [pts];
}

/** An open path straight from points you already have. */
export function pathShape(points: Pt[]): ShapeDef {
  return [points.map((p) => ({ ...p }))];
}

// --- jitter ---------------------------------------------------------------

function jitterShape(shape: ShapeDef, amount: number): ShapeDef {
  return shape.map((line) =>
    line.map((p) => ({
      x: p.x + (Math.random() - 0.5) * amount * 2,
      y: p.y + (Math.random() - 0.5) * amount * 2,
    })),
  );
}

// --- arc-length helpers (for the tracing hover variant) -------------------

function flatten(shape: ShapeDef): Pt[] {
  return shape.flat();
}

function cumulative(points: Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return out;
}

/** The slice of `points` between arc-lengths a and b, wrapping around. */
function sliceByLength(points: Pt[], lens: number[], a: number, b: number): Pt[] {
  const total = lens[lens.length - 1];
  if (total <= 0) return [];
  const norm = (v: number) => ((v % total) + total) % total;
  const start = norm(a);
  const end = norm(b);
  const take: Pt[] = [];
  const push = (from: number, to: number) => {
    for (let i = 0; i < points.length; i++) {
      if (lens[i] >= from && lens[i] <= to) take.push(points[i]);
    }
  };
  if (start <= end) push(start, end);
  else { push(start, total); take.push({ ...points[0] }); push(0, end); }
  return take;
}

// --- the shape ------------------------------------------------------------

export interface SketchShapeOptions {
  jitter?: number;
  fps?: number;
  depth?: number;
}

export class SketchShape {
  private variants: ShapeDef[] = [];
  private style: BoilStyle;
  private g: Phaser.GameObjects.Graphics;
  private fps: number;
  /** Random start offset so this shape does not boil in step with its neighbours. */
  private phaseOffset = Math.random() * 1000;
  private lastVariant = -1;
  private offsetX = 0;
  private offsetY = 0;
  private tracer = false;
  private tracerPhase = Math.random() * 1000;
  private solid = false;
  private frozen = false;
  private base: ShapeDef;
  private jitter: number;

  constructor(scene: Phaser.Scene, base: ShapeDef, style: Partial<BoilStyle> = {}, opts: SketchShapeOptions = {}) {
    this.base = base;
    this.jitter = opts.jitter ?? 1.6;
    this.style = defaultBoilStyle(style);
    this.fps = opts.fps ?? BOIL_FPS_IDLE;
    this.g = scene.add.graphics().setDepth(opts.depth ?? 10);
    this.regenerate();
  }

  /** Rebuild the jittered variants (after a geometry or jitter change). */
  regenerate(): void {
    this.variants = [];
    for (let i = 0; i < BOIL_VARIANTS; i++) this.variants.push(jitterShape(this.base, this.jitter));
    this.lastVariant = -1;
  }

  setGeometry(base: ShapeDef): this { this.base = base; this.regenerate(); return this; }
  setStyle(style: Partial<BoilStyle>): this { this.style = { ...this.style, ...style }; this.lastVariant = -1; return this; }
  setFps(fps: number): this { this.fps = fps; return this; }
  setJitter(j: number): this { this.jitter = j; this.regenerate(); return this; }
  setDepth(d: number): this { this.g.setDepth(d); return this; }
  setAlpha(a: number): this { this.g.setAlpha(a); return this; }
  setVisible(v: boolean): this { this.g.setVisible(v); return this; }
  /** Shift the whole outline — used by the hover "moves" nudge. */
  setOffset(x: number, y: number): this { this.offsetX = x; this.offsetY = y; this.lastVariant = -1; return this; }
  /** Hover variant B: a darker stroke continuously tracing the outline. */
  setTracer(on: boolean): this { this.tracer = on; this.lastVariant = -1; return this; }
  /** Press feedback: briefly draw the outline as one clean, un-jittered stroke. */
  setSolid(on: boolean): this { this.solid = on; this.lastVariant = -1; return this; }
  /** Reduced motion: hold a single variant forever. */
  setFrozen(on: boolean): this { this.frozen = on; this.lastVariant = -1; return this; }

  get graphics(): Phaser.GameObjects.Graphics { return this.g; }

  update(timeMs: number): void {
    const variant = this.frozen
      ? 0
      : Math.floor(((timeMs + this.phaseOffset) / 1000) * this.fps) % BOIL_VARIANTS;
    // Tracing redraws every frame; otherwise only when the variant changes.
    if (variant === this.lastVariant && !(this.tracer && !this.frozen)) return;
    this.lastVariant = variant;
    this.redraw(variant, timeMs);
  }

  private redraw(variant: number, timeMs: number): void {
    const g = this.g;
    g.clear();
    const shape = this.solid ? this.base : this.variants[variant];

    g.lineStyle(this.style.width, this.style.color, this.style.alpha);
    for (const line of shape) {
      if (line.length < 2) continue;
      g.beginPath();
      line.forEach((p, i) => {
        const x = p.x + this.offsetX;
        const y = p.y + this.offsetY;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.strokePath();
    }

    if (this.tracer && !this.frozen) {
      const pts = flatten(shape).map((p) => ({ x: p.x + this.offsetX, y: p.y + this.offsetY }));
      const lens = cumulative(pts);
      const total = lens[lens.length - 1];
      if (total > 0) {
        const speed = total / 1400; // one full lap roughly every 1.4s
        const head = ((timeMs + this.tracerPhase) * speed) % total;
        const seg = sliceByLength(pts, lens, head, head + total * 0.22);
        if (seg.length > 1) {
          g.lineStyle(this.style.width * 1.5, 0x1a1a1a, 1);
          g.beginPath();
          seg.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
          g.strokePath();
        }
      }
    }
  }

  destroy(): void { this.g.destroy(); }
}

/** Per-scene registry: ticks every shape from one place. */
export class Boiler {
  private shapes: SketchShape[] = [];

  add(shape: SketchShape): SketchShape {
    this.shapes.push(shape);
    return shape;
  }

  remove(shape: SketchShape): void {
    const i = this.shapes.indexOf(shape);
    if (i >= 0) this.shapes.splice(i, 1);
  }

  update(timeMs: number): void {
    for (const s of this.shapes) s.update(timeMs);
  }

  setFrozen(on: boolean): void {
    for (const s of this.shapes) s.setFrozen(on);
  }

  destroy(): void {
    this.shapes.forEach((s) => s.destroy());
    this.shapes = [];
  }
}
