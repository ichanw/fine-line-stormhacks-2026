/**
 * F1 debug panel.
 *
 * A small DOM overlay for tuning art direction at runtime without a rebuild.
 * Choices persist to localStorage so they survive a reload while you decide.
 * Nothing here is player-facing.
 *
 * The panel's DOM is built once and updated in place — re-rendering on every
 * change would cancel a slider drag mid-move.
 */

import titleData from '@/data/title.json';
import transitionData from '@/data/transitions.json';

const KEY = 'fine-line/debug/v1';

/** Title-background tuning (see systems/titleBackground.ts). */
export interface TitleTuning {
  leafCount: number;
  leafSpeed: number;
  /** -1 blows left (toward the ruins), +1 blows right. */
  windDir: number;
  windStrength: number;
  /** Flock spawn-rate multiplier; 1 = a flock every 6–12 s, 0 = none. */
  birdFreq: number;
  hazeOpacity: number;
  crackDensity: number;
  /** Centre of the left→right fade, as a fraction of screen width. */
  transitionPos: number;
  /** Strength of the "ink darkness" pass, 0 … 1. */
  inkAmount: number;
}

export interface DebugFlags {
  /**
   * Subtle shimmer on the character PNGs. Defaults ON: measured edge sharpness
   * was unchanged (static 42.3 vs shimmer 42.3 at 2x). The heads are drawn
   * downscaled from ~2.6x source art, so they are resampled either way and the
   * sub-pixel offset costs no detail. Re-measure if the art or scale changes.
   */
  characterShimmer: boolean;
  showStats: boolean;
  /**
   * Generated hatching over the user's tree and rocks (systems/artShading.ts).
   * ON by default since 2026-10-04 (user: "turn ON the shading overlay").
   */
  artShading: boolean;
  /** A second multiply pass over the user's art, at `title.inkAmount`. */
  inkDarkness: boolean;
  title: TitleTuning;
  /** Unsaved seed override from "reroll"; null = use src/data/title.json. */
  titleSeed: number | null;
  /** Screen transition style (see systems/transitions.ts). */
  transition: TransitionStyle;
  /** Bumped when a default changes in a way old saves must not override. */
  flagsVersion: number;
}

export type TransitionStyle = 'A' | 'B' | 'C' | 'D';

export const TITLE_DEFAULTS: TitleTuning = {
  leafCount: 11,
  leafSpeed: 1,
  windDir: -1,
  windStrength: 1,
  birdFreq: 1,
  hazeOpacity: 0.5,
  crackDensity: 1,
  transitionPos: 0.5,
  inkAmount: 0.6,
};

const DEFAULTS: DebugFlags = {
  characterShimmer: true,
  showStats: false,
  artShading: true,
  inkDarkness: false,
  title: { ...TITLE_DEFAULTS },
  titleSeed: null,
  transition: transitionData.defaultStyle as TransitionStyle,
  flagsVersion: 3,
};

/** Sliders shown for the title background: [key, label, min, max, step]. */
const TITLE_SLIDERS: Array<[keyof TitleTuning, string, number, number, number]> = [
  ['leafCount', 'leaf count', 0, 20, 1],
  ['leafSpeed', 'leaf speed', 0.3, 2.5, 0.1],
  ['windDir', 'wind direction (← −1 … +1 →)', -1, 1, 0.1],
  ['windStrength', 'wind strength', 0, 2, 0.1],
  ['birdFreq', 'bird frequency', 0, 3, 0.1],
  ['hazeOpacity', 'haze opacity', 0, 1, 0.05],
  ['crackDensity', 'crack density', 0.3, 2, 0.1],
  ['transitionPos', 'transition position', 0.3, 0.7, 0.01],
  ['inkAmount', 'ink darkness amount', 0, 1, 0.05],
];

type BoolFlag = 'characterShimmer' | 'showStats' | 'artShading' | 'inkDarkness';

type Listener = (f: DebugFlags, changed: string) => void;

class DebugPanel {
  private flags: DebugFlags = structuredClone(DEFAULTS);
  private listeners = new Set<Listener>();
  private el?: HTMLDivElement;
  private open = false;

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<DebugFlags>;
        this.flags = { ...structuredClone(DEFAULTS), ...saved, title: { ...TITLE_DEFAULTS, ...(saved.title ?? {}) } };
        // v2: art shading's default flipped to ON. Older saves recorded the old
        // default (every change persists the whole object), not a choice.
        if ((saved.flagsVersion ?? 1) < 2) this.flags.artShading = true;
        // v3: the default transition became D (stop-motion scrapbook).
        if ((saved.flagsVersion ?? 1) < 3) this.flags.transition = DEFAULTS.transition;
        this.flags.flagsVersion = DEFAULTS.flagsVersion;
      }
    } catch { /* defaults are fine */ }
  }

  install(): void {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F1') { e.preventDefault(); this.toggle(); }
    });
  }

  get(): Readonly<DebugFlags> { return this.flags; }

  /** Story controls (scene jump, avatar, score, outcome) are wired by main.ts. */
  storyHooks?: { bind(el: HTMLElement): void; sync(el: HTMLElement): void };

  /** The seed the title background should use right now. */
  titleSeed(): number { return this.flags.titleSeed ?? titleData.seed; }

  set<K extends keyof DebugFlags>(key: K, value: DebugFlags[K]): void {
    this.flags[key] = value;
    this.persist();
    this.listeners.forEach((fn) => fn(this.flags, key));
    this.sync();
  }

  setTitle<K extends keyof TitleTuning>(key: K, value: TitleTuning[K]): void {
    this.flags.title = { ...this.flags.title, [key]: value };
    this.persist();
    this.listeners.forEach((fn) => fn(this.flags, `title.${key}`));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  toggle(): void {
    this.open = !this.open;
    this.build();
    if (this.el) this.el.style.display = this.open ? '' : 'none';
    this.sync();
  }

  private persist(): void {
    try { localStorage.setItem(KEY, JSON.stringify(this.flags)); } catch { /* non-fatal */ }
  }

  /** Build the DOM once. */
  private build(): void {
    if (this.el) return;
    const el = document.createElement('div');
    el.id = 'debug-panel';
    el.style.cssText = [
      'position:fixed', 'right:12px', 'top:12px', 'z-index:9999', 'display:none',
      'background:rgba(255,255,255,0.97)', 'border:1px solid #1A1A1A',
      'font:12px ui-monospace,Menlo,monospace', 'color:#1A1A1A',
      'padding:10px 12px', 'width:290px', 'line-height:1.6', 'max-height:92vh', 'overflow:auto',
    ].join(';');
    const sliders = TITLE_SLIDERS.map(([k, label, min, max, step]) => `
      <label style="display:block;margin-top:4px">${label} <span data-out="${k}"></span>
        <input type="range" data-title="${k}" min="${min}" max="${max}" step="${step}" style="width:100%">
      </label>`).join('');
    el.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px">DEBUG — F1 to close</div>
      <div>Screen transition</div>
      <label style="display:block;cursor:pointer"><input type="radio" name="tr" value="A"/> A — crumple + scrapbook</label>
      <label style="display:block;cursor:pointer"><input type="radio" name="tr" value="B"/> B — paper turn</label>
      <label style="display:block;cursor:pointer"><input type="radio" name="tr" value="C"/> C — smudge dissolve</label>
      <label style="display:block;cursor:pointer;margin-bottom:6px"><input type="radio" name="tr" value="D"/> D — stop-motion scrapbook</label>
      <label style="display:block;cursor:pointer"><input type="checkbox" data-flag="characterShimmer"/> Character shimmer</label>
      <label style="display:block;cursor:pointer"><input type="checkbox" data-flag="showStats"/> Show stats</label>
      <div style="font-weight:700;margin:10px 0 2px">Story</div>
      <label style="display:block">scene <select data-story="scene" style="width:100%"></select></label>
      <label style="display:block">avatar <select data-story="avatar"><option>masc</option><option>fem</option><option>andro</option></select></label>
      <label style="display:block">commute <select data-story="commute"></select></label>
      <label style="display:block">lunch <select data-story="lunch"></select></label>
      <label style="display:block">score <input data-story="score" type="number" step="1" style="width:60px"></label>
      <label style="display:block">outcome <select data-story="outcome"><option value="">from score</option><option>good</option><option>neutral</option><option>bad</option></select></label>
      <div style="display:flex;gap:6px;margin-top:4px"><button type="button" data-act="story-go">go to scene</button></div>
      <div style="font-weight:700;margin:10px 0 2px">Title background</div>
      <label style="display:block;cursor:pointer"><input type="checkbox" data-flag="artShading"/> Art shading (tree, rocks)</label>
      <label style="display:block;cursor:pointer"><input type="checkbox" data-flag="inkDarkness"/> Ink darkness (my art)</label>
      ${sliders}
      <div style="margin-top:8px">seed <b data-seed></b> <span data-seed-state style="color:#888"></span></div>
      <div style="display:flex;gap:6px;margin-top:4px">
        <button type="button" data-act="reroll">reroll seed</button>
        <button type="button" data-act="keep">keep this seed</button>
        <button type="button" data-act="reset">reset sliders</button>
      </div>
      <div data-msg style="color:#888;margin-top:4px"></div>
    `;
    document.body.appendChild(el);
    this.el = el;

    el.querySelectorAll<HTMLInputElement>('input[name=tr]').forEach((r) =>
      r.addEventListener('change', () => this.set('transition', r.value as TransitionStyle)));
    el.querySelectorAll<HTMLInputElement>('input[data-flag]').forEach((c) =>
      c.addEventListener('change', () => this.set(c.dataset.flag as BoolFlag, c.checked)));
    el.querySelectorAll<HTMLInputElement>('input[data-title]').forEach((s) =>
      s.addEventListener('input', () => {
        const k = s.dataset.title as keyof TitleTuning;
        this.setTitle(k, Number(s.value));
        const out = el.querySelector(`[data-out="${k}"]`);
        if (out) out.textContent = String(Number(s.value));
      }));
    el.querySelector('[data-act=reroll]')?.addEventListener('click', () => {
      this.set('titleSeed', Math.floor(Math.random() * 2 ** 31));
    });
    this.storyHooks?.bind(el);
    el.querySelector('[data-act=keep]')?.addEventListener('click', () => void this.keepSeed());
    el.querySelector('[data-act=reset]')?.addEventListener('click', () => {
      this.flags.title = { ...TITLE_DEFAULTS };
      this.persist();
      this.listeners.forEach((fn) => fn(this.flags, 'title.*'));
      this.sync();
    });
  }

  /**
   * Write the current seed to src/data/title.json via the dev server (see the
   * dev-seed plugin in vite.config.ts). Dev only; the file change reloads the page.
   */
  private async keepSeed(): Promise<void> {
    const msg = this.el?.querySelector('[data-msg]');
    if (!import.meta.env.DEV) { if (msg) msg.textContent = 'only available on the dev server'; return; }
    const seed = this.titleSeed();
    try {
      const res = await fetch('/__dev/title-seed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed }),
      });
      if (!res.ok) throw new Error(String(res.status));
      this.flags.titleSeed = null; // the file now holds it
      this.persist();
      if (msg) msg.textContent = `saved ${seed} to src/data/title.json`;
    } catch (e) {
      if (msg) msg.textContent = `save failed: ${String(e)}`;
    }
  }

  /** Reflect current values in the inputs. */
  private sync(): void {
    const el = this.el;
    if (!el) return;
    const f = this.flags;
    el.querySelectorAll<HTMLInputElement>('input[name=tr]').forEach((r) => { r.checked = r.value === f.transition; });
    el.querySelectorAll<HTMLInputElement>('input[data-flag]').forEach((c) => {
      c.checked = Boolean(f[c.dataset.flag as BoolFlag]);
    });
    el.querySelectorAll<HTMLInputElement>('input[data-title]').forEach((s) => {
      const k = s.dataset.title as keyof TitleTuning;
      s.value = String(f.title[k]);
      const out = el.querySelector(`[data-out="${k}"]`);
      if (out) out.textContent = String(f.title[k]);
    });
    this.storyHooks?.sync(el);
    const seedEl = el.querySelector('[data-seed]');
    if (seedEl) seedEl.textContent = String(this.titleSeed());
    const st = el.querySelector('[data-seed-state]');
    if (st) st.textContent = f.titleSeed === null ? '(from title.json)' : '(unsaved)';
  }
}

export const debugPanel = new DebugPanel();
