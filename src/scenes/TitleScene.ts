/**
 * TitleScene — the home screen.
 *
 * One continuous drawing runs from a dystopian left to a utopian right (see
 * systems/world.ts); the title floats over it and the two buttons fade in one
 * after the other. All UI outlines are single-stroke boiled shapes.
 */

import Phaser from 'phaser';
import { music } from '@/systems/music';
import config from '@/data/config.json';
import { Boiler } from '@/systems/boil';
import { debugPanel } from '@/systems/debug';
import { PaperBackground } from '@/systems/paper';
import { settings } from '@/systems/SettingsManager';
import { viewport } from '@/systems/viewport';
import { transitionIn, transitionOut } from '@/systems/transitions';
import { FocusList, SketchButton } from '@/systems/ui';
import { TitleBackground } from '@/systems/titleBackground';
import { COLOR_PAPER, SCENE_AVATAR, SCENE_SETTINGS, SCENE_TITLE } from '@/systems/constants';
import { brushUnderline } from '@/systems/underline';
import type { SketchShape } from '@/systems/boil';

/** Layout, as fractions of the layout height (Figma title.png, measured). */
const L = { titleY: 0.405, underlineY: 0.452, button1Y: 0.535, button2Y: 0.611, buttonW: 0.194, buttonH: 0.056 };

interface TitleData { resized?: boolean; focusIndex?: number }

export class TitleScene extends Phaser.Scene {
  private boiler = new Boiler();
  private focusList = new FocusList();
  private world!: TitleBackground;
  private paper!: PaperBackground;
  private titleText!: Phaser.GameObjects.Text;
  private titleBaseY = 200;
  private floatT = 0;
  private underline?: SketchShape;
  /** Measured once per build: button size and the half-width of the UI column. */
  private btn = { w: 140, h: 40 };
  private unsubscribe?: () => void;
  private runData: TitleData = {};

  constructor() { super(SCENE_TITLE); }

  init(data: TitleData): void { this.runData = data ?? {}; }

  create(): void {
    // Camera zoom + device-resolution text; must run before anything is added.
    viewport.attach(this);
    music.forScene('Title');   // keeps flowing if it's already playing
    // Phaser reuses the scene instance; reset per-run state or the second visit
    // operates on destroyed objects from the first.
    this.boiler = new Boiler();
    this.focusList = new FocusList();
    this.floatT = 0;

    this.paper = new PaperBackground(this);
    const { W, H } = viewport;

    // Title first, so its measured size can keep the background's centre
    // column clear (Figma: centred at 40.5% height).
    this.titleBaseY = H * L.titleY;
    // UI sits above the whole background, falling leaves included.
    this.titleText = this.add.text(W / 2, this.titleBaseY, config.gameTitle, {})
      .setOrigin(0.5).setDepth(70);
    this.restyleTitle();
    const tb = this.titleText.getBounds();
    this.btn = this.measureButtons();
    const clearHalf = Math.max(tb.width / 2 + 16, this.btn.w / 2) + 34;

    // Regenerating (new seed, crack density, transition position from F1)
    // rebuilds the scene without replaying the intro.
    this.world = new TitleBackground(this, this.boiler, clearHalf, () =>
      this.scene.restart({ resized: true, focusIndex: this.focusList.currentIndex }));
    // A resize rebuild should be invisible — no wipe, no staggered fade-in.
    if (!this.runData.resized) transitionIn(this);

    // The hand-brushed underline, and an opaque paper backing behind the title
    // so leaves pass behind it, never through the letters.
    this.underline = brushUnderline(this, this.boiler, tb.x - 4, tb.right + 10, H * L.underlineY, 71);
    this.add.rectangle(W / 2, (tb.y + H * L.underlineY + 8) / 2, tb.width + 40, H * L.underlineY + 8 - tb.y + 16, COLOR_PAPER, 1)
      .setDepth(68);

    this.buildButtons();
    viewport.restartOnResize(this, () => ({ focusIndex: this.focusList.currentIndex }));

    this.unsubscribe = settings.subscribe(() => this.restyle());
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribe?.();
      this.scale.off(Phaser.Scale.Events.RESIZE, this.onResize, this);
      this.focusList.destroy();
      this.world.destroy();
      this.boiler.destroy();
      this.paper.destroy();
    });

    this.restyle();
    this.focusList.focus(this.runData.focusIndex ?? 0);
  }

  private onResize(): void { this.focusList.repositionProxies(); }

  // Layout: everything below is positioned from the live layout area
  // (viewport.W x viewport.H), never from a fixed 1280x720.

  /**
   * Figma's button size (~19% of height wide, 5.6% tall), widened if a larger
   * text-size setting needs more room for "Start Experience".
   */
  private measureButtons(): { w: number; h: number } {
    const H = viewport.H;
    const probe = this.add.text(0, 0, config.title.play, {
      fontFamily: settings.fontFamily(), fontSize: `${settings.fontSizePx(1.5)}px`,
    }).setVisible(false);
    const w = Math.max(H * L.buttonW, probe.width / 0.72);
    const h = Math.max(H * L.buttonH, probe.height * 1.6);
    probe.destroy();
    return { w, h };
  }

  private buildButtons(): void {
    const { W, H } = viewport;
    const cx = W / 2;
    const { w, h } = this.btn;

    const play = new SketchButton(this, {
      x: cx - w / 2, y: H * L.button1Y - h / 2, w, h, primary: true,
      label: config.title.play,
      ariaLabel: 'Start Experience',
      fontScale: 1.5,
      boiler: this.boiler,
      onActivate: () => transitionOut(this, () => this.scene.start(SCENE_AVATAR)),
    });

    const settingsBtn = new SketchButton(this, {
      x: cx - w / 2, y: H * L.button2Y - h / 2, w, h,
      label: config.title.settings,
      ariaLabel: 'Settings',
      fontScale: 1.5,
      boiler: this.boiler,
      onActivate: () => transitionOut(this, () =>
        this.scene.start(SCENE_SETTINGS, { returnTo: SCENE_TITLE })),
    });

    // One after the other, so the page assembles rather than appearing.
    if (!this.runData.resized) {
      play.fadeIn(260);
      settingsBtn.fadeIn(520);
    }

    this.focusList.setItems([play, settingsBtn]);

    // Arrows move focus. Enter/Space are handled natively by the focused DOM
    // proxy, so binding them here too would double-fire.
    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => {
      if (settings.matchesAction('down', e.code) || settings.matchesAction('right', e.code)) {
        this.focusList.move(1); e.preventDefault();
      } else if (settings.matchesAction('up', e.code) || settings.matchesAction('left', e.code)) {
        this.focusList.move(-1); e.preventDefault();
      }
    });
  }

  /** Figma: "fine line" glyphs ~5.5% of the height tall. */
  private restyleTitle(): void {
    this.titleText.setStyle({
      fontFamily: settings.fontFamily(),
      fontSize: `${settings.fontSizePx(3.4)}px`,
      color: settings.inkCss(),
    });
    this.titleText.setLetterSpacing(settings.letterSpacing());
  }

  private restyle(): void {
    this.restyleTitle();
    this.focusList.restyle();
  }

  update(time: number, delta: number): void {
    const reduced = settings.get('reducedMotion');
    this.boiler.setFrozen(reduced);
    this.boiler.update(time);
    this.paper.update(delta);
    this.world.update(time, delta);

    // The title drifts a couple of pixels, like a sheet breathing.
    if (!reduced) {
      this.floatT += delta * 0.0007;
      // Title and its underline float together, gently.
      const dy = Math.sin(this.floatT) * 3;
      this.titleText.setY(this.titleBaseY + dy);
      this.underline?.setOffset(0, dy);
    } else {
      this.titleText.setY(this.titleBaseY);
      this.underline?.setOffset(0, 0);
    }

    if (debugPanel.get().showStats) {
      // Stats are rendered by the DOM panel; nothing to draw here yet.
    }
  }
}
