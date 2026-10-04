/**
 * Transition D — stop-motion scrapbook (user spec, 2026-10-04). The default.
 *
 *   1. cover   4–6 torn paper scraps slide in from the edges or drop from
 *              above, each landing at a slight random tilt (±3–8°) with 1–2
 *              frames of overshoot jitter, until the old screen is covered
 *   2. hold    a beat on the collage (~200 ms)
 *   3. slap    the next screen arrives as a torn-edge sheet that slaps down on
 *              top with a small bounce; 2–3 masking-tape strips snap onto its
 *              corners
 *   4. live    the scraps beneath are gone, the tape fades, input unlocks
 *
 * Everything moves on STEPS at ~8 fps — positions, rotations and scale jump
 * between poses like stop-motion; nothing eases. Edges and tape keep boiling
 * at the UI rate (~2 fps). All tuning lives in src/data/transitions.json.
 *
 * Look: black-and-white paper, graphite torn edges with paper fibres on their
 * outer side, faint-grain masking tape, a soft drop shadow under every piece.
 * Torn outlines are generated from a seed that advances each transition, so
 * each one differs but any one can be reproduced.
 *
 * Built cheaply so it can start on a click: each scrap is a container of a
 * low-res blurred shadow, a paper polygon (Graphics fill) and four Ropes that
 * draw one pre-rendered pencil-edge texture along the torn sides. Boiling the
 * edge is re-jittering the rope points — no re-rendering.
 */

import Phaser from 'phaser';
import cfg from '@/data/transitions.json';
import { dabPolyline, defaultBrush, finishRegion, type Pt } from '@/systems/brush';
import { mulberry32 } from '@/systems/rng';
import { playSfx } from '@/systems/sfx';
import { viewport } from '@/systems/viewport';
import { COLOR_PAPER, COLOR_TAPE } from '@/systems/constants';

const C = cfg.scrapbook;
const FRAME_MS = 1000 / C.fps;
const BOIL_MS = 1000 / C.edgeBoilFps;
const frames = (ms: number) => Math.max(1, Math.round((ms * C.fps) / 1000));
const DEG = Math.PI / 180;
const TOP = 10000;

let runSeed = C.seed;

// --- shared textures -----------------------------------------------------------

/** Edge thickness (units): the graphite line plus the fibres beyond it. */
const EDGE_T = 7;

/**
 * One long pencil line with paper fibres along its outer half, drawn at device
 * resolution. Ropes stretch it along every torn side.
 */
function edgeTexture(scene: Phaser.Scene): string {
  const z = viewport.zoom;
  const key = `scrap-edge-${z.toFixed(3)}`;
  if (scene.textures.exists(key)) return key;
  const w = 4096, h = Math.ceil(EDGE_T * z), mid = h * 0.6;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const rng = mulberry32(4471);
  const pts: Pt[] = [];
  for (let x = 0; x <= w; x += 64) pts.push({ x, y: mid + (rng() - 0.5) * 0.5 * z });
  // Heavy enough to read like the game's pencil outlines (FG_TREE weight).
  const style = defaultBrush({ color: '#262626', alpha: 0.55, grain: 0.45 });
  dabPolyline(ctx, pts, 1.15 * z, style, rng);
  finishRegion(ctx, 0, 0, w, h, style);
  // Torn paper fibres: fine pale hairs on the outer side (towards row 0).
  ctx.lineCap = 'round';
  for (let x = 0; x < w; x += 2 + rng() * 6) {
    const len = (0.8 + rng() * 2.6) * z;
    ctx.strokeStyle = `rgba(90,90,90,${0.25 + rng() * 0.3})`;
    ctx.lineWidth = Math.max(0.6, 0.3 * z);
    ctx.beginPath();
    ctx.moveTo(x, mid - 0.4 * z);
    ctx.lineTo(x + (rng() - 0.5) * 1.6 * z, mid - 0.4 * z - len);
    ctx.stroke();
  }
  scene.textures.addCanvas(key, c);
  return key;
}

/** Three boil variants of a masking-tape strip with torn zig-zag ends and grain. */
function tapeTextures(scene: Phaser.Scene): string[] {
  const z = viewport.zoom;
  const keys: string[] = [];
  for (let v = 0; v < 3; v++) {
    const key = `scrap-tape-${v}-${z.toFixed(3)}`;
    keys.push(key);
    if (scene.textures.exists(key)) continue;
    const w = Math.ceil(TAPE_W * z), h = Math.ceil(TAPE_H * z);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const rng = mulberry32(880 + v * 31);
    const base = Phaser.Display.Color.IntegerToRGB(COLOR_TAPE);
    // Zig-zag torn ends, re-jittered per variant so they boil.
    const zig = (y: number, seed: number) => {
      const t = ((y / h) * 7 + seed) % 1;
      return (Math.abs(t - 0.5) * 2) * 2.2 * z + mulberry32(Math.floor(y / 3) + seed * 977)() * 0.9 * z;
    };
    for (let y = 0; y < h; y++) {
      const l = zig(y, v * 0.37 + 0.1), r = zig(y, v * 0.53 + 0.6);
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (x < l || x > w - 1 - r) { d[i + 3] = 0; continue; }
        // Faint grain, lengthwise streaks, a few diagonal crinkles, and
        // graphite-grey long edges so it reads on white paper.
        const crinkle = Math.abs(((x + y * 0.8) / (17 * z) + v * 0.3) % 1 - 0.5) < 0.03 ? -16 : 0;
        const g = (rng() - 0.5) * 16 + Math.sin(y * 1.7 + v) * 3 + crinkle;
        const edge = y < 1.1 * z || y > h - 1 - 1.1 * z;
        const e = edge ? -70 : 0;
        d[i] = base.r + g + e; d[i + 1] = base.g + g + e; d[i + 2] = base.b + g + e - 2;
        d[i + 3] = (edge ? 245 : 222) + (rng() - 0.5) * 24;
      }
    }
    ctx.putImageData(img, 0, 0);
    scene.textures.addCanvas(key, c);
  }
  return keys;
}
const TAPE_W = 132, TAPE_H = 30;

// --- torn paper ------------------------------------------------------------------

/**
 * A rough torn outline around a w x h rectangle centred on (0,0), as four
 * runs (one per side, clockwise from the top-left): slow waves, a fine jagged
 * walk, and the occasional bite.
 */
function tornSides(w: number, h: number, rng: () => number, step = 5): Pt[][] {
  const corners = [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }];
  const sides: Pt[][] = [];
  let walk = 0;
  for (let s = 0; s < 4; s++) {
    const a = corners[s], b = corners[(s + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(6, Math.round(len / step));
    const nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;           // outward
    const f1 = 0.012 + rng() * 0.01, ph = rng() * 10;
    const side: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = t * len;
      walk = walk * 0.65 + (rng() - 0.5) * 2.6;
      const bite = rng() < 0.035 ? -(2.5 + rng() * 6) : 0;
      const ends = Math.min(1, Math.min(i, n - i) / 3);             // corners stay put
      const o = (Math.sin(u * f1 + ph) * 4 + Math.sin(u * f1 * 2.9 + ph * 1.7) * 2 + walk + bite) * ends;
      side.push({ x: a.x + (b.x - a.x) * t + nx * o, y: a.y + (b.y - a.y) * t + ny * o });
    }
    sides.push(side);
  }
  return sides;
}

/** A soft drop shadow: the outline drawn small, so upscaling blurs it. */
function shadowTexture(scene: Phaser.Scene, outline: Pt[], w: number, h: number, id: string): { key: string; k: number } {
  const k = 8;                                   // units per shadow texel
  const pad = 4;
  const cw = Math.ceil(w / k) + pad * 2, ch = Math.ceil(h / k) + pad * 2;
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d')!;
  ctx.filter = 'blur(1.5px)';
  ctx.fillStyle = 'rgba(30,30,30,1)';
  ctx.beginPath();
  outline.forEach((p, i) => (i ? ctx.lineTo(cw / 2 + p.x / k, ch / 2 + p.y / k) : ctx.moveTo(cw / 2 + p.x / k, ch / 2 + p.y / k)));
  ctx.closePath();
  ctx.fill();
  const key = `scrap-shadow-${id}`;
  if (scene.textures.exists(key)) scene.textures.remove(key);
  scene.textures.addCanvas(key, c);
  return { key, k };
}

const SHADOW_A = 0.45;

/** A torn piece of paper: shadow, paper body, boiling graphite edges. */
class TornPiece {
  readonly root: Phaser.GameObjects.Container;
  readonly shadow: Phaser.GameObjects.Image;
  private ropes: Phaser.GameObjects.Rope[] = [];
  private variants: Phaser.Math.Vector2[][][] = [];   // [variant][side] → points (device px)
  private boilV = 0;
  private shadowKey: string;

  constructor(scene: Phaser.Scene, w: number, h: number, rng: () => number, id: string, depth: number) {
    const sides = tornSides(w, h, rng);
    const outline = sides.flatMap((s) => s.slice(0, -1));
    const sh = shadowTexture(scene, outline, w, h, id);
    this.shadowKey = sh.key;
    this.shadow = scene.add.image(0, 0, sh.key).setScale(sh.k).setAlpha(SHADOW_A);
    const body = scene.add.graphics().fillStyle(COLOR_PAPER, 1)
      .fillPoints(outline.map((p) => new Phaser.Math.Vector2(p.x, p.y)), true);
    const z = viewport.zoom, tex = edgeTexture(scene);
    // Three boil variants of the edge: the same tear, nudged a fraction.
    for (let v = 0; v < 3; v++) {
      const jr = mulberry32(Math.floor(rng() * 1e9));
      this.variants.push(sides.map((side) => side.map((p, i) => {
        const j = i === 0 || i === side.length - 1 ? 0 : 0.7;
        return new Phaser.Math.Vector2((p.x + (jr() - 0.5) * j) * z, (p.y + (jr() - 0.5) * j) * z);
      })));
    }
    for (let s = 0; s < 4; s++) {
      // Points are in device px with the rope scaled 1/zoom, so the texture's
      // height maps to EDGE_T layout units.
      this.ropes.push(scene.add.rope(0, 0, tex, undefined, this.variants[0][s], true).setScale(1 / z));
    }
    this.root = scene.add.container(0, 0, [this.shadow, body, ...this.ropes]).setDepth(depth);
  }

  /** Line boil: swap to the next edge variant. */
  boil(): void {
    this.boilV = (this.boilV + 1) % this.variants.length;
    this.ropes.forEach((r, s) => r.setPoints(this.variants[this.boilV][s]));
  }

  /** Lift: a bigger, fainter, further-offset shadow while in the air. */
  setLift(lift: number): void {
    this.shadow.setPosition(7 + 16 * lift, 11 + 22 * lift).setAlpha(SHADOW_A - 0.18 * lift);
  }

  destroy(scene: Phaser.Scene): void {
    this.root.destroy();
    if (scene.textures.exists(this.shadowKey)) scene.textures.remove(this.shadowKey);
  }
}

// --- the stepper -------------------------------------------------------------------

/**
 * Call `onFrame(i)` every FRAME_MS — the stop-motion clock — and boil edges at
 * the UI rate. Runs on the scene clock, so it pauses with the scene.
 */
function stepper(scene: Phaser.Scene, total: number, onFrame: (i: number) => void, onBoil: () => void, onDone: () => void): void {
  let i = 0;
  onFrame(i);
  const boil = scene.time.addEvent({ delay: BOIL_MS, loop: true, callback: onBoil });
  scene.time.addEvent({
    delay: FRAME_MS, repeat: total - 1,
    callback: () => {
      i++;
      if (i < total) onFrame(i);
      else { boil.remove(); onDone(); }
    },
  });
}

const pick = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();

// --- 1–2: cover the old screen, then hold -------------------------------------------

interface Pose { x: number; y: number; rot: number; scale: number; lift: number }

/**
 * Cover `scene` with torn scraps on stop-motion steps, hold, then `onCovered`
 * (the caller captures the collage and switches scenes).
 */
export function scrapbookCover(scene: Phaser.Scene, onCovered: () => void): void {
  const W = viewport.W, H = viewport.H;
  const r = mulberry32(runSeed++);
  const n = Math.round(pick(r, C.scraps.min, C.scraps.max + 0.999) - 0.5);
  const count = Math.min(C.scraps.max, Math.max(C.scraps.min, n));
  // Cells that tile the screen; scraps overshoot their cell so they overlap
  // and still cover the corners when tilted.
  const cols = count >= 6 ? 3 : 2, rows = 2;
  const cells: Array<{ cx: number; cy: number; w: number; h: number }> = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    cells.push({ cx: ((i + 0.5) * W) / cols, cy: ((j + 0.5) * H) / rows, w: W / cols, h: H / rows });
  }
  if (count === 5) cells.push({ cx: W / 2, cy: H / 2, w: W * 0.36, h: H * 0.42 });
  while (cells.length > count) cells.splice(Math.floor(r() * cells.length), 1);
  // A dropped cell would leave a hole: let its neighbours grow to fill it.
  const grow = cells.length < cols * rows ? 1.25 : 1;

  const coverF = frames(C.coverMs);
  const holdF = frames(C.holdMs);
  const pieces = cells.map((c, k) => {
    const w = c.w * pick(r, 1.55, 1.75) * grow, h = c.h * pick(r, 1.55, 1.75) * grow;
    const piece = new TornPiece(scene, w, h, r, `c${runSeed}-${k}`, TOP + 1 + k);
    const tilt = (r() < 0.5 ? -1 : 1) * pick(r, C.rotationDeg.min, C.rotationDeg.max) * DEG;
    const final: Pose = { x: c.cx + (r() - 0.5) * W * 0.04, y: c.cy + (r() - 0.5) * H * 0.05, rot: tilt, scale: 1, lift: 0 };
    // Slide in from the nearest edge, or drop from above (bigger, lifted).
    const drop = r() < 0.4;
    const dx = c.cx - W / 2, dy = c.cy - H / 2, dl = Math.hypot(dx, dy) || 1;
    const ux = dl > 1 ? dx / dl : 0, uy = dl > 1 ? dy / dl : -1;
    const away = Math.max(W, H) * 0.9;
    const startF = Math.min(coverF - 3, Math.floor((k / Math.max(1, cells.length - 1)) * Math.max(0, coverF - 3)));
    const over = Math.min(coverF - startF - 2, Math.round(pick(r, C.overshootFrames.min, C.overshootFrames.max + 0.999) - 0.5));
    const jig = () => ({ x: (r() - 0.5) * 14, y: (r() - 0.5) * 10, rot: (r() - 0.5) * 3 * DEG });
    const poses: Pose[] = drop
      ? [
        { ...final, x: final.x + ux * 30, y: final.y - 40, rot: tilt * 1.8, scale: 1.18, lift: 1 },
        { ...final, rot: tilt * 1.3, scale: 1.07, lift: 0.5 },
      ]
      : [
        { ...final, x: final.x + ux * away, y: final.y + uy * away, rot: tilt * 2.2, lift: 0.6 },
        { ...final, x: final.x + ux * away * 0.45, y: final.y + uy * away * 0.45, rot: tilt * 1.6, lift: 0.4 },
      ];
    for (let o = 0; o < Math.max(1, over); o++) {         // overshoot jitter on landing
      const j = jig();
      poses.push({ ...final, x: final.x + j.x, y: final.y + j.y, rot: final.rot + j.rot, scale: 1 + 0.02 * (over - o), lift: 0.1 });
    }
    poses.push(final);
    piece.root.setVisible(false);
    return { piece, poses, startF, landF: startF + 2 };
  });

  const total = coverF + holdF;
  stepper(scene, total, (f) => {
    for (const p of pieces) {
      const i = f - p.startF;
      if (i < 0) continue;
      const pose = p.poses[Math.min(i, p.poses.length - 1)];
      p.piece.root.setVisible(true).setPosition(pose.x, pose.y).setRotation(pose.rot).setScale(pose.scale);
      p.piece.setLift(pose.lift);
      if (f === p.landF) playSfx(scene, 'paperRustle');
    }
  }, () => pieces.forEach((p) => p.piece.boil()), () => onCovered());
}

// --- 3–4: the next screen slaps down, tape, live --------------------------------------

/**
 * In the incoming scene: show the captured collage beneath, slap the live
 * scene down on top as a torn-edge page (camera zoom/tilt about the centre),
 * snap tape onto its corners, then go live. `done` runs on the last step.
 */
export function scrapbookArrive(scene: Phaser.Scene, snap: { key: string }, done: () => void): void {
  const W = viewport.W, H = viewport.H, zoom0 = viewport.zoom;
  const cam = scene.cameras.main;
  const r = mulberry32(runSeed++);
  const pc = { x: W / 2, y: H / 2 };
  const tilt = (r() < 0.5 ? -1 : 1) * C.pageTiltDeg * DEG;

  // The collage, fixed to the screen whatever the camera does.
  const collage = scene.add.image(0, 0, snap.key).setOrigin(0, 0).setFlipY(true).setDepth(-2000);
  // The page's own torn edge just outside the screen rect, and its shadow.
  const page = new TornPiece(scene, W + 12, H + 12, r, `p${runSeed}`, -1001);
  page.root.setPosition(pc.x, pc.y);
  // Tape: 2–3 corners, always both top ones.
  const tapeKeys = tapeTextures(scene);
  const nTape = Math.min(C.tapeStrips.max, Math.max(C.tapeStrips.min, Math.round(pick(r, C.tapeStrips.min - 0.49, C.tapeStrips.max + 0.49))));
  const corners = [{ x: 0, y: 0, a: -38 }, { x: W, y: 0, a: 36 }, r() < 0.5 ? { x: W, y: H, a: -34 } : { x: 0, y: H, a: 40 }];
  const z = zoom0;
  const tapes = corners.slice(0, nTape).map((c, i) => {
    const a = (c.a + (r() - 0.5) * 12) * DEG;
    const shadow = scene.add.rectangle(c.x + 3, c.y + 4, TAPE_W * 0.96, TAPE_H * 0.8, 0x1e1e1e, 0.12).setRotation(a);
    const img = scene.add.image(c.x, c.y, tapeKeys[i % 3]).setRotation(a).setScale(1 / z);
    return { shadow, img, a, v: i % 3, snapF: 0, c };
  });
  tapes.forEach((t) => { t.img.setVisible(false).setDepth(TOP + 2); t.shadow.setVisible(false).setDepth(TOP + 1); });

  const slapF = frames(C.slapMs), tapeF = frames(C.tapeMs), liveF = frames(C.liveMs);
  // Page poses on steps: in the air (big, lifted), impact, bounce… then full.
  const air = { s: 1.1, r: tilt * 1.6, dx: 14, dy: -12, lift: 1 };
  const impact = { s: 0.935, r: tilt, dx: 0, dy: 0, lift: 0 };
  const bounce = { s: 0.958, r: tilt * 0.75, dx: 0, dy: -3, lift: 0.15 };
  const rest = { s: 0.95, r: tilt * 0.85, dx: 0, dy: 0, lift: 0 };
  const full = { s: 1, r: 0, dx: 0, dy: 0, lift: 0 };
  const poses = [air, impact];
  while (poses.length < slapF) poses.push(impact);
  poses.push(bounce);
  while (poses.length < slapF + tapeF) poses.push(rest);
  // Tape snaps onto the corners across the tape frames (oversized first).
  tapes.forEach((t, i) => { t.snapF = slapF + Math.min(tapeF - 1, Math.floor((i * tapeF) / tapes.length)); });

  const prevBg = cam.backgroundColor.rgba;
  const setView = (p: typeof air) => {
    const cs = Math.cos(p.r), sn = Math.sin(p.r);
    const inv = (x: number, y: number) => ({ x: cs * x + sn * y, y: -sn * x + cs * y });   // R(-r)
    const c0 = inv((pc.x + p.dx) / p.s, (pc.y + p.dy) / p.s);
    const sx = pc.x - c0.x, sy = pc.y - c0.y;
    cam.setZoom(zoom0 * p.s).setRotation(p.r).setScroll(sx, sy);
    // Counter-transform the collage so it stays put on screen.
    const o = inv(0, 0);
    collage.setPosition(sx + o.x, sy + o.y).setRotation(-p.r).setScale(1 / (zoom0 * p.s));
    page.setLift(p.lift);
  };

  const total = slapF + tapeF + liveF;
  stepper(scene, total, (f) => {
    if (f < slapF + tapeF) setView(poses[f]);
    else setView(full);
    for (const t of tapes) {
      const i = f - t.snapF;
      if (i < 0) continue;
      t.img.setVisible(true); t.shadow.setVisible(true);
      if (i === 0) {
        playSfx(scene, 'tapeRip');
        t.img.setScale(1.3 / z).setRotation(t.a + 0.12);              // snap: oversized
      } else {
        t.img.setScale(1 / z).setRotation(t.a);
      }
    }
    if (f >= slapF + tapeF) {
      // Live: the scraps beneath are gone, the tape fades in steps.
      collage.setVisible(false);
      page.root.setVisible(false);
      const k = (f - (slapF + tapeF) + 1) / (liveF + 1);
      for (const t of tapes) { t.img.setAlpha(1 - k); t.shadow.setAlpha(0.12 * (1 - k)); }
    }
  }, () => {
    page.boil();
    for (const t of tapes) { t.v = (t.v + 1) % 3; t.img.setTexture(tapeKeys[t.v]); }
  }, () => {
    cam.setZoom(zoom0).setRotation(0).setScroll(0, 0).setBackgroundColor(prevBg);
    collage.destroy();
    page.destroy(scene);
    tapes.forEach((t) => { t.img.destroy(); t.shadow.destroy(); });
    done();
  });
}
