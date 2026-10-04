/**
 * The user's title drawings (public/art/title/): loading and preparation.
 *
 * NEVER redrawn or altered. What happens here, at boot, once:
 *   1. Trim each 2360x1640 canvas to its ink (+ padding) and copy it 1:1 into a
 *      power-of-two texture, so WebGL1 builds mipmaps for clean downscaling
 *      (see CLAUDE.md, Fullscreen and resolution). Offsets are kept, so the
 *      layers stay exactly pre-aligned.
 *   2. Make two extra boil frames per layer by shifting pixels by WHOLE texels
 *      along a smooth noise field (nearest-neighbour). No resampling, so the
 *      boil adds no blur — the lines just wander a pixel or so, like a redraw.
 *   3. Measure the hill line's path, so generated ground continues it
 *      seamlessly.
 *
 * Like the character art, these PNGs are opaque white: draw with MULTIPLY.
 */

import Phaser from 'phaser';
import { noiseField } from '@/systems/displace';

export const TITLE_LAYERS = ['hill_right', 'grass_right', 'rocks', 'tree_trunk', 'tree_canopy'] as const;
export type TitleLayer = (typeof TITLE_LAYERS)[number];

/** Every title PNG shares this canvas, pre-aligned. */
export const TITLE_CANVAS = { w: 2360, h: 1640 };

export interface TitleLayerInfo {
  name: TitleLayer;
  ok: boolean;
  /** Trimmed region, in canvas texels. */
  crop: { x: number; y: number; w: number; h: number };
  /** Texture keys of the boil frames (v0 = untouched original). */
  frames: string[];
}

export interface Pt { x: number; y: number }

export const titleArt = {
  prepared: false,
  layers: {} as Record<TitleLayer, TitleLayerInfo>,
  /** Files that failed to load (placeholders are drawn instead). */
  missing: [] as string[],
  /** Hill line, canvas texels, left to right; gaps (behind rocks/trunk) skipped. */
  hillPath: [] as Pt[],
};

/** Boil-frame displacement amplitude per layer, in texels. Ground boils less. */
const BOIL_AMP: Record<TitleLayer, number> = {
  tree_canopy: 1.5,
  tree_trunk: 1.4,
  grass_right: 1.2,
  rocks: 0.8,
  hill_right: 0.8,
};

const rawKey = (n: TitleLayer) => `title-raw-${n}`;

export function preloadTitleArt(scene: Phaser.Scene): void {
  scene.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
    const n = TITLE_LAYERS.find((l) => rawKey(l) === file.key);
    if (n && !titleArt.missing.includes(`${n}.png`)) titleArt.missing.push(`${n}.png`);
  });
  for (const n of TITLE_LAYERS) scene.load.image(rawKey(n), `art/title/${n}.png`);
}

function nextPow2(n: number): number { return 2 ** Math.ceil(Math.log2(Math.max(1, n))); }

export function prepareTitleArt(scene: Phaser.Scene): void {
  if (titleArt.prepared) return;
  const work = document.createElement('canvas');
  work.width = TITLE_CANVAS.w;
  work.height = TITLE_CANVAS.h;
  const wctx = work.getContext('2d', { willReadFrequently: true })!;

  for (const name of TITLE_LAYERS) {
    const info: TitleLayerInfo = { name, ok: false, crop: { x: 0, y: 0, w: 0, h: 0 }, frames: [] };
    titleArt.layers[name] = info;
    const raw = scene.textures.get(rawKey(name));
    if (!raw || raw.key === '__MISSING') continue;

    wctx.fillStyle = '#ffffff';
    wctx.fillRect(0, 0, work.width, work.height);
    wctx.drawImage(raw.getSourceImage() as CanvasImageSource, 0, 0);
    const src = wctx.getImageData(0, 0, work.width, work.height);
    const d = src.data;
    const W = work.width;
    const lum = (i: number) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;

    // 1. Trim to ink.
    let x0 = W, y0 = work.height, x1 = -1, y1 = -1;
    for (let y = 0; y < work.height; y++) {
      for (let x = 0; x < W; x++) {
        if (lum((y * W + x) * 4) < 235) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) continue;
    const pad = 12;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(work.height - 1, y1 + pad);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    info.crop = { x: x0, y: y0, w: cw, h: ch };

    // 3. Hill path: ink centroid per column.
    if (name === 'hill_right') {
      titleArt.hillPath = [];
      for (let x = x0; x <= x1; x += 10) {
        let sy = 0, n = 0;
        for (let y = y0; y <= y1; y++) if (lum((y * W + x) * 4) < 200) { sy += y; n++; }
        if (n) titleArt.hillPath.push({ x, y: sy / n });
      }
    }

    // 1 + 2. Original and two whole-texel-displaced boil frames.
    const pw = nextPow2(cw), ph = nextPow2(ch);
    for (let v = 0; v < 3; v++) {
      const out = document.createElement('canvas');
      out.width = pw;
      out.height = ph;
      const octx = out.getContext('2d', { willReadFrequently: true })!;
      const img = octx.createImageData(pw, ph);
      const o = img.data;
      o.fill(255);
      const amp = BOIL_AMP[name];
      const fx = noiseField(1000 + v * 17 + TITLE_LAYERS.indexOf(name) * 101);
      const fy = noiseField(2000 + v * 31 + TITLE_LAYERS.indexOf(name) * 101);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          let sx = x0 + x, sy = y0 + y;
          if (v > 0) {
            sx = Math.min(W - 1, Math.max(0, sx + Math.round(amp * fx(sx, sy))));
            sy = Math.min(work.height - 1, Math.max(0, sy + Math.round(amp * fy(sx, sy))));
          }
          const si = (sy * W + sx) * 4, oi = (y * pw + x) * 4;
          o[oi] = d[si]; o[oi + 1] = d[si + 1]; o[oi + 2] = d[si + 2]; o[oi + 3] = 255;
        }
      }
      octx.putImageData(img, 0, 0);
      const key = `title-${name}-v${v}`;
      if (scene.textures.exists(key)) scene.textures.remove(key);
      const tex = scene.textures.create(key, out, pw, ph)!;
      tex.add('art', 0, 0, 0, cw, ch);
      info.frames.push(key);
    }
    info.ok = true;
    scene.textures.remove(rawKey(name));
  }
  if (titleArt.missing.length) {
    console.warn(`[title] missing art, drawing placeholders: ${titleArt.missing.join(', ')}`);
  }
  titleArt.prepared = true;
}
