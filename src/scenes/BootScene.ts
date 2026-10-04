/**
 * BootScene — the loading screen (Figma: design/figma/loading.png).
 *
 * Just "loading..." centred at ~51% height, written in with the brush, then
 * its dots cycle while the art is prepared. Reduced motion: static text.
 */

import Phaser from 'phaser';
import { preloadCharacters, registerHeadFrames } from '@/systems/characters';
import { handwriteReveal } from '@/systems/handwriting';
import { PaperBackground } from '@/systems/paper';
import { settings } from '@/systems/SettingsManager';
import { prepareTitleArt, preloadTitleArt } from '@/systems/titleArt';
import { preloadSfx } from '@/systems/sfx';
import { music } from '@/systems/music';
import { transitionOut } from '@/systems/transitions';
import { viewport } from '@/systems/viewport';
import { SCENE_BOOT, SCENE_TITLE } from '@/systems/constants';

const WORD = 'loading';
/** Figma: text centred at 50.8% of the height, ~6% of the height tall. */
const CENTRE_Y = 0.508;
/** ~6.5% of a 720-unit-tall layout at the default text size; follows the setting. */
const FONT_SCALE = 2.9;
/** Hold long enough that the word is seen being written, not flashed. */
const MIN_SHOW_MS = 1500;

export class BootScene extends Phaser.Scene {
  private paper!: PaperBackground;
  private label!: Phaser.GameObjects.Text;
  private dots = 3;
  private dotTimer?: Phaser.Time.TimerEvent;

  constructor() { super(SCENE_BOOT); }

  preload(): void {
    settings.applyGlobalFilters();
    preloadCharacters(this);
    preloadTitleArt(this);
    preloadSfx(this);
    music.preload(this);   // nothing yet: src/data/sfx.json entries are placeholders
  }

  create(): void {
    // Camera zoom + device-resolution text; must run before anything is added.
    viewport.attach(this);
    // The soundtrack starts here (audible from the first click — autoplay policy).
    music.forScene('Boot');
    this.dots = 3;
    const start = performance.now();

    this.paper = new PaperBackground(this);
    this.label = this.add.text(0, 0, `${WORD}...`, {}).setOrigin(0, 0.5).setDepth(5);
    this.restyle();
    this.layout();

    // Repack heads and prepare the title drawings (never altered) while the
    // word is being written.
    registerHeadFrames(this);
    prepareTitleArt(this);

    const reduced = settings.get('reducedMotion');
    const next = () => {
      const wait = Math.max(0, MIN_SHOW_MS - (performance.now() - start));
      this.time.delayedCall(wait, () => {
        this.dotTimer?.remove();
        transitionOut(this, () => this.scene.start(SCENE_TITLE));
      });
    };
    if (reduced) {
      next();
    } else {
      handwriteReveal(this, this.label, 750, () => {
        this.dotTimer = this.time.addEvent({
          delay: 380, loop: true,
          callback: () => {
            this.dots = (this.dots % 3) + 1;
            this.label.setText(WORD + '.'.repeat(this.dots));
          },
        });
        next();
      });
    }

    const offLayout = viewport.onLayoutChange(() => this.layout());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      offLayout();
      this.dotTimer?.remove();
      this.paper.destroy();
    });
  }

  /** Centre the full "loading..." width; anchor left so cycling dots don't shift the word. */
  private layout(): void {
    const full = this.label.text;
    this.label.setText(`${WORD}...`);
    const w = this.label.width;
    this.label.setText(full);
    this.label.setPosition(viewport.W / 2 - w / 2, viewport.H * CENTRE_Y);
    this.paper?.destroy();
    this.paper = new PaperBackground(this);
  }

  private restyle(): void {
    this.label.setStyle({
      fontFamily: settings.fontFamily(),
      fontSize: `${settings.fontSizePx(FONT_SCALE)}px`,
      color: settings.inkCss(),
    });
  }

  update(): void {
    this.paper?.update(this.game.loop.delta);
  }
}
