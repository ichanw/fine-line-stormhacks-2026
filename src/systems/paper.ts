/**
 * The page everything is drawn on: white, with a very faint tooth.
 *
 * The grain drifts extremely slowly, which keeps the page feeling like a
 * physical sheet without ever reading as movement. Reduced motion pins it.
 */

import Phaser from 'phaser';
import { settings } from '@/systems/SettingsManager';
import { viewport } from '@/systems/viewport';
import { COLOR_PAPER_CSS } from '@/systems/constants';

export const PAPER_TEXTURE = 'paper-tile';
/**
 * Texels, not design units. The tile is drawn at 1/zoom scale so every grain
 * speck lands on exactly one device pixel at any DPR; power-of-two so WebGL1
 * can repeat it.
 */
const TILE = 512;

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
      .tileSprite(0, 0, viewport.W, viewport.H, PAPER_TEXTURE)
      .setOrigin(0, 0)
      // Follows the camera like everything else (cameras never scroll here), so
      // the page tilts and scales with the scene in the scrapbook transition.
      .setDepth(-1000);
    this.tile.setTileScale(1 / viewport.zoom);
  }

  update(delta: number): void {
    // Cheap, and keeps grain device-exact after a resize or DPR change.
    const s = 1 / viewport.zoom;
    if (this.tile.tileScaleX !== s) this.tile.setTileScale(s);
    if (settings.get('reducedMotion')) return;
    // Very slow drift — a few pixels a minute, felt rather than seen.
    this.t += delta;
    this.tile.tilePositionX = Math.sin(this.t * 0.00004) * 6;
    this.tile.tilePositionY = Math.cos(this.t * 0.00003) * 6;
  }

  /** E.g. MULTIPLY, to lay the grain over a coloured page. */
  setBlendMode(mode: Phaser.BlendModes): void { this.tile.setBlendMode(mode); }

  destroy(): void { this.tile.destroy(); }
}

/** Convenience for scenes that don't need the drifting handle. */
export function addPaperBackground(scene: Phaser.Scene): PaperBackground {
  return new PaperBackground(scene);
}
