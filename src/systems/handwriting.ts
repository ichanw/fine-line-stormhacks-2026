/**
 * Reveal a Text object as if it were being written.
 *
 * A geometry mask advances left to right, but quantised into a handful of
 * steps rather than sliding smoothly — so the word arrives in strokes, the way
 * a brush pen lays it down, and a faint nib mark rides the leading edge.
 *
 * Reduced motion shows the text immediately.
 */

import Phaser from 'phaser';
import { SketchShape, pathShape } from '@/systems/boil';
import { settings } from '@/systems/SettingsManager';
import { COLOR_INK } from '@/systems/constants';

export interface HandwriteHandle {
  stop(): void;
}

export function handwriteReveal(
  scene: Phaser.Scene,
  text: Phaser.GameObjects.Text,
  durationMs = 1400,
  onDone?: () => void,
): HandwriteHandle {
  if (settings.get('reducedMotion')) {
    text.setAlpha(1);
    onDone?.();
    return { stop: () => {} };
  }

  const b = text.getBounds();
  const pad = 14;
  const maskG = scene.make.graphics({});
  const mask = maskG.createGeometryMask();
  text.setMask(mask);
  text.setAlpha(1);

  // The nib is a short brush mark, pre-rendered once and slid along.
  const nib = new SketchShape(
    scene, pathShape([{ x: 2, y: b.height * 0.24 }, { x: 6, y: b.height * 0.76 }]),
    { color: COLOR_INK, width: 0.6, alpha: 0.5 }, { jitter: 0.4, depth: text.depth + 1 },
  );
  nib.setVisible(false);
  const state = { p: 0 };
  // Enough steps to read as separate strokes, few enough to still feel written.
  const STEPS = 11;

  const tween = scene.tweens.add({
    targets: state,
    p: 1,
    duration: durationMs,
    ease: 'Sine.easeInOut',
    onUpdate: () => {
      const stepped = Math.ceil(state.p * STEPS) / STEPS;
      maskG.clear();
      maskG.fillStyle(0xffffff);
      maskG.fillRect(b.x - pad, b.y - pad, b.width * stepped + pad, b.height + pad * 2);

      // A faint nib mark at the writing edge.
      nib.setVisible(state.p < 1);
      nib.setOffset(b.x + b.width * stepped, b.y);
    },
    onComplete: () => {
      text.clearMask(true);
      maskG.destroy();
      nib.destroy();
      onDone?.();
    },
  });

  return {
    stop: () => {
      tween.stop();
      text.clearMask(true);
      maskG.destroy();
      nib.destroy();
    },
  };
}
