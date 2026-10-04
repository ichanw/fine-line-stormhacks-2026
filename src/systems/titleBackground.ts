/**
 * The title-screen background: a fine line between two worlds.
 *
 *   LEFT  dystopian — dry cracked earth, ruins, a fallen telephone pole, dead
 *         stumps, dusty haze. Generated, very faint and loose.
 *   RIGHT alive — the user's own tree on a hill with rocks and grass
 *         (public/art/title/), anchored bottom-right. Never redrawn.
 *   The middle third fades from one to the other; the centre stays clear for
 *   the title and buttons at every aspect ratio.
 *
 * Layer order, back → front: paper → haze + cracked earth → ruins, pole,
 * stumps, debris → transition zone → hill → grass → trunk + rocks → canopy →
 * birds → falling leaves → UI (UI sits at depth >= 50, outside this class).
 *
 * Black and white only (user spec for this screen).
 *
 * Generated strokes use the pencil brush via deferred, grouped SketchShapes
 * (rendered once at device resolution into atlas pages — see CLAUDE.md, Brush
 * performance rules) from a fixed seed (src/data/title.json, F1 to reroll).
 * The background is revealed as a whole once every stroke is rendered.
 */

import Phaser from 'phaser';
import { Boiler, SketchShape, type Pt } from '@/systems/boil';
import { BrushAtlas } from '@/systems/brushAtlas';
import { TITLE_ART_MAX_UPSCALE } from '@/systems/constants';
import { debugPanel, type TitleTuning } from '@/systems/debug';
import { mulberry32 } from '@/systems/rng';
import { settings } from '@/systems/SettingsManager';
import {
  brokenLine, castShadow, CROSS_ANGLE, fillPaper, HATCH_ANGLE, hatchPolygon, StrokeGroups, wobble, type StrokeLayer,
} from '@/systems/sketchKit';
import { TITLE_CANVAS, titleArt, type TitleLayer } from '@/systems/titleArt';
import { SHADED_LAYERS, artShadingFrames } from '@/systems/artShading';
import { viewport } from '@/systems/viewport';

// --- palette: graphite greys only ------------------------------------------
const INK = 0x2e2e2e;
const MID = 0x555555;

/**
 * Foreground ink MATCHED to the user's tree — measured on screen 2026-10-04
 * (1080p@2x; ink = pixels darker than 236/255, so the soft pencil edge counts):
 *   trunk        3.5 units wide, mean grey 178
 *   whole tree   2.8 units wide, mean grey 187
 * Brush calibration in INK: (2.4, 0.64) draws 3.5 u at 177; (2.0, 0.55) draws
 * 2.8 u at 186. Re-measure both if the tree art or the brush changes.
 */
const FG_TRUNK = { color: INK, width: 2.4, alpha: 0.64 };
const FG_TREE = { color: INK, width: 2.0, alpha: 0.55 };

/** Bird size relative to the first version (user, 2026-10-04: ~1.5x). */
const BIRD_SIZE = 1.5;
const HAZE = 0x9a9a9a;

// --- generated layers (back → front) ----------------------------------------
// Ground and ruins boil less than the tree: smaller jitter, slower.
const L_HAZE: StrokeLayer = { name: 'haze', depth: 1, jitter: 1, fps: 4, cell: 320 };
const L_CRACKS: StrokeLayer = { name: 'cracks', depth: 2, jitter: 0.5, fps: 4, cell: 200 };
const L_FAR: StrokeLayer = { name: 'far', depth: 2, jitter: 0.45, fps: 4, cell: 200 };
const L_MID: StrokeLayer = { name: 'mid', depth: 3, jitter: 0.55, fps: 4, cell: 160 };
const L_HERO: StrokeLayer = { name: 'hero', depth: 3, jitter: 0.6, fps: 4, cell: 140 };
const L_SHADE: StrokeLayer = { name: 'shade', depth: 3, jitter: 0.45, fps: 4, cell: 140 };
const L_PROPS: StrokeLayer = { name: 'props', depth: 4, jitter: 0.6, fps: 4, cell: 170 };
const L_FADE: StrokeLayer = { name: 'fade', depth: 5, jitter: 0.9, fps: 4, cell: 220 };

/** Art layer draw order and boil rate (ground boils less than the tree). */
const ART_ORDER: Array<{ name: TitleLayer; fps: number }> = [
  { name: 'hill_right', fps: 2 },
  { name: 'grass_right', fps: 4 },
  { name: 'tree_trunk', fps: 4 },
  { name: 'rocks', fps: 2 },
  { name: 'tree_canopy', fps: 4 },
];

/** Sway pivots, canvas texels: where the canopy meets the trunk; grass base. */
const CANOPY_PIVOT = { x: 1995, y: 800 };
const GRASS_PIVOT = { x: 2060, y: 1365 };

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1)));
  return t * t * (3 - 2 * t);
};

interface Leaf {
  img: Phaser.GameObjects.Image;
  x: number; y: number; scale: number; base: number;
  phase: number; flutter: number; rot: number; spin: number; flip: number; flipSpeed: number;
  speed: number; dying: number;
}

interface Bird { img: Phaser.GameObjects.Image; x: number; y: number; vx: number; flap: number; flapSpeed: number; bob: number }

export class TitleBackground {
  private root: Phaser.GameObjects.Container;
  private birdLayer: Phaser.GameObjects.Container;
  private leafLayer: Phaser.GameObjects.Container;
  private shapes: SketchShape[] = [];
  private hazeShapes: SketchShape[] = [];
  private tufts: Array<{ shape: SketchShape; phase: number; amp: number }> = [];
  private art: Array<{
    name: TitleLayer; img: Phaser.GameObjects.Image; frames: string[]; fps: number; phase: number;
    /** F1 "ink darkness": the same frame again, multiplied at partial alpha. */
    dark: Phaser.GameObjects.Image;
    /** F1 "art shading": generated hatching, built on first use. */
    shade?: Phaser.GameObjects.Image; shadeFrames?: string[];
  }> = [];
  private canopy?: Phaser.GameObjects.Image;
  private grass?: Phaser.GameObjects.Image;
  private leafFrames: Array<{ key: string; frame: string }> = [];
  private birdFrames: Array<{ key: string; frame: string }> = [];
  private templates: SketchShape[] = [];
  private leaves: Leaf[] = [];
  private birds: Bird[] = [];
  private nextFlock = 0;
  private swayT = Math.random() * 100;
  private unsubDebug: () => void;
  private destroyed = false;

  // Layout (layout units), computed once per build.
  private W = 0; private H = 0;
  private s = 1;          // units per art texel
  private anchorX = 0;    // screen x of the art canvas's right edge
  private clearL = 0; private clearR = 0;
  private tc = 0; private zoneHalf = 0;
  private horizon = 0;
  private hill: Pt[][] = [];

  constructor(
    private scene: Phaser.Scene,
    private boiler: Boiler,
    /** Half-width of the centre UI column (title + buttons + margin), units. */
    private clearHalf: number,
    private onRegenerate: () => void,
  ) {
    this.root = scene.add.container(0, 0).setDepth(2);
    this.birdLayer = scene.add.container(0, 0);
    this.leafLayer = scene.add.container(0, 0);

    this.computeLayout();
    const seed = debugPanel.titleSeed();
    const tune = debugPanel.get().title;

    // Generated layers, back to front, in stages. Each stage gets a paper
    // fill under its strokes, so solid objects hide what is behind them.
    const stage = (draw: (g: StrokeGroups, fill: Phaser.GameObjects.Graphics) => void): SketchShape[] => {
      const g = new StrokeGroups();
      const fill = scene.add.graphics();
      draw(g, fill);
      this.root.add(fill);
      const built = g.build(scene, boiler);
      this.shapes.push(...built);
      this.root.add(built.map((b) => b.object));
      return built;
    };
    this.hazeShapes = stage((g) => this.drawHaze(g, mulberry32(seed + 1)));
    stage((g, f) => { this.drawCracks(g, mulberry32(seed + 2), tune.crackDensity); this.drawFar(g, f, mulberry32(seed + 3)); });
    stage((g, f) => this.drawMidRuin(g, f, mulberry32(seed + 31)));
    stage((g, f) => this.drawHeroRuin(g, f, mulberry32(seed + 32)));
    stage((g, f) => this.drawStumpsAndDebris(g, f, mulberry32(seed + 5)));
    stage((g, f) => this.drawPole(g, f, mulberry32(seed + 4)));
    stage((g) => { this.drawFadeGround(g, mulberry32(seed + 6)); this.drawPlaceholders(g); });

    this.drawTufts(mulberry32(seed + 7));
    this.placeArt();
    this.makeLeafAndBirdFrames();
    this.root.add([this.birdLayer, this.leafLayer]);
    this.applyHaze(tune.hazeOpacity);
    this.nextFlock = this.flockDelay(mulberry32(seed + 8));

    // Reveal as a whole once every generated stroke has rendered.
    this.root.setAlpha(0);
    void BrushAtlas.for(scene, 'scenery').whenIdle().then(() => {
      if (this.destroyed) return;
      if (settings.get('reducedMotion')) this.root.setAlpha(1);
      else scene.tweens.add({ targets: this.root, alpha: 1, duration: 350, ease: 'Sine.easeOut' });
    });

    // Live tuning from F1. Structural changes rebuild the scene (debounced).
    let rebuildTimer = 0;
    this.unsubDebug = debugPanel.subscribe((flags, changed) => {
      if (changed === 'titleSeed' || changed === 'title.crackDensity' || changed === 'title.transitionPos' || changed === 'title.*') {
        window.clearTimeout(rebuildTimer);
        rebuildTimer = window.setTimeout(() => { if (!this.destroyed) this.onRegenerate(); }, 350);
      }
      if (changed === 'title.hazeOpacity' || changed === 'title.*') this.applyHaze(flags.title.hazeOpacity);
      if (changed === 'artShading' || changed === 'inkDarkness' || changed === 'title.inkAmount') this.applyArtOverlays();
    });
  }

  // --- layout ------------------------------------------------------------------

  /** Art canvas texel → screen units. */
  private X(cx: number): number { return this.anchorX - (TITLE_CANVAS.w - cx) * this.s; }
  private Y(cy: number): number { return this.H - (TITLE_CANVAS.h - cy) * this.s; }

  private computeLayout(): void {
    const { W, H, zoom } = viewport;
    this.W = W; this.H = H;
    // The centre column, measured from the actual title and buttons.
    this.clearL = W / 2 - this.clearHalf;
    this.clearR = W / 2 + this.clearHalf;

    // Tree group: full height, but never upscaled past the cap.
    let s = Math.min(H / TITLE_CANVAS.h, TITLE_ART_MAX_UPSCALE / zoom);
    const canopy = titleArt.layers.tree_canopy;
    const canopyLeft = canopy?.ok ? canopy.crop.x : 1474;
    const trunkCentre = 2007;
    // Keep the canopy out of the centre: slide the group right (cropping its
    // right edge) first; shrink only if the trunk would leave the screen.
    for (let i = 0; i < 60; i++) {
      this.s = s;
      this.anchorX = Math.max(W, this.clearR + 20 + (TITLE_CANVAS.w - canopyLeft) * s);
      if (this.X(trunkCentre) <= W - 40) break;
      s *= 0.95;
    }

    const tune = debugPanel.get().title;
    this.tc = W * tune.transitionPos;
    this.zoneHalf = W / 6;
    this.horizon = H * 0.8;

    // The user's hill line in screen units, split where it passes behind the
    // rocks and trunk.
    this.hill = [];
    let seg: Pt[] = [];
    let prevX = -Infinity;
    for (const p of titleArt.hillPath) {
      if (p.x - prevX > 40 && seg.length) { this.hill.push(seg); seg = []; }
      seg.push({ x: this.X(p.x), y: this.Y(p.y) });
      prevX = p.x;
    }
    if (seg.length) this.hill.push(seg);
  }

  /** 0 on the ruined side, 1 on the living side; smooth across the middle third. */
  private alive(x: number): number { return smooth(this.tc - this.zoneHalf, this.tc + this.zoneHalf, x); }

  /** Screen y of the user's hill line at x, if the hill is drawn there. */
  private hillY(x: number): number | null {
    for (const seg of this.hill) {
      for (let i = 1; i < seg.length; i++) {
        const a = seg[i - 1], b = seg[i];
        if (x >= a.x && x <= b.x) return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x || 1);
      }
    }
    return null;
  }

  // --- generated: left side ------------------------------------------------------

  /** Dusty haze: soft, light hatching just above the left horizon. */
  private drawHaze(g: StrokeGroups, r: () => number): void {
    const right = this.tc + this.zoneHalf * 0.5;
    for (let i = 0; i < 70; i++) {
      const x = r() * right;
      const fade = 1 - this.alive(x);
      if (r() > fade) continue;
      const y = this.horizon - 4 - Math.pow(r(), 1.6) * 70;
      const len = 40 + r() * 110;
      g.add(L_HAZE, wobble({ x, y }, { x: x + len, y: y + (r() - 0.5) * 6 }, r, 4, 2), {
        color: HAZE, width: 1.8 + r() * 1.6, alpha: 0.16 * fade,
      });
    }
  }

  /**
   * Dry cracked earth: an irregular polygon network in perspective (cells
   * grow toward the viewer), sketched with broken lines and sparse hatching.
   * Denser further left; fades out across the transition.
   */
  private drawCracks(g: StrokeGroups, r: () => number, density: number): void {
    const top = this.horizon + 6, bottom = this.H + 12;
    const right = this.tc + this.zoneHalf;
    const rows: Pt[][] = [];
    let y = top;
    for (let u = 0; y < bottom; u++) {
      const depth = (y - top) / (bottom - top);       // 0 horizon … 1 front
      const rowH = (12 + 46 * depth * depth) / Math.sqrt(density);
      const row: Pt[] = [];
      for (let x = -20; x < right + 40;) {
        row.push({ x: x + (r() - 0.5) * rowH * 1.4, y: y + (r() - 0.5) * rowH * 0.6 });
        // Cells get smaller (denser) further left.
        const cellW = rowH * (1.8 + r() * 1.6) * (0.7 + 0.9 * this.alive(x)) / Math.sqrt(density);
        x += Math.max(6, cellW);
      }
      rows.push(row);
      y += rowH;
    }

    const crack = (a: Pt, b: Pt) => {
      const mx = (a.x + b.x) / 2;
      const keep = Math.pow(1 - this.alive(mx), 0.8);
      if (r() > keep) return;
      const depth = Math.min(1, Math.max(0, (Math.max(a.y, b.y) - top) / (bottom - top)));
      const pts = wobble(a, b, r, 3, 1.6 + 2 * depth);
      // Suggest, don't outline: lots of lifts, low contrast.
      for (const piece of brokenLine(pts, r, 0.32)) {
        // Front cracks carry the tree's weight (FG_TREE); they thin and fade with distance.
        g.add(L_CRACKS, piece, { color: depth > 0.5 ? INK : MID, width: 0.65 + (FG_TREE.width - 0.65) * depth, alpha: (0.3 + (FG_TREE.alpha - 0.3) * depth) * keep });
      }
    };

    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri], next = rows[ri + 1];
      for (let i = 1; i < row.length; i++) if (r() < 0.64) crack(row[i - 1], row[i]);
      if (!next) continue;
      for (const p of row) {
        let best = next[0], bd = Infinity;
        for (const q of next) { const d = Math.abs(q.x - p.x); if (d < bd) { bd = d; best = q; } }
        if (r() < 0.55) crack(p, best);
      }
      // Sparse hatching in a few cells.
      for (let i = 1; i < row.length; i++) {
        const cx = (row[i - 1].x + row[i].x) / 2;
        if (r() > 0.05 * (1 - this.alive(cx))) continue;
        const cy = row[i].y + 6;
        const span = Math.min(18, Math.abs(row[i].x - row[i - 1].x) * 0.4);
        for (let k = 0; k < 4; k++) {
          const hx = cx - span + k * (span / 2);
          g.add(L_CRACKS, wobble({ x: hx, y: cy + 5 }, { x: hx + 6, y: cy - 4 }, r, 1, 0.8), {
            color: MID, width: 0.55, alpha: 0.3,
          });
        }
      }
    }

    // The far horizon line itself, broken, fading out where the hill rises.
    let meet = this.W;
    for (const seg of this.hill) for (const p of seg) if (p.y <= this.horizon) { meet = Math.min(meet, p.x); }
    const end = Math.min(meet, this.tc + this.zoneHalf);
    const pts: Pt[] = [];
    for (let x = -10; x <= end; x += 26) pts.push({ x, y: this.horizon + (r() - 0.5) * 3 + Math.sin(x * 0.01) * 2 });
    for (const piece of brokenLine(pts, r, 0.18)) {
      const mx = piece[Math.floor(piece.length / 2)].x;
      g.add(L_CRACKS, piece, { color: MID, width: 0.85, alpha: 0.5 * (1 - this.alive(mx) * 0.85) });
    }
  }

  // --- the ruined side ---------------------------------------------------------
  // Weighty, not faint: the foreground matches the line weight and darkness of
  // the user's tree side; only the most distant elements stay faint. Light from
  // the upper right: shadow sides face left/down, cast shadows fall down-left.

  /** Right edge for TALL objects (anything rising into the UI's height band). */
  private get tallMax(): number { return this.clearL - 16; }
  /** Right edge for ground-level objects, which may run under the buttons. */
  private get lowMax(): number { return Math.min(this.W * 0.46, this.tc + this.zoneHalf * 0.4); }

  private ink(width: number, alpha: number) { return { color: INK, width, alpha }; }

  /** Hatch a polygon in shadow; `deep` adds cross-hatching. */
  private shade(g: StrokeGroups, poly: Pt[], r: () => number,
    o: { spacing?: number; alpha?: number; deep?: boolean; width?: number } = {}): void {
    const sp = o.spacing ?? 4.2, a = o.alpha ?? 0.55, w = o.width ?? 0.62;
    g.add(L_SHADE, hatchPolygon(poly, HATCH_ANGLE, sp, r), { color: INK, width: w, alpha: a });
    if (o.deep) g.add(L_SHADE, hatchPolygon(poly, CROSS_ANGLE, sp * 1.1, r), { color: INK, width: w, alpha: a * 0.85 });
  }

  /** A cast shadow on the ground, hatched along the ground. */
  private groundShadow(g: StrokeGroups, baseL: Pt, baseR: Pt, len: number, r: () => number, alpha = 0.42): void {
    g.add(L_SHADE, hatchPolygon(castShadow(baseL, baseR, len), 0.1, 3.3, r, 0.2), { color: INK, width: 0.6, alpha: Math.min(0.75, alpha * 1.25) });
  }

  private ruinGeo?: {
    hero: { x0: number; yb: number; fw: number; fh: number; d: number } | null;
    mid: { x0: number; yb: number; fw: number; fh: number; d: number } | null;
  };

  /** Where the hero ruin and the one behind it go (shared by both stages). */
  private ruins() {
    if (this.ruinGeo) return this.ruinGeo;
    const room = this.tallMax - this.W * 0.015;
    const fw = Math.min(this.H * 0.3, room * 0.56);
    if (fw < 50) return (this.ruinGeo = { hero: null, mid: null });
    const d = fw * 0.3, fh = Math.min(this.H * 0.56, fw * 1.85);   // tall, to answer the tree
    const x0 = this.W * 0.015 + d + Math.max(0, room - fw * 1.75 - d) * 0.25;
    const hero = { x0, yb: this.H * 0.885, fw, fh, d };
    const x0m = x0 + fw * 0.55, fwm = Math.min(fw * 0.62, this.tallMax - x0m);
    const mid = fwm > 40 ? { x0: x0m, yb: this.horizon + this.H * 0.03, fw: fwm, fh: fh * 0.62, d: d * 0.6 } : null;
    return (this.ruinGeo = { hero, mid });
  }

  /** Distant, faint: two ruin silhouettes on the horizon and a standing utility pole. */
  private drawFar(g: StrokeGroups, fill: Phaser.GameObjects.Graphics, r: () => number): void {
    const y = this.horizon + 1;
    const far = { color: MID, width: 0.65, alpha: 0.38 };
    const xs = [this.W * 0.04 + r() * 30, Math.min(this.tallMax * 0.8, this.W * 0.22 + r() * 50)];
    for (const x of xs) {
      const w = this.H * (0.05 + r() * 0.03), h = this.H * (0.06 + r() * 0.05);
      const top: Pt[] = [{ x, y: y - h }];
      for (let i = 1; i <= 4; i++) top.push({ x: x + (w * i) / 4, y: y - h * (1 - 0.45 * (i / 4)) + (r() - 0.5) * h * 0.25 });
      fillPaper(fill, [{ x, y }, ...top, { x: x + w, y }]);
      g.add(L_FAR, wobble({ x, y }, { x, y: y - h }, r, 3, 0.8), far);
      g.add(L_FAR, top, far);
      g.add(L_FAR, wobble({ x: x + w, y }, top[top.length - 1], r, 2, 0.8), far);
      const wx = x + w * 0.3, wy = y - h * 0.5, ww = w * 0.22, wh = h * 0.22;
      g.add(L_FAR, [{ x: wx, y: wy }, { x: wx + ww, y: wy }, { x: wx + ww, y: wy - wh }, { x: wx, y: wy - wh }, { x: wx, y: wy }], { ...far, alpha: 0.26 });
    }
    // A utility pole still standing in the distance; the fallen one's wires lead to it.
    const px = Math.min(this.tallMax - 10, this.W * 0.31), ph = this.H * 0.12;
    g.add(L_FAR, wobble({ x: px, y: y + 2 }, { x: px + 1, y: y - ph }, r, 3, 0.6), { color: MID, width: 0.75, alpha: 0.42 });
    g.add(L_FAR, wobble({ x: px - ph * 0.17, y: y - ph * 0.86 }, { x: px + ph * 0.17, y: y - ph * 0.88 }, r, 2, 0.4), { color: MID, width: 0.65, alpha: 0.42 });
    this.farPole = { x: px - ph * 0.12, y: y - ph * 0.87 };
  }

  private farPole?: Pt;

  private drawMidRuin(g: StrokeGroups, fill: Phaser.GameObjects.Graphics, r: () => number): void {
    const m = this.ruins().mid;
    if (m) this.ruin(g, fill, r, { ...m, w: FG_TREE.width, a: FG_TREE.alpha, hero: false });
  }

  private drawHeroRuin(g: StrokeGroups, fill: Phaser.GameObjects.Graphics, r: () => number): void {
    const h = this.ruins().hero;
    if (!h) return;
    // The closest ruin carries the tree trunk's weight.
    this.ruin(g, fill, r, { ...h, w: FG_TRUNK.width, a: FG_TRUNK.alpha, hero: true });
    // A rubble mound against the front-right of the hero ruin.
    const mx = h.x0 + h.fw * 0.62, mw = h.fw * 0.62, mh = h.fh * 0.13, yb = h.yb + 2;
    const mound: Pt[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      mound.push({ x: mx + mw * t, y: yb - Math.sin(t * Math.PI) * mh * (0.8 + r() * 0.3) });
    }
    fillPaper(fill, [...mound, { x: mx + mw, y: yb + 2 }, { x: mx, y: yb + 2 }]);
    for (const piece of brokenLine(mound, r, 0.12)) g.add(L_HERO, piece, FG_TREE);
    for (let k = 0; k < 7; k++) {               // bricks and planks in the pile
      const t = 0.15 + r() * 0.7, bx = mx + mw * t, by = yb - Math.sin(t * Math.PI) * mh * (0.3 + r() * 0.5);
      if (r() < 0.6) {
        const bw = h.fw * 0.06, bh = bw * 0.45, ang = (r() - 0.5) * 0.8;
        const c = Math.cos(ang), s = Math.sin(ang);
        const P = (u: number, v: number) => ({ x: bx + u * c - v * s, y: by + u * s + v * c });
        g.add(L_HERO, [P(0, 0), P(bw, 0), P(bw, bh), P(0, bh), P(0, 0)], this.ink(1.4, 0.55));
      } else {
        const len = h.fw * (0.12 + r() * 0.12), ang = -0.6 + r() * 1.2;
        g.add(L_HERO, wobble({ x: bx, y: by }, { x: bx + Math.cos(ang) * len, y: by - Math.abs(Math.sin(ang)) * len * 0.6 }, r, 2, 0.6), this.ink(1.6, 0.55));
      }
    }
    this.shade(g, [mound[0], ...mound.slice(1, 5), { x: mx + mw * 0.5, y: yb }], r, { spacing: 3.4 });
    this.groundShadow(g, { x: mx, y: yb }, { x: mx + mw, y: yb }, mw * 0.4, r, 0.35);
  }

  /**
   * One ruined house: front face, a side wall receding up-left (in shadow), a
   * collapsed top, a broken gable, dark openings, beams, cracks, cast shadow.
   */
  private ruin(g: StrokeGroups, fill: Phaser.GameObjects.Graphics, r: () => number,
    o: { x0: number; yb: number; fw: number; fh: number; d: number; w: number; a: number; hero: boolean }): void {
    const { x0, yb, fw, fh, d, w, a } = o;
    const L = o.hero ? L_HERO : L_MID;
    const st = this.ink(w, a);
    const sa = o.hero ? 0.62 : 0.5;                          // shading strength
    const bx = x0 - d, by = yb - d * 0.42;                 // back-left bottom

    // Collapsed profile: full height at the left, broken down toward the right.
    const top: Pt[] = [{ x: x0, y: yb - fh }];
    const n = o.hero ? 7 : 5;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      top.push({ x: x0 + fw * t, y: yb - fh * (1 - 0.55 * Math.pow(t, 1.3)) + (i % 2 ? -1 : 1) * fh * 0.05 * r() });
    }
    const rightTop = top[top.length - 1];
    const sideTop = { x: bx, y: by - fh * 0.9 };
    const peak = { x: x0 + fw * 0.22, y: yb - fh * 1.2 };
    const eave = { x: bx - d * 0.1, y: sideTop.y + 2 };
    const roofBreak = { x: x0 + fw * 0.4, y: yb - fh * 1.06 };
    const side = [{ x: bx, y: by }, { x: x0, y: yb }, { x: x0, y: yb - fh }, sideTop];
    fillPaper(fill, side);
    fillPaper(fill, [{ x: x0, y: yb }, { x: x0 + fw, y: yb }, ...top.slice().reverse()]);
    fillPaper(fill, [eave, peak, roofBreak, { x: x0, y: yb - fh }, sideTop]);

    // Outline.
    g.add(L, wobble({ x: x0, y: yb }, { x: x0, y: yb - fh }, r, 6, 1.2), st);
    g.add(L, wobble({ x: x0 - 2, y: yb }, { x: x0 + fw + 4, y: yb }, r, 6, 1.2), st);
    g.add(L, wobble({ x: x0 + fw, y: yb }, rightTop, r, 3, 1.2), st);
    for (const piece of brokenLine(top, r, 0.08)) g.add(L, piece, st);
    g.add(L, wobble({ x: bx, y: by }, sideTop, r, 5, 1.2), st);
    g.add(L, wobble({ x: bx, y: by }, { x: x0, y: yb }, r, 3, 1), st);
    g.add(L, wobble(sideTop, { x: x0, y: yb - fh }, r, 3, 1), st);
    g.add(L, wobble(eave, peak, r, 3, 1), st);
    g.add(L, wobble(peak, roofBreak, r, 2, 1), st);
    for (let k = 1; k <= 3; k++) {                         // rafters left by the break
      const t = k / 4, p = { x: eave.x + (peak.x - eave.x) * t, y: eave.y + (peak.y - eave.y) * t };
      g.add(L, wobble(p, { x: p.x + fw * 0.08, y: p.y + fh * 0.06 }, r, 1, 0.6), this.ink(w * 0.7, a * 0.9));
    }
    const floorY = yb - fh * 0.48;                          // floor slab, broken at the right
    g.add(L, wobble({ x: x0, y: floorY }, { x: x0 + fw * 0.78, y: floorY + 2 }, r, 4, 0.8), this.ink(w * 0.7, a * 0.85));
    for (let k = 0; k < (o.hero ? 4 : 2); k++) {           // exposed beams out of the break
      const p = top[2 + Math.floor(r() * (top.length - 3))];
      const ang = -Math.PI / 2 + (r() - 0.3) * 1.4, len = fh * (0.08 + r() * 0.1);
      const q = { x: p.x + Math.cos(ang) * len, y: p.y + Math.sin(ang) * len };
      g.add(L, wobble(p, q, r, 2, 0.8), this.ink(w * 0.8, a));
      if (o.hero) g.add(L, wobble({ x: p.x + 3, y: p.y + 1 }, { x: q.x + 3, y: q.y + 1 }, r, 2, 0.6), this.ink(w * 0.6, a * 0.8));
    }

    // Openings: windows and a door, their interiors in deep shadow.
    const topAt = (x: number) => top.reduce((m, p) => (Math.abs(p.x - x) < Math.abs(m.x - x) ? p : m), top[0]).y;
    const opening = (cx: number, cy: number, ow: number, oh: number, broken: boolean) => {
      if (cy - oh < topAt(cx + ow / 2) + 6) return;          // above the collapse
      const poly = [{ x: cx, y: cy }, { x: cx + ow, y: cy }, { x: cx + ow, y: cy - oh }, { x: cx, y: cy - oh }];
      for (let e = 0; e < 4; e++) if (!broken || r() < 0.8) g.add(L, wobble(poly[e], poly[(e + 1) % 4], r, 1, 0.6), this.ink(w * 0.8, a));
      this.shade(g, poly, r, { spacing: o.hero ? 3 : 3.6, alpha: sa, deep: true });
      if (broken) g.add(L, wobble({ x: cx + ow * 0.2, y: cy - oh }, { x: cx + ow * 0.75, y: cy - oh * 0.35 }, r, 2, 0.6), this.ink(w * 0.6, a * 0.8));
    };
    const ow = fw * 0.16, oh = fh * 0.17;
    opening(x0 + fw * 0.12, floorY - fh * 0.08, ow, oh, false);
    opening(x0 + fw * 0.45, floorY - fh * 0.08, ow, oh, true);
    opening(x0 + fw * 0.12, yb - fh * 0.12, ow, oh, r() < 0.5);
    opening(x0 + fw * 0.48, yb - 1, fw * 0.2, fh * 0.32, false);   // door
    if (fh > fw * 1.6) {                                             // a third storey
      opening(x0 + fw * 0.12, yb - fh * 0.74, ow, oh * 0.9, r() < 0.5);
      opening(x0 + fw * 0.45, yb - fh * 0.74, ow, oh * 0.9, true);
    }

    for (let k = 0; k < (o.hero ? 3 : 1); k++) {           // facade cracks
      const pts = [{ x: x0 + fw * (0.1 + r() * 0.7), y: yb - fh * (0.25 + r() * 0.4) }];
      for (let j = 0; j < 4; j++) { const q = pts[pts.length - 1]; pts.push({ x: q.x + (r() - 0.5) * fw * 0.08, y: q.y + fh * 0.05 }); }
      g.add(L, pts, this.ink(w * 0.5, a * 0.7));
    }
    if (o.hero) for (let k = 0; k < 4; k++) {             // bricks where the plaster fell
      const b0x = x0 + fw * (0.05 + r() * 0.8), b0y = yb - fh * (0.05 + r() * 0.75), bw = fw * 0.055, bh = bw * 0.45;
      for (let j = 0; j < 3; j++) {
        const ox = (j % 2) * bw * 0.5, oy = j * bh * 1.15;
        g.add(L, [{ x: b0x + ox, y: b0y + oy }, { x: b0x + ox + bw, y: b0y + oy }, { x: b0x + ox + bw, y: b0y + oy + bh }, { x: b0x + ox, y: b0y + oy + bh }, { x: b0x + ox, y: b0y + oy }], this.ink(w * 0.45, a * 0.55));
      }
    }

    // Shading: the side wall faces away from the light; deeper near the ground.
    this.shade(g, side, r, { spacing: o.hero ? 3.6 : 4.5, alpha: sa });
    this.shade(g, [{ x: bx, y: by }, { x: x0, y: yb }, { x: x0, y: yb - fh * 0.35 }, { x: bx, y: by - fh * 0.32 }], r,
      { spacing: o.hero ? 3.6 : 4.5, alpha: sa * 0.8, deep: true });
    this.shade(g, [eave, peak, { x: peak.x, y: peak.y + fh * 0.05 }, { x: eave.x + 4, y: eave.y + fh * 0.04 }], r, { spacing: 3.2, alpha: sa * 0.85 });
    // Cast shadows, thrown down-left.
    this.groundShadow(g, { x: x0, y: yb }, { x: x0 + fw, y: yb }, fw * 0.55, r, sa * 0.75);
    this.groundShadow(g, { x: bx, y: by }, { x: x0, y: yb }, fw * 0.55, r, sa * 0.75);
  }

  /** Dead stumps, a bare snag and scattered debris, shaded, between the ruins and the pole. */
  private drawStumpsAndDebris(g: StrokeGroups, fill: Phaser.GameObjects.Graphics, r: () => number): void {
    const hero = this.ruins().hero;
    // From the hero ruin's right edge (stumps may stand in front of its rubble)
    // to just short of the pole's stump.
    const x0 = hero ? hero.x0 + hero.fw * 1.02 : this.W * 0.05;
    const x1 = this.lowMax - 10;
    const stump = (x: number, y: number, k: number) => {
      const w = 18 * k, h = 14 * k;
      const lt = { x: x + w * 0.12, y: y - h }, rt = { x: x + w * 0.9, y: y - h * 0.62 };
      const sp = { x: x + w * 0.42, y: y - h * 0.86 };
      const body = [{ x: x - w * 0.18, y: y + 1 }, { x: x + w * 0.05, y: y - h * 0.4 }, lt, sp, { x: sp.x + w * 0.06, y: sp.y - h * 0.45 }, { x: sp.x + w * 0.16, y: sp.y + h * 0.05 }, rt, { x: x + w * 0.96, y: y - h * 0.3 }, { x: x + w * 1.2, y: y + 1 }];
      fillPaper(fill, body);
      g.add(L_PROPS, body.slice(0, 3), FG_TRUNK);
      g.add(L_PROPS, body.slice(2, 7), FG_TREE);
      g.add(L_PROPS, body.slice(6), FG_TRUNK);
      this.shade(g, [{ x: x - w * 0.15, y: y }, { x: x + w * 0.05, y: y - h * 0.4 }, lt, { x: x + w * 0.4, y: y - h * 0.8 }, { x: x + w * 0.4, y }], r, { spacing: 2.6, alpha: 0.6, deep: true });
      g.add(L_PROPS, wobble({ x: x - w * 0.18, y: y + 1 }, { x: x - w * 0.6, y: y + 3 }, r, 1, 0.6), this.ink(1.4, 0.5));
      this.groundShadow(g, { x: x - w * 0.2, y: y + 1 }, { x: x + w * 1.2, y: y + 1 }, w * 0.9, r, 0.5);
    };
    if (x1 - x0 > 60) {
      stump(x0 + (x1 - x0) * 0.15, this.H * 0.9, 1.1);
      stump(x0 + (x1 - x0) * 0.7, this.H * 0.86, 0.85);
      // A bare dead snag: tapering trunk, broken top, a few forked branches —
      // only where it stands clear of the pole's stump (it cluttered it).
      // Try a few spots; skip only if every one crowds the pole's stump or a stump.
      const poleStumpX = Math.min(this.lowMax - 24, this.W * 0.4);
      const stumpXs = [x0 + (x1 - x0) * 0.15, x0 + (x1 - x0) * 0.7];
      const spot = [0.45, 0.3, 0.58].map((f) => x0 + (x1 - x0) * f)
        .find((x) => Math.abs(x - poleStumpX) > 60 && stumpXs.every((u) => Math.abs(x - u) > 34));
      const sx = spot ?? 0, sy = this.H * 0.885, sh = this.H * 0.17, sw = 17;   // wide enough to show its hatching inside the heavy outline
      if (spot !== undefined) {
      const trunk = [{ x: sx - sw / 2, y: sy }, { x: sx - sw * 0.3, y: sy - sh }, { x: sx + sw * 0.1, y: sy - sh * 1.04 }, { x: sx + sw * 0.25, y: sy - sh * 0.96 }, { x: sx + sw / 2, y: sy }];
      fillPaper(fill, trunk);
      g.add(L_PROPS, wobble(trunk[0], trunk[1], r, 4, 0.8), FG_TRUNK);
      g.add(L_PROPS, wobble(trunk[4], trunk[3], r, 4, 0.8), FG_TRUNK);
      g.add(L_PROPS, [trunk[1], trunk[2], trunk[3]], FG_TREE);
      for (let k = 0; k < 4; k++) {
        const t = 0.35 + k * 0.15, side = k % 2 ? 1 : -1;
        const p = { x: sx + side * sw * 0.3 * (1 - t), y: sy - sh * t };
        const q = { x: p.x + side * (14 + r() * 16), y: p.y - (12 + r() * 14) };
        g.add(L_PROPS, wobble(p, q, r, 2, 0.6), this.ink(FG_TREE.width - k * 0.2, FG_TREE.alpha));
        g.add(L_PROPS, wobble({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, { x: q.x + side * 6, y: q.y + 4 }, r, 1, 0.4), this.ink(1.1, 0.5));
      }
      // Like the user's tree: soft hatching on the trunk's left side, clipped
      // to the trunk, denser toward the ground.
      this.shade(g, [trunk[0], trunk[1], { x: sx - sw * 0.05, y: sy - sh }, { x: sx - sw * 0.05, y: sy }], r, { spacing: 2.4, alpha: 0.5 });
      this.shade(g, [trunk[0], { x: trunk[0].x + (trunk[1].x - trunk[0].x) * 0.35, y: sy - sh * 0.35 }, { x: sx + sw * 0.2, y: sy - sh * 0.35 }, { x: sx + sw * 0.2, y: sy }], r, { spacing: 2.4, alpha: 0.45, deep: true });
      this.groundShadow(g, { x: sx - sw / 2, y: sy }, { x: sx + sw / 2, y: sy }, sh * 0.5, r, 0.3);
      }
    }
    // Debris across the foreground: planks, bricks, stones — each with a small shadow.
    for (let i = 0; i < 16; i++) {
      const x = this.W * 0.02 + r() * (this.lowMax - this.W * 0.04), y = this.H * (0.9 + r() * 0.085);
      const k = 0.8 + (y / this.H - 0.9) * 4;
      if (r() < 0.5) {
        const len = (10 + r() * 16) * k, ang = (r() - 0.5) * 0.7;
        const a = { x, y }, b = { x: x + Math.cos(ang) * len, y: y + Math.sin(ang) * len };
        g.add(L_PROPS, wobble(a, b, r, 1, 0.5), this.ink(1.6, 0.55));
        g.add(L_PROPS, wobble({ x: a.x, y: a.y + 3 }, { x: b.x, y: b.y + 3 }, r, 1, 0.5), this.ink(1.2, 0.5));
        this.shade(g, [a, b, { x: b.x, y: b.y + 3 }, { x: a.x, y: a.y + 3 }], r, { spacing: 2, alpha: 0.5 });
        this.groundShadow(g, { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) + 3 }, { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) + 3 }, 6, r, 0.3);
      } else {
        const rr = (2.5 + r() * 3) * k;
        const loop: Pt[] = [];
        for (let j = 0; j <= 7; j++) loop.push({ x: x + Math.cos((j / 7) * Math.PI * 2) * rr * 1.4, y: y + Math.sin((j / 7) * Math.PI * 2) * rr });
        fillPaper(fill, loop);
        g.add(L_PROPS, loop, this.ink(1.4, 0.55));
        // A stone: lit from the upper right — hatch its lower-left half,
        // cross-hatch the very bottom, and a small cast shadow.
        this.shade(g, [loop[2], loop[3], loop[4], loop[5], { x, y }], r, { spacing: 1.9, alpha: 0.55 });
        this.shade(g, [loop[3], loop[4], { x, y: y + rr * 0.4 }], r, { spacing: 1.9, alpha: 0.5, deep: true });
        this.groundShadow(g, { x: x - rr * 1.4, y: y + rr * 0.8 }, { x: x + rr * 1.4, y: y + rr * 0.8 }, rr * 2.2, r, 0.45);
      }
    }
  }

  /**
   * The telephone pole, front-most and unmistakable: a splintered stump still
   * standing, the upper length snapped off and lying diagonally on the ground,
   * a crossarm with insulators near the top, a pole-mounted transformer, wood
   * grain, wires still attached and sagging to the ground (one runs back to
   * the standing pole in the distance), and a cast shadow.
   */
  private drawPole(g: StrokeGroups, fill: Phaser.GameObjects.Graphics, r: () => number): void {
    const H = this.H;
    const S = { x: Math.min(this.lowMax - 24, this.W * 0.4), y: H * 0.94 };   // stump base
    const ws = H * 0.024, hs = H * 0.12;
    if (S.x < this.W * 0.18) return;
    const B = { x: S.x - ws * 0.3, y: S.y - hs * 0.85 };                       // the break
    let L = H * 0.66;
    const endY = H * 0.975;
    const dy = endY - B.y;
    L = Math.min(L, Math.hypot(B.x - this.W * 0.02, dy));
    const dx = -Math.sqrt(Math.max(1, L * L - dy * dy));
    const E = { x: B.x + dx, y: B.y + dy };                                    // the pole's top end
    const ux = (E.x - B.x) / L, uy = (E.y - B.y) / L;                          // along the pole
    let nx = -uy, ny = ux;                                                     // across it…
    if (ny > 0) { nx = -nx; ny = -ny; }                                         // …pointing up
    const at = (t: number, v: number) => ({ x: B.x + ux * L * t + nx * v, y: B.y + uy * L * t + ny * v });
    const wb = ws * 0.95, wt = ws * 0.72;
    const half = (t: number) => (wb + (wt - wb) * t) / 2;
    const POLE = FG_TRUNK;

    // Stump: two edges up to a splintered top, flared at the base.
    const stumpPoly = [{ x: S.x - ws * 0.75, y: S.y }, { x: S.x - ws / 2, y: S.y - hs }, { x: S.x - ws * 0.1, y: S.y - hs * 1.12 },
      { x: S.x + ws * 0.1, y: S.y - hs * 0.94 }, { x: S.x + ws * 0.3, y: S.y - hs * 1.06 }, { x: S.x + ws / 2, y: S.y - hs * 0.9 }, { x: S.x + ws * 0.75, y: S.y }];
    fillPaper(fill, stumpPoly);
    g.add(L_PROPS, wobble(stumpPoly[0], stumpPoly[1], r, 3, 0.6), POLE);
    g.add(L_PROPS, wobble(stumpPoly[6], stumpPoly[5], r, 3, 0.6), POLE);
    g.add(L_PROPS, stumpPoly.slice(1, 6), FG_TREE);
    g.add(L_PROPS, wobble({ x: S.x - ws * 0.1, y: S.y - 3 }, { x: S.x - ws * 0.05, y: S.y - hs * 0.8 }, r, 3, 0.4), this.ink(0.9, 0.45));
    this.shade(g, [stumpPoly[0], stumpPoly[1], { x: S.x - ws * 0.05, y: S.y - hs }, { x: S.x - ws * 0.05, y: S.y }], r, { spacing: 2.4, alpha: 0.55, deep: true });
    this.groundShadow(g, stumpPoly[0], stumpPoly[6], hs * 0.9, r, 0.45);

    // The fallen length.
    const top: Pt[] = [], bot: Pt[] = [];
    for (let i = 0; i <= 10; i++) { const t = i / 10; top.push(at(t, half(t))); bot.push(at(t, -half(t))); }
    fillPaper(fill, [...top, ...bot.slice().reverse()]);
    for (const piece of brokenLine(top, r, 0.05)) g.add(L_PROPS, piece, POLE);
    g.add(L_PROPS, bot, POLE);
    const splinters: Pt[] = [at(0, half(0))];
    for (let k = 1; k < 6; k++) splinters.push(at((k % 2 ? 0.03 : -0.01) + r() * 0.01, half(0) - (2 * half(0) * k) / 6));
    splinters.push(at(0, -half(0)));
    g.add(L_PROPS, splinters, FG_TREE);                           // the snapped end
    const cap: Pt[] = [];                                                      // rounded top end
    for (let k = 0; k <= 6; k++) { const a = -Math.PI / 2 + (k / 6) * Math.PI; cap.push(at(1 + (Math.cos(a) * half(1) * 0.5) / L, Math.sin(a) * half(1))); }
    g.add(L_PROPS, cap, POLE);
    for (let k = 0; k < 4; k++) {                                              // wood grain
      const v = (k / 3 - 0.5) * half(0.5) * 1.3, t0 = 0.04 + r() * 0.15, t1 = t0 + 0.3 + r() * 0.45;
      const pts: Pt[] = [];
      for (let t = t0; t <= Math.min(0.97, t1); t += 0.05) pts.push(at(t, v + (r() - 0.5) * 0.8));
      for (const piece of brokenLine(pts, r, 0.15)) g.add(L_PROPS, piece, this.ink(0.9, 0.45));
    }
    for (const t of [0.3 + r() * 0.1, 0.62 + r() * 0.1]) {                   // knots
      const c = at(t, (r() - 0.5) * half(t)); const knot: Pt[] = [];
      for (let k = 0; k <= 6; k++) knot.push({ x: c.x + Math.cos((k / 6) * Math.PI * 2) * 3.2, y: c.y + Math.sin((k / 6) * Math.PI * 2) * 1.8 });
      g.add(L_PROPS, knot, this.ink(1, 0.5));
    }
    // Underside in shadow; deep where it meets the ground.
    const under = [...Array.from({ length: 11 }, (_, i) => at(i / 10, -half(i / 10) * 0.05)), ...bot.slice().reverse()];
    this.shade(g, under, r, { spacing: 2.8, alpha: 0.58 });
    this.shade(g, [at(0.55, 0), at(1, 0), at(1, -half(1)), at(0.55, -half(0.55))], r, { spacing: 2.8, alpha: 0.5, deep: true });
    this.groundShadow(g, bot[0], bot[10], 10, r, 0.5);

    // Crossarm near the top end. The pole lies on its side, so the crossarm
    // (perpendicular to it) now stands up off the ground like a T, with the
    // insulators still pointing toward the pole's top.
    const C = at(0.82, 0);
    const caLen = H * 0.15;
    const caTop = { x: C.x + nx * caLen * 0.7, y: C.y + ny * caLen * 0.7 };
    const caBot = { x: C.x - nx * caLen * 0.12, y: C.y - ny * caLen * 0.12 };   // the rest is in the ground
    const caw = 5;
    const caPoly = [{ x: caBot.x - ux * caw, y: caBot.y - uy * caw }, { x: caBot.x + ux * caw, y: caBot.y + uy * caw },
      { x: caTop.x + ux * caw, y: caTop.y + uy * caw }, { x: caTop.x - ux * caw, y: caTop.y - uy * caw }];
    fillPaper(fill, caPoly);
    g.add(L_PROPS, wobble(caPoly[0], caPoly[3], r, 3, 0.5), FG_TREE);
    g.add(L_PROPS, wobble(caPoly[1], caPoly[2], r, 3, 0.5), FG_TREE);
    g.add(L_PROPS, [caPoly[3], caPoly[2]], this.ink(1.6, 0.55));
    this.shade(g, [caPoly[0], caPoly[3], caTop, caBot], r, { spacing: 2.4, alpha: 0.5 });
    // A brace from the crossarm back to the pole.
    g.add(L_PROPS, wobble({ x: C.x + nx * caLen * 0.42, y: C.y + ny * caLen * 0.42 }, at(0.72, half(0.72)), r, 2, 0.4), this.ink(1.4, 0.55));
    const insulators: Pt[] = [];
    for (const t of [0.3, 0.62, 0.95]) {
      const base = { x: C.x + nx * caLen * 0.7 * t - ux * (caw + 1), y: C.y + ny * caLen * 0.7 * t - uy * (caw + 1) };
      g.add(L_PROPS, [base, { x: base.x - ux * 5, y: base.y - uy * 5 }], this.ink(1, 0.7));       // pin
      // A glass insulator in profile: a core with three umbrella skirts, so it
      // reads as an insulator rather than a row of rings.
      const tip = { x: base.x - ux * 19, y: base.y - uy * 19 };
      g.add(L_PROPS, [{ x: base.x + nx * 1.6, y: base.y + ny * 1.6 }, { x: tip.x + nx * 1.6, y: tip.y + ny * 1.6 }], this.ink(1, 0.7));
      g.add(L_PROPS, [{ x: base.x - nx * 1.6, y: base.y - ny * 1.6 }, { x: tip.x - nx * 1.6, y: tip.y - ny * 1.6 }], this.ink(1, 0.7));
      for (let k = 0; k < 3; k++) {
        const d = 7 + k * 4.6, rr = 6.2 - k * 0.9;
        const c = { x: base.x - ux * d, y: base.y - uy * d };
        const at2 = (side: number, back: number) => ({ x: c.x + nx * rr * side + ux * back, y: c.y + ny * rr * side + uy * back });
        g.add(L_PROPS, [at2(-1, 2.6), at2(-0.55, 0.4), at2(0, -0.6), at2(0.55, 0.4), at2(1, 2.6)], this.ink(1.3, 0.75));
      }
      g.add(L_PROPS, [{ x: tip.x + nx * 1.6, y: tip.y + ny * 1.6 }, { x: tip.x - ux * 1.8, y: tip.y - uy * 1.8 }, { x: tip.x - nx * 1.6, y: tip.y - ny * 1.6 }], this.ink(1.1, 0.75));
      insulators.push({ x: tip.x - ux * 1.8, y: tip.y - uy * 1.8 });
    }

    // Pole-mounted transformer: a can on a bracket, lying with the pole.
    const T = at(0.72, half(0.72) + 2);
    const tr = H * 0.028, th = H * 0.075;
    const tp = (u: number, v: number) => ({ x: T.x + ux * u + nx * v, y: T.y + uy * u + ny * v });
    const can = [tp(-tr, 3), tp(tr, 3), tp(tr, th), tp(-tr, th)];
    fillPaper(fill, can);
    g.add(L_PROPS, wobble(can[0], can[3], r, 3, 0.5), FG_TREE);
    g.add(L_PROPS, wobble(can[1], can[2], r, 3, 0.5), FG_TREE);
    const lid: Pt[] = [];
    for (let k = 0; k <= 10; k++) { const a = (k / 10) * Math.PI * 2; lid.push(tp(Math.cos(a) * tr, th + Math.sin(a) * tr * 0.35)); }
    g.add(L_PROPS, lid, this.ink(1.6, 0.55));
    g.add(L_PROPS, [tp(-tr, 3 + th * 0.35), tp(tr, 3 + th * 0.35)], this.ink(1, 0.5));     // bands
    g.add(L_PROPS, [tp(-tr, 3 + th * 0.7), tp(tr, 3 + th * 0.7)], this.ink(1, 0.5));
    for (const u of [-tr * 0.45, tr * 0.45]) g.add(L_PROPS, [tp(u, th + 1), tp(u, th + 7)], this.ink(1.2, 0.65)); // bushings
    g.add(L_PROPS, [tp(-tr * 0.7, 0), tp(-tr * 0.7, 6)], this.ink(1.4, 0.6));                 // bracket
    g.add(L_PROPS, [tp(tr * 0.7, 0), tp(tr * 0.7, 6)], this.ink(1.4, 0.6));
    this.shade(g, [can[0], { x: (can[0].x + can[1].x) / 2, y: (can[0].y + can[1].y) / 2 }, { x: (can[3].x + can[2].x) / 2, y: (can[3].y + can[2].y) / 2 }, can[3]], r, { spacing: 2.4, alpha: 0.58, deep: true });

    // Wires: still attached, sagging to the ground; one runs back to the far pole.
    insulators.forEach((I, k) => {
      const g1 = { x: I.x + 30 + k * 18, y: H * (0.965 - k * 0.012) };
      const g2 = { x: Math.min(this.lowMax, g1.x + 120 + k * 30), y: H * (0.952 - k * 0.01) };
      const sag: Pt[] = [];
      for (let t = 0; t <= 1.0001; t += 0.1) sag.push({ x: I.x + (g1.x - I.x) * t, y: I.y + (g1.y - I.y) * t * t });
      g.add(L_PROPS, sag, this.ink(1.3, 0.7));
      g.add(L_PROPS, wobble(g1, g2, r, 5, 1.6), this.ink(1.2, 0.65));
      if (k === 0 && this.farPole) {
        // Lifting off the ground and away toward the standing pole, fading with distance.
        const F = this.farPole;
        const run: Pt[] = [];
        for (let t = 0; t <= 1.0001; t += 0.1) run.push({ x: g2.x + (F.x - g2.x) * t, y: g2.y + (F.y - g2.y) * t - Math.sin(t * Math.PI) * -6 });
        g.add(L_PROPS, run.slice(0, 6), this.ink(1, 0.55));
        g.add(L_FAR, run.slice(5), { color: MID, width: 0.5, alpha: 0.35 });
      } else {
        const curl: Pt[] = [g2];                                               // snapped end, curling
        for (let j = 1; j <= 6; j++) { const a = j * 1.05; curl.push({ x: g2.x + 4 + Math.cos(a) * (6 - j * 0.7), y: g2.y - 2 + Math.sin(a) * (5 - j * 0.6) }); }
        g.add(L_PROPS, curl, this.ink(1.1, 0.65));
      }
    });
  }

  /** The hill flattening into the cracked earth, continuing the user's line. */
  private drawFadeGround(g: StrokeGroups, r: () => number): void {
    const first = this.hill[0]?.[0];
    if (!first) return;
    // Continue down-left from where the user's hill line ends, flattening out.
    const pts: Pt[] = [first];
    let x = first.x, y = first.y, slope = 0.35;
    while (x > first.x - 140 && y < this.H - 6) {
      x -= 14; slope *= 0.82; y = Math.min(this.H - 6, y + slope * 14 + (r() - 0.5));
      pts.push({ x, y });
    }
    g.add(L_FADE, pts.reverse(), { color: INK, width: 1.05, alpha: 0.4 });
  }

  /**
   * Grass across the transition: sparse, short and dry on the left, fuller on
   * the right where it meets the user's tuft. Each tuft is its own shape so it
   * can sway about its base.
   */
  private drawTufts(r: () => number): void {
    const left = this.tc - this.zoneHalf;
    const grassArt = titleArt.layers.grass_right;
    const right = Math.min(this.tc + this.zoneHalf, this.X(grassArt?.ok ? grassArt.crop.x : 1968) - 24);
    for (let x = left; x < right;) {
      const t = this.alive(x);
      x += 60 - 30 * t + r() * 50;            // irregular, sparser to the left
      if (r() > 0.3 + 0.7 * t) continue;
      const hy = this.hillY(x);
      const base = { x, y: hy ?? this.H - 6 - r() * 16 };
      // A fan of blades from one base, like the user's tuft: one taller blade,
      // the rest splayed. Dry ones droop and break; living ones stand.
      const blades: Pt[][] = [];
      const n = 3 + Math.floor(r() * (1 + 3 * t));
      for (let k = 0; k < n; k++) {
        const spread = (k / Math.max(1, n - 1) - 0.5) * (1.4 + 0.6 * (1 - t));
        const ang = -Math.PI / 2 + spread + (r() - 0.5) * 0.25;
        const len = (10 + 22 * t) * (k === 1 ? 1.5 : 0.6 + r() * 0.5);
        const tip = { x: base.x + Math.cos(ang) * len, y: base.y + Math.sin(ang) * len };
        const mid = { x: base.x + Math.cos(ang) * len * 0.5 + (r() - 0.5) * 2, y: base.y + Math.sin(ang) * len * 0.55 };
        const droop = t < 0.45 && r() < 0.6;
        const end = droop ? { x: tip.x + Math.cos(ang) * len * 0.3, y: tip.y + len * 0.45 } : tip;
        blades.push([{ x: base.x + (r() - 0.5) * 2, y: base.y + 1 }, mid, end]);
      }
      const shape = this.boiler.add(new SketchShape(this.scene, blades as never,
        { color: t > 0.5 ? INK : MID, width: 0.55 + 0.3 * t, alpha: 0.28 + 0.4 * t },
        { jitter: L_FADE.jitter, fps: 3 + t, depth: L_FADE.depth, deferred: true }));
      shape.setPivot(base.x, base.y);
      this.root.add(shape.object);
      this.shapes.push(shape);
      this.tufts.push({ shape, phase: r() * Math.PI * 2, amp: 0.015 + 0.05 * t });
    }
  }

  /** Simple brush stand-ins for any title PNG that failed to load. */
  private drawPlaceholders(g: StrokeGroups): void {
    const L: StrokeLayer = { name: 'placeholder', depth: 6, jitter: 1, fps: 4 };
    const st = { color: INK, width: 1.4, alpha: 0.7 };
    const P = (x: number, y: number) => ({ x: this.X(x), y: this.Y(y) });
    const miss = (n: TitleLayer) => !titleArt.layers[n]?.ok;
    if (miss('hill_right')) g.add(L, [P(880, 1577), P(1200, 1470), P(1660, 1344), P(2360, 1263)], st);
    if (miss('grass_right')) for (const dx of [-30, -10, 10, 30]) g.add(L, [P(2060, 1365), P(2060 + dx * 2, 1220)], st);
    if (miss('rocks')) g.add(L, [P(1650, 1440), P(1760, 1240), P(1880, 1300), P(1960, 1440)], st);
    if (miss('tree_trunk')) { g.add(L, [P(1950, 1290), P(1900, 760)], st); g.add(L, [P(2060, 1290), P(2080, 760)], st); }
    if (miss('tree_canopy')) {
      const loop: Pt[] = [];
      for (let k = 0; k <= 24; k++) loop.push(P(1900 + Math.cos((k / 24) * Math.PI * 2) * 430, 420 + Math.sin((k / 24) * Math.PI * 2) * 360));
      g.add(L, loop, st);
    }
  }

  // --- the user's art ------------------------------------------------------------

  private placeArt(): void {
    for (const { name, fps } of ART_ORDER) {
      const info = titleArt.layers[name];
      if (!info?.ok) continue;
      const img = this.scene.add.image(0, 0, info.frames[0], 'art')
        .setBlendMode(Phaser.BlendModes.MULTIPLY)   // opaque-white PNGs
        .setScale(this.s);
      const pivot = name === 'tree_canopy' ? CANOPY_PIVOT : name === 'grass_right' ? GRASS_PIVOT : null;
      if (pivot) {
        img.setOrigin((pivot.x - info.crop.x) / info.crop.w, (pivot.y - info.crop.y) / info.crop.h);
        img.setPosition(this.X(pivot.x), this.Y(pivot.y));
      } else {
        img.setOrigin(0, 0).setPosition(this.X(info.crop.x), this.Y(info.crop.y));
      }
      if (name === 'tree_canopy') this.canopy = img;
      if (name === 'grass_right') this.grass = img;
      this.root.add(img);
      const dark = this.scene.add.image(img.x, img.y, info.frames[0], 'art')
        .setBlendMode(Phaser.BlendModes.MULTIPLY).setScale(this.s).setOrigin(img.originX, img.originY);
      this.root.add(dark);
      this.art.push({ name, img, frames: info.frames, fps, phase: Math.random() * 1000, dark });
    }
    this.applyArtOverlays();
  }

  /**
   * F1 comparisons for the user's art, both default OFF: generated shading
   * over the tree and rocks, and an ink-darkness pass. The PNGs are untouched.
   */
  private applyArtOverlays(): void {
    const f = debugPanel.get();
    for (const a of this.art) {
      a.dark.setVisible(f.inkDarkness).setAlpha(f.title.inkAmount);
      if (f.artShading && !a.shade && SHADED_LAYERS.includes(a.name)) {
        // Hatch weight in texels, so it reads like the generated hatching (~0.6 units).
        const frames = artShadingFrames(this.scene, a.name, Math.max(1.1, 0.3 / this.s));
        if (frames) {
          a.shadeFrames = frames;
          a.shade = this.scene.add.image(a.img.x, a.img.y, frames[0], 'art')
            .setScale(this.s).setOrigin(a.img.originX, a.img.originY).setAlpha(0.9);
          this.root.addAt(a.shade, this.root.getIndex(a.dark) + 1);
        }
      }
      a.shade?.setVisible(f.artShading);
    }
  }

  // --- leaves and birds ------------------------------------------------------------

  /**
   * Leaves (no leaf PNGs exist — generated, per the user) and bird poses,
   * drawn once with the brush; instances reuse the frames.
   */
  private makeLeafAndBirdFrames(): void {
    const r = mulberry32(77);
    const leafShapes: Pt[][][] = [];
    for (let v = 0; v < 5; v++) {
      const L = 22 + r() * 6, Wd = 7 + r() * 4, bend = (r() - 0.5) * 5;
      const up: Pt[] = [], down: Pt[] = [];
      for (let k = 0; k <= 8; k++) {
        const t = k / 8, x = -L / 2 + L * t, w = Math.sin(t * Math.PI) * Wd;
        const crinkle = v >= 3 ? (r() - 0.5) * 1.6 : 0;   // two drier, crinkled leaves
        up.push({ x, y: -w + bend * t * t + crinkle });
        down.push({ x, y: w * (0.75 + r() * 0.2) + bend * t * t });
      }
      const rib: Pt[] = [{ x: -L / 2 - 3, y: 0.5 }, { x: 0, y: bend * 0.25 }, { x: L / 2 - 2, y: bend * 0.9 }];
      leafShapes.push([up, down, rib]);
    }
    for (const lines of leafShapes) {
      const sh = new SketchShape(this.scene, lines as never, { color: INK, width: 0.55, alpha: 0.85 }, { jitter: 0, depth: -5000 });
      sh.setVisible(false);
      this.templates.push(sh);
      this.leafFrames.push({ key: sh.object.texture.key, frame: sh.object.frame.name });
    }
    // Four wing poses: up, level, down, level. Drawn at BIRD_SIZE (user: 1.5x)
    // rather than scaled up, so the line stays crisp; flight speed and flap
    // rate are unchanged.
    const B = BIRD_SIZE;
    for (const lift of [-5, -1.5, 3, -1.5]) {
      const wing = (sgn: number): Pt[] => [{ x: 0, y: 0 }, { x: sgn * 4 * B, y: (lift * 0.4 - 1.2) * B }, { x: sgn * 9 * B, y: lift * B }];
      const sh = new SketchShape(this.scene, [wing(-1), wing(1)] as never, { color: INK, width: 0.62, alpha: 0.85 }, { jitter: 0, depth: -5000 });
      sh.setVisible(false);
      this.templates.push(sh);
      this.birdFrames.push({ key: sh.object.texture.key, frame: sh.object.frame.name });
    }
  }

  private canopyBox(): { x0: number; y0: number; x1: number; y1: number } {
    const c = titleArt.layers.tree_canopy;
    const crop = c?.ok ? c.crop : { x: 1474, y: 3, w: 869, h: 848 };
    return { x0: this.X(crop.x + crop.w * 0.08), y0: this.Y(crop.y + crop.h * 0.35), x1: this.X(crop.x + crop.w * 0.9), y1: this.Y(crop.y + crop.h * 0.92) };
  }

  private spawnLeaf(leaf?: Leaf): Leaf {
    const b = this.canopyBox();
    const f = this.leafFrames[Math.floor(Math.random() * this.leafFrames.length)];
    const img = leaf?.img ?? this.scene.add.image(0, 0, f.key, f.frame);
    img.setTexture(f.key, f.frame).setOrigin(0.5, 0.5);
    if (!leaf) this.leafLayer.add(img);
    const scale = 0.55 + Math.random() * 0.45;          // depth: small = far = slow
    const l: Leaf = leaf ?? ({ img } as Leaf);
    Object.assign(l, {
      x: b.x0 + Math.random() * (b.x1 - b.x0),
      y: b.y0 + Math.random() * (b.y1 - b.y0),
      scale, base: 0.55 + Math.random() * 0.35,
      phase: Math.random() * Math.PI * 2, flutter: 0.6 + Math.random() * 0.8,
      rot: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 0.9,
      flip: Math.random() * Math.PI * 2, flipSpeed: 0.4 + Math.random() * 0.9,
      speed: 0.7 + scale * 0.6, dying: 0,
    });
    return l;
  }

  private flockDelay(r: () => number = Math.random): number {
    const f = debugPanel.get().title.birdFreq;
    if (f <= 0) return Infinity;
    return (6000 + r() * 6000) / f;
  }

  private spawnFlock(): void {
    const n = 2 + Math.floor(Math.random() * 4);
    const x = this.W * 0.2 + Math.random() * Math.max(10, this.clearL - 30 - this.W * 0.2);
    const y = this.H * (0.12 + Math.random() * 0.22);
    const vx = -(12 + Math.random() * 7);
    for (let i = 0; i < n; i++) {
      const f = this.birdFrames[0];
      const img = this.scene.add.image(0, 0, f.key, f.frame).setOrigin(0.5, 0.5);
      this.birdLayer.add(img);
      const k = 0.7 + Math.random() * 0.4;
      img.setScale(k / viewport.zoom * 1).setAlpha(0.7);
      this.birds.push({
        img, x: x + i * (14 + Math.random() * 16) * BIRD_SIZE, y: y + (Math.random() - 0.5) * 26 * BIRD_SIZE,
        vx: vx * (0.92 + Math.random() * 0.16), flap: Math.random() * 4, flapSpeed: 2.6 + Math.random() * 1.6, bob: Math.random() * 6,
      });
    }
  }

  private applyHaze(opacity: number): void {
    // 0.5 is the designed look; the slider scales it 0 … 2x.
    for (const h of this.hazeShapes) h.setAlpha(Math.min(1, opacity * 2));
  }

  // --- per frame -------------------------------------------------------------------

  update(time: number, delta: number): void {
    const reduced = settings.get('reducedMotion');
    const tune: TitleTuning = debugPanel.get().title;
    const dt = Math.min(0.05, delta / 1000);
    const wind = tune.windDir * tune.windStrength;

    // Boil the user's art: whole-texel-displaced frames, out of sync.
    for (const a of this.art) {
      const v = reduced ? 0 : Math.floor(((time + a.phase) / 1000) * a.fps) % a.frames.length;
      if (a.img.texture.key !== a.frames[v]) a.img.setTexture(a.frames[v], 'art');
      if (a.dark.visible) {
        if (a.dark.texture.key !== a.frames[v]) a.dark.setTexture(a.frames[v], 'art');
        a.dark.setRotation(a.img.rotation);
      }
      if (a.shade?.visible && a.shadeFrames) {
        if (a.shade.texture.key !== a.shadeFrames[v]) a.shade.setTexture(a.shadeFrames[v], 'art');
        a.shade.setRotation(a.img.rotation);
      }
    }

    // Breeze sway: canopy and grass (and the generated tufts), out of sync.
    if (!reduced) this.swayT += dt;
    const gust = (p: number) => Math.sin(this.swayT * 0.9 + p) * 0.6 + Math.sin(this.swayT * 0.37 + p * 1.7) * 0.4;
    const lean = -Math.sign(wind || -1) * Math.min(1, Math.abs(wind));
    this.canopy?.setRotation(reduced ? 0 : 0.008 * (gust(0) * 0.7 + lean * 0.4) * Math.max(0.2, tune.windStrength));
    this.grass?.setRotation(reduced ? 0 : 0.03 * (gust(2.1) * 0.7 + lean * 0.4) * Math.max(0.2, tune.windStrength));
    for (const t of this.tufts) t.shape.setRotation(reduced ? 0 : t.amp * (gust(t.phase) * 0.7 + lean * 0.3) * Math.max(0.2, tune.windStrength));

    this.updateLeaves(dt, reduced, tune, wind);
    this.updateBirds(dt, reduced, tune);
  }

  private updateLeaves(dt: number, reduced: boolean, tune: TitleTuning, wind: number): void {
    const want = reduced ? Math.min(3, tune.leafCount) : Math.round(tune.leafCount);
    while (this.leaves.length < want) {
      const l = this.spawnLeaf();
      this.leaves.push(l);
    }
    while (this.leaves.length > want) this.leaves.pop()!.img.destroy();

    const dissolveStart = this.tc, dissolveEnd = this.W * 0.08;
    const z = viewport.zoom;
    for (const l of this.leaves) {
      const sp = tune.leafSpeed * l.speed * (reduced ? 0.25 : 1);
      if (!reduced) l.phase += dt * l.flutter * 2;
      const flutterX = reduced ? 0 : Math.sin(l.phase) * 9;
      const flutterY = reduced ? 0 : Math.cos(l.phase * 0.7) * 4;
      l.x += ((wind || -0.15) * 22 + flutterX) * sp * dt;
      l.y += (6 + 6 * l.scale + flutterY) * sp * dt;
      if (!reduced) { l.rot += l.spin * dt; l.flip += l.flipSpeed * dt; }

      // Over the ruined side the leaf grows lighter and dissolves before the edge.
      let a = l.base * smooth(dissolveEnd, dissolveStart, l.x);
      const ground = this.hillY(l.x) ?? this.H - 4;
      if (l.y > ground - 2) l.dying = Math.min(1, l.dying + dt * 0.8);
      a *= 1 - l.dying;
      const gone = a < 0.01 || l.x < -20 || l.x > this.W + 20 || l.dying >= 1;
      if (gone) { this.spawnLeaf(l); continue; }

      const flipX = reduced ? 1 : 0.35 + 0.65 * Math.cos(l.flip); // "slight flip", edge-on now and then
      l.img.setPosition(l.x, Math.min(l.y, ground))
        .setRotation(l.rot)
        .setScale((l.scale * flipX) / z, l.scale / z)
        .setAlpha(a);
    }
  }

  private updateBirds(dt: number, reduced: boolean, tune: TitleTuning): void {
    if (reduced) {
      // No birds under reduced motion.
      this.birds.forEach((b) => b.img.destroy());
      this.birds = [];
      return;
    }
    this.nextFlock -= dt * 1000;
    if (this.nextFlock <= 0) {
      this.spawnFlock();
      this.nextFlock = this.flockDelay();
    }
    if (tune.birdFreq <= 0 && this.nextFlock === Infinity) this.nextFlock = Infinity;
    else if (this.nextFlock === Infinity) this.nextFlock = this.flockDelay();

    for (const b of this.birds) {
      b.x += b.vx * dt;
      b.bob += dt * 1.3;
      b.flap += dt * b.flapSpeed;
      // Soft flaps with the odd glide.
      const frame = Math.sin(b.bob * 0.7) > 0.85 ? 1 : Math.floor(b.flap) % this.birdFrames.length;
      const f = this.birdFrames[frame];
      b.img.setTexture(f.key, f.frame).setPosition(b.x, b.y + Math.sin(b.bob) * 2.5);
    }
    this.birds = this.birds.filter((b) => {
      if (b.x > -30) return true;
      b.img.destroy();
      return false;
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubDebug();
    this.templates.forEach((t) => t.destroy());
    this.shapes.forEach((s) => this.boiler.remove(s));
    this.root.destroy();
    this.shapes.forEach((s) => s.destroy());
  }
}
