/**
 * Story UI: the narration box and the choice panel (Figma story frames).
 *
 * Both sit exactly over the boxes baked into the user's flattened frames and
 * are opaque, so the frame's own text never shows through. They are pencil
 * (one boiling stroke at the UI rate), with a soft drop shadow like Figma's.
 * Text is the narration serif and honours text size / dyslexia font; when a
 * larger text size no longer fits, a box grows upward (never smaller than the
 * baked box it covers).
 */

import Phaser from 'phaser';
import config from '@/data/config.json';
import { A11yProxy, keyboardNav, onNavModeChange } from '@/systems/a11y';
import { Boiler, SketchShape, pathShape, type Pt } from '@/systems/boil';
import { settings } from '@/systems/SettingsManager';
import { FocusableControl, SketchButton } from '@/systems/ui';
import { viewport } from '@/systems/viewport';
import { BOIL_FPS_UI, COLOR_INK, COLOR_PAPER, COLOR_STROKE_IDLE, uiText } from '@/systems/constants';

export interface URect { x: number; y: number; w: number; h: number }

/**
 * A rounded-rectangle outline as one polyline, resampled to even spacing:
 * Catmull-Rom smoothing (boil.ts) overshoots badly where tiny corner steps
 * meet long straight edges.
 */
function roundedPath(r: URect, rad: number, step = 14): Pt[] {
  const raw: Pt[] = [];
  const c = [
    { cx: r.x + r.w - rad, cy: r.y + rad, a0: -Math.PI / 2 },
    { cx: r.x + r.w - rad, cy: r.y + r.h - rad, a0: 0 },
    { cx: r.x + rad, cy: r.y + r.h - rad, a0: Math.PI / 2 },
    { cx: r.x + rad, cy: r.y + rad, a0: Math.PI },
  ];
  for (const k of c) for (let i = 0; i <= 6; i++) {
    const a = k.a0 + (i / 6) * (Math.PI / 2);
    raw.push({ x: k.cx + Math.cos(a) * rad, y: k.cy + Math.sin(a) * rad });
  }
  raw.push({ ...raw[0] });
  const out: Pt[] = [raw[0]];
  let carry = 0;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1], b = raw[i], len = Math.hypot(b.x - a.x, b.y - a.y);
    let d = step - carry;
    while (d <= len) { const t = d / len; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); d += step; }
    carry = len - (d - step);
  }
  out.push({ x: raw[0].x - 3, y: raw[0].y });     // close with a little overlap
  return out;
}

/** A blurred rounded rect, used as a soft drop shadow. */
function shadowTexture(scene: Phaser.Scene, w: number, h: number): string {
  const key = `story-shadow-${Math.round(w)}x${Math.round(h)}`;
  if (scene.textures.exists(key)) return key;
  const k = 4, pad = 6;
  const c = document.createElement('canvas');
  c.width = Math.ceil(w / k) + pad * 2; c.height = Math.ceil(h / k) + pad * 2;
  const ctx = c.getContext('2d')!;
  ctx.filter = 'blur(2px)';
  ctx.fillStyle = 'rgba(40,40,40,1)';
  ctx.beginPath();
  ctx.roundRect(pad, pad, w / k, h / k, 4);
  ctx.fill();
  scene.textures.addCanvas(key, c);
  return key;
}

/** Paper body + shadow + boiling pencil outline. */
class PaperBox {
  readonly shape: SketchShape;
  private fill: Phaser.GameObjects.Graphics;
  private shadow: Phaser.GameObjects.Image;
  constructor(private scene: Phaser.Scene, boiler: Boiler, public rect: URect, depth: number, private rad: number) {
    this.shadow = scene.add.image(0, 0, '__DEFAULT').setOrigin(0, 0).setDepth(depth - 1).setAlpha(0.22);
    this.fill = scene.add.graphics().setDepth(depth);
    this.shape = boiler.add(new SketchShape(scene, pathShape(roundedPath(rect, rad)),
      { color: COLOR_STROKE_IDLE, width: 1.1, alpha: 1 }, { jitter: 1.2, fps: BOIL_FPS_UI, depth: depth + 1 }));
    this.layout(rect);
  }
  layout(r: URect): void {
    this.rect = r;
    this.fill.clear().fillStyle(COLOR_PAPER, 1).fillRoundedRect(r.x, r.y, r.w, r.h, this.rad);
    this.shape.setGeometry(pathShape(roundedPath(r, this.rad)));
    const key = shadowTexture(this.scene, r.w, r.h);
    this.shadow.setTexture(key).setPosition(r.x + 3 - 6 * 4, r.y + 6 - 6 * 4).setScale(4);
  }
  setActive(on: boolean): void {
    this.shape.setStyle(on ? { color: COLOR_INK, width: 1.6 } : { color: COLOR_STROKE_IDLE, width: 1.1 });
  }
  setVisible(v: boolean): void { this.fill.setVisible(v); this.shadow.setVisible(v); this.shape.setVisible(v); }
  destroy(): void { this.fill.destroy(); this.shadow.destroy(); this.shape.destroy(); }
}

export interface TextBoxOptions {
  /** The box to cover (units). */
  rect: URect;
  /** Font size as a fraction of frame scale (Figma px × frame scale). */
  fontUnits: number;
  align: 'center' | 'left';
  pad: number;
  /** Right padding if different (the choice panel's text runs close to the buttons). */
  padRight?: number;
  depth?: number;
}

/**
 * Narration text in a paper box. With `onContinue`, the box itself is the
 * "continue" control (click / Enter / Space), with a small hint.
 */
export class NarrationBox implements FocusableControl {
  readonly proxy: A11yProxy;
  private box: PaperBox;
  private text: Phaser.GameObjects.Text;
  private hint: Phaser.GameObjects.Text;
  private base: URect;
  private hovered = false;
  private focused = false;
  private continueOn = false;
  private unsubMode: () => void;
  private hintT = 0;

  constructor(private scene: Phaser.Scene, boiler: Boiler, private o: TextBoxOptions, private onContinue: () => void) {
    this.base = { ...o.rect };
    const d = o.depth ?? 80;
    this.box = new PaperBox(scene, boiler, o.rect, d, 10);
    this.text = scene.add.text(0, 0, '', {}).setDepth(d + 2);
    this.hint = scene.add.text(0, 0, `${uiText(config.story.continue)} ›`, {}).setOrigin(1, 1).setDepth(d + 2).setAlpha(0.55);
    this.proxy = new A11yProxy(scene, {
      label: config.story.continueAria, ...o.rect,
      onActivate: () => { if (this.continueOn) this.onContinue(); },
      onHover: (over) => { this.hovered = over; this.paint(); },
    });
    this.unsubMode = onNavModeChange(() => this.paint());
    this.restyle();
  }

  /** Show `s`; `canContinue` shows the hint and makes the box clickable. */
  setText(s: string, canContinue: boolean): void {
    this.text.setText(s);
    this.continueOn = canContinue;
    this.hint.setVisible(canContinue);
    this.proxy.el.style.display = canContinue ? '' : 'none';
    this.layout();
    if (!settings.get('reducedMotion')) {
      this.text.setAlpha(0);
      this.scene.tweens.add({ targets: this.text, alpha: 1, duration: 260, ease: 'Sine.easeOut' });
    }
  }

  setVisible(v: boolean): void {
    this.box.setVisible(v); this.text.setVisible(v); this.hint.setVisible(v && this.continueOn);
    this.proxy.el.style.display = v && this.continueOn ? '' : 'none';
  }

  get rect(): URect { return this.box.rect; }

  /** Move/resize the box (e.g. to make room for choice cards) and reflow the text. */
  setFrame(rect: URect, padRight?: number): void {
    this.base = { ...rect };
    this.o.padRight = padRight;
    this.layout();
  }

  private layout(): void {
    const { pad, align } = this.o;
    const padR = this.o.padRight ?? pad;
    const b = this.base;
    this.text.setWordWrapWidth(b.w - pad - padR, true);
    // Grow upward if the text no longer fits (large text sizes).
    const need = this.text.height + pad * 2 + (this.continueOn ? this.hint.height * 0.6 : 0);
    const r = need > b.h ? { x: b.x, y: b.y + b.h - need, w: b.w, h: need } : { ...b };
    this.box.layout(r);
    this.proxy.setRect(r.x, r.y, r.w, r.h);
    this.text.setOrigin(align === 'center' ? 0.5 : 0, 0.5)
      .setPosition(align === 'center' ? r.x + r.w / 2 : r.x + pad, r.y + r.h / 2 - (this.continueOn && need > b.h ? this.hint.height * 0.3 : 0));
    this.hint.setPosition(r.x + r.w - pad * 0.6, r.y + r.h - pad * 0.25);
  }

  restyle(): void {
    const fam = settings.serifFamily(), ink = settings.inkCss();
    const size = settings.fontSizePx(this.o.fontUnits / 16);
    this.text.setStyle({ fontFamily: fam, fontSize: `${size}px`, color: ink, align: this.o.align, lineSpacing: size * 0.32 });
    this.hint.setStyle({ fontFamily: fam, fontStyle: 'italic', fontSize: `${Math.round(size * 0.72)}px`, color: ink });
    this.layout();
    this.paint();
  }

  private paint(): void {
    this.box.setActive(this.continueOn && (this.hovered || (this.focused && keyboardNav())));
  }

  setFocused(v: boolean): void { this.focused = v; this.paint(); }
  activate(): void { if (this.continueOn) this.onContinue(); }

  /** Stepped pulse of the hint (none under reduced motion). */
  update(delta: number): void {
    if (settings.get('reducedMotion') || !this.continueOn) { this.hint.setAlpha(0.6); return; }
    this.hintT += delta;
    this.hint.setAlpha(Math.floor(this.hintT / 500) % 2 ? 0.75 : 0.45);
  }

  destroy(): void {
    this.unsubMode();
    this.box.destroy(); this.text.destroy(); this.hint.destroy(); this.proxy.destroy();
  }
}

/**
 * The choice panel: a wide narration box with the choices stacked on its
 * right as paper cards resting ON it — each card's left edge overlaps the
 * box's right edge by ~13% of the card width, with a soft drop shadow and a
 * tiny random tilt (user, 2026-10-04). The narration text reflows so the
 * cards never cover it. Cards use the shared filled look (black fill, paper
 * text on hover / focus / press).
 */
export class ChoicePanel {
  readonly narration: NarrationBox;
  readonly buttons: SketchButton[] = [];
  private cover: Phaser.GameObjects.Rectangle;

  constructor(private scene: Phaser.Scene, private boiler: Boiler,
    private panel: URect, private buttonRects: URect[], coverRect: URect,
    fontUnits: number, private buttonFontUnits: number, onContinue: () => void, paper = COLOR_PAPER) {
    // Below the cards (depth 58.5+), above the frame.
    this.narration = new NarrationBox(scene, boiler, { rect: panel, fontUnits, align: 'left', pad: panel.h * 0.3, padRight: panel.h * 0.12, depth: 52 }, onContinue);
    // Hides the frame's baked buttons.
    this.cover = scene.add.rectangle(coverRect.x, coverRect.y, coverRect.w, coverRect.h, paper, 1)
      .setOrigin(0, 0).setDepth(50);
  }

  /** Show choices (labels + callbacks), or none for a narration beat. */
  setChoices(choices: Array<{ label: string; aria: string; onPick: () => void }>): SketchButton[] {
    this.buttons.forEach((b) => b.destroy());
    this.buttons.length = 0;
    const pad = this.panel.h * 0.3;
    if (!choices.length) { this.narration.setFrame(this.panel, this.panel.h * 0.12); return []; }
    // Widen (to the left) if a label at the current text size doesn't fit.
    const probe = this.scene.add.text(0, 0, '', { fontFamily: settings.serifFamily(), fontSize: `${settings.fontSizePx(this.buttonFontUnits / 16)}px` }).setVisible(false);
    let need = 0;
    for (const c of choices) { probe.setText(uiText(c.label)); need = Math.max(need, probe.width + 36); }
    probe.destroy();
    const r0 = this.buttonRects[0];
    const right = r0.x + r0.w;
    const w = Math.max(r0.w, need), x = right - w;
    const overlap = w * 0.13;
    // The box ends under the cards; its text stops short of them.
    const boxRight = x + overlap;
    this.narration.setFrame({ ...this.panel, w: boxRight - this.panel.x }, overlap + pad * 0.5);
    const deg = Math.PI / 180;
    this.buttonRects.slice(0, choices.length).forEach((r, i) => {
      const c = choices[i];
      const tilt = (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random()) * deg;
      this.buttons.push(new SketchButton(this.scene, {
        x, y: r.y, w, h: r.h, label: c.label, ariaLabel: c.aria, serif: true, rotation: tilt, dropShadow: true,
        fontScale: this.buttonFontUnits / 16, boiler: this.boiler, onActivate: c.onPick,
      }));
    });
    return this.buttons;
  }

  restyle(): void { this.narration.restyle(); this.buttons.forEach((b) => b.restyle()); }
  update(delta: number): void { this.narration.update(delta); }

  destroy(): void {
    this.narration.destroy();
    this.buttons.forEach((b) => b.destroy());
    this.cover.destroy();
  }
}

/** The small "7:52 am" chip (Figma), brush font in a pencil pill. */
export function timeChip(scene: Phaser.Scene, boiler: Boiler, text: string, x: number, y: number, depth = 85): Phaser.GameObjects.GameObject[] {
  const t = scene.add.text(0, 0, uiText(text), { fontFamily: settings.fontFamily(), fontSize: `${settings.fontSizePx(1.6)}px`, color: settings.inkCss() })
    .setOrigin(0.5).setDepth(depth + 1);
  const w = t.width + 34, h = t.height + 10;
  t.setPosition(x + w / 2, y + h / 2);
  const fill = scene.add.graphics().setDepth(depth).fillStyle(COLOR_PAPER, 1).fillRoundedRect(x, y, w, h, h / 2);
  const pill = boiler.add(new SketchShape(scene, pathShape(roundedPath({ x, y, w, h }, h / 2)),
    { color: COLOR_INK, width: 1.4, alpha: 1 }, { jitter: 1, fps: BOIL_FPS_UI, depth: depth + 1 }));
  void viewport;
  return [t, fill, pill.object];
}
