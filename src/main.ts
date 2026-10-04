/**
 * Entry point. A fixed 1280x720 design space that scales to fit the window.
 *
 * The game waits for the brush face to load before booting: Phaser measures
 * text at creation time, so starting early bakes in fallback metrics and every
 * label ends up mis-sized.
 */

import Phaser from 'phaser';
import { AvatarSelectScene } from '@/scenes/AvatarSelectScene';
import { BootScene } from '@/scenes/BootScene';
import { SettingsScene } from '@/scenes/SettingsScene';
import { TitleScene } from '@/scenes/TitleScene';
import { debugPanel } from '@/systems/debug';
import { settings } from '@/systems/SettingsManager';
import { COLOR_PAPER_CSS, GAME_HEIGHT, GAME_WIDTH } from '@/systems/constants';

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
  render: { antialias: true, roundPixels: false },
  scene: [BootScene, TitleScene, SettingsScene, AvatarSelectScene],
};

async function start(): Promise<void> {
  try {
    // Explicitly load the face at a size we use; document.fonts.ready alone can
    // resolve before a lazily-fetched webfont is actually available.
    await (document as Document).fonts.load("48px 'Nanum Brush Script'");
    await (document as Document).fonts.ready;
  } catch {
    // Offline or blocked — the fallback stack still renders, just not as nicely.
  }

  new Phaser.Game(config);
  settings.applyGlobalFilters();
  debugPanel.install();
  document.getElementById('loading')?.remove();
}

void start();
