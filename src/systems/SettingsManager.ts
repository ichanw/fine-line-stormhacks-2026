/**
 * Global settings: persisted to localStorage, emits change events.
 *
 * Scenes should SUBSCRIBE and restyle live rather than reading values once in
 * create(). Every accessibility option here is a requirement, not a nicety —
 * see CLAUDE.md.
 */

import { FONT_BRUSH, FONT_DYSLEXIC, FONT_SERIF, COLOR_INK_CSS, COLOR_INK_HC_CSS } from '@/systems/constants';

const STORAGE_KEY = 'climate-game/settings/v1';

export type TextSize = 'small' | 'medium' | 'large' | 'xlarge';
export type TextSpeed = 'slow' | 'normal' | 'fast' | 'instant';
export type InteractionMode = 'hold' | 'toggle';

/** Rebindable actions. */
export type GameAction =
  | 'up' | 'down' | 'left' | 'right'
  | 'confirm' | 'cancel' | 'menu' | 'skip' | 'fullscreen';

export type KeyBindings = Record<GameAction, string[]>;

export interface Settings {
  // Visual
  textSize: TextSize;
  dyslexiaFont: boolean;
  highContrast: boolean;
  waterPattern: boolean;
  reducedMotion: boolean;
  brightness: number; // percent, 70..130

  // Audio
  masterVolume: number;
  musicVolume: number;
  voiceVolume: number;
  sfxVolume: number;
  captions: boolean;
  captionOpacity: number;
  speakerNames: boolean;
  visualSoundCues: boolean;

  // Gameplay
  textSpeed: TextSpeed;
  autoAdvance: boolean;
  interactionMode: InteractionMode;
  choiceTimers: boolean;
  keyBindings: KeyBindings;
}

export const DEFAULT_KEYBINDINGS: KeyBindings = {
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  confirm: ['Enter', 'Space'],
  cancel: ['Escape', 'Backspace'],
  menu: ['Tab'],
  skip: ['KeyE'],
  fullscreen: ['KeyF'],
};

export const DEFAULTS: Settings = {
  textSize: 'medium',
  dyslexiaFont: false,
  highContrast: false,
  waterPattern: false,
  reducedMotion: false,
  brightness: 100,

  masterVolume: 80,
  musicVolume: 70,
  voiceVolume: 100,
  sfxVolume: 80,
  captions: true, // captions default ON
  captionOpacity: 70,
  speakerNames: true,
  visualSoundCues: false,

  textSpeed: 'normal',
  autoAdvance: false,
  interactionMode: 'toggle',
  choiceTimers: false, // no choice timers by default
  keyBindings: DEFAULT_KEYBINDINGS,
};

const TEXT_SIZE_SCALE: Record<TextSize, number> = {
  small: 0.85,
  medium: 1,
  large: 1.2,
  xlarge: 1.45,
};

export const TEXT_SPEED_CPS: Record<TextSpeed, number> = {
  slow: 15,
  normal: 30,
  fast: 60,
  instant: Infinity,
};

type Listener = (s: Settings) => void;

class SettingsManager {
  private current: Settings = structuredClone(DEFAULTS);
  private listeners = new Set<Listener>();

  constructor() {
    this.load();
  }

  // --- persistence -------------------------------------------------------

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<Settings>;
      this.current = {
        ...structuredClone(DEFAULTS),
        ...saved,
        // merge bindings so a newly added action still gets a default
        keyBindings: { ...DEFAULT_KEYBINDINGS, ...(saved.keyBindings ?? {}) },
      };
    } catch {
      // Corrupt or unavailable storage (private window, blocked cookies) —
      // defaults are already in place, so just carry on.
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      // Non-fatal: the game stays playable, the choice just won't persist.
    }
  }

  // --- read / write ------------------------------------------------------

  all(): Readonly<Settings> {
    return this.current;
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.current[key];
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (this.current[key] === value) return;
    this.current[key] = value;
    this.save();
    this.emit();
  }

  reset(): void {
    this.current = structuredClone(DEFAULTS);
    this.save();
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.applyGlobalFilters();
    for (const fn of this.listeners) fn(this.current);
  }

  // --- derived style helpers --------------------------------------------

  fontFamily(): string {
    return this.current.dyslexiaFont ? FONT_DYSLEXIC : FONT_BRUSH;
  }

  /** Base size 16px * the player's text-size scale * a per-element multiplier. */
  /** Story/narration typeface; the dyslexia-friendly font replaces it too. */
  serifFamily(): string {
    return this.current.dyslexiaFont ? FONT_DYSLEXIC : FONT_SERIF;
  }
  fontSizePx(multiplier = 1): number {
    return Math.round(16 * TEXT_SIZE_SCALE[this.current.textSize] * multiplier);
  }

  inkCss(): string {
    return this.current.highContrast ? COLOR_INK_HC_CSS : COLOR_INK_CSS;
  }

  /** Letter-spacing nudge: dyslexia-friendly mode wants a little more air. */
  letterSpacing(): number {
    return this.current.dyslexiaFont ? 1.2 : 0;
  }

  /**
   * Brightness is applied as a CSS filter on the canvas host so it covers
   * everything the game draws without each scene having to opt in.
   */
  applyGlobalFilters(): void {
    const host = document.getElementById('game');
    if (!host) return;
    const b = this.current.brightness / 100;
    host.style.filter = b === 1 ? '' : `brightness(${b})`;
  }

  // --- key bindings ------------------------------------------------------

  matchesAction(action: GameAction, code: string): boolean {
    return this.current.keyBindings[action]?.includes(code) ?? false;
  }

  /** Which action, if any, a key code is currently bound to. */
  actionFor(code: string): GameAction | null {
    for (const action of Object.keys(this.current.keyBindings) as GameAction[]) {
      if (this.current.keyBindings[action].includes(code)) return action;
    }
    return null;
  }

  /**
   * Bind `code` as the primary key for `action`, removing it from any other
   * action so one key never drives two things.
   */
  rebind(action: GameAction, code: string): void {
    const next: KeyBindings = { ...this.current.keyBindings };
    for (const a of Object.keys(next) as GameAction[]) {
      next[a] = next[a].filter((c) => c !== code);
    }
    next[action] = [code, ...next[action]].slice(0, 2);
    this.current.keyBindings = next;
    this.save();
    this.emit();
  }

  resetBindings(): void {
    this.current.keyBindings = structuredClone(DEFAULT_KEYBINDINGS);
    this.save();
    this.emit();
  }
}

export const settings = new SettingsManager();

/** Human-readable label for a key code, for the remapping UI. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5) + ' arrow';
  const special: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    Escape: 'Esc',
    Backspace: 'Backspace',
    Tab: 'Tab',
  };
  return special[code] ?? code;
}
