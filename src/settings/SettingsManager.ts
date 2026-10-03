/**
 * SettingsManager — the single source of truth for every player preference.
 *
 * Accessibility is a core feature, so ALL of it lives here: text size, font,
 * contrast, reduced motion, captions, audio volumes, text speed, key bindings.
 * Scenes must read from here (never hardcode) and subscribe to changes so a
 * setting applied in the menu takes effect everywhere immediately.
 *
 * Persists to localStorage. One instance, exported as `settings`.
 */

export type TextSizeKey = 'small' | 'medium' | 'large' | 'xlarge';
export type FontKey = 'serif' | 'sans' | 'dyslexic';

/** Logical actions the game listens for, so keys are fully rebindable. */
export type GameAction =
  | 'confirm'
  | 'cancel'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'skip'
  | 'menu';

export interface GameSettings {
  // Text / reading
  textSize: TextSizeKey;
  font: FontKey;
  /** 0 = instant, 1 = slow typewriter. Characters-per-second is derived. */
  textSpeed: number;

  // Visual
  highContrast: boolean;
  reducedMotion: boolean;

  // Audio (0..1 each). master scales the others.
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  voiceVolume: number;

  // Captions for voiced / sfx lines (ElevenLabs later).
  captions: boolean;

  /** Logical action -> list of KeyboardEvent.code values. */
  keyBindings: Record<GameAction, string[]>;
}

export const DEFAULT_SETTINGS: GameSettings = {
  textSize: 'medium',
  font: 'serif',
  textSpeed: 0.5,

  highContrast: false,
  reducedMotion: false,

  masterVolume: 0.8,
  musicVolume: 0.7,
  sfxVolume: 0.8,
  voiceVolume: 1.0,

  captions: true,

  keyBindings: {
    confirm: ['Enter', 'Space'],
    cancel: ['Escape', 'Backspace'],
    up: ['ArrowUp', 'KeyW'],
    down: ['ArrowDown', 'KeyS'],
    left: ['ArrowLeft', 'KeyA'],
    right: ['ArrowRight', 'KeyD'],
    skip: ['KeyE'],
    menu: ['Tab'],
  },
};

/** Pixel font sizes mapped from the logical text-size setting. */
export const TEXT_SIZE_PX: Record<TextSizeKey, number> = {
  small: 18,
  medium: 22,
  large: 28,
  xlarge: 36,
};

/** CSS font-family strings mapped from the logical font setting. */
export const FONT_FAMILY: Record<FontKey, string> = {
  serif: "Georgia, 'Times New Roman', serif",
  sans: "'Helvetica Neue', Arial, sans-serif",
  // "dyslexic" uses a widely-legible fallback until a real face is bundled.
  dyslexic: "'Comic Sans MS', 'Trebuchet MS', Verdana, sans-serif",
};

const STORAGE_KEY = 'climate-game.settings.v1';

type Listener = (settings: GameSettings) => void;

class SettingsManagerImpl {
  private current: GameSettings;
  private listeners = new Set<Listener>();

  constructor() {
    this.current = this.load();
  }

  /** Read a shallow copy so callers can't mutate internal state directly. */
  get(): Readonly<GameSettings> {
    return this.current;
  }

  getValue<K extends keyof GameSettings>(key: K): GameSettings[K] {
    return this.current[key];
  }

  /** Update one or more settings, persist, and notify every subscriber. */
  set(patch: Partial<GameSettings>): void {
    this.current = { ...this.current, ...patch };
    this.save();
    this.emit();
  }

  reset(): void {
    this.current = structuredClone(DEFAULT_SETTINGS);
    this.save();
    this.emit();
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- Derived helpers the scenes actually use -------------------------

  fontFamily(): string {
    return FONT_FAMILY[this.current.font];
  }

  fontSizePx(scale = 1): number {
    return Math.round(TEXT_SIZE_PX[this.current.textSize] * scale);
  }

  /** Characters per second for the typewriter. textSpeed 0 => instant. */
  charsPerSecond(): number {
    if (this.current.textSpeed <= 0) return Infinity;
    // 0.0..1.0 maps to a fast..slow reveal (approx 120..18 cps).
    return 120 - this.current.textSpeed * 102;
  }

  /** Effective volume for a channel after the master multiplier. */
  effectiveVolume(channel: 'music' | 'sfx' | 'voice'): number {
    const ch =
      channel === 'music'
        ? this.current.musicVolume
        : channel === 'sfx'
          ? this.current.sfxVolume
          : this.current.voiceVolume;
    return Math.max(0, Math.min(1, this.current.masterVolume * ch));
  }

  /** True if the given keyboard event code triggers the given action. */
  matchesAction(action: GameAction, code: string): boolean {
    return this.current.keyBindings[action].includes(code);
  }

  // --- Persistence -----------------------------------------------------

  private emit(): void {
    for (const l of this.listeners) l(this.current);
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      // Private-mode / quota failures are non-fatal; settings stay in memory.
    }
  }

  private load(): GameSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_SETTINGS);
      const parsed = JSON.parse(raw) as Partial<GameSettings>;
      // Merge over defaults so newly-added settings get sensible values.
      return {
        ...structuredClone(DEFAULT_SETTINGS),
        ...parsed,
        keyBindings: {
          ...DEFAULT_SETTINGS.keyBindings,
          ...(parsed.keyBindings ?? {}),
        },
      };
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }
}

/** The one and only settings instance. Import this everywhere. */
export const settings = new SettingsManagerImpl();
