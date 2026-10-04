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

export interface ProxyOptions {
  label: string;
  /** Game-space rect the control occupies. */
  x: number; y: number; w: number; h: number;
  onActivate: () => void;
  onFocus?: () => void;
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

  constructor(private scene: Phaser.Scene, opts: ProxyOptions) {
    this.rect = { x: opts.x, y: opts.y, w: opts.w, h: opts.h };
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.setAttribute('aria-label', opts.label);
    if (opts.role) this.el.setAttribute('role', opts.role);
    // Transparent but still focusable and hit-testable.
    this.el.style.cssText =
      'position:absolute;background:transparent;border:0;padding:0;margin:0;' +
      'color:transparent;font-size:1px;cursor:pointer;pointer-events:auto;outline:none;';
    this.el.textContent = opts.label;
    this.el.addEventListener('click', (e) => { e.preventDefault(); opts.onActivate(); });
    this.el.addEventListener('focus', () => opts.onFocus?.());
    ensureLayer().appendChild(this.el);
    this.reposition();
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
    const sm = this.scene.scale;
    const b = sm.canvasBounds;
    const sx = b.width / sm.width;
    const sy = b.height / sm.height;
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
