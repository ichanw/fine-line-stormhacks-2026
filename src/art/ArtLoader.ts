/**
 * ArtLoader — the bridge between placeholder art and real art.
 *
 * Every visual asset is registered with a key, the PNG filename it *will*
 * eventually have in /public/art/, and a procedural placeholder that draws
 * the same thing in the sketchy graphite style. At runtime:
 *   - during preload we attempt to load each PNG (failures are silent);
 *   - when a scene wants the asset, `place()` uses the PNG if it loaded and
 *     otherwise calls the placeholder. Drop a PNG into /public/art/ and it is
 *     picked up automatically with no code change.
 */

import Phaser from 'phaser';

/**
 * A placed asset — either an Image (real PNG) or a Graphics (placeholder).
 * Typed as the components both share so callers can position / depth-sort /
 * tween it uniformly.
 */
export type PlacedArt = Phaser.GameObjects.GameObject &
  Phaser.GameObjects.Components.Depth &
  Phaser.GameObjects.Components.Transform &
  Phaser.GameObjects.Components.Visible;

/** A placeholder draws itself onto a fresh Graphics centred at (x, y). */
export type PlaceholderFn = (
  scene: Phaser.Scene,
  x: number,
  y: number,
  scale: number,
) => PlacedArt;

export interface ArtEntry {
  key: string;
  /** Filename inside /public/art/ (see README.md there). */
  file: string;
  placeholder: PlaceholderFn;
}

const registry = new Map<string, ArtEntry>();

/** Register an art asset. Called from placeholders.ts at module load. */
export function registerArt(entry: ArtEntry): void {
  registry.set(entry.key, entry);
}

export function allArtEntries(): ArtEntry[] {
  return [...registry.values()];
}

/**
 * Queue every registered PNG for loading. Missing files simply never create
 * a texture, so `place()` falls back to the placeholder. We swallow the
 * loader's error events so a not-yet-drawn asset isn't noisy in the console.
 */
export function preloadArt(scene: Phaser.Scene): void {
  const expected = new Set(registry.keys());
  scene.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
    if (expected.has(file.key)) {
      // Expected during development before real art is dropped in. Ignore.
    }
  });
  for (const entry of registry.values()) {
    scene.load.image(entry.key, `art/${entry.file}`);
  }
}

/**
 * Add the asset to the scene. Returns a GameObject either way so callers can
 * position / tween it uniformly.
 *
 * @param scale multiplier applied to both the PNG image and the placeholder.
 */
export function placeArt(
  scene: Phaser.Scene,
  key: string,
  x: number,
  y: number,
  scale = 1,
): PlacedArt {
  const entry = registry.get(key);
  if (scene.textures.exists(key)) {
    const img = scene.add.image(x, y, key);
    img.setScale(scale);
    return img;
  }
  if (entry) {
    return entry.placeholder(scene, x, y, scale);
  }
  // Unknown key: draw a visible marker rather than failing silently.
  const g = scene.add.graphics();
  g.lineStyle(2, 0xff0000, 1).strokeRect(x - 20, y - 20, 40, 40);
  return g;
}

/** True when a real PNG has been loaded for this key. */
export function hasRealArt(scene: Phaser.Scene, key: string): boolean {
  return scene.textures.exists(key);
}
