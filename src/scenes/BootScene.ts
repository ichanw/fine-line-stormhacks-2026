/**
 * BootScene — the loading screen.
 *
 * Sequence: the title writes itself stroke by stroke, then the bar sketches in
 * beneath it with a faint pencil scribbling at its leading edge. Under reduced
 * motion the title simply appears and the bar is a plain static fill.
 */

import Phaser from 'phaser';
import config from '@/data/config.json';
import { Boiler, SketchShape, boxShape, pathShape } from '@/systems/boil';
import { preloadCharacters, registerHeadFrames } from '@/systems/characters';
import { handwriteReveal } from '@/systems/handwriting';
import { PaperBackground } from '@/systems/paper';
import { settings } from '@/systems/SettingsManager';
import { pencilWipeOut } from '@/systems/transitions';
import {
  COLOR_INK, COLOR_STROKE_IDLE, GAME_HEIGHT, GAME_WIDTH, GREY_SOFT,
  SCENE_BOOT, SCENE_TITLE,
} from '@/systems/constants';

const BAR_W = 420;
const BAR_H = 22;
const BAR_X = (GAME_WIDTH - BAR_W) / 2;
const BAR_Y = GAME_HEIGHT / 2 + 26;

export class BootScene extends Phaser.Scene {
  private boiler = new Boiler();
  private paper!: PaperBackground;
  private titleText!: Phaser.GameObjects.Text;
  private lineText!: Phaser.GameObjects.Text;
  private barOutline!: SketchShape;
  private barFill!: SketchShape;
  private scribble!: Phaser.GameObjects.Graphics;
  private progress = 0;
  private lineIndex = 0;
  private cycleTimer?: Phaser.Time.TimerEvent;
  private lastFillRebuild = -1;

  constructor() { super(SCENE_BOOT); }

  preload(): void {
    // Reset per-run state — Phaser reuses scene instances across start().
    this.progress = 0;
    this.lineIndex = 0;
    this.lastFillRebuild = -1;
    this.boiler = new Boiler();

    settings.applyGlobalFilters();
    preloadCharacters(this);
  }

  create(): void {
    registerHeadFrames(this);
    this.paper = new PaperBackground(this);

    const cx = GAME_WIDTH / 2;
    this.titleText = this.add.text(cx, GAME_HEIGHT / 2 - 70, config.gameTitle, {})
      .setOrigin(0.5).setDepth(5).setAlpha(0);

    this.lineText = this.add.text(cx, BAR_Y + BAR_H + 38, config.loadingLines[0], {})
      .setOrigin(0.5).setDepth(5).setAlpha(0);

    // Single-stroke outline; no second border anywhere.
    this.barOutline = this.boiler.add(new SketchShape(
      this, boxShape(BAR_X, BAR_Y, BAR_W, BAR_H),
      { color: COLOR_STROKE_IDLE, width: 1, alpha: 1 },
      { jitter: 1.4, depth: 5 },
    )).setVisible(false);

    this.barFill = this.boiler.add(new SketchShape(
      this, pathShape([]), { color: GREY_SOFT, width: 1.2, alpha: 0.65 },
      { jitter: 1.2, depth: 5 },
    ));

    this.scribble = this.add.graphics().setDepth(6);

    this.restyle();
    this.runIntro();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.cycleTimer?.remove();
      this.boiler.destroy();
      this.paper.destroy();
    });
  }

  /** Title writes itself, then the bar sketches in, then we move on. */
  private runIntro(): void {
    const reduced = settings.get('reducedMotion');

    const startBar = () => {
      this.barOutline.setVisible(true);
      this.lineText.setAlpha(0.6);

      if (!reduced) {
        this.cycleTimer = this.time.addEvent({
          delay: 900, loop: true,
          callback: () => {
            this.lineIndex = (this.lineIndex + 1) % config.loadingLines.length;
            this.lineText.setText(config.loadingLines[this.lineIndex]);
          },
        });
      }

      const state = { p: 0 };
      this.tweens.add({
        targets: state,
        p: 1,
        duration: reduced ? 420 : 1250,
        ease: 'Sine.easeInOut',
        onUpdate: () => { this.progress = state.p; this.refreshBar(); },
        onComplete: () => {
          this.cycleTimer?.remove();
          this.time.delayedCall(reduced ? 100 : 280, () => {
            pencilWipeOut(this, () => this.scene.start(SCENE_TITLE));
          });
        },
      });
    };

    if (reduced) {
      this.titleText.setAlpha(1);
      startBar();
    } else {
      handwriteReveal(this, this.titleText, 1250, () => this.time.delayedCall(180, startBar));
    }
  }

  /** Shade the filled portion with pencil hatching, clipped to the bar. */
  private refreshBar(): void {
    const filled = Phaser.Math.Clamp(this.progress, 0, 1) * BAR_W;

    // Rebuilding jitter variants is not free, so only do it as the fill grows
    // by a visible amount.
    const bucket = Math.floor(filled / 8);
    if (bucket !== this.lastFillRebuild) {
      this.lastFillRebuild = bucket;
      const lines = [];
      for (let i = -BAR_H; i < filled; i += 7) {
        let x1 = BAR_X + i, y1 = BAR_Y + BAR_H;
        let x2 = BAR_X + i + BAR_H, y2 = BAR_Y;
        if (x1 < BAR_X) { y1 = BAR_Y + BAR_H - (BAR_X - x1); x1 = BAR_X; }
        if (x2 > BAR_X + filled) { y2 = BAR_Y + BAR_H - (filled - i); x2 = BAR_X + filled; }
        if (x2 > x1) lines.push([{ x: x1, y: y1 }, { x: x2, y: y2 }]);
      }
      this.barFill.setGeometry(lines);
    }

    // A faint pencil scribbling away at the leading edge of the fill.
    const g = this.scribble;
    g.clear();
    if (settings.get('reducedMotion') || this.progress >= 1 || this.progress <= 0) return;
    const ex = BAR_X + filled;
    g.lineStyle(1.1, COLOR_INK, 0.3);
    for (let i = 0; i < 5; i++) {
      const y = BAR_Y - 5 + Math.random() * (BAR_H + 10);
      g.beginPath();
      g.moveTo(ex - 4 + Math.random() * 5, y);
      g.lineTo(ex + 7 + Math.random() * 9, y + (Math.random() - 0.5) * 9);
      g.strokePath();
    }
  }

  private restyle(): void {
    const family = settings.fontFamily();
    const ink = settings.inkCss();
    this.titleText.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(3.6)}px`, color: ink });
    this.lineText.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(1.1)}px`, color: ink });
  }

  update(time: number): void {
    this.boiler.update(time);
    this.boiler.setFrozen(settings.get('reducedMotion'));
    this.paper?.update(this.game.loop.delta);
  }
}
