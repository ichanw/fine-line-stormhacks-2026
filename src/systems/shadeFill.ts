/**
 * The "selected" fill (user spec, 2026-10-04): when a button is pressed or an
 * option is the chosen one, its background is shaded in solid near-black
 * graphite with a subtle grain and a sketchy edge, quickly, as if by hand.
 *
 * Five progressive stages are pre-rendered into the UI atlas: thick diagonal
 * strokes sweep in from the left with a ragged front, and the last stage is
 * solid. Animating is then only a frame flip over SELECT_FILL_MS (instant under
 * reduced motion). Strokes are plain canvas lines finished with the brush's
 * grain pass — a dab-brush fill this size cost ~20 ms per control.
 */

import Phaser from 'phaser';
import { BrushAtlas } from '@/systems/brushAtlas';
import { defaultBrush, finishRegion, type Pt } from '@/systems/brush';
import { mulberry32 } from '@/systems/rng';
import { settings } from '@/systems/SettingsManager';
import { viewport } from '@/systems/viewport';
import { COLOR_SELECTED_FILL_CSS, COLOR_SELECTED_TEXT, SELECT_FILL_MS } from '@/systems/constants';

const STAGES = 5;
/** Stage from which the fill counts as dark enough for white text. */
const FILLED_AT = 3;
let uid = 0;

export interface ShadeRect { x: number; y: number; w: number; h: number }

export class ShadeFill {
  readonly img: Phaser.GameObjects.Image;
  private names: string[] = [];
  private shown = 0;              // stages currently visible, 0 … STAGES
  private target = 0;
  private tween?: Phaser.Tweens.Tween;
  private destroyed = false;
  private dark = false;
  private onFilledChange?: (filled: boolean) => void;

  constructor(
    private scene: Phaser.Scene, rect: ShadeRect,
    opts: { depth: number; inset?: number; seed?: number; onFilledChange?: (filled: boolean) => void },
  ) {
    this.onFilledChange = opts.onFilledChange;
    const z = viewport.zoom;
    const pad = 2;
    const fw = Math.ceil((rect.w + pad * 2) * z), fh = Math.ceil((rect.h + pad * 2) * z);
    const atlas = BrushAtlas.for(scene, 'ui');
    const r = atlas.alloc(fw * STAGES, fh) ?? atlas.allocOwn(fw * STAGES, fh);
    const rng = mulberry32(opts.seed ?? 9000 + ++uid * 13);
    const inset = opts.inset ?? 1.5;

    // A sketchy quad: each edge subdivided and nudged, so the fill's edge is
    // hand-drawn rather than ruled. In local units, origin at the frame's pad.
    const W = rect.w - inset * 2, H = rect.h - inset * 2;
    const o = pad + inset;
    const poly: Pt[] = [];
    const edge = (a: Pt, b: Pt, nx: number, ny: number) => {
      for (let i = 0; i < 4; i++) {
        const t = i / 4, j = (rng() - 0.5) * 1.6;
        poly.push({ x: a.x + (b.x - a.x) * t + nx * j, y: a.y + (b.y - a.y) * t + ny * j });
      }
    };
    edge({ x: o, y: o }, { x: o + W, y: o }, 0, 1);
    edge({ x: o + W, y: o }, { x: o + W, y: o + H }, 1, 0);
    edge({ x: o + W, y: o + H }, { x: o, y: o + H }, 0, 1);
    edge({ x: o, y: o + H }, { x: o, y: o }, 1, 0);

    // Diagonal strokes leaning right, each with its own reach, so the sweep
    // front is ragged like quick pencil shading.
    const lean = H * 0.55, sw = Math.max(5, H * 0.24);
    const strokes: Array<{ x: number; front: number }> = [];
    for (let x = o - lean - sw; x < o + W + sw; x += sw * 0.6) {
      strokes.push({ x, front: (x - (o - lean)) / (W + lean) + (rng() - 0.5) * 0.18 });
    }

    const { ctx } = r;
    const style = defaultBrush({ color: COLOR_SELECTED_FILL_CSS, grain: 0.22 });
    for (let k = 1; k <= STAGES; k++) {
      const fx = r.x + (k - 1) * fw, fy = r.y;
      ctx.save();
      ctx.beginPath();
      poly.forEach((p, i) => (i ? ctx.lineTo(fx + p.x * z, fy + p.y * z) : ctx.moveTo(fx + p.x * z, fy + p.y * z)));
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = ctx.strokeStyle = '#000';
      if (k === STAGES) {
        ctx.fill();
      } else {
        ctx.lineWidth = sw * z;
        ctx.lineCap = 'round';
        const reach = k / STAGES;
        for (const s of strokes) {
          if (s.front > reach) continue;
          const short = (rng() * 0.25) * H;
          ctx.beginPath();
          ctx.moveTo(fx + s.x * z, fy + (o + H + 2 - short * 0.5) * z);
          ctx.lineTo(fx + (s.x + lean) * z, fy + (o - 2 + short) * z);
          ctx.stroke();
        }
      }
      ctx.restore();
      // Recolour to graphite and knock out a little paper grain.
      finishRegion(ctx, fx, fy, fw, fh, style, rect.x * z, rect.y * z);
      const name = `sel${uid}-${k}`;
      r.tex.add(name, 0, fx, fy, fw, fh);
      this.names.push(name);
    }
    r.markDirty(r.x, r.y, fw * STAGES, fh);

    this.img = scene.add.image(rect.x - pad, rect.y - pad, r.key, this.names[STAGES - 1])
      .setOrigin(0, 0).setScale(1 / z).setDepth(opts.depth).setVisible(false);
  }

  get on(): boolean { return this.target > 0; }

  /** Dark enough that text on it should be paper-white. */
  get filled(): boolean { return this.dark; }

  /**
   * Shade in, or fade back out (user, 2026-10-04: hover-off fades rather than
   * un-shading stroke by stroke). `instant` skips the animation.
   */
  set(on: boolean, instant = false): void {
    if (this.destroyed) return;
    const target = on ? STAGES : 0;
    if (target === this.target && !instant) return;
    this.target = target;
    this.tween?.stop();
    if (instant || settings.get('reducedMotion')) { this.img.setAlpha(1); this.show(target); return; }
    if (on) {
      this.img.setAlpha(1);                       // re-hovered mid fade: back to solid
      const state = { k: this.shown };
      this.tween = this.scene.tweens.add({
        targets: state, k: STAGES, duration: SELECT_FILL_MS * (1 - this.shown / STAGES), ease: 'Sine.easeOut',
        onUpdate: () => this.show(Math.round(state.k)),
        onComplete: () => this.show(STAGES),
      });
    } else {
      this.tween = this.scene.tweens.add({
        targets: this.img, alpha: 0, duration: SELECT_FILL_MS, ease: 'Sine.easeIn',
        onUpdate: () => this.setDark(this.shown >= FILLED_AT && this.img.alpha > 0.5),
        onComplete: () => { this.img.setAlpha(1); this.show(0); },
      });
    }
  }

  /** Paper-coloured instead of graphite: a chosen option inside a focused row. */
  invert(on: boolean): void {
    if (on) this.img.setTintFill(COLOR_SELECTED_TEXT); else this.img.clearTint();
  }

  private show(k: number): void {
    this.shown = k;
    this.img.setVisible(k > 0);
    if (k > 0) this.img.setFrame(this.names[k - 1]);
    this.setDark(k >= FILLED_AT && this.img.alpha > 0.5);
  }

  private setDark(d: boolean): void {
    if (d === this.dark) return;
    this.dark = d;
    this.onFilledChange?.(d);
  }

  destroy(): void {
    this.destroyed = true;
    this.tween?.stop();
    this.img.destroy();
  }
}
