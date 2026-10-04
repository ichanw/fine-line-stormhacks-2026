/**
 * Optional graphite shading over the user's title art (F1 → "Art shading").
 *
 * The PNGs are never edited. Instead each layer's SHAPE is recovered from its
 * ink, and hatching is generated over it with the same light as the generated
 * left side (upper right): single hatching on the side facing away from the
 * light, cross-hatching where it is deepest. The result is a separate
 * transparent texture drawn on top of the art, so it can be compared on/off.
 *
 * Silhouette recovery (on a coarse grid, for speed):
 *   - ink cells = any pixel darker than the paper;
 *   - CLOSING + flood fill catches shapes with small breaks (trunk, rocks);
 *   - a 16-ray "enclosed" test catches the canopy, whose outline has gaps
 *     wider than any sensible closing radius;
 *   - the union is smoothed and pulled in a cell so no hatch pokes out.
 *
 * Shade amount per cell = how far it lies along the light axis inside its own
 * silhouette: 0 at the edge facing the light, 1 at the edge facing away.
 */

import Phaser from 'phaser';
import { defaultBrush, dabPolyline, finishStroke, type Pt } from '@/systems/brush';
import { mulberry32 } from '@/systems/rng';
import { CROSS_ANGLE, HATCH_ANGLE } from '@/systems/sketchKit';
import { titleArt, type TitleLayer } from '@/systems/titleArt';

/** Layers that get shading (the user asked for the tree and the rocks). */
export const SHADED_LAYERS: TitleLayer[] = ['rocks', 'tree_trunk', 'tree_canopy'];

/**
 * Silhouette recovery per layer: closing radius (cells) and how many of 16 rays
 * must hit ink (0 = off). Rocks have a closed outline but ground marks under
 * them that a ray test would wrongly enclose; the canopy needs the ray test.
 */
const RECOVER: Record<string, { R: number; rays: number }> = {
  rocks: { R: 2, rays: 0 },
  tree_trunk: { R: 4, rays: 14 },
  tree_canopy: { R: 4, rays: 14 },
};

/**
 * How each layer is shaded (light from the upper right throughout):
 *   underside  the canopy: hatching along its underside, densest at the
 *              bottom edge and fading upward
 *   left       the trunk: a little hatching down its left side
 *   light      rocks: hatched on the side facing away from the light,
 *              cross-hatched where deepest
 */
const MODE: Partial<Record<TitleLayer, 'underside' | 'left' | 'light'>> = {
  tree_canopy: 'underside',
  tree_trunk: 'left',
  rocks: 'light',
};

/** Grid cell size in texels. */
const CELL = 5;
/** Light comes FROM the upper right; shade grows toward the lower left. */
const LIGHT = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };

const cache = new Map<string, string[]>();

function nextPow2(n: number): number { return 2 ** Math.ceil(Math.log2(Math.max(1, n))); }

/**
 * Build (once per layer and line weight) three boil variants of the shading
 * overlay. Returns texture keys, each with an 'art' frame the size of the
 * layer's crop — place it exactly like the art image. Null if the art is missing.
 */
export function artShadingFrames(scene: Phaser.Scene, name: TitleLayer, radius: number): string[] | null {
  const info = titleArt.layers[name];
  if (!info?.ok) return null;
  const id = `${name}:${radius.toFixed(2)}`;
  const hit = cache.get(id);
  if (hit && hit.every((k) => scene.textures.exists(k))) return hit;

  const { w: cw, h: ch } = info.crop;
  const src = scene.textures.get(info.frames[0]).source[0].image as HTMLCanvasElement;
  const data = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, cw, ch).data;

  const gw = Math.ceil(cw / CELL), gh = Math.ceil(ch / CELL);
  const ink = new Uint8Array(gw * gh);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      if (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 < 190) {
        ink[((y / CELL) | 0) * gw + ((x / CELL) | 0)] = 1;
      }
    }
  }

  const inside = silhouette(ink, gw, gh, RECOVER[name] ?? { R: 4, rays: 14 });
  // Strict clip: one more cell in from the silhouette, which already sits on
  // the outline — so hatching stops just inside the user's lines.
  const clip = erode(inside, gw, gh);
  const mode = MODE[name] ?? 'light';
  const shade = mode === 'underside' ? undersideAxis(clip, gw, gh)
    : mode === 'left' ? leftAxis(clip, gw, gh) : lightAxis(clip, gw, gh);

  const keys: string[] = [];
  const pw = nextPow2(cw), ph = nextPow2(ch);
  for (let v = 0; v < 3; v++) {
    const rng = mulberry32(4100 + v * 97 + name.length * 13);
    const sp = radius * 6.5;
    const lines = mode === 'underside'
      // Soft hatching densest at the bottom edge, fading upward: a sparse pass
      // over the lower band, a second interleaved pass nearer the edge, and
      // cross-hatching right along it.
      ? [
        ...hatch(shade, gw, gh, cw, ch, HATCH_ANGLE, sp * 1.6, 0.12, rng),
        ...hatch(shade, gw, gh, cw, ch, HATCH_ANGLE, sp * 1.6, 0.5, rng, 0.5),
        ...hatch(shade, gw, gh, cw, ch, CROSS_ANGLE, sp * 1.5, 0.8, rng),
      ]
      : mode === 'left'
        ? hatch(shade, gw, gh, cw, ch, HATCH_ANGLE, sp * 0.9, 0.62, rng)   // "a little"
        : [
          ...hatch(shade, gw, gh, cw, ch, HATCH_ANGLE, sp, 0.5, rng),
          ...hatch(shade, gw, gh, cw, ch, CROSS_ANGLE, sp * 1.15, 0.78, rng),
        ];
    const canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const style = defaultBrush({ width: radius * 2, alpha: mode === 'light' ? 0.26 : 0.22, grain: 0.55 });
    for (const l of lines) dabPolyline(ctx, l, radius, style, rng);
    finishStroke(ctx, cw, ch, style);
    // Clip per pixel too, so no dab's edge spills over the outline.
    const img = ctx.getImageData(0, 0, cw, ch), d = img.data;
    for (let y = 0; y < ch; y++) {
      const row = ((y / CELL) | 0) * gw;
      for (let x = 0; x < cw; x++) if (!clip[row + ((x / CELL) | 0)]) d[(y * cw + x) * 4 + 3] = 0;
    }
    ctx.putImageData(img, 0, 0);
    const key = `title-${name}-shade-v${v}`;
    if (scene.textures.exists(key)) scene.textures.remove(key);
    const tex = scene.textures.create(key, canvas, pw, ph)!;
    tex.add('art', 0, 0, 0, cw, ch);
    keys.push(key);
  }
  cache.set(id, keys);
  return keys;
}

/** Closing + flood fill, unioned with a 16-ray enclosure test, then tidied. */
function silhouette(ink: Uint8Array, gw: number, gh: number, opt: { R: number; rays: number }): Uint8Array {
  const n = gw * gh;
  const at = (a: Uint8Array, x: number, y: number) => (x < 0 || y < 0 || x >= gw || y >= gh ? 0 : a[y * gw + x]);
  const morph = (a: Uint8Array, grow: boolean): Uint8Array => {
    const o = new Uint8Array(n);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let v = grow ? 0 : 1;
      for (let dy = -1; dy <= 1 && v === (grow ? 0 : 1); dy++) for (let dx = -1; dx <= 1; dx++) {
        const s = at(a, x + dx, y + dy);
        if (grow ? s : !s) { v = grow ? 1 : 0; break; }
      }
      o[y * gw + x] = v;
    }
    return o;
  };

  // A. Closing (radius R) + flood fill from the border.
  const R = opt.R;
  let dil = ink;
  for (let k = 0; k < R; k++) dil = morph(dil, true);
  const ext = new Uint8Array(n);
  const stack: number[] = [];
  const seed = (i: number) => { if (!dil[i] && !ext[i]) { ext[i] = 1; stack.push(i); } };
  for (let x = 0; x < gw; x++) { seed(x); seed((gh - 1) * gw + x); }
  for (let y = 0; y < gh; y++) { seed(y * gw); seed(y * gw + gw - 1); }
  while (stack.length) {
    const i = stack.pop()!, x = i % gw, y = (i / gw) | 0;
    if (x > 0) seed(i - 1); if (x < gw - 1) seed(i + 1);
    if (y > 0) seed(i - gw); if (y < gh - 1) seed(i + gw);
  }
  let filled: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) filled[i] = ext[i] ? 0 : 1;
  for (let k = 0; k < R; k++) filled = morph(filled, false);

  // B. Enclosed: ink found along at least `opt.rays` of 16 rays.
  const dirs: Pt[] = [];
  for (let k = 0; k < 16; k++) dirs.push({ x: Math.cos((k / 16) * Math.PI * 2), y: Math.sin((k / 16) * Math.PI * 2) });
  const out = new Uint8Array(n);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x;
    if (filled[i]) { out[i] = 1; continue; }
    if (!opt.rays) continue;
    let hits = 0, miss = 0;
    for (const d of dirs) {
      let px = x + 0.5, py = y + 0.5, found = false;
      for (;;) {
        px += d.x; py += d.y;
        const cx = px | 0, cy = py | 0;
        if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) break;
        if (ink[cy * gw + cx]) { found = true; break; }
      }
      if (found) hits++; else if (++miss > 16 - opt.rays) break;
    }
    out[i] = hits >= opt.rays ? 1 : 0;
  }

  // Tidy: majority smoothing, then pull in one cell from the outline.
  let s = out;
  for (let pass = 0; pass < 2; pass++) {
    const o = new Uint8Array(n);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) c += at(s, x + dx, y + dy);
      o[y * gw + x] = c >= 5 ? 1 : 0;
    }
    s = o;
  }
  return morph(s, false);
}

function erode(a: Uint8Array, gw: number, gh: number): Uint8Array {
  const o = new Uint8Array(gw * gh);
  for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
    const i = y * gw + x;
    o[i] = a[i] && a[i - 1] && a[i + 1] && a[i - gw] && a[i + gw] ? 1 : 0;
  }
  return o;
}

/** Cells to the shape's edge from (x, y) stepping (dx, dy). */
function runTo(inside: Uint8Array, gw: number, gh: number, x: number, y: number, dx: number, dy: number): number {
  let px = x + 0.5, py = y + 0.5, k = 0;
  for (;;) {
    px += dx; py += dy;
    const cx = Math.floor(px), cy = Math.floor(py);
    if (cx < 0 || cy < 0 || cx >= gw || cy >= gh || !inside[cy * gw + cx]) return k;
    k++;
  }
}

/**
 * Canopy underside: 1 at the bottom edge, falling to 0 about a third of the way
 * up the column, nudged darker on the left (away from the light).
 */
function undersideAxis(inside: Uint8Array, gw: number, gh: number): Float32Array {
  const t = new Float32Array(gw * gh).fill(-1);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    if (!inside[y * gw + x]) continue;
    const down = runTo(inside, gw, gh, x, y, 0, 1), up = runTo(inside, gw, gh, x, y, 0, -1);
    // Short fragments (e.g. a sliver under the top outline) are not undersides.
    if (up + down + 1 < gh * 0.1) { t[y * gw + x] = 0; continue; }
    const band = Math.max(4, (up + down + 1) * 0.38);
    const left = runTo(inside, gw, gh, x, y, -1, 0), right = runTo(inside, gw, gh, x, y, 1, 0);
    const lean = 0.12 * ((right + 0.5) / (left + right + 1) - 0.5) * 2;   // + on the left side
    t[y * gw + x] = Math.max(0, Math.min(1, 1 - down / band + lean));
  }
  return t;
}

/** Trunk: 1 at the left edge, 0 by about 40% across. */
function leftAxis(inside: Uint8Array, gw: number, gh: number): Float32Array {
  const t = new Float32Array(gw * gh).fill(-1);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    if (!inside[y * gw + x]) continue;
    const left = runTo(inside, gw, gh, x, y, -1, 0), right = runTo(inside, gw, gh, x, y, 1, 0);
    t[y * gw + x] = Math.max(0, 1 - (left + 0.5) / ((left + right + 1) * 0.42));
  }
  return t;
}

/** 0 at the lit edge … 1 at the edge facing away; -1 outside. */
function lightAxis(inside: Uint8Array, gw: number, gh: number): Float32Array {
  const t = new Float32Array(gw * gh).fill(-1);
  const run = (x: number, y: number, dx: number, dy: number): number => {
    let px = x + 0.5, py = y + 0.5, k = 0;
    for (;;) {
      px += dx; py += dy;
      const cx = Math.floor(px), cy = Math.floor(py);
      if (cx < 0 || cy < 0 || cx >= gw || cy >= gh || !inside[cy * gw + cx]) return k;
      k++;
    }
  };
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    if (!inside[y * gw + x]) continue;
    const toLight = run(x, y, LIGHT.x, LIGHT.y), away = run(x, y, -LIGHT.x, -LIGHT.y);
    t[y * gw + x] = (toLight + 0.5) / (toLight + away + 1);
  }
  return t;
}

/**
 * Parallel pencil strokes at `angle` wherever shade > threshold. The threshold
 * wanders along each stroke so the shadow edge is hand-ragged, not contoured.
 */
function hatch(
  shade: Float32Array, gw: number, gh: number, cw: number, ch: number,
  angle: number, spacing: number, threshold: number, rng: () => number, phase = 0,
): Pt[][] {
  const d = { x: Math.cos(angle), y: Math.sin(angle) }, p = { x: -d.y, y: d.x };
  const cx = cw / 2, cy = ch / 2, half = Math.hypot(cw, ch) / 2;
  const lines: Pt[][] = [];
  const step = 2;
  const ok = (x: number, y: number, thr: number) => {
    if (x < 0 || y < 0 || x >= cw || y >= ch) return false;
    const v = shade[((y / CELL) | 0) * gw + ((x / CELL) | 0)];
    return v >= 0 && v > thr;
  };
  void gh;
  for (let off = -half + spacing * phase; off <= half; off += spacing * (0.85 + rng() * 0.3)) {
    const ox = cx + p.x * off, oy = cy + p.y * off;
    const ph = rng() * 10;
    let run: Pt[] = [];
    const flush = () => {
      if (run.length * step >= spacing * 1.6) {
        const a = run[0], b = run[run.length - 1];
        const trimA = rng() * 0.12, trimB = rng() * 0.18;
        const A = { x: a.x + (b.x - a.x) * trimA, y: a.y + (b.y - a.y) * trimA };
        const B = { x: b.x - (b.x - a.x) * trimB, y: b.y - (b.y - a.y) * trimB };
        const mid = { x: (A.x + B.x) / 2 + p.x * (rng() - 0.5) * 1.2, y: (A.y + B.y) / 2 + p.y * (rng() - 0.5) * 1.2 };
        lines.push([A, mid, B]);
      }
      run = [];
    };
    for (let s = -half; s <= half; s += step) {
      const x = ox + d.x * s, y = oy + d.y * s;
      const thr = threshold + Math.sin(s * 0.03 + ph) * 0.05;
      if (ok(x, y, thr)) run.push({ x, y });
      else if (run.length) flush();
    }
    flush();
  }
  return lines;
}
