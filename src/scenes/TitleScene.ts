/**
 * TitleScene — the home screen.
 *
 * One continuous drawing runs from a dystopian left to a utopian right (see
 * systems/world.ts); the title floats over it and the two buttons fade in one
 * after the other. All UI outlines are single-stroke boiled shapes.
 */

import Phaser from 'phaser';
import config from '@/data/config.json';
import { Boiler } from '@/systems/boil';
import { debugPanel } from '@/systems/debug';
import { PaperBackground } from '@/systems/paper';
import { settings } from '@/systems/SettingsManager';
import { pencilWipeIn, pencilWipeOut } from '@/systems/transitions';
import { FocusList, SketchButton } from '@/systems/ui';
import { World } from '@/systems/world';
import {
  GAME_WIDTH, SCENE_AVATAR, SCENE_SETTINGS, SCENE_TITLE,
} from '@/systems/constants';

export class TitleScene extends Phaser.Scene {
  private boiler = new Boiler();
  private focusList = new FocusList();
  private world!: World;
  private paper!: PaperBackground;
  private titleText!: Phaser.GameObjects.Text;
  private titleBaseY = 200;
  private floatT = 0;
  private unsubscribe?: () => void;

  constructor() { super(SCENE_TITLE); }

  create(): void {
    // Phaser reuses the scene instance; reset per-run state or the second visit
    // operates on destroyed objects from the first.
    this.boiler = new Boiler();
    this.focusList = new FocusList();
    this.floatT = 0;

    this.paper = new PaperBackground(this);
    this.world = new World(this, this.boiler);
    pencilWipeIn(this);

    const cx = GAME_WIDTH / 2;
    this.titleText = this.add.text(cx, this.titleBaseY, config.gameTitle, {})
      .setOrigin(0.5).setDepth(20);

    this.buildButtons();

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
    this.focusList.focus(0);
  }

  private onResize(): void { this.focusList.repositionProxies(); }

  private buildButtons(): void {
    const cx = GAME_WIDTH / 2;
    const w = 300, h = 62;
    const topY = 352;

    const play = new SketchButton(this, {
      x: cx - w / 2, y: topY, w, h,
      label: config.title.play,
      ariaLabel: 'Play',
      boiler: this.boiler,
      onActivate: () => pencilWipeOut(this, () => this.scene.start(SCENE_AVATAR)),
    });

    const settingsBtn = new SketchButton(this, {
      x: cx - w / 2, y: topY + h + 22, w, h,
      label: config.title.settings,
      ariaLabel: 'Settings',
      boiler: this.boiler,
      onActivate: () => pencilWipeOut(this, () =>
        this.scene.start(SCENE_SETTINGS, { returnTo: SCENE_TITLE })),
    });

    // One after the other, so the page assembles rather than appearing.
    play.fadeIn(260);
    settingsBtn.fadeIn(520);

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

  private restyle(): void {
    this.titleText.setStyle({
      fontFamily: settings.fontFamily(),
      fontSize: `${settings.fontSizePx(4.2)}px`,
      color: settings.inkCss(),
    });
    this.titleText.setLetterSpacing(settings.letterSpacing());
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
      this.titleText.setY(this.titleBaseY + Math.sin(this.floatT) * 4);
    } else {
      this.titleText.setY(this.titleBaseY);
    }

    if (debugPanel.get().showStats) {
      // Stats are rendered by the DOM panel; nothing to draw here yet.
    }
  }
}
