/**
 * Screen transitions. Four styles, chosen in the F1 panel; the default is D
 * (`defaultStyle` in src/data/transitions.json):
 *
 *   D  stop-motion scrapbook  torn scraps cover the old screen on ~8 fps
 *                           steps, the next screen slaps down as a torn-edge
 *                           page and is taped on — see systems/scrapbook.ts
 *
 *   A  crumple + scrapbook  the old screen is crumpled into a paper ball and
 *                           tossed away; beneath it the next screen lies on
 *                           the desk like a scrapbook page, taped down a little
 *                           askew, and settles flat to fill the screen
 *   B  paper turn           the old screen lifts from its right edge and turns
 *                           over the left edge like a sketchbook page
 *   C  smudge dissolve      the old screen smears and dissolves through
 *                           paper-grain noise into the next one
 *
 * A–C run ~700–900 ms, D ~1.4 s. Under reduced motion every style becomes a
 * plain quick crossfade. Input is locked from the first frame of a transition
 * to its last, so a double-click can't skip or stack transitions.
 *
 * Use: `transitionOut(scene, () => scene.scene.start(...))` on the way out and
 * `transitionIn(this)` near the top of the next scene's create(). Out records
 * what In must finish; In does nothing if no transition is pending.
 *
 * Every style starts from a copy of the outgoing scene's last frame, taken on
 * the GPU straight from the framebuffer right after Phaser renders it
 * (copyTexImage2D) — no pixel readback.
 */

import Phaser from 'phaser';
import { debugPanel, type TransitionStyle } from '@/systems/debug';
import { settings } from '@/systems/SettingsManager';
import { viewport } from '@/systems/viewport';
import { COLOR_DESK, COLOR_TAPE, SELECT_FILL_MS } from '@/systems/constants';
import { noiseField } from '@/systems/displace';
import { scrapbookArrive, scrapbookCover } from '@/systems/scrapbook';

const TOP = 10000;

type Pending = { style: TransitionStyle | 'fade'; key: string; w: number; h: number };

let pending: Pending | null = null;
/** Scenes already on their way out — a second press must not start another. */
const leaving = new Set<Phaser.Scene>();

/** True while `scene` is on its way out (its pressed button stays shaded). */
export function isLeaving(scene: Phaser.Scene): boolean { return leaving.has(scene); }

// --- input lock ------------------------------------------------------------------

/**
 * While a transition runs, nothing reacts to input: a transparent blocker sits
 * over the page (pointer and hover), keys are swallowed in the capture phase
 * before Phaser or the focused proxy see them, and Phaser's own input is off.
 * Released when the incoming half finishes (with a safety timeout).
 */
let blocker: HTMLDivElement | null = null;
let lockedGame: Phaser.Game | null = null;
let lockTimer = 0;
const swallow = (e: KeyboardEvent) => { e.preventDefault(); e.stopImmediatePropagation(); };

function lockInput(game: Phaser.Game): void {
  if (!blocker) {
    blocker = document.createElement('div');
    blocker.setAttribute('aria-hidden', 'true');
    blocker.style.cssText = 'position:fixed;inset:0;z-index:2147483500;background:transparent;display:none;';
    document.body.appendChild(blocker);
  }
  blocker.style.display = 'block';
  if (!lockedGame) {
    window.addEventListener('keydown', swallow, true);
    window.addEventListener('keyup', swallow, true);
  }
  lockedGame = game;
  game.input.enabled = false;
  window.clearTimeout(lockTimer);
  lockTimer = window.setTimeout(unlockInput, 5000);   // never strand the player
}

function unlockInput(): void {
  window.clearTimeout(lockTimer);
  if (blocker) blocker.style.display = 'none';
  window.removeEventListener('keydown', swallow, true);
  window.removeEventListener('keyup', swallow, true);
  if (lockedGame) lockedGame.input.enabled = true;
  lockedGame = null;
}

/** True while a transition holds the input lock. */
export function inputLocked(): boolean { return lockedGame !== null; }

/** Run the outgoing half, then `onDone` (typically scene.start). */
export function transitionOut(scene: Phaser.Scene, onDone: () => void): void {
  if (leaving.has(scene) || inputLocked()) return;
  leaving.add(scene);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => leaving.delete(scene));
  lockInput(scene.game);

  const reduced = settings.get('reducedMotion');
  const style: TransitionStyle | 'fade' = reduced ? 'fade' : debugPanel.get().transition;
  const capture = () => captureFrame(scene, (snap) => {
    pending = snap ? { style, ...snap } : null;
    onDone();
  });
  // Let a pressed button finish shading in first, so the press is seen (and is
  // part of the captured picture).
  scene.time.delayedCall(reduced ? 0 : SELECT_FILL_MS, () => {
    // D covers the old screen on this side, then captures the collage.
    if (style === 'D') scrapbookCover(scene, capture);
    else capture();
  });
}

/**
 * Finish whatever the previous scene started. Call from create(). If the
 * scene is still loading its art, pass `ready`: the outgoing picture holds on
 * screen until it resolves, so nothing half-built is ever revealed.
 */
export function transitionIn(scene: Phaser.Scene, ready?: Promise<unknown>): void {
  const p = pending;
  pending = null;
  if (!p) { unlockInput(); return; }
  if (ready) {
    const hold = scene.add.image(0, 0, p.key).setOrigin(0, 0).setScale(1 / viewport.zoom).setFlipY(true)
      .setScrollFactor(0).setDepth(TOP + 50);
    void ready.then(() => {
      if (!scene.sys.isActive()) return;
      hold.destroy();
      run(scene, p);
    });
    return;
  }
  run(scene, p);
}

function run(scene: Phaser.Scene, p: Pending): void {
  const z = viewport.zoom;
  const done = () => {
    if (scene.textures.exists(p.key)) scene.textures.remove(p.key);
    unlockInput();
  };
  if (p.style === 'D') { scrapbookArrive(scene, p, done); return; }
  if (p.style === 'A') { crumple(scene, p, done); return; }
  if (p.style === 'B') { pageTurn(scene, p, done); return; }
  const img = scene.add.image(0, 0, p.key).setOrigin(0, 0).setScale(1 / z).setFlipY(true)
    .setScrollFactor(0).setDepth(TOP);
  if (p.style === 'C') { smudge(scene, img, done); return; }
  // Reduced motion: a plain, quick crossfade.
  scene.tweens.add({ targets: img, alpha: 0, duration: 220, ease: 'Linear', onComplete: () => { img.destroy(); done(); } });
}

// --- frame capture ------------------------------------------------------------

/**
 * Copy the frame Phaser has just rendered into a texture, on the GPU. The
 * copy is bottom-up (GL convention), so it is drawn with flipY.
 */
function captureFrame(scene: Phaser.Scene, cb: (snap: { key: string; w: number; h: number } | null) => void): void {
  const renderer = scene.game.renderer;
  if (!(renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer)) { cb(null); return; }
  renderer.once(Phaser.Renderer.Events.POST_RENDER, () => {
    const gl = renderer.gl;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const wrapper = renderer.createTexture2D(
      0, gl.LINEAR, gl.LINEAR, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE, gl.RGBA,
      null as unknown as HTMLCanvasElement, w, h, true, false, false,
    );
    // Mirror Phaser's own texture-unit discipline: save, use unit 0, restore.
    gl.activeTexture(gl.TEXTURE0);
    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, wrapper.webGLTexture);
    // The game's context has no alpha channel, so the copy must be RGB —
    // RGBA from an RGB framebuffer is GL_INVALID_OPERATION and copies nothing.
    const hasAlpha = gl.getContextAttributes()?.alpha ?? false;
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, hasAlpha ? gl.RGBA : gl.RGB, 0, 0, w, h, 0);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    const key = `transition-snap-${Date.now()}`;
    scene.textures.addGLTexture(key, wrapper);
    cb({ key, w, h });
  });
}

// --- A: crumple + scrapbook -----------------------------------------------------

const CRUMPLE_MS = 820;
/** Grid columns of the crumpling sheet (rows follow the aspect). */
const CRUMPLE_GRID = 36;

/**
 * The old screen as a sheet of paper — a grid mesh textured with the captured
 * frame — crumpled into a ball, edges first, creases folding over each other
 * and darkening, then tossed off to the lower right. Beneath it the next
 * screen lies on the desk as a scrapbook page: a little small and askew, two
 * strips of tape at its top corners, settling flat to fill the screen as the
 * ball leaves.
 *
 * The page settle moves the scene's camera (zoom and tilt about the centre;
 * nothing in this game scrolls otherwise). The crumpling sheet is
 * counter-transformed so the settle does not move it.
 */
function crumple(scene: Phaser.Scene, snap: { key: string; w: number; h: number }, done: () => void): void {
  const W = viewport.W, H = viewport.H, zoom0 = viewport.zoom;
  const cam = scene.cameras.main;
  const pc = { x: W / 2, y: H / 2 };
  const GX = CRUMPLE_GRID, GY = Math.max(8, Math.round((CRUMPLE_GRID * H) / W));
  const ball = Math.min(W, H) * 0.11;
  const maxd = Math.hypot(W / 2, H / 2);
  const twist = noiseField(71, 0.35), lump = noiseField(72, 1.4), depth = noiseField(73, 1.1);
  const ruffle = noiseField(74, 2.2), crease = noiseField(75, 2.6), lag = noiseField(76, 0.8);

  // Per grid point, computed once: rest position, crumpled position, when it
  // starts moving, how it ruffles on the way, and how dark its crease gets.
  const N = (GX + 1) * (GY + 1);
  const rest = new Float32Array(N * 2), tgt = new Float32Array(N * 3), fold = new Float32Array(N * 2), rim = new Float32Array(N);
  const start = new Float32Array(N), dark = new Float32Array(N);
  const verts: number[] = [], uvs: number[] = [], idx: number[] = [];
  for (let j = 0; j <= GY; j++) {
    for (let i = 0; i <= GX; i++) {
      const k = j * (GX + 1) + i;
      const px = (W * i) / GX, py = (H * j) / GY;
      const rx = px - pc.x, ry = py - pc.y, d = Math.hypot(rx, ry) / maxd, a0 = Math.atan2(ry, rx);
      const a = a0 + twist(px, py) * 1.1;
      const rr = ball * (0.3 + 0.7 * Math.sqrt(d)) * (0.9 + 0.2 * lump(px, py));
      rim[k] = Math.min(1, rr / ball);                             // 0 centre … 1 edge of the ball
      rest[k * 2] = px; rest[k * 2 + 1] = py;
      tgt[k * 3] = pc.x + Math.cos(a) * rr;
      tgt[k * 3 + 1] = pc.y + Math.sin(a) * rr;
      tgt[k * 3 + 2] = ball * (1.2 - d) + ball * 0.5 * depth(px, py);
      start[k] = 0.22 * (1 - d) + 0.03 * (lag(px, py) + 1);       // edges go first
      const amp = ball * 0.9 * ruffle(px, py);
      fold[k * 2] = -Math.sin(a0) * amp; fold[k * 2 + 1] = Math.cos(a0) * amp;
      dark[k] = 0.5 + 0.5 * crease(px, py);
      // Model space: centred on the mesh, y up; the capture is bottom-up.
      verts.push(px - pc.x, -(py - pc.y), 0);
      uvs.push(i / GX, 1 - j / GY);
    }
  }
  for (let j = 0; j < GY; j++) {
    for (let i = 0; i < GX; i++) {
      const a = j * (GX + 1) + i, b = a + 1, c = a + GX + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const sheet = scene.add.mesh(pc.x, pc.y, snap.key);
  sheet.setSize(W, H);
  sheet.addVertices(verts, uvs, idx, true);
  sheet.setOrtho(W, H);                      // model units = layout units
  sheet.hideCCW = false;                     // folds show their backs
  sheet.ignoreDirtyCache = true;             // vertices move every frame
  sheet.setDepth(TOP + 1);

  // The next screen as a page on the desk: a soft shadow and two strips of tape.
  const prevBg = cam.backgroundColor.rgba;
  cam.setBackgroundColor(COLOR_DESK);
  const shadow = scene.add.rectangle(7, 10, W, H, 0x2e2e2e, 0.22).setOrigin(0, 0).setDepth(-1001);
  const tape = [
    scene.add.rectangle(W * 0.09, 4, W * 0.1, 24, COLOR_TAPE, 0.85).setAngle(-28),
    scene.add.rectangle(W * 0.91, 4, W * 0.1, 24, COLOR_TAPE, 0.85).setAngle(24),
  ];
  tape.forEach((t) => t.setStrokeStyle(1, 0x8a8a8a, 0.45).setDepth(TOP));

  const gx = new Float32Array(N), gy = new Float32Array(N), gz = new Float32Array(N), gc = new Uint32Array(N);
  const smooth = (x: number) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
  const backOut = (x: number) => { const c = 1.4; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  const state = { t: 0 };
  const draw = () => {
    const t = state.t;
    // 1. Crumple (done by ~58%).
    const tc = t / 0.58;
    for (let k = 0; k < N; k++) {
      const e = smooth((tc - start[k]) / 0.55);
      const rf = Math.sin(Math.PI * e);
      gx[k] = rest[k * 2] + (tgt[k * 3] - rest[k * 2]) * e + fold[k * 2] * rf;
      gy[k] = rest[k * 2 + 1] + (tgt[k * 3 + 1] - rest[k * 2 + 1]) * e + fold[k * 2 + 1] * rf;
      gz[k] = tgt[k * 3 + 2] * e;
      // Creases darken, and the ball shades toward its rim so it reads round.
      const g = Math.round(255 * (1 - e * (0.12 + 0.36 * dark[k] + 0.28 * rim[k] * rim[k])));
      gc[k] = (g << 16) | (g << 8) | g;
    }
    const vs = sheet.vertices;
    for (let m = 0; m < vs.length; m++) {
      const k = idx[m], v = vs[m];
      v.x = gx[k] - pc.x; v.y = -(gy[k] - pc.y); v.z = gz[k]; v.color = gc[k];
    }
    // 2. Page settle: camera zoom + tilt about the screen centre.
    const ts = Math.min(1, Math.max(0, (t - 0.28) / 0.72));
    const sb = backOut(ts);
    const s = 0.9 + 0.1 * sb, r = -0.035 * (1 - sb);
    const cs = Math.cos(r), sn = Math.sin(r);
    const inv = (x: number, y: number) => ({ x: cs * x + sn * y, y: -sn * x + cs * y });   // R(-r)
    const c0 = inv(pc.x / s, pc.y / s);
    const scroll = { x: pc.x - c0.x, y: pc.y - c0.y };
    cam.setZoom(zoom0 * s).setRotation(r).setScroll(scroll.x, scroll.y);
    shadow.setAlpha(0.22 * (1 - ts));
    tape.forEach((tp) => tp.setAlpha(0.85 * (1 - smooth((t - 0.86) / 0.14))));
    // 3. Toss the ball off to the lower right, spinning (screen space, then
    //    counter-transformed so the camera settle doesn't move it).
    const tt = Math.min(1, Math.max(0, (t - 0.42) / 0.58));
    const mx = pc.x + W * 0.85 * Math.pow(tt, 1.3), my = pc.y - H * 0.2 * Math.sin(Math.PI * tt) + H * 0.95 * tt * tt;
    const mp = inv(mx / s, my / s);
    sheet.setPosition(scroll.x + mp.x, scroll.y + mp.y);
    sheet.setRotation(3.6 * tt * (tt + 0.3) - r);
    sheet.setScale((1 - 0.3 * tt) / s);
  };
  draw();
  scene.tweens.add({
    targets: state, t: 1, duration: CRUMPLE_MS, ease: 'Linear',
    onUpdate: draw,
    onComplete: () => {
      cam.setZoom(zoom0).setRotation(0).setScroll(0, 0).setBackgroundColor(prevBg);
      sheet.destroy(); shadow.destroy(); tape.forEach((tp) => tp.destroy());
      done();
    },
  });
}
// --- B: paper turn -------------------------------------------------------------------

const TURN_MS = 760;
const STRIPS = 48;

/**
 * The old screen as a page hinged on its left edge, turning toward the viewer
 * and over. Drawn as vertical strips, each projected in perspective, so the
 * free edge rises and grows as it lifts and the page curls near that edge.
 * Strips facing away show the page's blank back; a soft shadow falls on the
 * new screen beside the turning edge.
 */
function pageTurn(scene: Phaser.Scene, snap: { key: string; w: number; h: number }, done: () => void): void {
  const W = viewport.W, H = viewport.H;
  const tex = scene.textures.get(snap.key);
  const strips: Phaser.GameObjects.Image[] = [];
  const pxW = snap.w / STRIPS;
  for (let i = 0; i < STRIPS; i++) {
    const x0 = Math.floor(i * pxW), x1 = Math.floor((i + 1) * pxW);
    tex.add(`s${i}`, 0, x0, 0, x1 - x0, snap.h);
    strips.push(scene.add.image(0, H / 2, snap.key, `s${i}`).setOrigin(0, 0.5).setFlipY(true).setScrollFactor(0).setDepth(TOP + 1));
  }
  const shadow = scene.add.image(0, 0, shadowTexture(scene)).setOrigin(0, 0).setScrollFactor(0).setDepth(TOP).setVisible(false);

  const D = W * 2.4;                       // viewer distance, layout units
  const cx = W / 2;
  const du = W / STRIPS;
  const xs = new Float32Array(STRIPS + 1), zs = new Float32Array(STRIPS + 1);
  const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const state = { p: 0 };
  const draw = () => {
    const p = state.p;
    const phi = p * Math.PI * 0.58;                    // past 90°: gone off the left
    const curl = 0.95 * Math.sin(Math.PI * Math.min(1, p * 1.15));
    xs[0] = 0; zs[0] = 0;
    for (let i = 0; i < STRIPS; i++) {
      const a = phi + curl * smooth(W * 0.45, W, (i + 0.5) * du);
      xs[i + 1] = xs[i] + du * Math.cos(a);
      zs[i + 1] = zs[i] + du * Math.sin(a);
    }
    const proj = (x: number, zz: number) => cx + (x - cx) * (D / (D - zz));
    for (let i = 0; i < STRIPS; i++) {
      const X0 = proj(xs[i], zs[i]), X1 = proj(xs[i + 1], zs[i + 1]);
      const zm = (zs[i] + zs[i + 1]) / 2, k = D / (D - zm);
      const a = Math.atan2(zs[i + 1] - zs[i], xs[i + 1] - xs[i]);
      const s = strips[i];
      const back = X1 < X0;
      const left = Math.min(X0, X1), width = Math.abs(X1 - X0) + 0.6;   // overlap hides seams
      s.setPosition(left, H / 2).setDisplaySize(width, H * k);
      if (back) {
        // The blank back of the page, a touch grey where it faces away.
        const g = Math.round(236 - 26 * Math.abs(Math.cos(a)));
        s.setTintFill(Phaser.Display.Color.GetColor(g, g - 2, g - 6));
      } else {
        // The front darkens as it tilts away from the light.
        const g = Math.round(255 - 80 * Math.min(1, Math.sin(Math.max(0, a))));
        s.clearTint().setTint(Phaser.Display.Color.GetColor(g, g, g));
      }
    }
    // Soft shadow on the new screen, just right of the lifting edge.
    const edge = proj(xs[STRIPS], zs[STRIPS]);
    const lift = Math.sin(Math.min(Math.PI / 2, phi + curl));
    shadow.setVisible(edge > 0 && edge < W).setPosition(edge, 0).setDisplaySize(40 + 90 * lift, H).setAlpha(0.35 * lift);
  };
  draw();
  scene.tweens.add({
    targets: state, p: 1, duration: TURN_MS, ease: 'Sine.easeInOut',
    onUpdate: draw,
    onComplete: () => { strips.forEach((s) => s.destroy()); shadow.destroy(); done(); },
  });
}

/** A horizontal graphite-to-transparent gradient, made once. */
function shadowTexture(scene: Phaser.Scene): string {
  const key = 'transition-shadow';
  if (scene.textures.exists(key)) return key;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 4;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, 'rgba(30,30,30,0.9)');
  g.addColorStop(1, 'rgba(30,30,30,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 4);
  scene.textures.addCanvas(key, c);
  return key;
}

// --- C: smudge dissolve ----------------------------------------------------------------

const SMUDGE_MS = 720;

const SMUDGE_FRAG = `
#define SHADER_NAME SMUDGE_FS
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uMainSampler;
uniform vec2 uResolution;
uniform float uProgress;
uniform float uZoom;
varying vec2 outTexCoord;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// Fractal noise with each octave rotated, so smudges are soft and round
// rather than aligned to the noise grid.
float fbm(vec2 p) {
  const mat2 R = mat2(0.8, -0.6, 0.6, 0.8);
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = R * p * 2.03 + 17.1; a *= 0.5; }
  return v / 0.9375;
}

void main() {
  vec2 px = outTexCoord * uResolution / uZoom;          // layout units
  // Big soft smudges, finer clumps, and per-speck paper grain.
  float n = 0.82 * fbm(px / 230.0) + 0.1 * vnoise(px / 24.0) + 0.08 * hash(floor(px * uZoom / 1.5));
  n = clamp((n - 0.2) / 0.6, 0.0, 1.0);                 // fbm sits mid-range; spread it out
  // Drag the old picture sideways in streaks, like a thumb through graphite.
  float streak = vnoise(vec2(px.y / 7.0, px.x / 260.0));
  vec2 off = vec2(-(0.5 + streak) * 30.0, (streak - 0.5) * 5.0) * uProgress * uZoom / uResolution;
  vec4 c = texture2D(uMainSampler, outTexCoord + off);
  float keep = smoothstep(uProgress - 0.06, uProgress + 0.06, n);
  // A darker graphite rim along the dissolving front.
  float front = clamp(1.0 - abs(n - uProgress) / 0.07, 0.0, 1.0);
  c.rgb = mix(c.rgb, vec3(0.18) * c.a, front * 0.4);
  gl_FragColor = c * keep;
}
`;

class SmudgeFX extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  progress = -0.12;
  constructor(game: Phaser.Game) { super({ game, name: 'SmudgeFX', fragShader: SMUDGE_FRAG }); }
  onPreRender(): void {
    this.set1f('uProgress', this.progress);
    this.set1f('uZoom', viewport.zoom);
    this.set2f('uResolution', this.renderer.width, this.renderer.height);
  }
}

function smudge(scene: Phaser.Scene, img: Phaser.GameObjects.Image, done: () => void): void {
  const renderer = scene.game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
  if (!renderer.pipelines.getPostPipeline('SmudgeFX')) renderer.pipelines.addPostPipeline('SmudgeFX', SmudgeFX);
  img.setPostPipeline('SmudgeFX');
  const fx = img.getPostPipeline('SmudgeFX') as SmudgeFX;
  scene.tweens.add({
    targets: fx, progress: 1.12, duration: SMUDGE_MS, ease: 'Sine.easeIn',
    onComplete: () => { img.destroy(); done(); },
  });
}
