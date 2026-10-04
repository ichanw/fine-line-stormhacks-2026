/**
 * Whole-texel displacement for hand-drawn boil on raster art.
 *
 * Pixels are moved by integer amounts along a smooth noise field and copied
 * nearest-neighbour — never resampled — so the result is exactly as sharp as
 * the source. Stepping between a few fixed fields reads as line boil (the
 * drawing being redone), not as a warp or blur.
 */

import { mulberry32 } from '@/systems/rng';

/** Smooth 2D noise in -1..1 from a few sines with seeded frequency and phase. */
export function noiseField(seed: number, scale = 1): (x: number, y: number) => number {
  const r = mulberry32(seed);
  const waves = Array.from({ length: 3 }, () => ({
    fx: (0.03 + r() * 0.05) * scale * (r() < 0.5 ? -1 : 1),
    fy: (0.03 + r() * 0.05) * scale * (r() < 0.5 ? -1 : 1),
    p: r() * Math.PI * 2,
    w: 0.5 + r() * 0.5,
  }));
  const norm = waves.reduce((a, w) => a + w.w, 0);
  return (x, y) => waves.reduce((a, w) => a + w.w * Math.sin(x * w.fx + y * w.fy + w.p), 0) / norm;
}

/**
 * A displaced copy of the region (0,0,w,h) of `src`, as a new canvas of the
 * same size as `src`. Outside the region is copied untouched.
 */
export function displaceCanvas(src: HTMLCanvasElement, w: number, h: number, amp: number, seed: number, scale = 1): HTMLCanvasElement {
  const sctx = src.getContext('2d', { willReadFrequently: true })!;
  const sd = sctx.getImageData(0, 0, src.width, src.height);
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const octx = out.getContext('2d', { willReadFrequently: true })!;
  const od = octx.createImageData(src.width, src.height);
  od.data.set(sd.data);
  const fx = noiseField(seed, scale), fy = noiseField(seed + 7919, scale);
  const W = src.width;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x + Math.round(amp * fx(x, y))));
      const sy = Math.min(h - 1, Math.max(0, y + Math.round(amp * fy(x, y))));
      const si = (sy * W + sx) * 4, oi = (y * W + x) * 4;
      od.data[oi] = sd.data[si]; od.data[oi + 1] = sd.data[si + 1];
      od.data[oi + 2] = sd.data[si + 2]; od.data[oi + 3] = sd.data[si + 3];
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}
