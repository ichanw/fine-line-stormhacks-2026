/**
 * Procedural placeholder art, all drawn in the sketchy graphite style so the
 * game's mood is visible from day one. Each entry registers a key + the PNG
 * filename it will later be replaced by (ArtLoader swaps automatically).
 *
 * Designs are original and deliberately simple: dot eyes, minimal features.
 * The player has NO name and NO distinguishing marks — just "a kid".
 */

import Phaser from 'phaser';
import { registerArt } from './ArtLoader';
import { sketchCircle, sketchLine, sketchPoly, sketchRect, sketchStyle } from './sketchy';
import { COLOR_INK } from '@/config/constants';

/** Helper: a Graphics placed at (x,y) that we draw into in local coords. */
function figureContainer(scene: Phaser.Scene, x: number, y: number, scale: number) {
  const g = scene.add.graphics();
  g.setPosition(x, y);
  g.setScale(scale);
  return g;
}

/** A simple standing kid: round head, dot eyes, a few body strokes. */
function drawPlayer(scene: Phaser.Scene, x: number, y: number, scale: number) {
  const g = figureContainer(scene, x, y, scale);
  const line = sketchStyle({ width: 2, jitter: 1.5, passes: 3, alpha: 0.45 });

  // Head
  sketchCircle(g, 0, -70, 26, line);
  // Dot eyes
  g.fillStyle(COLOR_INK, 0.8);
  g.fillCircle(-9, -72, 2.2);
  g.fillCircle(9, -72, 2.2);
  // Body
  sketchLine(g, 0, -44, 0, 20, line);
  // Arms
  sketchLine(g, 0, -30, -22, -8, line);
  sketchLine(g, 0, -30, 22, -8, line);
  // Legs
  sketchLine(g, 0, 20, -16, 60, line);
  sketchLine(g, 0, 20, 16, 60, line);
  return g;
}

/** A neighbour NPC: slightly taller, a coat suggested by a boxy outline. */
function drawNeighbour(scene: Phaser.Scene, x: number, y: number, scale: number) {
  const g = figureContainer(scene, x, y, scale);
  const line = sketchStyle({ width: 2, jitter: 1.5, passes: 3, alpha: 0.45 });

  sketchCircle(g, 0, -84, 24, line);
  g.fillStyle(COLOR_INK, 0.8);
  g.fillCircle(-8, -86, 2);
  g.fillCircle(8, -86, 2);
  // Coat
  sketchPoly(
    g,
    [
      [-20, -56],
      [20, -56],
      [24, 40],
      [-24, 40],
    ],
    true,
    line,
  );
  // Legs
  sketchLine(g, -10, 40, -12, 74, line);
  sketchLine(g, 10, 40, 12, 74, line);
  return g;
}

/** A spare, wind-bent tree. */
function drawTree(scene: Phaser.Scene, x: number, y: number, scale: number) {
  const g = figureContainer(scene, x, y, scale);
  const trunk = sketchStyle({ width: 3, jitter: 2, passes: 3, alpha: 0.4 });
  const leaves = sketchStyle({ width: 1.5, jitter: 3, passes: 2, alpha: 0.35 });

  sketchLine(g, 0, 60, -6, -40, trunk);
  // Branches
  sketchLine(g, -2, -10, -40, -30, trunk);
  sketchLine(g, -3, -25, 34, -50, trunk);
  // A loose, scratchy canopy
  sketchCircle(g, -40, -40, 22, leaves);
  sketchCircle(g, 36, -60, 26, leaves);
  sketchCircle(g, -6, -60, 24, leaves);
  return g;
}

/** A small house with a pitched roof. */
function drawHouse(scene: Phaser.Scene, x: number, y: number, scale: number) {
  const g = figureContainer(scene, x, y, scale);
  const line = sketchStyle({ width: 2, jitter: 1.5, passes: 3, alpha: 0.4 });

  sketchRect(g, -60, -40, 120, 90, line);
  // Roof
  sketchPoly(
    g,
    [
      [-70, -40],
      [0, -95],
      [70, -40],
    ],
    false,
    line,
  );
  // Door
  sketchRect(g, -16, 8, 32, 42, line);
  // Window
  sketchRect(g, 20, -20, 28, 28, line);
  sketchLine(g, 34, -20, 34, 8, line);
  sketchLine(g, 20, -6, 48, -6, line);
  return g;
}

registerArt({ key: 'player', file: 'player.png', placeholder: drawPlayer });
registerArt({ key: 'npc-neighbour', file: 'npc-neighbour.png', placeholder: drawNeighbour });
registerArt({ key: 'tree', file: 'tree.png', placeholder: drawTree });
registerArt({ key: 'house', file: 'house.png', placeholder: drawHouse });
