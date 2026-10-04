/**
 * Global constants.
 *
 * The world is brush-and-pencil line work on white paper. It is monochrome
 * everywhere EXCEPT the utopian (right) side of the world, which is the only
 * place `COLOR_SEA` is allowed to appear — colour literally marks the better
 * world and drains away toward the dystopian left. See CLAUDE.md.
 */

export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

/** The page. White, per the Figma mockup. */
export const COLOR_PAPER = 0xffffff;
export const COLOR_PAPER_CSS = '#FFFFFF';

/** Ink. Near-black brush/pencil line. */
export const COLOR_INK = 0x1a1a1a;
export const COLOR_INK_CSS = '#1A1A1A';

/** Resting UI stroke: thin and grey until hovered/focused. */
export const COLOR_STROKE_IDLE = 0x8a8a8a;
export const COLOR_STROKE_IDLE_CSS = '#8A8A8A';

/** Greys for shading and filler line work. */
export const GREY_SOFT = 0x6f6f6f;
export const GREY_FAINT = 0xb4b4b4;

/**
 * The single colour in the game, reserved for the utopian side. Never use it
 * for UI, text or the dystopian half.
 */
export const COLOR_SEA = 0x3b6ea5;
export const COLOR_SEA_CSS = '#3B6EA5';

/** High-contrast overrides. */
export const COLOR_INK_HC_CSS = '#000000';

export const FONT_BRUSH = "'Nanum Brush Script', 'Bradley Hand', cursive";
/** Stack chosen for dyslexia-friendliness; overrides the brush face entirely. */
export const FONT_DYSLEXIC =
  "'OpenDyslexic', 'Comic Sans MS', 'Trebuchet MS', Verdana, sans-serif";

export const SCENE_BOOT = 'Boot';
export const SCENE_TITLE = 'Title';
export const SCENE_SETTINGS = 'Settings';
export const SCENE_AVATAR = 'AvatarSelect';

/** Line-boil timing. See src/systems/boil.ts. */
export const BOIL_FPS_IDLE = 4;
export const BOIL_FPS_HOVER = 10;
export const BOIL_VARIANTS = 3;
