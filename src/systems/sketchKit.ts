/**
 * Helpers for generated scenery drawn with the pencil brush.
 */

import Phaser from 'phaser';
import { Boiler, ShapeDef, SketchShape, type Pt } from '@/systems/boil';

/**
 * Split a polyline into pieces with small gaps — the pencil lifting mid-line,
 * as in the user's broken canopy outline. `lift` is the chance of a lift per
 * point; pieces shorter than 2 points are dropped.
 */
export function brokenLine(points: Pt[], rng: () => number, lift = 0.12): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  for (let i = 0; i < points.length; i++) {
    cur.push(points[i]);
    if (i > 0 && i < points.length - 1 && rng() < lift) {
      if (cur.length > 1) out.push(cur);
      cur = [];
      i++; // skip a point: the gap
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** A wobbly polyline from a to b with `n` segments. */
export function wobble(a: Pt, b: Pt, rng: () => number, n = 4, amp = 2): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const e = i === 0 || i === n ? 0.3 : 1;
    pts.push({
      x: a.x + (b.x - a.x) * t + (rng() - 0.5) * amp * e,
      y: a.y + (b.y - a.y) * t + (rng() - 0.5) * amp * e,
    });
  }
  return pts;
}

export interface StrokeStyle { color: number; width: number; alpha: number }

export interface StrokeLayer {
  /** Unique within a scene; strokes of different layers never share a shape. */
  name: string;
  depth: number;
  /** Boil amplitude in layout units; background layers boil less. */
  jitter: number;
  fps: number;
  /** Spatial grouping cell, layout units. Smaller → tighter boxes, more shapes. */
  cell?: number;
  /** Number of independent boil phases strokes are spread across. */
  phases?: number;
}

/**
 * Batches strokes into a modest number of deferred SketchShapes: grouped by
 * layer, style (alpha bucketed) and location, then spread across a few boil
 * phases. One shape per stroke cost seconds at scene start (CLAUDE.md, Brush
 * performance rules); one shape per layer would boil everything in step.
 */
export class StrokeGroups {
  private groups = new Map<string, { layer: StrokeLayer; style: StrokeStyle; lines: Pt[][] }>();
  private n = 0;

  add(layer: StrokeLayer, points: Pt[] | Pt[][], style: StrokeStyle): void {
    const lines = (Array.isArray(points[0]) ? points : [points]) as Pt[][];
    const cell = layer.cell ?? 240;
    for (const line of lines) {
      if (line.length < 2) continue;
      const a = Math.max(0.05, Math.round(style.alpha * 8) / 8);
      const phase = this.n++ % (layer.phases ?? 3);
      const mid = line[Math.floor(line.length / 2)];
      const key = `${layer.name}|${style.color}|${style.width}|${a}|${phase}|${Math.floor(mid.x / cell)},${Math.floor(mid.y / cell)}`;
      let g = this.groups.get(key);
      if (!g) { g = { layer, style: { ...style, alpha: a }, lines: [] }; this.groups.set(key, g); }
      g.lines.push(line);
    }
  }

  /** Create the shapes (rendered later, within the per-frame budget). */
  build(scene: Phaser.Scene, boiler: Boiler): SketchShape[] {
    const out: SketchShape[] = [];
    for (const g of this.groups.values()) {
      const def = g.lines.map((l) => l.map((p) => ({ ...p }))) as ShapeDef;
      out.push(boiler.add(new SketchShape(scene, def, g.style, {
        jitter: g.layer.jitter, fps: g.layer.fps, depth: g.layer.depth, deferred: true,
      })));
    }
    this.groups.clear();
    return out;
  }
}

// --- shading -------------------------------------------------------------------

/**
 * Light comes from the upper right (user spec): shadow sides face left/down,
 * cast shadows fall toward the lower left. Hatch strokes run at HATCH_ANGLE;
 * cross-hatching for deep shadow adds a second pass at CROSS_ANGLE.
 */
export const HATCH_ANGLE = -1.0;   // radians: strokes rising to the right
export const CROSS_ANGLE = 0.35;
/** Direction a cast shadow is thrown along the ground (down-left). */
export const SHADOW_DIR = { x: -1, y: 0.22 };

/**
 * Parallel hatch strokes clipped to a polygon. Strokes are jittered, with the
 * occasional lift, so they read as hand hatching, not a ruled pattern.
 */
export function hatchPolygon(poly: Pt[], angle: number, spacing: number, rng: () => number, lift = 0.08): Pt[][] {
  if (poly.length < 3) return [];
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const nx = -dy, ny = dx;
  // Range of offsets along the normal that the polygon covers.
  let lo = Infinity, hi = -Infinity;
  for (const p of poly) { const o = p.x * nx + p.y * ny; lo = Math.min(lo, o); hi = Math.max(hi, o); }
  const out: Pt[][] = [];
  for (let o = lo + spacing * (0.3 + rng() * 0.5); o < hi; o += spacing * (0.8 + rng() * 0.4)) {
    // Intersect the line {p : p·n = o} with every edge.
    const ts: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const oa = a.x * nx + a.y * ny - o, ob = b.x * nx + b.y * ny - o;
      if ((oa < 0) === (ob < 0)) continue;
      const t = oa / (oa - ob);
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      ts.push(x * dx + y * dy);
    }
    ts.sort((u, v) => u - v);
    for (let k = 0; k + 1 < ts.length; k += 2) {
      const s0 = ts[k] + 1.2, s1 = ts[k + 1] - 1.2;   // stay just inside the outline
      if (s1 - s0 < 3) continue;
      const P = (s: number) => ({ x: dx * s + nx * o + (rng() - 0.5) * 0.8, y: dy * s + ny * o + (rng() - 0.5) * 0.8 });
      const pts = [P(s0), P((s0 + s1) / 2), P(s1)];
      out.push(...(rng() < lift ? brokenLine(pts, rng, 0.5) : [pts]));
    }
  }
  return out;
}

/**
 * A ground shadow cast from a base edge (left→right along the ground):
 * the polygon swept from the base along SHADOW_DIR by `length`.
 */
export function castShadow(baseL: Pt, baseR: Pt, length: number): Pt[] {
  const sx = SHADOW_DIR.x * length, sy = SHADOW_DIR.y * length;
  return [baseR, baseL, { x: baseL.x + sx, y: baseL.y + sy }, { x: baseR.x + sx * 0.6, y: baseR.y + sy * 0.6 }];
}

/**
 * Paper-coloured fills so solid objects hide what is behind them (lines are
 * otherwise transparent and cross). Drawn into one Graphics per depth stage.
 */
export function fillPaper(g: Phaser.GameObjects.Graphics, poly: Pt[], color = 0xffffff): void {
  if (poly.length < 3) return;
  g.fillStyle(color, 1);
  g.fillPoints(poly.map((p) => new Phaser.Math.Vector2(p.x, p.y)), true);
}

// --- loose, hand-sketched geometry ------------------------------------------------

/**
 * A line from a to b as a pencil sketch would draw it: 1–3 passes, each
 * jittered and slightly curved, starting/ending a little early or overshooting,
 * sometimes lifting mid-way. `amp` is the wobble in the caller's units.
 */
export function sketchLine(a: Pt, b: Pt, rng: () => number, o: { passes?: number; amp?: number; over?: number; lift?: number } = {}): Pt[][] {
  const passes = o.passes ?? (rng() < 0.55 ? 2 : 1), amp = o.amp ?? 2, over = o.over ?? 0.06, lift = o.lift ?? 0.12;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, nx = -uy, ny = ux;
  const out: Pt[][] = [];
  for (let p = 0; p < passes; p++) {
    const s0 = (rng() - 0.6) * over * len, s1 = len + (rng() - 0.4) * over * len;
    const bow = (rng() - 0.5) * amp * 1.5, off = (rng() - 0.5) * amp;
    const n = Math.max(2, Math.round(len / 18));
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, s = s0 + (s1 - s0) * t;
      const w = off + bow * Math.sin(Math.PI * t) + (rng() - 0.5) * amp * 0.5;
      pts.push({ x: a.x + ux * s + nx * w, y: a.y + uy * s + ny * w });
    }
    out.push(...brokenLine(pts, rng, lift));
  }
  return out;
}

/** A closed or open polyline sketched edge by edge (corners overshoot). */
export function sketchPath(points: Pt[], rng: () => number, o: { closed?: boolean; passes?: number; amp?: number } = {}): Pt[][] {
  const out: Pt[][] = [];
  const n = o.closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) out.push(...sketchLine(points[i], points[(i + 1) % points.length], rng, { passes: o.passes, amp: o.amp, over: 0.08 }));
  return out;
}

/** A few quick scribbled marks suggesting a window (not a tidy square). */
export function scribbleMark(c: Pt, w: number, h: number, rng: () => number): Pt[][] {
  const out: Pt[][] = [];
  const k = rng();
  if (k < 0.4) {                                  // zig-zag fill
    const pts: Pt[] = [];
    for (let i = 0; i <= 4; i++) pts.push({ x: c.x - w / 2 + (w * i) / 4 + (rng() - 0.5) * 2, y: c.y + (i % 2 ? h / 2 : -h / 2) + (rng() - 0.5) * 2 });
    out.push(pts);
  } else if (k < 0.75) {                          // two short strokes
    out.push([{ x: c.x - w / 2, y: c.y - h / 3 }, { x: c.x + w / 2, y: c.y - h / 3 + (rng() - 0.5) * 3 }]);
    out.push([{ x: c.x - w / 2 + 2, y: c.y + h / 3 }, { x: c.x + w / 2 - 1, y: c.y + h / 3 + (rng() - 0.5) * 3 }]);
  } else {                                        // a loose open box
    out.push([{ x: c.x - w / 2, y: c.y + h / 2 }, { x: c.x - w / 2 + 1, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y - h / 2 + 1 }, { x: c.x + w / 2 - 1, y: c.y + h / 3 }]);
  }
  return out;
}
