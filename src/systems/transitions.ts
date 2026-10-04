/**
 * Scene transitions: a pencil sweep rather than a plain fade.
 *
 * The screen is covered by a bank of short graphite strokes that sweep across
 * the page, as if someone scribbled over the drawing; the next scene then
 * uncovers the same way. Under reduced motion this collapses to a plain fade.
 */

import Phaser from 'phaser';
import { settings } from '@/systems/SettingsManager';
import { GAME_HEIGHT, GAME_WIDTH } from '@/systems/constants';

interface Stroke { x: number; y: number; len: number; angle: number; width: number; alpha: number }

const FADE_RGB = [255, 255, 255] as const;

/** A fixed bank of scribble strokes covering the page, ordered left to right. */
function buildStrokes(): Stroke[] {
  const strokes: Stroke[] = [];
  const cols = 46;
  for (let c = 0; c < cols; c++) {
    const x = (c / cols) * (GAME_WIDTH + 160) - 80;
    const per = 16;
    for (let i = 0; i < per; i++) {
      strokes.push({
        x: x + (Math.random() - 0.5) * 54,
        y: (i / per) * GAME_HEIGHT + (Math.random() - 0.5) * 48,
        len: 70 + Math.random() * 130,
        angle: -1.25 + (Math.random() - 0.5) * 0.5,
        width: 7 + Math.random() * 16,
        alpha: 0.5 + Math.random() * 0.5,
      });
    }
  }
  return strokes.sort((a, b) => a.x - b.x);
}

function drawUpTo(g: Phaser.GameObjects.Graphics, strokes: Stroke[], progress: number): void {
  g.clear();
  const edge = progress * (GAME_WIDTH + 200) - 100;
  for (const s of strokes) {
    if (s.x > edge) break;
    // Soften the leading edge so the sweep has a ragged, drawn-in border.
    const near = Phaser.Math.Clamp((edge - s.x) / 90, 0, 1);
    g.lineStyle(s.width, 0x1a1a1a, s.alpha * near * 0.85);
    g.beginPath();
    g.moveTo(s.x, s.y);
    g.lineTo(s.x + Math.cos(s.angle) * s.len, s.y + Math.sin(s.angle) * s.len);
    g.strokePath();
  }
}

/** Cover the screen, then run `onDone` (typically scene.start). */
export function pencilWipeOut(scene: Phaser.Scene, onDone: () => void): void {
  if (settings.get('reducedMotion')) {
    scene.cameras.main.fadeOut(200, ...FADE_RGB);
    scene.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, onDone);
    return;
  }
  const g = scene.add.graphics().setDepth(10000).setScrollFactor(0);
  const strokes = buildStrokes();
  const state = { p: 0 };
  scene.tweens.add({
    targets: state,
    p: 1.1,
    duration: 460,
    ease: 'Cubic.easeIn',
    onUpdate: () => drawUpTo(g, strokes, state.p),
    onComplete: () => { onDone(); },
  });
}

/** Start covered and uncover. Call from the incoming scene's create(). */
export function pencilWipeIn(scene: Phaser.Scene): void {
  if (settings.get('reducedMotion')) {
    scene.cameras.main.fadeIn(200, ...FADE_RGB);
    return;
  }
  const g = scene.add.graphics().setDepth(10000).setScrollFactor(0);
  const strokes = buildStrokes();
  const state = { p: 1.1 };
  drawUpTo(g, strokes, state.p);
  scene.tweens.add({
    targets: state,
    p: 0,
    duration: 460,
    ease: 'Cubic.easeOut',
    onUpdate: () => drawUpTo(g, strokes, state.p),
    onComplete: () => g.destroy(),
  });
}
