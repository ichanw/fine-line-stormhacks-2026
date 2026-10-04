/**
 * The page everything is drawn on: white, with a very faint tooth.
 *
 * The grain drifts extremely slowly, which keeps the page feeling like a
 * physical sheet without ever reading as movement. Reduced motion pins it.
 */

import Phaser from 'phaser';
import { settings } from '@/systems/SettingsManager';
import { COLOR_PAPER_CSS, GAME_HEIGHT, GAME_WIDTH } from '@/systems/constants';

export const PAPER_TEXTURE = 'paper-tile';
const TILE = 256;

export function ensurePaperTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists(PAPER_TEXTURE)) return;
  const canvas = scene.textures.createCanvas(PAPER_TEXTURE, TILE, TILE);
  if (!canvas) return;
  const ctx = canvas.getContext();

  ctx.fillStyle = COLOR_PAPER_CSS;
  ctx.fillRect(0, 0, TILE, TILE);

  // Barely-there tooth. The page is white, so this must stay subtle.
  const img = ctx.getImageData(0, 0, TILE, TILE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 5;
    d[i] = Math.min(255, Math.max(0, d[i] + n));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + n));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  canvas.refresh();
}

export class PaperBackground {
  private tile: Phaser.GameObjects.TileSprite;
  private t = 0;

  constructor(scene: Phaser.Scene) {
    ensurePaperTexture(scene);
    this.tile = scene.add
      .tileSprite(0, 0, GAME_WIDTH, GAME_HEIGHT, PAPER_TEXTURE)
      .setOrigin(0, 0)
      .setDepth(-1000)
      .setScrollFactor(0);
  }

  update(delta: number): void {
    if (settings.get('reducedMotion')) return;
    // Very slow drift — a few pixels a minute, felt rather than seen.
    this.t += delta;
    this.tile.tilePositionX = Math.sin(this.t * 0.00004) * 6;
    this.tile.tilePositionY = Math.cos(this.t * 0.00003) * 6;
  }

  destroy(): void { this.tile.destroy(); }
}

/** Convenience for scenes that don't need the drifting handle. */
export function addPaperBackground(scene: Phaser.Scene): PaperBackground {
  return new PaperBackground(scene);
}
