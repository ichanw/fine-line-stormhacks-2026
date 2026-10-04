/**
 * Accessibility layer.
 *
 * A Phaser canvas is a single opaque element: screen readers can't see what's
 * drawn on it and the browser has no Tab order for it. So every focusable
 * control also gets a real, transparent <button> positioned over the canvas.
 * Phaser draws the pixels; the DOM provides focus, Tab order, Enter/Space
 * activation and accessible names.
 *
 * Game coordinates are the fixed 1280x720 design space; this maps them onto
 * wherever Phaser's FIT scaling actually put the canvas.
 */

import Phaser from 'phaser';
import { viewport } from '@/systems/viewport';

let layer: HTMLDivElement | null = null;

function ensureLayer(): HTMLDivElement {
  if (layer && document.body.contains(layer)) return layer;
  layer = document.createElement('div');
  layer.id = 'a11y-layer';
  layer.style.cssText = 'position:fixed;left:0;top:0;margin:0;padding:0;pointer-events:none;';
  document.body.appendChild(layer);
  return layer;
}

/** Announce a message to screen readers without moving focus. */
export function announce(message: string): void {
  const host = ensureLayer();
  let live = host.querySelector<HTMLDivElement>('[data-live]');
  if (!live) {
    live = document.createElement('div');
    live.setAttribute('data-live', '');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    live.style.cssText =
      'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
    host.appendChild(live);
  }
  live.textContent = '';
  window.setTimeout(() => { if (live) live.textContent = message; }, 30);
}

// --- input modality ------------------------------------------------------------

/**
 * Whether the player is currently navigating by keyboard. Keyboard focus is
 * only DRAWN while this is true (like CSS :focus-visible): every screen always
 * has a focused control, and a permanently filled button would read as stuck
 * hover to a mouse user. Any key turns it on; moving or pressing the pointer
 * turns it off, so hover takes over.
 */
let keyboardMode = false;
const modeListeners = new Set<() => void>();
let modeInstalled = false;

function setKeyboardMode(on: boolean): void {
  if (on === keyboardMode) return;
  keyboardMode = on;
  modeListeners.forEach((fn) => fn());
}

export function keyboardNav(): boolean { return keyboardMode; }

/** Call `fn` when keyboard navigation starts or stops. Returns an unsubscribe. */
export function onNavModeChange(fn: () => void): () => void {
  if (!modeInstalled) {
    modeInstalled = true;
    window.addEventListener('keydown', (e) => {
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) setKeyboardMode(true);
    }, true);
    window.addEventListener('pointermove', (e) => { if (e.movementX || e.movementY) setKeyboardMode(false); }, true);
    window.addEventListener('pointerdown', () => setKeyboardMode(false), true);
  }
  modeListeners.add(fn);
  return () => modeListeners.delete(fn);
}

export interface ProxyOptions {
  label: string;
  /** Game-space rect the control occupies. */
  x: number; y: number; w: number; h: number;
  /** `e` is the DOM click (absent when a canvas zone triggers it); a real
   *  mouse click has `e.detail > 0`, a keyboard Enter/Space has 0. */
  onActivate: (e?: MouseEvent) => void;
  onFocus?: () => void;
  /**
   * Pointer enters/leaves the control. The transparent proxy sits over the
   * canvas, so it — not a Phaser zone — is what the mouse is actually over.
   */
  onHover?: (over: boolean) => void;
  /** Pointer pressed on the control (before the click). */
  onPress?: () => void;
  /** aria-role override; defaults to a plain button. */
  role?: string;
}

/**
 * A transparent DOM button mirroring an on-canvas control.
 * Remember to destroy() it — scenes do this on SHUTDOWN.
 */
export class A11yProxy {
  readonly el: HTMLButtonElement;
  private rect: { x: number; y: number; w: number; h: number };
  private onActivate: (e?: MouseEvent) => void;
  private lastFire = -Infinity;

  constructor(private scene: Phaser.Scene, opts: ProxyOptions) {
    this.rect = { x: opts.x, y: opts.y, w: opts.w, h: opts.h };
    this.onActivate = opts.onActivate;
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.setAttribute('aria-label', opts.label);
    if (opts.role) this.el.setAttribute('role', opts.role);
    // Transparent but still focusable and hit-testable.
    this.el.style.cssText =
      'position:absolute;background:transparent;border:0;padding:0;margin:0;' +
      'color:transparent;font-size:1px;cursor:pointer;pointer-events:auto;outline:none;';
    this.el.textContent = opts.label;
    this.el.addEventListener('click', (e) => { e.preventDefault(); this.trigger(e); });
    this.el.addEventListener('focus', () => opts.onFocus?.());
    if (opts.onHover) {
      this.el.addEventListener('pointerenter', () => opts.onHover!(true));
      this.el.addEventListener('pointerleave', () => opts.onHover!(false));
    }
    if (opts.onPress) this.el.addEventListener('pointerdown', () => opts.onPress!());
    ensureLayer().appendChild(this.el);
    this.reposition();
  }

  /**
   * Activate once per physical click. A mouse click lands on this (transparent)
   * button AND on the canvas zone drawn under it — Phaser hit-tests mouseups on
   * the window too — so canvas zones must activate through here, never directly.
   */
  trigger(e?: MouseEvent): void {
    const t = performance.now();
    if (t - this.lastFire < 250) return;
    this.lastFire = t;
    this.onActivate(e);
  }

  setLabel(label: string): void {
    this.el.setAttribute('aria-label', label);
    this.el.textContent = label;
  }

  setRect(x: number, y: number, w: number, h: number): void {
    this.rect = { x, y, w, h };
    this.reposition();
  }

  focus(): void {
    this.el.focus({ preventScroll: true });
  }

  get focused(): boolean {
    return document.activeElement === this.el;
  }

  /** Map the game-space rect onto the live canvas position. */
  reposition(): void {
    // Rects are in design units; map them onto the canvas's on-screen box.
    // (The backing store is in device pixels, so don't divide by its size.)
    const b = this.scene.scale.canvasBounds;
    const sx = b.width / viewport.W;
    const sy = b.height / viewport.H;
    const { x, y, w, h } = this.rect;
    this.el.style.left = `${b.x + x * sx}px`;
    this.el.style.top = `${b.y + y * sy}px`;
    this.el.style.width = `${w * sx}px`;
    this.el.style.height = `${h * sy}px`;
  }

  destroy(): void {
    this.el.remove();
  }
}

/** Remove every proxy — used when a scene tears down. */
export function clearProxies(proxies: A11yProxy[]): void {
  proxies.forEach((p) => p.destroy());
  proxies.length = 0;
}

/**
 * Make Tab follow the on-screen order: re-append the proxies' DOM buttons in
 * the given order (Tab follows DOM order, not creation intent).
 */
export function setTabOrder(proxies: A11yProxy[]): void {
  const host = proxies[0]?.el.parentElement;
  if (!host) return;
  for (const p of proxies) host.appendChild(p.el);
}
