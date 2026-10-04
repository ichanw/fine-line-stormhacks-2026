/**
 * Line boil, drawn with the pencil brush.
 *
 * Every hand-drawn shape pre-generates a few jittered variants of a SINGLE
 * stroke and cycles them at a few frames per second, the way a rough
 * animation's outline wobbles:
 *
 *   - One stroke per variant. No multi-pass outlines, no double borders.
 *   - Every shape gets a random start offset, so nothing boils in sync.
 *   - Each variant is rendered ONCE with the pencil brush (systems/brush.ts) at
 *     device resolution into a frame of a per-shape texture. Boiling is then
 *     just a frame switch — no per-frame drawing, nothing ever scaled up.
 *
 * Shapes register with the scene's Boiler, which ticks them from update().
 */

import Phaser from 'phaser';
import {
  boxPath, dabPolyline, defaultBrush, finishRegion, smoothPolyline,
  type BrushStyle, type Pt,
} from '@/systems/brush';
import { BrushAtlas } from '@/systems/brushAtlas';
import { BOIL_FPS_SCENERY, BOIL_VARIANTS } from '@/systems/constants';
import { mulberry32 } from '@/systems/rng';
import { viewport } from '@/systems/viewport';

export type { Pt };
export type Polyline = Pt[];
/**
 * One or more polylines in layout units. A box carries its rect so it can be
 * drawn as a single continuous hand-drawn loop with sharp corners; `sharp`
 * skips smoothing (for ticks and other deliberate corners).
 */
export type ShapeDef = Polyline[] & { box?: { x: number; y: number; w: number; h: number }; sharp?: boolean };

export interface BoilStyle {
  color: number;
  /** Visual weight; 1 = a thin UI line. Mapped onto brush width. */
  width: number;
  /** 0..1 strength; mapped onto dab opacity. */
  alpha: number;
}

export const defaultBoilStyle = (p: Partial<BoilStyle> = {}): BoilStyle => ({
  color: 0x6e6e6e, width: 1, alpha: 1, ...p,
});

/** Brush units per BoilStyle width unit, and dab opacity at alpha 1. */
const WIDTH_TO_BRUSH = 2;
const ALPHA_TO_DAB = 0.3;

function toBrush(s: BoilStyle): BrushStyle {
  return defaultBrush({
    color: `#${s.color.toString(16).padStart(6, '0')}`,
    width: s.width * WIDTH_TO_BRUSH,
    alpha: s.alpha * ALPHA_TO_DAB,
  });
}

/** Running counters, surfaced by the F1 panel's "show stats". */
export const boilStats = {
  redraws: 0,
  regenerates: 0,
  /** Brush renders (one per style set), the expensive operation. */
  renders: 0,
  /** Time spent in brush rendering, split by phase (ms). */
  dabMs: 0,
  finishMs: 0,
  uploadMs: 0,
  dabs: 0,
  /** Variant flips per labelled shape (e.g. a button's aria label). */
  flips: {} as Record<string, number>,
};

// --- shape builders --------------------------------------------------------

export function boxShape(x: number, y: number, w: number, h: number): ShapeDef {
  // The polyline is only used for bounds and the hover tracer; the box itself
  // is drawn from `box` as one continuous stroke.
  const def = [[{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }]] as ShapeDef;
  def.box = { x, y, w, h };
  return def;
}

export function lineShape(x1: number, y1: number, x2: number, y2: number, step = 24): ShapeDef {
  const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / step));
  const pts: Polyline = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
  }
  return [pts] as ShapeDef;
}

export function pathShape(points: Pt[], opts: { sharp?: boolean } = {}): ShapeDef {
  const def = [points.map((p) => ({ ...p }))] as ShapeDef;
  def.sharp = opts.sharp;
  return def;
}

// --- arc-length helpers (hover tracer) --------------------------------------

function cumulative(points: Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return out;
}

/** The slice of `points` between arc-lengths a and b (b may wrap past the end). */
function sliceByLength(points: Pt[], lens: number[], a: number, b: number): Pt[] {
  const total = lens[lens.length - 1];
  if (total <= 0) return [];
  const take: Pt[] = [];
  const push = (from: number, to: number) => {
    for (let i = 0; i < points.length; i++) if (lens[i] >= from && lens[i] <= to) take.push(points[i]);
  };
  const start = ((a % total) + total) % total;
  const end = start + (b - a);
  if (end <= total) push(start, end);
  else { push(start, total); push(0, end - total); }
  return take;
}

// --- the shape ---------------------------------------------------------------

export interface SketchShapeOptions {
  jitter?: number;
  fps?: number;
  depth?: number;
  /** Debug label; flips are counted under it in boilStats. */
  label?: string;
  /** Build the clean "solid" frame used by the press feedback. */
  interactive?: boolean;
  /**
   * Render later, within the scene's per-frame budget, instead of now. Use for
   * scenery; leave off for UI that must be visible and usable immediately.
   */
  deferred?: boolean;
}

interface RenderedSet {
  key: string;
  /** Frame names for each boil variant, then (interactive) the solid frame. */
  frames: string[];
  solid?: string;
  /** True if this set has its own texture (too big for an atlas page). */
  own: boolean;
  /** Top-left of every frame, in layout units. */
  ox: number;
  oy: number;
  /** One frame's size in device px. */
  frameW: number;
  frameH: number;
}

let uid = 0;

export class SketchShape {
  private scene: Phaser.Scene;
  private base: ShapeDef;
  private jitter: number;
  private style: BoilStyle;
  private fps: number;
  private label?: string;
  private interactive: boolean;
  private seed = Math.floor(Math.random() * 2 ** 31);

  private variants: Polyline[][] = [];
  private solidShape: Polyline[] = [];
  private sets = new Map<string, RenderedSet>();
  private current!: RenderedSet;
  private img: Phaser.GameObjects.Image;
  private zoom = viewport.zoom;

  /** Random start offset so this shape does not boil in step with its neighbours. */
  private phaseOffset = Math.random() * 1000;
  private lastVariant = -1;
  private lastFlipVariant = -1;
  private offsetX = 0;
  private offsetY = 0;
  private squashX = 1;
  private squashY = 1;
  private solid = false;
  private frozen = false;
  /** Optional pivot (layout units) for rotation, e.g. grass swaying at its base. */
  private pivot?: Pt;
  private rotation = 0;
  /** Uniform display scale about the pivot (carousel frames). Downscale only. */
  private displayScale = 1;

  private tracerOn = false;
  private tracerImg?: Phaser.GameObjects.Image;
  private tracerTex?: Phaser.Textures.CanvasTexture;
  private tracerPhase = Math.random() * 1000;

  constructor(scene: Phaser.Scene, base: ShapeDef, style: Partial<BoilStyle> = {}, opts: SketchShapeOptions = {}) {
    this.scene = scene;
    this.base = base;
    this.jitter = opts.jitter ?? 1.6;
    this.style = defaultBoilStyle(style);
    this.fps = opts.fps ?? BOIL_FPS_SCENERY;
    this.label = opts.label;
    this.interactive = opts.interactive ?? false;
    this.deferred = opts.deferred ?? false;
    this.regenerate();
    if (opts.deferred) {
      // A hidden placeholder now, so callers can parent/depth-sort it; the
      // real stroke arrives when the queue gets to it.
      this.img = scene.add.image(0, 0, '__DEFAULT').setOrigin(0, 0).setDepth(opts.depth ?? 10).setVisible(false);
      BrushAtlas.for(scene, 'scenery').enqueue(() => this.becomeReady());
    } else {
      this.current = this.renderSet(this.style);
      this.img = scene.add.image(0, 0, this.current.key, this.current.frames[0]).setOrigin(0, 0).setDepth(opts.depth ?? 10);
      this.ready = true;
      this.applyTransform();
    }
  }

  private ready = false;
  private deferred = false;
  private wantVisible = true;
  private destroyed = false;
  /** The atlas this shape rendered into — never look it up again during teardown. */
  private atlas?: BrushAtlas;

  private becomeReady(): void {
    if (this.destroyed) return;
    this.current = this.renderSet(this.style);
    this.ready = true;
    this.img.setTexture(this.current.key, this.frameName(0));
    this.img.setVisible(this.wantVisible);
    this.lastVariant = -1;
    this.applyTransform();
  }

  // --- geometry ---------------------------------------------------------------

  /** Rebuild the jittered variants (after a geometry or jitter change). */
  regenerate(): void {
    boilStats.regenerates++;
    const rng = mulberry32(this.seed++);
    this.variants = [];
    for (let i = 0; i < BOIL_VARIANTS; i++) this.variants.push(this.makeVariant(rng, this.jitter));
    this.solidShape = this.makeVariant(rng, 0);
    this.dropSets();
    this.lastVariant = -1;
  }

  private makeVariant(rng: () => number, jitter: number): Polyline[] {
    const b = this.base.box;
    if (b) return [boxPath(b.x, b.y, b.w, b.h, jitter, rng)];
    return this.base.filter((l) => l.length > 1).map((line) => {
      const j = line.map((p) => ({ x: p.x + (rng() - 0.5) * 2 * jitter, y: p.y + (rng() - 0.5) * 2 * jitter }));
      return this.base.sharp || j.length < 3 ? j : smoothPolyline(j, 5);
    });
  }

  // --- brush rendering ------------------------------------------------------

  private styleKey(s: BoilStyle): string { return `${s.color}|${s.width}|${s.alpha}`; }

  /**
   * Render every variant (plus the solid frame for interactive shapes) of one
   * style into a single texture, one frame each, at device resolution.
   */
  private renderSet(style: BoilStyle): RenderedSet {
    const k = this.styleKey(style);
    const cached = this.sets.get(k);
    if (cached) return cached;
    boilStats.renders++;

    const brush = toBrush(style);
    const z = this.zoom;
    const frames = this.interactive ? [...this.variants, this.solidShape] : this.variants;

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of frames) for (const l of f) for (const p of l) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    if (!isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }
    const pad = brush.width * 1.6 + 2;
    const ox = x0 - pad, oy = y0 - pad;
    const frameW = Math.max(1, Math.ceil((x1 - x0 + pad * 2) * z));
    const frameH = Math.max(1, Math.ceil((y1 - y0 + pad * 2) * z));

    const n = frames.length;
    const atlas = BrushAtlas.for(this.scene, this.deferred ? 'scenery' : 'ui');
    this.atlas = atlas;
    let horizontal = true;
    let rect = atlas.alloc(frameW * n, frameH);
    if (!rect) { horizontal = false; rect = atlas.alloc(frameW, frameH * n); }

    // Too big for a shared page (e.g. a ground line spanning the screen):
    // give it a dedicated one, frames stacked vertically.
    if (!rect) { horizontal = false; rect = atlas.allocOwn(frameW, frameH * n); }
    const { ctx, key, tex } = rect;
    const bx = rect.x, by = rect.y;
    const own = rect.own;

    const id = ++uid;
    const names: string[] = [];
    const radius = (brush.width / 2) * z;
    frames.forEach((lines, f) => {
      const fx = bx + (horizontal ? f * frameW : 0);
      const fy = by + (horizontal ? 0 : f * frameH);
      const rng = mulberry32(this.seed * 31 + f);
      const t0 = performance.now();
      for (const l of lines) {
        dabPolyline(ctx, l.map((p) => ({ x: (p.x - ox) * z + fx, y: (p.y - oy) * z + fy })), radius, brush, rng);
      }
      const t1 = performance.now();
      finishRegion(ctx, fx, fy, frameW, frameH, brush, ox * z, oy * z);
      boilStats.dabMs += t1 - t0;
      boilStats.finishMs += performance.now() - t1;
      const name = `f${id}-${f}`;
      tex.add(name, 0, fx, fy, frameW, frameH);
      names.push(name);
    });

    const tu = performance.now();
    rect.markDirty(rect.x, rect.y, horizontal ? frameW * n : frameW, horizontal ? frameH : frameH * n);
    boilStats.uploadMs += performance.now() - tu;

    const set: RenderedSet = {
      key,
      frames: names.slice(0, this.variants.length),
      solid: this.interactive ? names[this.variants.length] : undefined,
      own,
      ox, oy, frameW, frameH,
    };
    this.sets.set(k, set);
    return set;
  }

  /** Release a set's frames (atlas) or its whole texture (own). */
  private releaseSet(set: RenderedSet): void {
    if (set.own) { this.atlas?.releaseOwn(set.key); return; }
    const tex = this.scene.textures.get(set.key);
    if (!tex || tex.key === '__MISSING') return;
    for (const f of [...set.frames, ...(set.solid ? [set.solid] : [])]) tex.remove(f);
  }

  private dropSets(): void {
    const old = [...this.sets.values()];
    this.sets.clear();
    if (this.ready && this.img) {
      // Re-render the current style first, then free the old frames.
      this.current = this.renderSet(this.style);
      this.img.setTexture(this.current.key, this.frameName(0));
      this.applyTransform();
    }
    old.forEach((set) => this.releaseSet(set));
  }

  private applyTransform(): void {
    if (!this.ready) return;
    const s = this.current;
    const wU = s.frameW / this.zoom, hU = s.frameH / this.zoom;
    if (this.pivot) {
      // Rotate about the pivot: origin at the pivot within the frame.
      this.img.setOrigin((this.pivot.x - s.ox) / wU, (this.pivot.y - s.oy) / hU);
      this.img.setScale((this.displayScale * this.squashX) / this.zoom, (this.displayScale * this.squashY) / this.zoom);
      this.img.setPosition(this.pivot.x + this.offsetX, this.pivot.y + this.offsetY);
      this.img.setRotation(this.rotation);
      return;
    }
    this.img.setScale(this.squashX / this.zoom, this.squashY / this.zoom);
    // Squash about the centre of the frame.
    this.img.setPosition(
      s.ox + this.offsetX + (wU * (1 - this.squashX)) / 2,
      s.oy + this.offsetY + (hU * (1 - this.squashY)) / 2,
    );
    this.tracerImg?.setPosition(s.ox + this.offsetX, s.oy + this.offsetY).setScale(1 / this.zoom);
  }

  // --- public API -------------------------------------------------------------

  setGeometry(base: ShapeDef): this { this.base = base; this.regenerate(); return this; }

  setStyle(style: Partial<BoilStyle>): this {
    this.style = { ...this.style, ...style };
    if (!this.ready) return this; // the queued render picks up the latest style
    this.current = this.renderSet(this.style);
    this.img.setTexture(this.current.key, this.frameName(Math.max(0, this.lastVariant)));
    this.applyTransform();
    if (this.tracerOn) this.rebuildTracer();
    return this;
  }

  setFps(fps: number): this { this.fps = fps; return this; }
  setJitter(j: number): this { this.jitter = j; this.regenerate(); return this; }
  setDepth(d: number): this { this.img.setDepth(d); this.tracerImg?.setDepth(d + 1); return this; }
  setAlpha(a: number): this { this.img.setAlpha(a); return this; }
  setVisible(v: boolean): this {
    this.wantVisible = v;
    if (this.ready) this.img.setVisible(v);
    this.tracerImg?.setVisible(v && this.tracerOn);
    return this;
  }
  /** Shift the whole outline — used by the hover "moves" nudge. */
  setOffset(x: number, y: number): this { this.offsetX = x; this.offsetY = y; this.applyTransform(); return this; }
  /** Rotate about a fixed point (layout units) — breeze sway. */
  setPivot(x: number, y: number): this { this.pivot = { x, y }; this.applyTransform(); return this; }
  /** Scale about the pivot (requires setPivot). Keep <= 1: textures are 1:1. */
  setDisplayScale(k: number): this { this.displayScale = k; this.applyTransform(); return this; }
  setRotation(r: number): this {
    this.rotation = r;
    if (this.ready && this.pivot) this.img.setRotation(r);
    return this;
  }

  /** Press feedback: squash about the centre. 1,1 = normal. */
  setSquash(sx: number, sy: number): this { this.squashX = sx; this.squashY = sy; this.applyTransform(); return this; }
  /** Press feedback: briefly show the clean, un-jittered stroke. */
  setSolid(on: boolean): this { this.solid = on; this.lastVariant = -1; return this; }
  /**
   * Reduced motion: hold a single variant forever. Scenes call this every
   * frame, so it must be a no-op when nothing changes.
   */
  setFrozen(on: boolean): this {
    if (this.frozen === on) return this;
    this.frozen = on;
    this.lastVariant = -1;
    return this;
  }

  /** Hover variant B: a darker pencil stroke continuously tracing the outline. */
  setTracer(on: boolean): this {
    if (this.tracerOn === on) return this;
    this.tracerOn = on;
    if (on && this.ready) this.rebuildTracer();
    else this.tracerImg?.setVisible(false);
    return this;
  }

  /** The display object — for containers, tweens and depth sorting. */
  get object(): Phaser.GameObjects.Image { return this.img; }

  private frameName(v: number): string {
    if (this.solid && this.current.solid) return this.current.solid;
    return this.current.frames[v] ?? this.current.frames[0];
  }

  update(timeMs: number): void {
    if (!this.ready) return;
    const variant = this.frozen
      ? 0
      : Math.floor(((timeMs + this.phaseOffset) / 1000) * this.fps) % BOIL_VARIANTS;
    if (this.label && variant !== this.lastFlipVariant) {
      this.lastFlipVariant = variant;
      boilStats.flips[this.label] = (boilStats.flips[this.label] ?? 0) + 1;
    }
    if (this.tracerOn && !this.frozen) this.drawTracer(timeMs, variant);
    if (variant === this.lastVariant) return;
    this.lastVariant = variant;
    boilStats.redraws++;
    this.img.setFrame(this.frameName(variant));
  }

  // --- tracer ------------------------------------------------------------------

  private rebuildTracer(): void {
    const s = this.current;
    const key = `sk${++uid}tr`;
    this.tracerImg?.destroy();
    if (this.tracerTex) this.scene.textures.remove(this.tracerTex.key);
    this.tracerTex = this.scene.textures.createCanvas(key, s.frameW, s.frameH) ?? undefined;
    if (!this.tracerTex) return;
    this.tracerImg = this.scene.add.image(0, 0, key).setOrigin(0, 0).setDepth(this.img.depth + 1);
    this.applyTransform();
  }

  /** Render the moving segment with the brush; ends taper, so it reads as a stroke. */
  private drawTracer(timeMs: number, variant: number): void {
    if (!this.tracerTex || !this.tracerImg) return;
    const s = this.current;
    const z = this.zoom;
    const pts = this.variants[variant].flat();
    const lens = cumulative(pts);
    const total = lens[lens.length - 1];
    if (total <= 0) return;
    const head = ((timeMs + this.tracerPhase) * (total / 2400)) % total; // a calm lap every ~2.4 s
    const seg = sliceByLength(pts, lens, head, head + total * 0.26);

    const ctx = this.tracerTex.getContext();
    ctx.clearRect(0, 0, s.frameW, s.frameH);
    if (seg.length > 1) {
      const brush = toBrush({ color: 0x141414, width: this.style.width * 1.5, alpha: 1 });
      dabPolyline(ctx, seg.map((p) => ({ x: (p.x - s.ox) * z, y: (p.y - s.oy) * z })), (brush.width / 2) * z, brush, mulberry32(7));
      finishRegion(ctx, 0, 0, s.frameW, s.frameH, brush, s.ox * z, s.oy * z);
    }
    this.tracerTex.refresh();
    this.tracerImg.setVisible(this.img.visible);
  }

  destroy(): void {
    this.destroyed = true;
    this.tracerImg?.destroy();
    if (this.tracerTex) this.scene.textures.remove(this.tracerTex.key);
    this.img.destroy();
    for (const set of this.sets.values()) this.releaseSet(set);
    this.sets.clear();
  }
}

/** Per-scene registry: ticks every shape from one place. */
export class Boiler {
  private shapes: SketchShape[] = [];

  add(shape: SketchShape): SketchShape { this.shapes.push(shape); return shape; }

  remove(shape: SketchShape): void {
    const i = this.shapes.indexOf(shape);
    if (i >= 0) this.shapes.splice(i, 1);
  }

  update(timeMs: number): void { for (const s of this.shapes) s.update(timeMs); }

  setFrozen(on: boolean): void { for (const s of this.shapes) s.setFrozen(on); }

  destroy(): void {
    this.shapes.forEach((s) => s.destroy());
    this.shapes = [];
  }
}
