/**
 * Generated ambient life for story scenes, in the pencil style: birds, leaves,
 * sparkles, smoke, drifting smog, litter, and heavy cross-hatching.
 *
 * Shapes are drawn once with the brush (SketchShape templates) and reused by
 * many sprites, so a scene full of motion costs a handful of brush renders.
 * Static filler (litter, hatching) is built as boiling StrokeGroups at the
 * scenery rate. Everything respects reduced motion: moving things hold still
 * (or are left out), boil freezes.
 *
 * Positions are in layout units; scenes convert from frame pixels first.
 */

import Phaser from 'phaser';
import { Boiler, SketchShape, type Pt } from '@/systems/boil';
import { hatchPolygon, HATCH_ANGLE, StrokeGroups, wobble, type StrokeLayer } from '@/systems/sketchKit';
import { dabPolyline, defaultBrush, finishStroke } from '@/systems/brush';
import { mulberry32 } from '@/systems/rng';
import { settings } from '@/systems/SettingsManager';
import { viewport } from '@/systems/viewport';
import { BOIL_FPS_SCENERY } from '@/systems/constants';

const INK = 0x2e2e2e;
type Frame = { key: string; frame: string };

export interface Area { x: number; y: number; w: number; h: number }

/** Owns templates and sprites; call update() each frame and destroy() on shutdown. */
export class Ambient {
  private templates: SketchShape[] = [];
  private shapes: SketchShape[] = [];
  private systems: Array<(t: number, dt: number, reduced: boolean) => void> = [];
  private objects: Phaser.GameObjects.GameObject[] = [];
  readonly layer: Phaser.GameObjects.Container;

  constructor(private scene: Phaser.Scene, private boiler: Boiler, depth: number) {
    this.layer = scene.add.container(0, 0).setDepth(depth);
  }

  private template(lines: Pt[][], style: { width: number; alpha: number; color?: number }): Frame {
    const sh = new SketchShape(this.scene, lines as never, { color: style.color ?? INK, width: style.width, alpha: style.alpha },
      { jitter: 0, depth: -5000 });
    sh.setVisible(false);
    this.templates.push(sh);
    return { key: sh.object.texture.key, frame: sh.object.frame.name };
  }

  private sprite(f: Frame): Phaser.GameObjects.Image {
    const img = this.scene.add.image(0, 0, f.key, f.frame).setOrigin(0.5);
    this.layer.add(img);
    return img;
  }

  // --- birds ------------------------------------------------------------------------

  /**
   * Flocks crossing `area`. mood: happy = lively flaps, rising; normal; sad =
   * slow, low, wings drooping, gliding downward.
   */
  birds(area: Area, mood: 'happy' | 'normal' | 'sad' = 'normal', size = 1): void {
    const lifts = mood === 'sad' ? [2, 4, 6, 4] : [-5, -1.5, 3, -1.5];
    const frames = lifts.map((lift) => {
      const B = 1.5 * size;
      const wing = (s: number): Pt[] => mood === 'sad'
        ? [{ x: 0, y: 0 }, { x: s * 4 * B, y: (lift * 0.5) * B }, { x: s * 8 * B, y: (lift + 3) * B }]
        : [{ x: 0, y: 0 }, { x: s * 4 * B, y: (lift * 0.4 - 1.2) * B }, { x: s * 9 * B, y: lift * B }];
      return this.template([wing(-1), wing(1)], { width: 0.62, alpha: mood === 'sad' ? 0.75 : 0.85 });
    });
    const birds: Array<{ img: Phaser.GameObjects.Image; x: number; y: number; vx: number; vy: number; flap: number; rate: number; bob: number }> = [];
    let next = 0.5;
    const speed = mood === 'sad' ? 9 : mood === 'happy' ? 22 : 15;
    this.systems.push((_t, dt, reduced) => {
      if (reduced) { birds.forEach((b) => b.img.setVisible(false)); return; }
      next -= dt;
      if (next <= 0) {
        next = (mood === 'happy' ? 3 : 6) + Math.random() * 6;
        const dir = Math.random() < 0.5 ? -1 : 1;
        const n = 2 + Math.floor(Math.random() * (mood === 'happy' ? 5 : 3));
        const y0 = area.y + Math.random() * area.h * 0.6;
        for (let i = 0; i < n; i++) {
          const img = this.sprite(frames[0]).setAlpha(mood === 'sad' ? 0.6 : 0.75);
          birds.push({
            img, x: (dir > 0 ? area.x - 20 : area.x + area.w + 20) - dir * i * (12 + Math.random() * 14),
            y: y0 + (Math.random() - 0.5) * 24, vx: dir * speed * (0.9 + Math.random() * 0.2),
            vy: mood === 'happy' ? -2.5 : mood === 'sad' ? 2.2 : 0, flap: Math.random() * 4,
            rate: mood === 'sad' ? 1.1 : mood === 'happy' ? 4.2 : 2.8, bob: Math.random() * 6,
          });
        }
      }
      for (let i = birds.length - 1; i >= 0; i--) {
        const b = birds[i];
        b.x += b.vx * dt; b.y += b.vy * dt; b.flap += dt * b.rate; b.bob += dt * 1.4;
        const f = frames[Math.floor(b.flap) % frames.length];
        b.img.setTexture(f.key, f.frame).setPosition(b.x, b.y + Math.sin(b.bob) * 2).setScale(1 / viewport.zoom);
        if (b.x < area.x - 40 || b.x > area.x + area.w + 40) { b.img.destroy(); birds.splice(i, 1); }
      }
    });
  }

  // --- leaves -----------------------------------------------------------------------

  /** Leaves drifting down through `area` (fast: streaming past, as from a bike). */
  leaves(area: Area, count = 6, fast = false): void {
    const r = mulberry32(77);
    const frames: Frame[] = [];
    for (let v = 0; v < 4; v++) {
      const L = 20 + r() * 6, Wd = 6 + r() * 4, bend = (r() - 0.5) * 5;
      const up: Pt[] = [], down: Pt[] = [];
      for (let k = 0; k <= 8; k++) {
        const t = k / 8, x = -L / 2 + L * t, w = Math.sin(t * Math.PI) * Wd;
        up.push({ x, y: -w + bend * t * t }); down.push({ x, y: w * 0.8 + bend * t * t });
      }
      frames.push(this.template([up, down, [{ x: -L / 2 - 3, y: 0.5 }, { x: L / 2 - 2, y: bend * 0.9 }]], { width: 0.55, alpha: 0.85 }));
    }
    const leaves = Array.from({ length: count }, () => ({
      img: this.sprite(frames[Math.floor(Math.random() * frames.length)]),
      x: area.x + Math.random() * area.w, y: area.y + Math.random() * area.h,
      ph: Math.random() * 6, spin: (Math.random() - 0.5) * 2, rot: Math.random() * 6, s: 0.6 + Math.random() * 0.5,
    }));
    this.systems.push((_t, dt, reduced) => {
      for (const l of leaves) {
        if (!reduced) {
          l.ph += dt * 1.6; l.rot += l.spin * dt;
          if (fast) { l.x += (l.x < area.x + area.w / 2 ? -1 : 1) * 160 * l.s * dt; l.y += 50 * l.s * dt; }
          else { l.x += (Math.sin(l.ph) * 14 - 8) * dt; l.y += (10 + 8 * l.s) * dt; }
          if (l.y > area.y + area.h || l.x < area.x - 20 || l.x > area.x + area.w + 20) {
            l.x = fast ? area.x + area.w * (0.35 + Math.random() * 0.3) : area.x + Math.random() * area.w;
            l.y = area.y + (fast ? area.h * 0.2 * Math.random() : -10);
          }
        }
        l.img.setPosition(l.x, l.y).setRotation(l.rot).setScale(l.s / viewport.zoom, (l.s * Math.cos(l.ph * 0.7)) / viewport.zoom).setAlpha(0.7);
      }
    });
  }

  // --- sparkles (good outcome) -------------------------------------------------------

  sparkles(area: Area, count = 14): void {
    const f = this.template([[{ x: -6, y: 0 }, { x: 6, y: 0 }], [{ x: 0, y: -8 }, { x: 0, y: 8 }], [{ x: -3, y: -3 }, { x: 3, y: 3 }]],
      { width: 0.55, alpha: 0.8 });
    const sp = Array.from({ length: count }, () => ({
      img: this.sprite(f).setPosition(area.x + Math.random() * area.w, area.y + Math.random() * area.h),
      ph: Math.random() * 10, rate: 0.6 + Math.random() * 0.8,
    }));
    this.systems.push((t, _dt, reduced) => {
      for (const s of sp) {
        // Stepped like the boil, not smooth: twinkle in 4 fps steps.
        const step = Math.floor((t / 1000) * BOIL_FPS_SCENERY);
        const v = reduced ? 0.6 : 0.5 + 0.5 * Math.sin(step * 0.9 * s.rate + s.ph);
        s.img.setAlpha(reduced ? 0.45 : Math.max(0, v) * 0.9).setScale((0.6 + 0.6 * Math.max(0, v)) / viewport.zoom);
      }
    });
  }

  // --- smoke ------------------------------------------------------------------------------

  /** Puffs rising from each source; `dark` for the bad outcome. */
  smoke(sources: Pt[], dark: boolean, rate = 1): void {
    const r = mulberry32(31);
    const puffs: Frame[] = [];
    for (let v = 0; v < 3; v++) {
      const loop: Pt[] = [], R = 26 + r() * 8;
      for (let k = 0; k <= 22; k++) {
        const a = (k / 22) * Math.PI * 2.15, rr = R * (0.8 + 0.25 * Math.sin(a * 3 + v));
        loop.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr * 0.75 });
      }
      const lines: Pt[][] = [loop];
      if (dark) for (let k = -4; k <= 4; k++) lines.push(wobble({ x: -R * 0.45 + k * 5, y: R * 0.45 }, { x: -R * 0.05 + k * 5, y: -R * 0.4 }, r, 2, 1));
      puffs.push(this.template(lines, { width: dark ? 1 : 0.7, alpha: dark ? 0.85 : 0.6 }));
    }
    const live: Array<{ img: Phaser.GameObjects.Image; x: number; y: number; age: number; life: number; drift: number }> = [];
    const timers = sources.map(() => Math.random());
    this.systems.push((_t, dt, reduced) => {
      sources.forEach((s, i) => {
        timers[i] -= dt * rate * (reduced ? 0 : 1);
        if (timers[i] <= 0) {
          timers[i] = 0.55 + Math.random() * 0.5;
          live.push({ img: this.sprite(puffs[Math.floor(Math.random() * 3)]), x: s.x, y: s.y, age: 0, life: 4 + Math.random() * 2, drift: 4 + Math.random() * 6 });
        }
      });
      // Reduced motion: a few puffs stay frozen in place above each source.
      if (reduced && !live.length) sources.forEach((s) => [0.2, 0.5, 0.8].forEach((a) => live.push({ img: this.sprite(puffs[0]), x: s.x, y: s.y, age: a * 4, life: 4, drift: 6 })));
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i];
        if (!reduced) p.age += dt;
        const k = p.age / p.life;
        if (k >= 1) { p.img.destroy(); live.splice(i, 1); continue; }
        p.img.setPosition(p.x + p.drift * p.age + Math.sin(p.age * 1.3) * 3, p.y - 14 * p.age)
          .setScale((0.6 + k * 2.2) / viewport.zoom).setAlpha((dark ? 0.95 : 0.7) * Math.sin(Math.PI * Math.min(1, k * 1.2)));
      }
    });
  }

  // --- tiled pencil textures (cheap at any size) ---------------------------------------

  /**
   * Three boil variants of a pencil tile `wpx` x `hpx` device pixels that
   * repeats horizontally (strokes are drawn shifted by ±wpx so they wrap).
   * `fade(y01)` scales alpha down the tile, so a band has soft edges instead
   * of stopping on a hard line.
   */
  tileTextures(id: string, wpx: number, hpx: number, lines: (r: () => number) => Pt[][],
    style: { width: number; alpha: number }, fade: (y: number) => number): string[] {
    const keys: string[] = [];
    for (let v = 0; v < 3; v++) {
      const key = `ambient-tile-${id}-${v}-${wpx}x${hpx}`;
      keys.push(key);
      if (this.scene.textures.exists(key)) continue;
      const c = document.createElement('canvas');
      c.width = wpx; c.height = hpx;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      const r = mulberry32(900 + v * 13 + id.length);
      const brush = defaultBrush({ color: '#2e2e2e', width: style.width * 2, alpha: style.alpha * 0.3 });
      const rad = style.width * viewport.zoom;
      for (const l of lines(r)) for (const ox of [-wpx, 0, wpx]) dabPolyline(ctx, l.map((p) => ({ x: p.x + ox, y: p.y })), rad, brush, r);
      finishStroke(ctx, wpx, hpx, brush);
      const img = ctx.getImageData(0, 0, wpx, hpx), d = img.data;
      for (let y = 0; y < hpx; y++) {
        const f = Math.max(0, Math.min(1, fade(y / hpx)));
        for (let x = 0; x < wpx; x++) d[(y * wpx + x) * 4 + 3] *= f;
      }
      ctx.putImageData(img, 0, 0);
      this.scene.textures.addCanvas(key, c);
    }
    return keys;
  }

  /** A horizontally repeating tile over `area`, boiling at the scenery rate. */
  tiled(area: Area, keys: string[], alpha: number, scroll = 0): Phaser.GameObjects.TileSprite {
    const z = viewport.zoom;
    const ts = this.scene.add.tileSprite(area.x, area.y, area.w, area.h, keys[0]).setOrigin(0, 0).setTileScale(1 / z).setAlpha(alpha);
    this.layer.add(ts);
    let off = 0, cur = 0;
    this.systems.push((t, dt, reduced) => {
      const v = reduced ? 0 : Math.floor((t / 1000) * BOIL_FPS_SCENERY) % 3;
      if (v !== cur) { cur = v; ts.setTexture(keys[v]); }
      if (!reduced && scroll) { off += scroll * dt * z; ts.tilePositionX = off; }
    });
    return ts;
  }

  /** Wide bands of graphite haze drifting slowly sideways across `area`. */
  smog(area: Area, bands = 3): void {
    const z = viewport.zoom;
    for (let b = 0; b < bands; b++) {
      const h = area.h * (0.16 + b * 0.04), y = area.y + area.h * (0.08 + (b / bands) * 0.72);
      const hpx = Math.ceil(h * z), wpx = 512;
      const keys = this.tileTextures(`smog${b}`, wpx, hpx, (r) => {
        const out: Pt[][] = [];
        for (let yy = 6; yy < hpx; yy += 8 + r() * 4) {
          if (r() < 0.2) continue;
          const pts: Pt[] = [], amp = 3 + r() * 6, ph = r() * 6;
          for (let x = 0; x <= wpx; x += 32) pts.push({ x, y: yy + Math.sin((x / wpx) * Math.PI * 4 + ph) * amp });
          out.push(pts);
        }
        return out;
      }, { width: 0.55, alpha: 0.6 }, (t) => Math.sin(Math.PI * t) ** 1.5);
      this.tiled({ x: area.x, y, w: area.w, h }, keys, 0.6, (b % 2 ? -1 : 1) * (6 + b * 3));
    }
  }

  /** Heavy dark cross-hatching over `area` (bad outcome sky), fading out at the bottom. */
  hatching(area: Area, alpha = 0.5): void {
    const wpx = 512, hpx = Math.ceil(area.h * viewport.zoom);
    const keys = this.tileTextures('hatch', wpx, hpx, (r) => {
      const out: Pt[][] = [];
      const dir = (slope: number, sp: number) => {
        // Strokes from the top edge down at `slope` (dx per dy), wrapping sideways.
        for (let x = -hpx * Math.abs(slope); x < wpx + hpx * Math.abs(slope); x += sp * (0.8 + r() * 0.4)) {
          if (r() < 0.12) continue;
          const y0 = r() * 40 - 20, y1 = hpx + 20;
          out.push([{ x: x + (r() - 0.5) * 3, y: y0 }, { x: x + slope * (y1 - y0) / 2, y: (y0 + y1) / 2 }, { x: x + slope * (y1 - y0), y: y1 }]);
        }
      };
      dir(-0.55, 18);
      dir(0.4, 22);
      return out;
    }, { width: 0.6, alpha: 1 }, (t) => (t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3));
    this.tiled(area, keys, alpha);
  }

  // --- traffic and walkers ------------------------------------------------------------------

  /** Side-view vehicles along a road band: cars (smoky when `dirty`) or a tram. */
  traffic(area: Area, count: number, kind: 'car' | 'tram', dirty = false): void {
    const car = (): Pt[][] => [
      [{ x: -20, y: 4 }, { x: -20, y: -3 }, { x: -12, y: -4 }, { x: -7, y: -11 }, { x: 8, y: -11 }, { x: 13, y: -4 }, { x: 20, y: -3 }, { x: 20, y: 4 }, { x: -20, y: 4 }],
      [{ x: -12, y: 5 }, { x: -9, y: 8 }, { x: -6, y: 5 }], [{ x: 7, y: 5 }, { x: 10, y: 8 }, { x: 13, y: 5 }],
    ];
    const tram = (): Pt[][] => {
      const out: Pt[][] = [[{ x: -60, y: 6 }, { x: -60, y: -14 }, { x: 60, y: -14 }, { x: 60, y: 6 }, { x: -60, y: 6 }],
        [{ x: -30, y: -14 }, { x: -24, y: -24 }], [{ x: -24, y: -24 }, { x: 10, y: -24 }]];
      for (let x = -52; x < 52; x += 17) out.push([{ x, y: -10 }, { x: x + 11, y: -10 }, { x: x + 11, y: -3 }, { x, y: -3 }, { x, y: -10 }]);
      return out;
    };
    const f = this.template(kind === 'car' ? car() : tram(), { width: 0.8, alpha: 0.85 });
    const vs = Array.from({ length: count }, (_, i) => {
      const dir = i % 2 ? -1 : 1;
      return { img: this.sprite(f).setFlipX(dir < 0), x: area.x + Math.random() * area.w, y: area.y + (i % 2 ? area.h * 0.65 : area.h * 0.3), dir,
        v: (kind === 'tram' ? 16 : 26 + Math.random() * 14) * dir, ph: Math.random() * 6 };
    });
    if (dirty) this.smokeTrail(vs);
    this.systems.push((_t, dt, reduced) => {
      for (const c of vs) {
        if (!reduced) { c.x += c.v * dt; c.ph += dt * 9; }
        if (c.x > area.x + area.w + 60) c.x = area.x - 60;
        if (c.x < area.x - 60) c.x = area.x + area.w + 60;
        c.img.setPosition(c.x, c.y + (reduced ? 0 : Math.sin(c.ph) * 0.6)).setScale(1 / viewport.zoom);
      }
    });
  }

  /** Exhaust puffs behind moving vehicles. */
  private smokeTrail(vs: Array<{ x: number; y: number; dir: number }>): void {
    const f = this.template([[{ x: -5, y: 0 }, { x: -2, y: -4 }, { x: 3, y: -3 }, { x: 5, y: 1 }, { x: 0, y: 4 }, { x: -5, y: 0 }]], { width: 0.6, alpha: 0.6 });
    const puffs: Array<{ img: Phaser.GameObjects.Image; x: number; y: number; age: number }> = [];
    let tmr = 0;
    this.systems.push((_t, dt, reduced) => {
      if (reduced) return;
      tmr -= dt;
      if (tmr <= 0) {
        tmr = 0.35;
        for (const c of vs) puffs.push({ img: this.sprite(f), x: c.x - c.dir * 22, y: c.y + 2, age: 0 });
      }
      for (let i = puffs.length - 1; i >= 0; i--) {
        const p = puffs[i]; p.age += dt;
        if (p.age > 1.6) { p.img.destroy(); puffs.splice(i, 1); continue; }
        p.img.setPosition(p.x, p.y - p.age * 8).setScale((0.6 + p.age) / viewport.zoom).setAlpha(0.6 * (1 - p.age / 1.6));
      }
    });
  }

  /** Small walking figures crossing a band (good outcome). */
  walkers(area: Area, count: number): void {
    const fig = (step: number): Pt[][] => [
      [{ x: -3, y: -22 }, { x: 0, y: -25 }, { x: 3, y: -22 }, { x: 0, y: -19 }, { x: -3, y: -22 }],
      [{ x: 0, y: -19 }, { x: 0, y: -8 }],
      [{ x: 0, y: -16 }, { x: -4 * step, y: -11 }], [{ x: 0, y: -16 }, { x: 4 * step, y: -11 }],
      [{ x: 0, y: -8 }, { x: -4 * step, y: 0 }], [{ x: 0, y: -8 }, { x: 4 * step, y: 0 }],
    ];
    const frames = [this.template(fig(1), { width: 0.7, alpha: 0.85 }), this.template(fig(0.25), { width: 0.7, alpha: 0.85 })];
    const ws = Array.from({ length: count }, (_, i) => ({ img: this.sprite(frames[0]), x: area.x + Math.random() * area.w,
      y: area.y + area.h * (0.4 + Math.random() * 0.5), v: (8 + Math.random() * 6) * (i % 2 ? -1 : 1), ph: Math.random() * 2 }));
    this.systems.push((_t, dt, reduced) => {
      for (const w of ws) {
        if (!reduced) { w.x += w.v * dt; w.ph += dt * 3; }
        if (w.x > area.x + area.w + 10) w.x = area.x - 10;
        if (w.x < area.x - 10) w.x = area.x + area.w + 10;
        const f = frames[Math.floor(w.ph) % 2];
        w.img.setTexture(f.key, f.frame).setPosition(w.x, w.y).setFlipX(w.v < 0).setScale(1 / viewport.zoom);
      }
    });
  }

  // --- static filler (boiling) -------------------------------------------------------------

  /** Litter scattered along `area`: crumpled paper, bottles, wrappers; `piles` heaps them. */
  litter(area: Area, count: number, piles = false, seed = 9): void {
    const r = mulberry32(seed);
    const g = new StrokeGroups();
    const L: StrokeLayer = { name: 'litter', depth: 0, jitter: 0.5, fps: BOIL_FPS_SCENERY, cell: 120 };
    const st = { color: INK, width: 0.9, alpha: 0.8 };
    const item = (x: number, y: number, k: number) => {
      const kind = r();
      if (kind < 0.45) {                           // crumpled paper ball
        const loop: Pt[] = [];
        for (let j = 0; j <= 9; j++) { const a = (j / 9) * Math.PI * 2, rr = 5 * k * (0.75 + r() * 0.5); loop.push({ x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr * 0.8 }); }
        g.add(L, loop, st);
        g.add(L, wobble({ x: x - 3 * k, y: y - 1 }, { x: x + 3 * k, y: y + 2 }, r, 2, 1.5), { ...st, width: 0.6 });
      } else if (kind < 0.75) {                     // bottle on its side
        const a = r() * Math.PI, c = Math.cos(a), s = Math.sin(a), l = 13 * k, w = 3.5 * k;
        const P = (u: number, v: number) => ({ x: x + u * c - v * s, y: y + u * s + v * c });
        g.add(L, [P(-l, -w), P(l * 0.5, -w), P(l * 0.7, -w * 0.5), P(l, -w * 0.4), P(l, w * 0.4), P(l * 0.7, w * 0.5), P(l * 0.5, w), P(-l, w), P(-l, -w)], st);
      } else {                                      // wrapper / bag
        g.add(L, [{ x: x - 7 * k, y }, { x: x - 3 * k, y: y - 5 * k }, { x: x + 5 * k, y: y - 3 * k }, { x: x + 8 * k, y: y + 2 * k }, { x: x - 6 * k, y: y + 3 * k }, { x: x - 7 * k, y }], st);
      }
    };
    if (piles) {
      for (let p = 0; p < count; p++) {
        const cx = area.x + r() * area.w, cy = area.y + area.h * (0.5 + r() * 0.5), pw = 40 + r() * 50, ph = 16 + r() * 14;
        const mound: Pt[] = [];
        for (let j = 0; j <= 10; j++) { const t = j / 10; mound.push({ x: cx - pw / 2 + pw * t, y: cy - Math.sin(t * Math.PI) * ph * (0.8 + r() * 0.3) }); }
        g.add(L, mound, { ...st, width: 1.2, alpha: 0.85 });
        g.add(L, hatchPolygon([...mound, { x: cx + pw / 2, y: cy }, { x: cx - pw / 2, y: cy }], HATCH_ANGLE, 3.2, r), { color: INK, width: 0.6, alpha: 0.6 });
        for (let j = 0; j < 7; j++) item(cx - pw * 0.4 + r() * pw * 0.8, cy - r() * ph * 0.9, 0.9 + r() * 0.5);
      }
    } else {
      for (let j = 0; j < count; j++) item(area.x + r() * area.w, area.y + r() * area.h, 0.8 + r() * 0.4);
    }
    this.build(g);
  }

  private build(g: StrokeGroups): void {
    const built = g.build(this.scene, this.boiler);
    built.forEach((s) => this.layer.add(s.object));
    this.shapes.push(...built);
  }

  /** A flat veil (dimming, or a faint grey for the neutral outcome). */
  veil(area: Area, color: number, alpha: number): void {
    const rect = this.scene.add.rectangle(area.x, area.y, area.w, area.h, color, alpha).setOrigin(0, 0);
    this.layer.add(rect);
    this.objects.push(rect);
  }

  /** Register a custom per-frame system (scene-specific animation). */
  add(fn: (t: number, dt: number, reduced: boolean) => void): void { this.systems.push(fn); }

  update(time: number, delta: number): void {
    const dt = Math.min(0.05, delta / 1000), reduced = settings.get('reducedMotion');
    this.systems.forEach((s) => s(time, dt, reduced));
  }

  destroy(): void {
    this.templates.forEach((t) => t.destroy());
    this.shapes.forEach((s) => s.destroy());
    this.layer.destroy();
  }
}
