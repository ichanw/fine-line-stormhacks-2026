/**
 * Shared UI widgets.
 *
 * All UI outlines are single-stroke boiled shapes (see systems/boil.ts) — no
 * double borders, no multi-pass outlines, and boxes are never filled.
 *
 * Button states:
 *   idle    thin grey stroke, slow boil
 *   hover   identical to keyboard focus: darkens to ink, ~1.5x thicker, and
 *           moves. Two flavours, switchable live in the F1 debug panel:
 *             A  the boil speeds up, like the line being re-sketched
 *             B  a darker pencil stroke continuously traces the outline
 *   press   quick squash, and the outline briefly snaps to a clean solid line
 */

import Phaser from 'phaser';
import { A11yProxy } from '@/systems/a11y';
import { Boiler, SketchShape, boxShape } from '@/systems/boil';
import { debugPanel } from '@/systems/debug';
import { settings } from '@/systems/SettingsManager';
import {
  BOIL_FPS_HOVER, BOIL_FPS_IDLE, COLOR_INK, COLOR_INK_CSS, COLOR_INK_HC_CSS,
  COLOR_STROKE_IDLE,
} from '@/systems/constants';

export interface FocusableControl {
  proxy: A11yProxy;
  setFocused(v: boolean): void;
  activate(): void;
  restyle(): void;
  destroy(): void;
}

export interface SketchButtonOptions {
  x: number; y: number; w: number; h: number;
  label: string;
  ariaLabel?: string;
  onActivate: () => void;
  onFocus?: () => void;
  fontScale?: number;
  boiler: Boiler;
}

const IDLE_WIDTH = 1;
const HOVER_WIDTH = 1.5;

export class SketchButton implements FocusableControl {
  readonly proxy: A11yProxy;
  private box: SketchShape;
  private text: Phaser.GameObjects.Text;
  private active = false;   // hover OR keyboard focus — deliberately one state
  private pressed = false;
  private opts: SketchButtonOptions;
  private scene: Phaser.Scene;
  private unsubDebug?: () => void;
  private pressTimer?: Phaser.Time.TimerEvent;
  /**
   * Removing the proxy from the DOM fires a final `blur`. Without this guard
   * that lands on an already-destroyed Text and throws from deep inside
   * Phaser's text renderer.
   */
  private destroyed = false;
  private onBlur = () => this.setFocused(false);

  constructor(scene: Phaser.Scene, opts: SketchButtonOptions) {
    this.scene = scene;
    this.opts = opts;
    const { x, y, w, h, label } = opts;

    this.box = opts.boiler.add(
      new SketchShape(scene, boxShape(x, y, w, h), {
        color: COLOR_STROKE_IDLE, width: IDLE_WIDTH, alpha: 1,
      }, { jitter: 1.5, fps: BOIL_FPS_IDLE, depth: 10 }),
    );

    this.text = scene.add.text(x + w / 2, y + h / 2, label, {}).setOrigin(0.5).setDepth(11);

    const zone = scene.add.zone(x, y, w, h).setOrigin(0, 0).setInteractive({ useHandCursor: true });
    zone.on('pointerover', () => this.setFocused(true));
    zone.on('pointerout', () => { if (!this.proxy.focused) this.setFocused(false); });
    zone.on('pointerdown', () => this.press());
    zone.on('pointerup', () => this.activate());

    this.proxy = new A11yProxy(scene, {
      label: opts.ariaLabel ?? label,
      x, y, w, h,
      onActivate: () => { this.press(); this.opts.onActivate(); },
      onFocus: () => opts.onFocus?.(),
    });
    this.proxy.el.addEventListener('blur', this.onBlur);

    this.unsubDebug = debugPanel.subscribe(() => this.applyState());
    this.restyle();
  }

  setLabel(label: string): void { this.text.setText(label); }

  setFocused(v: boolean): void {
    if (this.destroyed || this.active === v) return;
    this.active = v;
    this.applyState();
  }

  activate(): void { this.opts.onActivate(); }

  /** Quick squash + the outline briefly snapping solid. */
  press(): void {
    if (this.destroyed) return;
    if (settings.get('reducedMotion')) { this.flashSolid(); return; }
    this.pressed = true;
    this.applyGeometry();
    this.box.setSolid(true);
    this.text.setScale(1, 0.94);
    this.pressTimer?.remove();
    this.pressTimer = this.scene.time.delayedCall(110, () => {
      this.pressed = false;
      this.box.setSolid(false);
      this.text.setScale(1, 1);
      this.applyGeometry();
    });
  }

  private flashSolid(): void {
    this.box.setSolid(true);
    this.pressTimer?.remove();
    this.pressTimer = this.scene.time.delayedCall(110, () => this.box.setSolid(false));
  }

  /** Squash shrinks the box slightly about its centre. */
  private applyGeometry(): void {
    const { x, y, w, h } = this.opts;
    if (this.pressed) {
      const sx = 1.012, sy = 0.93;
      const nw = w * sx, nh = h * sy;
      this.box.setGeometry(boxShape(x + (w - nw) / 2, y + (h - nh) / 2, nw, nh));
    } else {
      this.box.setGeometry(boxShape(x, y, w, h));
    }
  }

  private applyState(): void {
    if (this.destroyed) return;
    const hc = settings.get('highContrast');
    const variant = debugPanel.get().hoverVariant;
    const reduced = settings.get('reducedMotion');

    if (this.active) {
      this.box.setStyle({
        color: hc ? 0x000000 : COLOR_INK,
        width: HOVER_WIDTH * (hc ? 1.3 : 1),
      });
      // "and moves" — a small persistent nudge so the outline shifts on hover.
      this.box.setOffset(reduced ? 0 : -1.5, reduced ? 0 : -1.5);
      // Variant A speeds the boil up; variant B adds a tracing stroke instead.
      this.box.setFps(!reduced && variant === 'A' ? BOIL_FPS_HOVER : BOIL_FPS_IDLE);
      this.box.setTracer(!reduced && variant === 'B');
    } else {
      this.box.setStyle({ color: hc ? 0x000000 : COLOR_STROKE_IDLE, width: IDLE_WIDTH });
      this.box.setOffset(0, 0);
      this.box.setFps(BOIL_FPS_IDLE);
      this.box.setTracer(false);
    }
    this.box.setFrozen(reduced);
    this.text.setColor(hc ? COLOR_INK_HC_CSS : COLOR_INK_CSS);
    this.text.setAlpha(this.active ? 1 : 0.85);
  }

  restyle(): void {
    if (this.destroyed) return;
    this.text.setStyle({
      fontFamily: settings.fontFamily(),
      fontSize: `${settings.fontSizePx(this.opts.fontScale ?? 1.5)}px`,
      color: settings.inkCss(),
    });
    this.text.setLetterSpacing(settings.letterSpacing());
    this.applyState();
  }

  /** Fade the whole control in (home screen staggers these). */
  fadeIn(delayMs: number): void {
    if (settings.get('reducedMotion')) return;
    this.text.setAlpha(0);
    this.box.setAlpha(0);
    this.scene.tweens.add({ targets: this.text, alpha: 0.85, duration: 420, delay: delayMs, ease: 'Sine.easeOut' });
    this.scene.tweens.add({ targets: this.box.graphics, alpha: 1, duration: 420, delay: delayMs, ease: 'Sine.easeOut' });
  }

  destroy(): void {
    this.destroyed = true;
    this.proxy.el.removeEventListener('blur', this.onBlur);
    this.pressTimer?.remove();
    this.unsubDebug?.();
    this.opts.boiler.remove(this.box);
    this.box.destroy();
    this.text.destroy();
    this.proxy.destroy();
  }
}

/**
 * Keyboard focus across a list of controls. Tab is left to the browser (the DOM
 * proxies are real buttons); arrows move the selection.
 */
export class FocusList {
  private index = 0;
  private items: FocusableControl[] = [];

  setItems(items: FocusableControl[]): void {
    this.items = items;
    items.forEach((item, i) => {
      item.proxy.el.addEventListener('focus', () => {
        this.index = i;
        this.render();
      });
    });
    this.render();
  }

  get current(): FocusableControl | undefined { return this.items[this.index]; }

  focus(i: number): void {
    if (!this.items.length) return;
    this.index = Phaser.Math.Wrap(i, 0, this.items.length);
    this.items[this.index].proxy.focus();
    this.render();
  }

  move(delta: number): void { this.focus(this.index + delta); }

  render(): void {
    this.items.forEach((item, i) => item.setFocused(i === this.index));
  }

  restyle(): void {
    this.items.forEach((i) => i.restyle());
    this.render();
  }

  repositionProxies(): void { this.items.forEach((i) => i.proxy.reposition()); }

  destroy(): void {
    this.items.forEach((i) => i.destroy());
    this.items = [];
  }
}
