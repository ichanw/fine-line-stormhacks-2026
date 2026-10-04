/**
 * The layered character heads.
 *
 * Naming on disk: {avatar}_{layer}_eyes_{opened|closed}.png in
 * public/art/characters/. See CLAUDE.md for the measured facts behind the
 * constants below — in particular that the source PNGs are opaque white (so
 * layers must be drawn with MULTIPLY) and that the whole "closed" set is drawn
 * at an offset from the "opened" set.
 */

export const AVATARS = ['masc', 'fem', 'andro'] as const;
export type AvatarId = (typeof AVATARS)[number];

export type EyeState = 'opened' | 'closed';

/** Bottom → top. `andro` wears a hat where the others have hair. */
export function layersOf(avatar: AvatarId): readonly string[] {
  return avatar === 'andro' ? ['face', 'eyes', 'hat'] : ['face', 'eyes', 'hair'];
}

/**
 * The "closed" artwork is drawn on a different part of the shared canvas than
 * the "opened" artwork. Measured as exactly this, uniform across all 18 files.
 * Without this compensation, heads visibly jump on every blink.
 */
export const CLOSED_OFFSET = { x: 1090, y: -20 } as const;

/**
 * Head bounding box per avatar, in *opened* canvas coordinates, derived from the
 * face + hair/hat layers (the eyes layer contains a stray mark on `fem`).
 * Cropping to this both trims the mostly-empty 2360x1640 canvas and removes the
 * stray.
 */
export const HEAD_RECT: Record<AvatarId, { x: number; y: number; w: number; h: number }> = {
  masc: { x: 139, y: 177, w: 235, h: 312 },
  fem: { x: 436, y: 174, w: 258, h: 314 },
  andro: { x: 768, y: 161, w: 275, h: 330 },
};


/**
 * Where the face sits inside HEAD_RECT, as a normalised origin.
 *
 * The three avatars are drawn at the same scale (every face layer is ~217px
 * wide) and share a chin baseline at y~=488, but each sits at a different spot
 * on the canvas and `andro`'s hat makes its box taller. Anchoring on
 * (face centre x, chin y) instead of the crop box makes all three line up at a
 * single uniform scale.
 */
export const FACE_ANCHOR: Record<AvatarId, { ox: number; oy: number }> = {
  masc: { ox: 121.5 / 235, oy: 311 / 312 },
  fem: { ox: 127 / 258, oy: 313 / 314 },
  andro: { ox: 137 / 275, oy: 329 / 330 },
};

/** Shared display scale: source art is ~2.6x the size we draw heads at. */
export const HEAD_SCALE = 0.62;

/** Texture key for one layer image. */
export function textureKey(avatar: AvatarId, layer: string, eyes: EyeState): string {
  return `char-${avatar}-${layer}-${eyes}`;
}

/** Path under public/ for one layer image. */
export function texturePath(avatar: AvatarId, layer: string, eyes: EyeState): string {
  return `art/characters/${avatar}_${layer}_eyes_${eyes}.png`;
}

/** The cropped sub-frame Boot registers on every character texture. */
export const HEAD_FRAME = 'head';

/** Every (avatar, layer, eyes) triple — used by the preloader. */
export function allCharacterAssets(): Array<{
  avatar: AvatarId;
  layer: string;
  eyes: EyeState;
  key: string;
  path: string;
}> {
  const out = [];
  for (const avatar of AVATARS) {
    for (const layer of layersOf(avatar)) {
      for (const eyes of ['opened', 'closed'] as EyeState[]) {
        out.push({ avatar, layer, eyes, key: textureKey(avatar, layer, eyes), path: texturePath(avatar, layer, eyes) });
      }
    }
  }
  return out;
}

/**
 * Accessible names. Deliberately positional — the avatar select screen must
 * never label these by gender. See CLAUDE.md.
 */
export function accessibleName(avatar: AvatarId): string {
  return `Avatar ${AVATARS.indexOf(avatar) + 1}`;
}
