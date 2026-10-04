/**
 * Loading and preparing the user's story frames (public/art/scenes/).
 *
 * The frames are flattened 2880x2048 Figma exports. Per scene:
 *   - loaded on demand (17 frames decoded at once would be ~400 MB),
 *   - optionally split: "cutouts" lift a part (a bus handle, a car) out of the
 *     frame by its ink, so it can move; the hole is filled with paper,
 *   - drawn down to the device resolution it will be shown at, with
 *     high-quality smoothing (WebGL1 has no mipmaps for non-power-of-two
 *     textures, so drawing the 2880 px original small would alias the pencil),
 *   - freed when the scene shuts down.
 *
 * Cutouts become transparent graphite (alpha from darkness), so they can move
 * over the frame without carrying a paper rectangle with them.
 */

import Phaser from 'phaser';

export interface Rect { x: number; y: number; w: number; h: number }

export interface CutoutSpec {
  rect: Rect;
  /** Keep only ink components whose top is above this y (frame px). */
  maxTop?: number;
  /** Keep only components lying fully inside `rect` (drops long lines passing through). */
  inside?: boolean;
  /**
   * Keep only components that reach into this inner box (frame px). With a
   * padded `rect` and `inside`, this lifts a whole object (outline, body,
   * windows, wheels) while leaving nearby road marks and long lines behind.
   */
  core?: Rect;
  /**
   * Instead of ink components: take every mark inside an elliptical ring
   * (outer minus inner ellipse, frame px) — a bus handle's loop drawn over a
   * window. `patches` then redraws the lines the ring crossed (each segment's
   * ends are snapped to the existing line, found by searching ±18 px near y).
   */
  ring?: { cx: number; cy: number; rxo: number; ryo: number; rxi: number; ryi: number };
  patches?: Array<{ x0: number; x1: number; y: number }>;
  /**
   * The drawn band of the ring (exact outer and inner contours). Inside it
   * the cutout is made fully opaque from the drawing itself — line and paper
   * fill — so nothing behind ever shows through the handle; only the hole in
   * the middle stays see-through.
   */
  band?: { cx: number; cy: number; rxo: number; ryo: number; rxi: number; ryi: number };
}

export interface PreparedArt {
  key: string;
  /** Texture px per frame px. */
  k: number;
  /** Paper colour sampled from the frame. */
  paper: number;
  cutouts: Array<{ key: string; rect: Rect }>;
  keys: string[];
}

let uid = 0;

export function artKey(path: string): string { return `scene:${path}`; }

/** Queue a frame for loading (no-op if loaded). */
export function loadArt(scene: Phaser.Scene, path: string): void {
  const key = artKey(path);
  if (!scene.textures.exists(key)) scene.load.image(key, `art/scenes/${path}`);
}

const INK = 205;   // luminance below this counts as ink

export function prepareArt(scene: Phaser.Scene, path: string, k: number, cutouts: CutoutSpec[] = []): PreparedArt | null {
  const raw = scene.textures.get(artKey(path));
  if (!raw || raw.key === '__MISSING') return null;
  const img = raw.getSourceImage() as HTMLImageElement;
  const W = img.width, H = img.height;
  const full = document.createElement('canvas');
  full.width = W; full.height = H;
  const fctx = full.getContext('2d', { willReadFrequently: true })!;
  fctx.drawImage(img, 0, 0);
  const corner = fctx.getImageData(4, 4, 1, 1).data;
  const paper = (corner[0] << 16) | (corner[1] << 8) | corner[2];
  const id = ++uid;
  const keys: string[] = [];
  const out: PreparedArt['cutouts'] = [];

  for (const [i, c] of cutouts.entries()) {
    const { x, y, w, h } = c.rect;
    const data = fctx.getImageData(x, y, w, h);
    const core = c.core ? { x: c.core.x - x, y: c.core.y - y, w: c.core.w, h: c.core.h } : undefined;
    const mask = c.ring ? ringMask(data, x, y, c.ring)
      : inkMask(data, c.maxTop !== undefined ? c.maxTop - y : undefined, !!c.inside, core);
    // Find the patch lines' ends before anything is erased.
    const patchSegs = (c.patches ?? []).map((p) => ({ a: { x: p.x0, y: lineY(fctx, p.x0, p.y) }, b: { x: p.x1, y: lineY(fctx, p.x1, p.y) } }));
    // The cutout: graphite with alpha from darkness, at device resolution.
    const cut = document.createElement('canvas');
    cut.width = w; cut.height = h;
    const cctx = cut.getContext('2d')!;
    const cd = cctx.createImageData(w, h);
    const d = data.data, pr = corner[0], pg = corner[1], pb = corner[2];
    for (let p = 0; p < w * h; p++) {
      // The band first: every pixel in it, not just the ink.
      if (c.band) {
        const fx = (p % w) + x - c.band.cx, fy = ((p / w) | 0) + y - c.band.cy;
        const inOuter = (fx / c.band.rxo) ** 2 + (fy / c.band.ryo) ** 2 <= 1;
        const outInner = (fx / c.band.rxi) ** 2 + (fy / c.band.ryi) ** 2 >= 1;
        if (inOuter && outInner) {
          cd.data[p * 4] = d[p * 4]; cd.data[p * 4 + 1] = d[p * 4 + 1]; cd.data[p * 4 + 2] = d[p * 4 + 2]; cd.data[p * 4 + 3] = 255;
          d[p * 4] = pr; d[p * 4 + 1] = pg; d[p * 4 + 2] = pb;
          continue;
        }
      }
      if (!mask[p]) continue;
      // Ring cutouts carry the loop's white fill as opaque paper-white (it hides
      // the window lines behind the loop, as in the drawing).
      if (c.ring && d[p * 4] >= 254 && d[p * 4 + 1] >= 254 && d[p * 4 + 2] >= 254) {
        cd.data[p * 4] = cd.data[p * 4 + 1] = cd.data[p * 4 + 2] = cd.data[p * 4 + 3] = 255;
        d[p * 4] = pr; d[p * 4 + 1] = pg; d[p * 4 + 2] = pb;
        continue;
      }
      const lum = d[p * 4] * 0.299 + d[p * 4 + 1] * 0.587 + d[p * 4 + 2] * 0.114;
      const a = Math.max(0, Math.min(1, 1 - lum / 250));
      cd.data[p * 4] = 30; cd.data[p * 4 + 1] = 30; cd.data[p * 4 + 2] = 30;
      cd.data[p * 4 + 3] = Math.round(Math.min(1, a * 1.15) * 255);
      // Fill the hole with paper.
      d[p * 4] = pr; d[p * 4 + 1] = pg; d[p * 4 + 2] = pb;
    }
    // Grow the hole by a pixel so no antialiased rim is left behind.
    fctx.putImageData(data, x, y);
    cctx.putImageData(cd, 0, 0);
    // Redraw the lines the cut crossed, in graphite, so they stay put.
    fctx.save();
    fctx.lineCap = 'round';
    for (const sgm of patchSegs) {
      // Two light passes with a slight wobble read as pencil, not a ruled line.
      for (const [col, lw, j] of [['rgba(80,80,80,0.55)', 3, 0.6], ['rgba(60,60,60,0.45)', 2, -0.4]] as const) {
        fctx.strokeStyle = col;
        fctx.lineWidth = lw;
        fctx.beginPath();
        fctx.moveTo(sgm.a.x, sgm.a.y + j);
        fctx.quadraticCurveTo((sgm.a.x + sgm.b.x) / 2, (sgm.a.y + sgm.b.y) / 2 + j * 1.5, sgm.b.x, sgm.b.y - j);
        fctx.stroke();
      }
    }
    fctx.restore();
    const ckey = `scene-cut-${id}-${i}`;
    scene.textures.addCanvas(ckey, downscale(cut, k));
    keys.push(ckey);
    out.push({ key: ckey, rect: c.rect });
  }

  const key = `scene-art-${id}`;
  scene.textures.addCanvas(key, downscale(full, k));
  keys.push(key);
  // The 2880 px original isn't needed once prepared.
  scene.textures.remove(artKey(path));
  return { key, k, paper, cutouts: out, keys };
}

export function freeArt(scene: Phaser.Scene, art: PreparedArt | null): void {
  art?.keys.forEach((k) => { if (scene.textures.exists(k)) scene.textures.remove(k); });
}

/** y of the darkest-ish line pixel in column x nearest `y` (±18 px), or `y`. */
function lineY(ctx: CanvasRenderingContext2D, x: number, y: number): number {
  const d = ctx.getImageData(Math.round(x) - 1, Math.round(y) - 18, 3, 37).data;
  let best = y, bestD = Infinity;
  for (let r = 0; r < 37; r++) {
    let lum = 0;
    for (let c = 0; c < 3; c++) { const i = (r * 3 + c) * 4; lum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; }
    if (lum / 3 < 160 && Math.abs(r - 18) < bestD) { bestD = Math.abs(r - 18); best = Math.round(y) - 18 + r; }
  }
  return best;
}

/** Marks inside an elliptical ring (region-local mask; `ox, oy` = region origin in frame px). */
function ringMask(img: ImageData, ox: number, oy: number, r: NonNullable<CutoutSpec['ring']>): Uint8Array {
  const { width: w, height: h, data: d } = img;
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x + ox - r.cx, dy = y + oy - r.cy;
    const o = (dx / r.rxo) ** 2 + (dy / r.ryo) ** 2, i = (dx / r.rxi) ** 2 + (dy / r.ryi) ** 2;
    if (o > 1 || i < 1) continue;
    const p = (y * w + x) * 4;
    const white = d[p] >= 254 && d[p + 1] >= 254 && d[p + 2] >= 254;
    if (white || d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114 < 250) m[y * w + x] = 1;
  }
  return m;
}

/** High-quality downscale (in halving steps, so nothing aliases). */
function downscale(src: HTMLCanvasElement, k: number): HTMLCanvasElement {
  if (k >= 0.999) return src;
  let cur = src, cw = src.width, ch = src.height;
  const tw = Math.max(1, Math.round(src.width * k)), th = Math.max(1, Math.round(src.height * k));
  while (cw / 2 > tw) {
    const n = document.createElement('canvas');
    n.width = Math.ceil(cw / 2); n.height = Math.ceil(ch / 2);
    const c = n.getContext('2d')!;
    c.imageSmoothingQuality = 'high';
    c.drawImage(cur, 0, 0, cw, ch, 0, 0, n.width, n.height);
    cur = n; cw = n.width; ch = n.height;
  }
  const o = document.createElement('canvas');
  o.width = tw; o.height = th;
  const c = o.getContext('2d')!;
  c.imageSmoothingQuality = 'high';
  c.drawImage(cur, 0, 0, cw, ch, 0, 0, tw, th);
  return o;
}

/**
 * Ink pixels of the region, grouped into 8-connected components (after a
 * 4 px dilation, so a pencil line's gaps don't split it and its faint halo comes along). Components are kept
 * if their top is above `maxTop` and, with `inside`, if they don't touch the
 * region's edge.
 */
function inkMask(img: ImageData, maxTop: number | undefined, inside: boolean, core?: Rect): Uint8Array {
  const { width: w, height: h, data: d } = img;
  const ink = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    ink[p] = d[p * 4] * 0.299 + d[p * 4 + 1] * 0.587 + d[p * 4 + 2] * 0.114 < INK ? 1 : 0;
  }
  const grown = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!ink[y * w + x]) continue;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) grown[ny * w + nx] = 1;
    }
  }
  const label = new Int32Array(w * h).fill(-1);
  const keep: boolean[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!grown[s] || label[s] >= 0) continue;
    const L = keep.length;
    let top = h, edge = false, hitsCore = !core;
    label[s] = L; stack.push(s);
    while (stack.length) {
      const p = stack.pop()!, x = p % w, y = (p / w) | 0;
      if (y < top) top = y;
      if (core && !hitsCore && x >= core.x && y >= core.y && x < core.x + core.w && y < core.y + core.h) hitsCore = true;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (grown[q] && label[q] < 0) { label[q] = L; stack.push(q); }
      }
    }
    keep.push((maxTop === undefined || top < maxTop) && (!inside || !edge) && hitsCore);
  }
  const mask = new Uint8Array(w * h);
  // Take the grown area (not just ink) so soft pencil edges come along.
  for (let p = 0; p < w * h; p++) if (label[p] >= 0 && keep[label[p]]) {
    const lum = d[p * 4] * 0.299 + d[p * 4 + 1] * 0.587 + d[p * 4 + 2] * 0.114;
    if (lum < 250) mask[p] = 1;
  }
  return mask;
}
