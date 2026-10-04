/**
 * Pencil brush.
 *
 * Replaces uniform vector strokes everywhere. Matches the user's title art
 * (measured, see CLAUDE.md "Art direction"):
 *   - soft graphite with heavy tooth — the line is built from many small,
 *     semi-transparent dabs, then paper grain knocks white specks out of it;
 *   - soft greys, never black (darkest ~45–70/255, typical ~150–195);
 *   - pressure swells mid-stroke and wanders a little; ends taper softly;
 *   - slightly uneven opacity from dab to dab.
 *
 * Pure 2D-canvas code with no Phaser dependency, so the dev brush lab
 * (dev/brush-lab.html) renders with exactly the same engine as the game.
 *
 * Everything is rendered at DEVICE resolution: callers pass `zoom` (device px
 * per layout unit) and draw the resulting canvas at 1/zoom. Never render small
 * and scale up.
 */

export interface Pt { x: number; y: number }

export interface BrushStyle {
  /** Graphite colour as CSS. Keep it a grey — dab overlap supplies the dark. */
  color: string;
  /** Nominal line width in layout units at full pressure. */
  width: number;
  /** Opacity of a single dab; overlap builds the line up from this. */
  alpha: number;
  /** 0..1 — how many paper specks show through the line. */
  grain: number;
  /** 0..1 — how much pressure wanders along a stroke. */
  pressureNoise: number;
  /** Taper lengths as multiples of the line width. */
  taperIn: number;
  taperOut: number;
}

export const defaultBrush = (p: Partial<BrushStyle> = {}): BrushStyle => ({
  color: '#2e2e2e',
  width: 2.2,
  alpha: 0.3,
  grain: 0.6,
  pressureNoise: 0.3,
  taperIn: 1.4,
  taperOut: 2.4,
  ...p,
});

// --- shared resources ------------------------------------------------------

/*
 * All brush canvases are CPU-backed (`willReadFrequently`). Stroke canvases are
 * read back for the levels pass, and mixing them with GPU-backed source
 * canvases (dab sprite, grain tile) forced a GPU→CPU readback on every grain
 * fill — that alone made a title-screen build take 7–12 s.
 */

let dabCache: HTMLCanvasElement | null = null;

/**
 * One soft graphite dab, drawn black; strokes are recoloured afterwards. Has
 * its own internal noise so even a single dab isn't a clean disc.
 */
function dab(): HTMLCanvasElement {
  if (dabCache) return dabCache;
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.createImageData(S, S);
  // Drag streaks: each row has its own density. Dabs are rotated to the stroke
  // direction, so overlapping rows build into streaks running ALONG the line —
  // the pencil-drag texture in the reference strokes.
  // Rows get darker toward one side — the pressure edge a tilted pencil
  // leaves (the reference lines are darker along one edge, light inside).
  const rows = Array.from({ length: S }, (_, y) =>
    Math.min(1, (0.22 + Math.random() * 0.78) * (0.65 + 0.6 * (y / S))));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S * 2 - 1;
      const dy = (y + 0.5) / S * 2 - 1;
      const d = Math.sqrt(dx * dx + dy * dy) * (0.96 + Math.random() * 0.08);
      if (d >= 1) continue;
      // Graphite meets paper at a crisp edge (measured at 3x on the
      // reference): a flat body with a very short rim, not a soft blob.
      const body = Math.min(1, (1 - d) / 0.1);
      const tooth = Math.random() < 0.1 ? 0.3 : 0.7 + Math.random() * 0.3;
      img.data[(y * S + x) * 4 + 3] = Math.round(255 * body * rows[y] * tooth);
    }
  }
  ctx.putImageData(img, 0, 0);
  dabCache = c;
  return c;
}

let grainCache: HTMLCanvasElement | null = null;

/**
 * Paper tooth: speckles plus faint diagonal striations, as in the reference
 * strokes. Used with destination-out, so opaque pixels here become gaps in the
 * line. Applied in screen space, so the tooth stays put while a line boils.
 */
function grainTile(): HTMLCanvasElement {
  if (grainCache) return grainCache;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  // Flecks about 2 px across (the reference tooth), from half-res noise
  // scaled up without smoothing, with 1 px fines on top.
  const half = document.createElement('canvas');
  half.width = S / 2;
  half.height = S / 2;
  const hctx = half.getContext('2d', { willReadFrequently: true })!;
  const himg = hctx.createImageData(S / 2, S / 2);
  for (let i = 0; i < (S / 2) * (S / 2); i++) {
    const r = Math.random();
    himg.data[i * 4 + 3] = r < 0.13 ? 255 : r < 0.36 ? 110 + Math.random() * 110 : Math.random() * 25;
  }
  hctx.putImageData(himg, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(half, 0, 0, S, S);
  const fine = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) {
    if (Math.random() < 0.08) fine.data[i * 4 + 3] = Math.min(255, fine.data[i * 4 + 3] + 140);
  }
  ctx.putImageData(fine, 0, 0);
  // Striations: short strokes at the pencil's angle.
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 0.7;
  for (let i = 0; i < 520; i++) {
    const x = Math.random() * S, y = Math.random() * S, len = 2 + Math.random() * 6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len * 0.5, y - len * 0.87);
    ctx.stroke();
  }
  grainCache = c;
  return c;
}

// --- strokes ---------------------------------------------------------------

/** Smooth wandering pressure from two incommensurate sines with random phase. */
function pressureFn(rng: () => number, amount: number): (s: number) => number {
  const f1 = 0.011 + rng() * 0.01, f2 = 0.031 + rng() * 0.02;
  const p1 = rng() * Math.PI * 2, p2 = rng() * Math.PI * 2;
  return (s) => 1 + amount * (0.6 * Math.sin(f1 * s + p1) + 0.4 * Math.sin(f2 * s + p2));
}

/**
 * Lay one polyline down as dabs (in black) on `ctx`. Points are in DEVICE px.
 */
export function dabPolyline(
  ctx: CanvasRenderingContext2D,
  pts: Pt[],
  radius: number,
  style: BrushStyle,
  rng: () => number,
): void {
  if (pts.length < 2) return;
  const seg: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    seg.push(seg[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const L = seg[seg.length - 1];
  if (L <= 0) return;

  const stamp = dab();
  const spacing = Math.max(0.35, radius * 0.3);
  const tin = Math.min(L * 0.3, radius * 2 * style.taperIn);
  const tout = Math.min(L * 0.4, radius * 2 * style.taperOut);
  const pressure = pressureFn(rng, style.pressureNoise);
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / Math.max(1e-6, e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  let k = 0;
  for (let s = 0; s <= L; s += spacing) {
    while (k < seg.length - 2 && seg[k + 1] < s) k++;
    const a = pts[k], b = pts[k + 1];
    const segLen = seg[k + 1] - seg[k] || 1;
    const u = (s - seg[k]) / segLen;
    const x = a.x + (b.x - a.x) * u;
    const y = a.y + (b.y - a.y) * u;
    const nx = -(b.y - a.y) / segLen, ny = (b.x - a.x) / segLen;

    const taper = smooth(0, tin, s) * smooth(0, tout, L - s);
    const p = (0.3 + 0.7 * taper) * pressure(s);
    // Uneven dab size and rare drop-outs give the ragged, slightly broken
    // edge the reference lines have — kept small so the edge stays cohesive.
    if (rng() < 0.02) continue;
    const r = Math.max(0.35, radius * p * (0.92 + rng() * 0.16));
    const wobble = (rng() - 0.5) * r * 0.2;
    ctx.globalAlpha = Math.min(1, style.alpha * (0.55 + 0.45 * taper) * (0.7 + rng() * 0.6));
    // Rotate the dab to the stroke direction so its streaks run along the line.
    const tx = (b.x - a.x) / segLen, ty = (b.y - a.y) / segLen;
    ctx.setTransform(tx, ty, -ty, tx, x + nx * wobble, y + ny * wobble);
    ctx.drawImage(stamp, -r, -r, r * 2, r * 2);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

let grainAlpha: Uint8ClampedArray | null = null;

/** The grain tile's alpha channel, for sampling inside the pixel loop. */
function grainData(): Uint8ClampedArray {
  if (grainAlpha) return grainAlpha;
  const t = grainTile();
  const d = t.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, t.width, t.height).data;
  grainAlpha = new Uint8ClampedArray(t.width * t.height);
  for (let i = 0; i < grainAlpha.length; i++) grainAlpha[i] = d[i * 4 + 3];
  return grainAlpha;
}

function parseColor(css: string): [number, number, number] {
  const h = css.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Finish a region of black dabs in ONE pixel pass: levels on coverage (crisp
 * edge), recolour to graphite, and knock out paper grain. `screenX/Y` is where
 * the region's top-left lands on screen (device px), so the grain is aligned to
 * the PAGE — every boil frame of a line shares the same paper tooth, and the
 * line moves over fixed paper.
 *
 * Done as a single read/loop/write rather than canvas compositing: the
 * source-in recolour + destination-out grain fills + clip cost ~1.8 s on the
 * title screen; the fused loop is a fraction of that.
 */
export function finishRegion(
  ctx: CanvasRenderingContext2D,
  rx: number, ry: number, rw: number, rh: number,
  style: BrushStyle,
  screenX = 0, screenY = 0,
): void {
  if (rw <= 0 || rh <= 0) return;
  const img = ctx.getImageData(rx, ry, rw, rh);
  const d = img.data;
  const [cr, cg, cb] = parseColor(style.color);
  const grain = grainData();
  const gs = style.grain;
  const gx0 = Math.floor(screenX), gy0 = Math.floor(screenY);
  let i = 0;
  for (let y = 0; y < rh; y++) {
    const grow = (((gy0 + y) % 256) + 256) % 256 << 8;
    for (let x = 0; x < rw; x++, i += 4) {
      const a0 = d[i + 3];
      if (a0 <= 25) { d[i + 3] = 0; continue; } // levels: drop the faint halo (<0.1)
      // levels: stretch the rest, which also deepens the streak contrast
      let a = (a0 / 255 - 0.1) * 1.65;
      if (a > 1) a = 1;
      if (gs > 0) a *= 1 - gs * (grain[grow | ((((gx0 + x) % 256) + 256) % 256)] / 255);
      d[i] = cr; d[i + 1] = cg; d[i + 2] = cb;
      d[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, rx, ry);
}

/** Whole-canvas convenience wrapper around finishRegion. */
export function finishStroke(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  style: BrushStyle,
  originX = 0, originY = 0,
): void {
  finishRegion(ctx, 0, 0, w, h, style, originX, originY);
}

export interface RenderedShape {
  canvas: HTMLCanvasElement;
  /** Top-left of the canvas, in layout units. */
  x: number;
  y: number;
}

/**
 * Render a set of polylines (in LAYOUT UNITS) as one pencil drawing at device
 * resolution. Draw the returned canvas at (x, y) with scale 1/zoom.
 */
export function renderShape(
  lines: Pt[][],
  style: BrushStyle,
  zoom: number,
  rng: () => number = Math.random,
  into?: { ctx: CanvasRenderingContext2D; dx: number; dy: number; x: number; y: number },
): RenderedShape {
  const pad = style.width * 1.6 + 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines) for (const p of l) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  if (!isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }
  const ox = x0 - pad, oy = y0 - pad;

  let canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, dx = 0, dy = 0;
  if (into) {
    ({ ctx, dx, dy } = into);
    canvas = ctx.canvas;
  } else {
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil((x1 - x0 + pad * 2) * zoom));
    canvas.height = Math.max(1, Math.ceil((y1 - y0 + pad * 2) * zoom));
    ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  }
  const radius = (style.width / 2) * zoom;
  for (const l of lines) {
    dabPolyline(ctx, l.map((p) => ({ x: (p.x - ox) * zoom + dx, y: (p.y - oy) * zoom + dy })), radius, style, rng);
  }
  if (!into) finishStroke(ctx, canvas.width, canvas.height, style, ox * zoom, oy * zoom);
  return { canvas, x: ox, y: oy };
}

/**
 * Catmull-Rom smoothing. Jittered control points joined with straight segments
 * leave little kinks no hand-drawn line has; this turns them into a gentle
 * wander. `closed` treats the path as a loop.
 */
export function smoothPolyline(pts: Pt[], samplesPerSeg = 6, closed = false): Pt[] {
  if (pts.length < 3) return pts.slice();
  const n = pts.length;
  const get = (i: number) => closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  const out: Pt[] = [];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let k = 0; k < samplesPerSeg; k++) {
      const t = k / samplesPerSeg, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(closed ? { ...pts[0] } : { ...pts[n - 1] });
  return out;
}

/**
 * A hand-drawn box as ONE continuous stroke: starts just past a corner, goes
 * all the way round and overshoots the start slightly, like a box drawn
 * without lifting the pencil. Jittered then smoothed.
 */
export function boxPath(x: number, y: number, w: number, h: number, jitter: number, rng: () => number, step = 22): Pt[] {
  const j = () => (rng() - 0.5) * 2 * jitter;
  const cornerJ = () => ({ dx: j() * 0.6, dy: j() * 0.6 });
  const c = [
    { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y },
  ].map((p) => { const d = cornerJ(); return { x: p.x + d.dx, y: p.y + d.dy }; });
  const startX = x + Math.min(18, w * 0.08);
  const start = { x: startX, y: y + j() * 0.5 };
  const end = { x: startX + Math.min(30, w * 0.12), y: y + j() };

  // Each edge: jittered interior points between fixed ends, smoothed alone.
  const edge = (a: Pt, b: Pt): Pt[] => {
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
    const pts: Pt[] = [a];
    for (let i = 1; i < n; i++) {
      const t = i / n;
      pts.push({ x: a.x + (b.x - a.x) * t + j(), y: a.y + (b.y - a.y) * t + j() });
    }
    pts.push(b);
    return smoothPolyline(pts, 5, false);
  };
  const path: Pt[] = [];
  const legs: Array<[Pt, Pt]> = [[start, c[0]], [c[0], c[1]], [c[1], c[2]], [c[2], c[3]], [c[3], end]];
  legs.forEach(([a, b], i) => {
    const e = edge(a, b);
    path.push(...(i === 0 ? e : e.slice(1))); // shared corner point appears once
  });
  return path;
}
