/**
 * BootScene — loads registered art (PNGs if present) then hands off to the
 * TitleScene. Kept tiny on purpose; it exists so the loader runs once.
 */

import Phaser from 'phaser';
import { preloadArt } from '@/art/ArtLoader';
import '@/art/placeholders'; // registers all placeholder art as a side effect
import { COLOR_INK_CSS, COLOR_PAPER_CSS } from '@/config/constants';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    // Minimal in-canvas loading note (the HTML one is already hidden by now).
    const { width, height } = this.scale;
    this.add
      .text(width / 2, height / 2, 'loading…', {
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: '20px',
        color: COLOR_INK_CSS,
      })
      .setOrigin(0.5)
      .setAlpha(0.6);

    this.cameras.main.setBackgroundColor(COLOR_PAPER_CSS);
    preloadArt(this);
  }

  create(): void {
    this.scene.start('Title');
  }
}
