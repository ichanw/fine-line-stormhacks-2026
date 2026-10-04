/**
 * Dev-only brush lab: the user's reference strokes at 1:1 beside strokes from
 * the game's own brush engine (src/systems/brush.ts). Open /dev/brush-lab.html
 * on the dev server. Not part of the production build.
 */
import { boxPath, defaultBrush, renderShape, smoothPolyline, type BrushStyle, type Pt } from '../src/systems/brush';
import { mulberry32 } from '../src/systems/rng';

const DPR = window.devicePixelRatio || 1;
/** Device px per layout unit for the generated samples (≈ 1080p Retina). */
const ZOOM = 2.5;

const grid = document.getElementById('grid')!;

function cell(title: string, caption: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'cell';
  d.innerHTML = `<h2>${title}</h2><div class="cap">${caption}</div>`;
  grid.appendChild(d);
  return d;
}

/** A canvas whose backing pixels map 1:1 to device pixels. */
function deviceCanvas(wDev: number, hDev: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = wDev; c.height = hDev;
  c.style.width = `${wDev / DPR}px`; c.style.height = `${hDev / DPR}px`;
  return c;
}

async function refCrop(file: string, x: number, y: number, w: number, h: number): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = `/art/title/${file}.png`;
  await img.decode();
  const c = deviceCanvas(w, h);
  c.getContext('2d')!.drawImage(img, x, y, w, h, 0, 0, w, h);
  return c;
}

function generated(lines: Pt[][], style: BrushStyle, wUnits: number, hUnits: number, seed: number): HTMLCanvasElement {
  const out = deviceCanvas(Math.ceil(wUnits * ZOOM), Math.ceil(hUnits * ZOOM));
  const r = renderShape(lines, style, ZOOM, mulberry32(seed));
  out.getContext('2d')!.drawImage(r.canvas, r.x * ZOOM, r.y * ZOOM);
  return out;
}

const IDLE = defaultBrush({ color: '#6e6e6e', width: 2.0, alpha: 0.3 });
const HOVER = defaultBrush({ color: '#1A1A1A', width: 3.0, alpha: 0.27 });
const LINE = defaultBrush({ color: '#333333', width: 3.4 });

async function main(): Promise<void> {
  // Row 1: reference rock / generated button idle
  cell('Reference — rocks.png (1:1)', 'your outline: soft, grainy, broken').appendChild(await refCrop('rocks', 1585, 1160, 430, 340));
  const bIdle = cell('Generated — button, idle', 'single stroke, thin grey, 4 fps boil frame');
  bIdle.appendChild(generated([boxPath(10, 10, 300, 62, 1.6, mulberry32(7))], IDLE, 320, 82, 11));
  const bHover = document.createElement('div');
  bHover.innerHTML = '<div class="cap" style="margin-top:10px">same button, hover / focus (#1A1A1A, 1.5× width)</div>';
  bHover.appendChild(generated([boxPath(10, 10, 300, 62, 1.6, mulberry32(7))], HOVER, 320, 82, 12));
  bIdle.appendChild(bHover);

  // Row 2: reference hill line / generated hill-like line
  cell('Reference — hill_right.png (1:1)', 'pressure swells, end fades out').appendChild(await refCrop('hill_right', 860, 1320, 820, 270));
  const hill: Pt[] = smoothPolyline([
    { x: 6, y: 100 }, { x: 60, y: 86 }, { x: 70, y: 80 }, { x: 80, y: 82 }, { x: 140, y: 64 },
    { x: 200, y: 46 }, { x: 260, y: 34 }, { x: 320, y: 18 },
  ], 8);
  cell('Generated — free line', 'same brush, heavier weight').appendChild(generated([hill], LINE, 330, 110, 21));

  // Row 3: reference trunk / generated trunk-like strokes
  cell('Reference — tree_trunk.png (1:1)', 'paired strokes, uneven pressure').appendChild(await refCrop('tree_trunk', 1760, 480, 480, 420));
  const t1 = smoothPolyline([{ x: 70, y: 166 }, { x: 74, y: 120 }, { x: 80, y: 80 }, { x: 70, y: 46 }, { x: 40, y: 10 }], 8);
  const t2 = smoothPolyline([{ x: 100, y: 166 }, { x: 102, y: 120 }, { x: 104, y: 84 }, { x: 128, y: 52 }, { x: 160, y: 30 }], 8);
  cell('Generated — two strokes', 'separate strokes, independent pressure').appendChild(generated([t1, t2], LINE, 190, 175, 31));
}

void main();
