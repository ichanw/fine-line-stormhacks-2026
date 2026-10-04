/**
 * The title-screen world: one continuous drawing that runs from a dystopian
 * left to a utopian right, which is the game's whole premise — a fine line
 * between two worlds, decided by what you choose.
 *
 * Rules this file exists to enforce:
 *   - Everything is line work. No fills except the water.
 *   - Monochrome, EXCEPT `COLOR_SEA`, which is allowed only on the utopian
 *     side and drains to nothing before mid-screen. See `utopiaMix`.
 *   - All static line work boils (systems/boil.ts); the birds and leaves are
 *     redrawn per frame because they actually travel.
 */

import Phaser from 'phaser';
import { Boiler, Pt, SketchShape, pathShape } from '@/systems/boil';
import { settings } from '@/systems/SettingsManager';
import {
  COLOR_INK, COLOR_SEA, GAME_HEIGHT, GAME_WIDTH, GREY_FAINT, GREY_SOFT,
} from '@/systems/constants';

const HORIZON = 560;
/** Left of this, no colour at all. Colour ramps from here to the right edge. */
const COLOUR_START = GAME_WIDTH * 0.56;

/** 0 on the dystopian side, 1 at the far utopian edge. */
function utopiaMix(x: number): number {
  return Phaser.Math.Clamp((x - COLOUR_START) / (GAME_WIDTH - COLOUR_START), 0, 1);
}

function wobble(x1: number, y1: number, x2: number, y2: number, n = 4, amp = 3): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({
      x: x1 + (x2 - x1) * t + (Math.random() - 0.5) * amp,
      y: y1 + (y2 - y1) * t + (Math.random() - 0.5) * amp,
    });
  }
  return pts;
}

interface Bird { x: number; y: number; speed: number; phase: number; scale: number }
interface Leaf { x: number; y: number; vx: number; vy: number; spin: number; r: number; size: number; colour: number }

export class World {
  private shapes: SketchShape[] = [];
  private birds: Bird[] = [];
  private leaves: Leaf[] = [];
  private birdGfx: Phaser.GameObjects.Graphics;
  private leafGfx: Phaser.GameObjects.Graphics;
  private waterGfx: Phaser.GameObjects.Graphics;
  private waveT = 0;

  constructor(private scene: Phaser.Scene, private boiler: Boiler) {
    this.birdGfx = scene.add.graphics().setDepth(3);
    this.leafGfx = scene.add.graphics().setDepth(4);
    this.waterGfx = scene.add.graphics().setDepth(1);

    this.buildGround();
    this.buildDystopia();
    this.buildUtopia();
    this.buildSky();

    for (let i = 0; i < 7; i++) {
      this.birds.push({
        x: Math.random() * 520,
        y: 150 + Math.random() * 240,
        speed: 7 + Math.random() * 10,
        phase: Math.random() * Math.PI * 2,
        scale: 0.7 + Math.random() * 0.7,
      });
    }
    for (let i = 0; i < 16; i++) this.leaves.push(this.spawnLeaf(true));
  }

  private add(points: Pt[], color: number, width: number, alpha: number, jitter = 1.4): SketchShape {
    const s = this.boiler.add(
      new SketchShape(this.scene, pathShape(points), { color, width, alpha }, { jitter, depth: 2 }),
    );
    this.shapes.push(s);
    return s;
  }

  // --- terrain -----------------------------------------------------------

  private buildGround(): void {
    // One sweeping ground line, dipping and rising across the page.
    const pts: Pt[] = [];
    for (let x = -20; x <= GAME_WIDTH + 20; x += 34) {
      const y = HORIZON + Math.sin(x * 0.006) * 26 + Math.sin(x * 0.021) * 7;
      pts.push({ x, y });
    }
    this.add(pts, COLOR_INK, 2, 0.9, 2);
  }

  private groundY(x: number): number {
    return HORIZON + Math.sin(x * 0.006) * 26 + Math.sin(x * 0.021) * 7;
  }

  // --- the dystopian (left) side ----------------------------------------

  private buildDystopia(): void {
    // A collapsing shack: roof, walls, a leaning post.
    const bx = 150, by = this.groundY(150);
    this.add(wobble(bx - 72, by - 86, bx, by - 150), COLOR_INK, 2, 0.85);
    this.add(wobble(bx, by - 150, bx + 78, by - 84), COLOR_INK, 2, 0.85);
    this.add(wobble(bx - 66, by - 92, bx - 60, by), COLOR_INK, 1.8, 0.8);
    this.add(wobble(bx + 72, by - 90, bx + 66, by - 4), COLOR_INK, 1.8, 0.8);
    this.add(wobble(bx - 60, by - 6, bx + 66, by - 10), COLOR_INK, 1.6, 0.7);
    // A broken doorway and a hole in the roof.
    this.add(wobble(bx - 16, by - 6, bx - 14, by - 60), GREY_SOFT, 1.4, 0.75);
    this.add(wobble(bx - 14, by - 60, bx + 16, by - 58), GREY_SOFT, 1.4, 0.75);
    this.add(wobble(bx + 16, by - 58, bx + 18, by - 8), GREY_SOFT, 1.4, 0.75);
    this.add(wobble(bx + 20, by - 118, bx + 44, by - 104), GREY_SOFT, 1.2, 0.6);

    // A dead, bare tree.
    const tx = 400, ty = this.groundY(400);
    this.add(wobble(tx, ty, tx - 8, ty - 150, 5, 4), COLOR_INK, 2.4, 0.9);
    const limbs: Array<[number, number, number, number]> = [
      [tx - 6, ty - 96, tx - 62, ty - 140], [tx - 7, ty - 118, tx + 48, ty - 162],
      [tx - 8, ty - 142, tx - 40, ty - 196], [tx - 8, ty - 146, tx + 34, ty - 192],
      [tx - 50, ty - 132, tx - 76, ty - 170], [tx + 40, ty - 156, tx + 62, ty - 190],
    ];
    for (const [x1, y1, x2, y2] of limbs) this.add(wobble(x1, y1, x2, y2, 3, 3), COLOR_INK, 1.6, 0.8);

    // Dead reeds and scratched-out ground.
    for (let i = 0; i < 46; i++) {
      const x = Math.random() * 520;
      const y = this.groundY(x);
      const len = 16 + Math.random() * 42;
      const lean = (Math.random() - 0.5) * 30;
      this.add(wobble(x, y + 6, x + lean, y - len, 2, 2), GREY_SOFT, 1.2, 0.35 + Math.random() * 0.35);
    }
    for (let i = 0; i < 16; i++) {
      const x = Math.random() * 480;
      const y = this.groundY(x) + 14 + Math.random() * 90;
      this.add(wobble(x, y, x + 30 + Math.random() * 70, y + (Math.random() - 0.5) * 16, 2, 2),
        GREY_FAINT, 1.1, 0.4);
    }
  }

  // --- the utopian (right) side -----------------------------------------

  private buildUtopia(): void {
    // A full, living tree.
    const tx = 1050, ty = this.groundY(1050);
    this.add(wobble(tx, ty, tx + 6, ty - 170, 5, 4), COLOR_INK, 2.6, 0.9);
    const limbs: Array<[number, number, number, number]> = [
      [tx + 4, ty - 120, tx - 54, ty - 170], [tx + 5, ty - 140, tx + 66, ty - 186],
      [tx + 6, ty - 162, tx - 28, ty - 210], [tx + 6, ty - 166, tx + 40, ty - 214],
    ];
    for (const [x1, y1, x2, y2] of limbs) this.add(wobble(x1, y1, x2, y2, 3, 3), COLOR_INK, 1.7, 0.85);

    // Canopy: many small leaf marks. The colour ramp means the outer, further
    // right leaves pick up the blue while the inner ones stay graphite.
    for (let i = 0; i < 150; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.6) * 118;
      const lx = tx + 6 + Math.cos(a) * r * 1.15;
      const ly = ty - 196 + Math.sin(a) * r * 0.78;
      const mix = utopiaMix(lx);
      const colour = mix > 0.45 && Math.random() < mix * 0.5 ? COLOR_SEA : COLOR_INK;
      this.add(wobble(lx, ly, lx + 7 + Math.random() * 7, ly - 4 + Math.random() * 8, 2, 1.5),
        colour, 1.2, 0.45 + Math.random() * 0.4, 1);
    }

    // Grass tufts and a couple of rocks.
    for (let i = 0; i < 44; i++) {
      const x = 760 + Math.random() * 520;
      const y = this.groundY(x);
      const len = 14 + Math.random() * 30;
      const mix = utopiaMix(x);
      const colour = Math.random() < mix * 0.35 ? COLOR_SEA : GREY_SOFT;
      this.add(wobble(x, y + 4, x + (Math.random() - 0.5) * 20, y - len, 2, 2), colour, 1.2, 0.45);
    }
    const rock = (rx: number, scale: number) => {
      const ry = this.groundY(rx);
      this.add([
        { x: rx - 32 * scale, y: ry + 2 }, { x: rx - 18 * scale, y: ry - 22 * scale },
        { x: rx + 6 * scale, y: ry - 28 * scale }, { x: rx + 30 * scale, y: ry + 2 },
      ], COLOR_INK, 1.6, 0.8, 1.6);
    };
    rock(905, 1); rock(1210, 0.7);
  }

  // --- sky ---------------------------------------------------------------

  private buildSky(): void {
    // Scratchy, broken cloud on the left; softer, fuller cloud on the right.
    for (let i = 0; i < 20; i++) {
      const x = Math.random() * 480;
      const y = 90 + Math.random() * 170;
      this.add(wobble(x, y, x + 40 + Math.random() * 90, y + (Math.random() - 0.5) * 10, 3, 3),
        GREY_FAINT, 1.2, 0.35);
    }
    const softCloud = (cx: number, cy: number, w: number) => {
      const pts: Pt[] = [];
      for (let i = 0; i <= 26; i++) {
        const t = i / 26;
        const a = Math.PI + t * Math.PI;
        pts.push({ x: cx + Math.cos(a) * w, y: cy + Math.sin(a) * w * 0.42 - Math.sin(t * Math.PI * 3) * 9 });
      }
      this.add(pts, GREY_SOFT, 1.3, 0.5, 1.6);
    };
    softCloud(1120, 180, 150);
    softCloud(880, 128, 96);
  }

  // --- animated elements -------------------------------------------------

  private spawnLeaf(scatter = false): Leaf {
    const x = 900 + Math.random() * 380;
    const mix = utopiaMix(x);
    return {
      x,
      y: scatter ? 260 + Math.random() * 280 : 300 + Math.random() * 60,
      vx: -10 - Math.random() * 16,
      vy: 7 + Math.random() * 13,
      spin: (Math.random() - 0.5) * 2.4,
      r: Math.random() * Math.PI * 2,
      size: 4 + Math.random() * 4,
      colour: Math.random() < mix * 0.55 ? COLOR_SEA : COLOR_INK,
    };
  }

  update(_time: number, delta: number): void {
    const reduced = settings.get('reducedMotion');
    this.drawWater(reduced);
    this.drawBirds(reduced, delta);
    this.drawLeaves(reduced, delta);
  }

  /** The one body of water, on the utopian side. The only fill in the drawing. */
  private drawWater(reduced: boolean): void {
    if (!reduced) this.waveT += 0.016;
    const g = this.waterGfx;
    g.clear();
    const left = 1120, right = GAME_WIDTH + 10;
    const top = this.groundY(1180) + 46;
    g.fillStyle(COLOR_SEA, 0.18);
    g.beginPath();
    g.moveTo(left, top + 10);
    for (let x = left; x <= right; x += 12) {
      g.lineTo(x, top + Math.sin(this.waveT + x * 0.03) * 3);
    }
    g.lineTo(right, GAME_HEIGHT);
    g.lineTo(left, GAME_HEIGHT);
    g.closePath();
    g.fillPath();

    g.lineStyle(1.4, COLOR_SEA, 0.75);
    for (let row = 0; row < 3; row++) {
      const baseY = top + 16 + row * 20;
      g.beginPath();
      for (let x = left + 8; x <= right; x += 12) {
        const y = baseY + Math.sin(this.waveT * 1.2 + x * 0.028 + row) * 3;
        if (x === left + 8) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.strokePath();
    }

    // Accessibility: water must not be identified by colour alone.
    if (settings.get('waterPattern')) {
      g.lineStyle(1, COLOR_SEA, 0.5);
      for (let x = left; x < right; x += 14) {
        g.beginPath();
        g.moveTo(x, top + 8);
        g.lineTo(x + 26, GAME_HEIGHT);
        g.strokePath();
      }
    }
  }

  private drawBirds(reduced: boolean, delta: number): void {
    const g = this.birdGfx;
    g.clear();
    g.lineStyle(1.5, COLOR_INK, 0.7);
    for (const b of this.birds) {
      if (!reduced) {
        b.x += (b.speed * delta) / 1000;
        b.phase += delta * 0.006;
        if (b.x > 560) { b.x = -40; b.y = 150 + Math.random() * 240; }
      }
      // A simple two-stroke gull; the flap opens and closes the wings.
      const flap = reduced ? 0.5 : (Math.sin(b.phase) * 0.5 + 0.5);
      const w = 9 * b.scale;
      const lift = 5 * b.scale * flap;
      g.beginPath();
      g.moveTo(b.x - w, b.y + lift);
      g.lineTo(b.x, b.y - lift * 0.4);
      g.lineTo(b.x + w, b.y + lift);
      g.strokePath();
    }
  }

  private drawLeaves(reduced: boolean, delta: number): void {
    const g = this.leafGfx;
    g.clear();
    for (const l of this.leaves) {
      if (!reduced) {
        l.x += (l.vx * delta) / 1000;
        l.y += (l.vy * delta) / 1000;
        l.r += (l.spin * delta) / 1000;
        if (l.y > this.groundY(l.x) + 10 || l.x < 700) Object.assign(l, this.spawnLeaf());
      }
      g.lineStyle(1.2, l.colour, 0.75);
      const c = Math.cos(l.r), s = Math.sin(l.r);
      g.beginPath();
      g.moveTo(l.x - c * l.size, l.y - s * l.size);
      g.lineTo(l.x + c * l.size, l.y + s * l.size);
      g.strokePath();
    }
  }

  destroy(): void {
    this.shapes.forEach((s) => this.boiler.remove(s));
    this.shapes.forEach((s) => s.destroy());
    this.shapes = [];
    this.birdGfx.destroy();
    this.leafGfx.destroy();
    this.waterGfx.destroy();
  }
}
