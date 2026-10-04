/**
 * F1 debug panel.
 *
 * A small DOM overlay for comparing art-direction options at runtime without a
 * rebuild. Choices persist to localStorage so they survive a reload while you
 * are deciding. Nothing here is player-facing.
 */

const KEY = 'fine-line/debug/v1';

export type HoverVariant = 'A' | 'B';

export interface DebugFlags {
  /** A = boil speeds up on hover. B = a darker stroke traces the outline. */
  hoverVariant: HoverVariant;
  /**
   * Subtle shimmer on the character PNGs. Defaults OFF: the art is line work on
   * a large canvas, and sub-pixel displacement resamples it into a blur.
   */
  characterShimmer: boolean;
  /** Draw the boil variant index / fps readout. */
  showStats: boolean;
}

const DEFAULTS: DebugFlags = {
  hoverVariant: 'A',
  characterShimmer: false,
  showStats: false,
};

type Listener = (f: DebugFlags) => void;

class DebugPanel {
  private flags: DebugFlags = { ...DEFAULTS };
  private listeners = new Set<Listener>();
  private el?: HTMLDivElement;
  private open = false;

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.flags = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch { /* defaults are fine */ }
  }

  /** Call once, after the DOM exists. */
  install(): void {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F1') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  get(): Readonly<DebugFlags> { return this.flags; }

  set<K extends keyof DebugFlags>(key: K, value: DebugFlags[K]): void {
    this.flags[key] = value;
    try { localStorage.setItem(KEY, JSON.stringify(this.flags)); } catch { /* non-fatal */ }
    this.listeners.forEach((fn) => fn(this.flags));
    this.render();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  toggle(): void {
    this.open = !this.open;
    this.render();
  }

  private render(): void {
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.id = 'debug-panel';
      this.el.style.cssText = [
        'position:fixed', 'right:12px', 'top:12px', 'z-index:9999',
        'background:rgba(255,255,255,0.96)', 'border:1px solid #1A1A1A',
        'font:12px ui-monospace,Menlo,monospace', 'color:#1A1A1A',
        'padding:10px 12px', 'min-width:230px', 'line-height:1.7',
      ].join(';');
      document.body.appendChild(this.el);
    }
    if (!this.open) { this.el.style.display = 'none'; return; }
    this.el.style.display = '';

    const f = this.flags;
    this.el.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px">DEBUG — F1 to close</div>
      <div style="margin-bottom:6px">Hover style</div>
      <label style="display:block;cursor:pointer">
        <input type="radio" name="hv" value="A" ${f.hoverVariant === 'A' ? 'checked' : ''}/>
        A — boil speeds up (re-sketched)
      </label>
      <label style="display:block;cursor:pointer;margin-bottom:8px">
        <input type="radio" name="hv" value="B" ${f.hoverVariant === 'B' ? 'checked' : ''}/>
        B — tracing pencil stroke
      </label>
      <label style="display:block;cursor:pointer">
        <input type="checkbox" id="dbg-shimmer" ${f.characterShimmer ? 'checked' : ''}/>
        Character shimmer (off by default)
      </label>
      <label style="display:block;cursor:pointer">
        <input type="checkbox" id="dbg-stats" ${f.showStats ? 'checked' : ''}/>
        Show stats
      </label>
    `;
    this.el.querySelectorAll<HTMLInputElement>('input[name=hv]').forEach((r) => {
      r.addEventListener('change', () => this.set('hoverVariant', r.value as HoverVariant));
    });
    this.el.querySelector<HTMLInputElement>('#dbg-shimmer')
      ?.addEventListener('change', (e) => this.set('characterShimmer', (e.target as HTMLInputElement).checked));
    this.el.querySelector<HTMLInputElement>('#dbg-stats')
      ?.addEventListener('change', (e) => this.set('showStats', (e.target as HTMLInputElement).checked));
  }
}

export const debugPanel = new DebugPanel();
