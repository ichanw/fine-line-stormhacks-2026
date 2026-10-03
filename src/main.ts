/**
 * Entry point. Creates the Phaser game at a fixed 1280x720 design size that
 * scales to fit the window while preserving aspect ratio, and registers the
 * scenes. Global systems (settings) are plain singletons imported where used.
 */

import Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH, COLOR_PAPER_CSS } from '@/config/constants';
import { BootScene } from '@/scenes/BootScene';
import { TitleScene } from '@/scenes/TitleScene';
import { SettingsScene } from '@/scenes/SettingsScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: COLOR_PAPER_CSS,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    antialias: true,
    roundPixels: false,
  },
  scene: [BootScene, TitleScene, SettingsScene],
};

new Phaser.Game(config);

// Remove the pre-boot HTML loading note once the canvas is up.
document.getElementById('loading')?.remove();
