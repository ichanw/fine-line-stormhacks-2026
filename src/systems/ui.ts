/**
 * Shared UI widgets.
 *
 * All UI outlines are single-stroke boiled shapes (see systems/boil.ts) — no
 * double borders, no multi-pass outlines.
 *
 * One filled look (user, 2026-10-04) for every button, arrow and option:
 *   idle     paper fill, grey pencil outline, slow 2 fps boil
 *   filled   on hover, keyboard focus, press, or as the chosen option: the
 *            background shades in solid near-black graphite (~150 ms, see
 *            shadeFill.ts; fades back out on hover-off), text turns
 *            paper-white, the outline darkens. The boil stays at 2 fps.
 *   pressed  the filled look plus a quick small squash
 *
 * Keyboard focus is only drawn while navigating by keyboard (`keyboardNav`,
 * like :focus-visible), so a mouse user never sees a "stuck" filled button.
 * Visible labels are lowercase (`uiText`); accessible names are not.
 */

import Phaser from 'phaser';
import { A11yProxy, keyboardNav, onNavModeChange } from '@/systems/a11y';
import { Boiler, SketchShape, boxShape } from '@/systems/boil';
import { ShadeFill } from '@/systems/shadeFill';
import { isLeaving } from '@/systems/transitions';
import { settings } from '@/systems/SettingsManager';
import {
  BOIL_FPS_UI, COLOR_INK, COLOR_INK_CSS, COLOR_INK_HC_CSS, COLOR_PAPER,
  COLOR_SELECTED_TEXT_CSS, COLOR_STROKE_IDLE, uiText,
} from '@/systems/constants';

export interface FocusableControl {
  proxy: A11yProxy;
  /** Has keyboard focus (drawn only while navigating by keyboard). */
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
  /** The main action on a screen: drawn with a heavier outline. */
  primary?: boolean;
  /** Starts in the selected (chosen) state. */
  selected?: boolean;
  /** Story choices use the narration serif (Figma story frames). */
  serif?: boolean;
  /** Tilt in radians, about the button's centre (story choice cards). */
  rotation?: number;
  /** A soft drop shadow under the button (cards resting on the narration box). */
  dropShadow?: boolean;
}

/** A blurred rounded rect for drop shadows, `w` x `h` units, made once per size. */
function shadowKey(scene: Phaser.Scene, w: number, h: number): string {
  const key = `btn-shadow-${Math.round(w)}x${Math.round(h)}`;
  if (scene.textures.exists(key)) return key;
  const k = 4, pad = 6;
  const c = document.createElement('canvas');
  c.width = Math.ceil(w / k) + pad * 2; c.height = Math.ceil(h / k) + pad * 2;
  const ctx = c.getContext('2d')!;
  ctx.filter = 'blur(2.5px)';
  ctx.fillStyle = 'rgba(30,30,30,1)';
  ctx.fillRect(pad, pad, w / k, h / k);
  scene.textures.addCanvas(key, c);
  return key;
}

/** How long a press keeps the button filled after it is released. */
const PRESS_HOLD_MS = 260;

const IDLE_WIDTH = 1;
const ACTIVE_WIDTH = 1.4;

export class SketchButton implements FocusableControl {
  readonly proxy: A11yProxy;
  private box: SketchShape;
  /** Opaque paper fill: buttons are solid, so leaves and scenery pass behind. */
  private fill: Phaser.GameObjects.Rectangle;
  private text: Phaser.GameObjects.Text;
  private shade: ShadeFill;
  private shadow?: Phaser.GameObjects.Image;
  /** Chosen option (persistent). */
  private selected = false;
  private hovered = false;
  private focused = false;
  /** A press keeps the fill for PRESS_HOLD_MS (and to the end if it navigates away). */
  private pressing = false;
  private holdTimer?: Phaser.Time.TimerEvent;
  private squashed = false;
  private opts: SketchButtonOptions;
  private scene: Phaser.Scene;
  private unsubMode: () => void;
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

    this.fill = scene.add.rectangle(x + 1.5, y + 1.5, w - 3, h - 3, COLOR_PAPER, 1).setOrigin(0, 0).setDepth(59);
    this.box = opts.boiler.add(
      new SketchShape(scene, boxShape(x, y, w, h), {
        color: COLOR_STROKE_IDLE, width: this.idleWidth(), alpha: 1,
      }, { jitter: 1.5, fps: BOIL_FPS_UI, depth: 60, label: opts.ariaLabel ?? label, interactive: true }),
    );
    // Depth 60+: UI always sits above backgrounds (title leaves fly behind it).
    // Between the paper fill and the outline, so the sketchy outline stays on top.
    this.shade = new ShadeFill(scene, { x, y, w, h }, { depth: 59.5, onFilledChange: () => this.applyState() });
    this.text = scene.add.text(x + w / 2, y + h / 2, uiText(label), {}).setOrigin(0.5).setDepth(61);
    this.selected = !!opts.selected;
    const cx = x + w / 2, cy = y + h / 2, rot = opts.rotation ?? 0;
    if (opts.dropShadow) {
      this.shadow = scene.add.image(cx + 3, cy + 6, shadowKey(scene, w, h)).setScale(4).setAlpha(0.28).setDepth(58.5).setRotation(rot);
    }
    if (rot) {
      // Tilt every layer about the centre (the a11y proxy stays axis-aligned).
      this.fill.setOrigin(0.5).setPosition(cx, cy).setRotation(rot);
      this.shade.img.setOrigin(0.5).setPosition(cx, cy).setRotation(rot);
      this.box.setPivot(cx, cy).setRotation(rot);
      this.text.setRotation(rot);
    }

    // Pointer input arrives on the proxy, which sits over the canvas.
    this.proxy = new A11yProxy(scene, {
      label: opts.ariaLabel ?? label,
      x, y, w, h,
      onActivate: () => { this.press(); this.opts.onActivate(); },
      onFocus: () => opts.onFocus?.(),
      onHover: (over) => { this.hovered = over; this.applyFill(); },
      onPress: () => this.press(),
    });
    this.proxy.el.addEventListener('blur', this.onBlur);

    this.unsubMode = onNavModeChange(() => this.applyFill());
    this.restyle();
    this.applyFill(true);
  }

  setLabel(label: string): void { this.text.setText(uiText(label)); }

  /** Mark as the chosen option (stays filled until cleared). */
  setSelected(on: boolean): void {
    if (this.destroyed) return;
    this.selected = on;
    this.applyFill();
  }

  /** Primary vs secondary is told apart only by outline weight (user choice). */
  private idleWidth(): number { return IDLE_WIDTH * (this.opts.primary ? 1.45 : 1); }

  setFocused(v: boolean): void {
    if (this.destroyed || this.focused === v) return;
    this.focused = v;
    this.applyFill();
  }

  activate(): void { this.opts.onActivate(); }

  /** Filled whenever hovered, keyboard-focused, pressed or chosen. */
  private get active(): boolean {
    return this.hovered || (this.focused && keyboardNav()) || this.pressing || this.selected;
  }

  private applyFill(instant = false): void {
    if (this.destroyed) return;
    this.shade.set(this.active, instant);
    this.applyState();
  }

  /** The filled look plus a quick squash; the outline briefly snaps solid. */
  press(): void {
    if (this.destroyed) return;
    this.pressing = true;
    this.holdTimer?.remove();
    this.holdTimer = this.scene.time.delayedCall(PRESS_HOLD_MS, () => {
      // A button that navigated away stays filled to the end of the transition.
      if (!isLeaving(this.scene)) { this.pressing = false; this.applyFill(); }
    });
    this.applyFill();
    this.box.setSolid(true);
    if (!settings.get('reducedMotion')) {
      this.squashed = true;
      this.applyGeometry();
      this.text.setScale(1, 0.94);
    }
    this.pressTimer?.remove();
    this.pressTimer = this.scene.time.delayedCall(110, () => {
      this.squashed = false;
      this.box.setSolid(false);
      this.text.setScale(1, 1);
      this.applyGeometry();
    });
  }

  /**
   * Squash shrinks the box slightly about its centre. Done by scaling the
   * pre-rendered stroke for ~110 ms rather than re-rendering the brush.
   */
  private applyGeometry(): void {
    if (this.squashed) this.box.setSquash(1.012, 0.93);
    else this.box.setSquash(1, 1);
  }

  private applyState(): void {
    if (this.destroyed) return;
    const hc = settings.get('highContrast');
    const reduced = settings.get('reducedMotion');
    const on = this.active;
    this.box.setStyle(on
      ? { color: hc ? 0x000000 : COLOR_INK, width: ACTIVE_WIDTH * (this.opts.primary ? 1.2 : 1) * (hc ? 1.3 : 1), alpha: hc ? 1 : 0.9 }
      : { color: hc ? 0x000000 : this.opts.primary ? COLOR_INK : COLOR_STROKE_IDLE, width: this.idleWidth(), alpha: this.opts.primary ? 0.85 : 1 });
    this.box.setFps(BOIL_FPS_UI);           // the slow boil, filled or not
    this.box.setFrozen(reduced);
    // Paper-white once the fill is dark enough to read on; ink otherwise.
    const dark = this.shade.filled;
    this.text.setColor(dark ? COLOR_SELECTED_TEXT_CSS : hc ? COLOR_INK_HC_CSS : COLOR_INK_CSS);
    this.text.setAlpha(on || dark ? 1 : 0.85);
  }

  restyle(): void {
    if (this.destroyed) return;
    this.text.setStyle({
      fontFamily: this.opts.serif ? settings.serifFamily() : settings.fontFamily(),
      fontSize: `${settings.fontSizePx(this.opts.fontScale ?? 1.5)}px`,
    });
    this.text.setLetterSpacing(settings.letterSpacing());
    this.applyState();
  }

  /** Hide the outline and label until a later fadeIn() (staged reveals). */
  hide(): void { this.text.setAlpha(0); this.box.setAlpha(0); }

  /** Fade the whole control in (home screen staggers these). */
  fadeIn(delayMs: number): void {
    if (settings.get('reducedMotion')) return;
    this.text.setAlpha(0);
    this.box.setAlpha(0);
    this.scene.tweens.add({ targets: this.text, alpha: 0.85, duration: 420, delay: delayMs, ease: 'Sine.easeOut' });
    this.scene.tweens.add({ targets: this.box.object, alpha: 1, duration: 420, delay: delayMs, ease: 'Sine.easeOut' });
    // The paper fill stays opaque throughout, so the button area is solid from the start.
  }

  destroy(): void {
    this.destroyed = true;
    this.proxy.el.removeEventListener('blur', this.onBlur);
    this.pressTimer?.remove();
    this.holdTimer?.remove();
    this.unsubMode();
    this.shade.destroy();
    this.shadow?.destroy();
    this.opts.boiler.remove(this.box);
    this.box.destroy();
    this.fill.destroy();
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

  /** Index of the focused control — scenes carry it across a resize rebuild. */
  get currentIndex(): number { return this.index; }

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
