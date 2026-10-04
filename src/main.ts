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
import { StoryScene } from '@/scenes/StoryScene';
import { installStoryDebug } from '@/systems/storyDebug';
import { music } from '@/systems/music';
import { TitleScene } from '@/scenes/TitleScene';
import { debugPanel } from '@/systems/debug';
import { settings } from '@/systems/SettingsManager';
import { viewport } from '@/systems/viewport';
import { COLOR_PAPER_CSS } from '@/systems/constants';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  // Backing store starts at device pixels; see systems/viewport.ts.
  ...viewport.gameSize(),
  backgroundColor: COLOR_PAPER_CSS,
  scale: {
    // We size the canvas ourselves (device-pixel exact). FIT would let the
    // browser stretch a fixed 1280x720 buffer, which is what made it blurry.
    mode: Phaser.Scale.NONE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    antialias: true,
    pixelArt: false,
    roundPixels: false,
    // Trilinear filtering for downscaled art. Phaser (WebGL1) only builds
    // mipmaps for power-of-two textures — see characters.ts for the repack.
    mipmapFilter: 'LINEAR_MIPMAP_LINEAR',
  },
  scene: [BootScene, TitleScene, SettingsScene, AvatarSelectScene, StoryScene],
};

async function start(): Promise<void> {
  try {
    // Explicitly load the face at a size we use; document.fonts.ready alone can
    // resolve before a lazily-fetched webfont is actually available.
    await (document as Document).fonts.load("48px 'Nanum Brush Script'");
    await (document as Document).fonts.load("32px 'EB Garamond'");
    await (document as Document).fonts.ready;
  } catch {
    // Offline or blocked — the fallback stack still renders, just not as nicely.
  }

  const game = new Phaser.Game(config);
  viewport.install(game);
  if (import.meta.env.DEV) (window as unknown as { __game: Phaser.Game }).__game = game;
  settings.applyGlobalFilters();
  music.install(game);
  installStoryDebug(game);
  debugPanel.install();
  document.getElementById('loading')?.remove();
}

void start();

// Dev-only probe for the line-boil counters (used by the F1 stats readout and
// by automated checks). Stripped from production builds.
if (import.meta.env.DEV) {
  void import('@/systems/boil').then(({ boilStats }) => {
    (window as unknown as { __boilStats: typeof boilStats }).__boilStats = boilStats;
  });
  void import('@/systems/brushAtlas').then(({ atlasStats }) => {
    (window as unknown as { __atlasStats: typeof atlasStats }).__atlasStats = atlasStats;
  });
}
if (import.meta.env.DEV) {
  // The app's own module instances (a test's dynamic import can get a separate
  // copy after hot reloads).
  void Promise.all([import('@/systems/transitions'), import('@/systems/gameState')]).then(([t, g]) => {
    Object.assign(window, { __inputLocked: t.inputLocked, __gameState: g.gameState });
  });
  void import('@/systems/music').then((m) => {
    Object.assign(window, { __music: m.music });
  });
}
