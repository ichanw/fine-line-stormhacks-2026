/**
 * The hand-brushed underline under screen headings (Figma: under "fine line"
 * and "play as?"): heavy at the left, thinning to a flick at the right.
 */

import Phaser from 'phaser';
import { Boiler, SketchShape, pathShape } from '@/systems/boil';
import { BOIL_FPS_UI, COLOR_INK } from '@/systems/constants';

export function brushUnderline(scene: Phaser.Scene, boiler: Boiler, x0: number, x1: number, y: number, depth: number): SketchShape {
  const w = x1 - x0;
  const pts = [
    { x: x0, y: y + 3 },
    { x: x0 + w * 0.25, y: y + 0.5 },
    { x: x0 + w * 0.55, y: y + 1.5 },
    { x: x0 + w * 0.8, y: y + 0.5 },
    { x: x1, y: y - 5 },       // the flick up at the end
  ];
  return boiler.add(new SketchShape(scene, pathShape(pts),
    { color: COLOR_INK, width: 2.4, alpha: 1 }, { jitter: 1, fps: BOIL_FPS_UI, depth }));
}
