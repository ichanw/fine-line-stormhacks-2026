/**
 * Fullscreen, device-pixel-exact rendering.
 *
 * The canvas always fills the window (no letterboxing) and its backing store is
 * the window's CSS size × devicePixelRatio, so one canvas pixel is one physical
 * pixel. Phaser's scale zoom (1/DPR) gives the canvas its CSS size and keeps
 * pointer mapping correct.
 *
 * LAYOUT UNITS. Scenes lay out in "units", not raw CSS pixels: one unit is
 * `unit` CSS px, where `unit` follows the window height (720 units tall on a
 * typical landscape window), clamped so a narrow window still gets enough room
 * across. So the UI scales with the window instead of being tiny on a big
 * monitor. The layout area is `W` x `H` units and changes with the window —
 * always anchor to W/H, never to a fixed 1280x720.
 *
 *   unit ──(viewport.zoom = dpr × unit)──▶ device pixel
 *
 * `zoom` is also the resolution for Text and for any texture generated at
 * runtime: generate at `zoom` texels per unit and draw at 1/zoom.
 */

import Phaser from 'phaser';
import { GAME_HEIGHT } from '@/systems/constants';
import { settings } from '@/systems/SettingsManager';

/** Very high DPRs cost fill-rate for no visible gain. */
const MAX_DPR = 3;
/** Narrowest layout we design for, in units; narrower windows shrink the unit. */
const MIN_LAYOUT_W = 1000;
/** Clamp on CSS px per unit. Set both to 1 for literal CSS-pixel layout. */
const UNIT_MIN = 0.75;
const UNIT_MAX = 2.5;
/** Rebuild layouts at most this often while a window edge is being dragged. */
const RELAYOUT_DEBOUNCE_MS = 120;

type Listener = () => void;

class Viewport {
  dpr = 1;
  cssW = 0;
  cssH = 0;
  backingW = 1;
  backingH = 1;
  /** CSS px per layout unit. */
  unit = 1;
  /** Layout area in units. */
  W = 1280;
  H = 720;
  /** Device px per layout unit: camera zoom and text/texture resolution. */
  zoom = 1;

  private game?: Phaser.Game;
  private dprQuery?: MediaQueryList;
  private layoutListeners = new Set<Listener>();
  private relayoutTimer?: number;

  constructor() { this.measure(); }

  measure(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this.cssW = Math.max(1, window.innerWidth);
    this.cssH = Math.max(1, window.innerHeight);
    this.unit = Phaser.Math.Clamp(
      Math.min(this.cssH / GAME_HEIGHT, this.cssW / MIN_LAYOUT_W), UNIT_MIN, UNIT_MAX,
    );
    this.W = this.cssW / this.unit;
    this.H = this.cssH / this.unit;
    this.backingW = Math.max(1, Math.round(this.cssW * this.dpr));
    this.backingH = Math.max(1, Math.round(this.cssH * this.dpr));
    this.zoom = this.backingW / this.W;
  }

  gameSize(): { width: number; height: number } {
    return { width: this.backingW, height: this.backingH };
  }

  install(game: Phaser.Game): void {
    this.game = game;
    window.addEventListener('resize', () => this.apply());
    document.addEventListener('fullscreenchange', () => this.apply());
    this.watchDpr();
    this.installFullscreenKey();
    this.apply();
  }

  /** DPR changes don't always fire `resize`; watch the media query instead. */
  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  private onDprChange = (): void => { this.watchDpr(); this.apply(); };

  apply(): void {
    if (!this.game) return;
    const prevW = this.W;
    const prevH = this.H;
    const prevZoom = this.zoom;
    this.measure();
    const sm = this.game.scale;
    sm.resize(this.backingW, this.backingH);
    sm.setZoom(1 / this.dpr);
    // Camera zoom and text resolution update immediately, so the frame stays
    // crisp mid-drag; layouts rebuild once the drag settles.
    for (const scene of this.game.scene.getScenes(true)) this.configure(scene);

    // Rebuild on a layout change, and on a pure DPR change too: brush strokes
    // are rendered for a specific zoom and must be regenerated, not rescaled.
    if (Math.abs(prevW - this.W) > 0.5 || Math.abs(prevH - this.H) > 0.5 || Math.abs(prevZoom - this.zoom) > 0.01) {
      window.clearTimeout(this.relayoutTimer);
      this.relayoutTimer = window.setTimeout(() => {
        this.layoutListeners.forEach((fn) => fn());
      }, RELAYOUT_DEBOUNCE_MS);
    }
  }

  /** Called (debounced) whenever the layout area W x H or the zoom changes. */
  onLayoutChange(fn: Listener): () => void {
    this.layoutListeners.add(fn);
    return () => this.layoutListeners.delete(fn);
  }

  /**
   * Standard scene wiring: rebuild the scene when the layout area changes,
   * carrying whatever UI state it wants to keep. The scene's init/create get
   * `{ ...state, resized: true }` and should skip entry animations.
   */
  restartOnResize(scene: Phaser.Scene, state: () => object = () => ({})): void {
    const off = this.onLayoutChange(() => {
      if (scene.scene.isActive()) scene.scene.restart({ ...state(), resized: true });
    });
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, off);
  }

  /**
   * Call first thing in every scene's create(): sets up the camera and renders
   * every Text added to the scene at device resolution.
   */
  attach(scene: Phaser.Scene): void {
    this.configure(scene);
    const onAdded = (go: Phaser.GameObjects.GameObject) => {
      if (go instanceof Phaser.GameObjects.Text) go.setResolution(this.zoom);
    };
    scene.events.on(Phaser.Scenes.Events.ADDED_TO_SCENE, onAdded);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      scene.events.off(Phaser.Scenes.Events.ADDED_TO_SCENE, onAdded);
    });
  }

  private configure(scene: Phaser.Scene): void {
    const cam = scene.cameras?.main;
    if (!cam) return;
    cam.setOrigin(0, 0);
    cam.setZoom(this.zoom);
    const fix = (go: Phaser.GameObjects.GameObject) => {
      if (go instanceof Phaser.GameObjects.Text) go.setResolution(this.zoom);
      if (go instanceof Phaser.GameObjects.Container) go.list.forEach(fix);
    };
    scene.children?.list.forEach(fix);
  }

  // --- fullscreen ---------------------------------------------------------

  get isFullscreen(): boolean {
    return Boolean(document.fullscreenElement);
  }

  /** Must be called from a user gesture (key press or click). */
  toggleFullscreen(): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }

  /** F by default; rebindable as the `fullscreen` action. */
  private installFullscreenKey(): void {
    window.addEventListener('keydown', (e) => {
      if (e.repeat || !settings.matchesAction('fullscreen', e.code)) return;
      e.preventDefault();
      this.toggleFullscreen();
    });
  }
}

export const viewport = new Viewport();
