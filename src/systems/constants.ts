/**
 * Global constants.
 *
 * The world is brush-and-pencil line work on white paper. It is monochrome
 * everywhere EXCEPT the utopian (right) side of the world, which is the only
 * place `COLOR_SEA` is allowed to appear — colour literally marks the better
 * world and drains away toward the dystopian left. See CLAUDE.md.
 */

/**
 * Reference size, NOT the screen size. The screen is `viewport.W x viewport.H`
 * layout units and changes with the window. These are only used to derive the
 * layout unit (720 units tall on a landscape window) and as the local drawing
 * space of art that is then scaled to cover the screen (systems/world.ts).
 */
export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

/** The page. White, per the Figma mockup. */
export const COLOR_PAPER = 0xffffff;
/**
 * The desk the sketchbook lies on — seen only around the edges of a page
 * during the crumple/scrapbook transition. A neutral grey, so the game stays
 * monochrome.
 */
export const COLOR_DESK = 0xdcdad6;
/** Masking tape in the scrapbook transitions — a light grey, so it reads on white. */
export const COLOR_TAPE = 0xd9d6cf;
export const COLOR_PAPER_CSS = '#FFFFFF';

/** Ink. Near-black brush/pencil line. */
export const COLOR_INK = 0x1a1a1a;
export const COLOR_INK_CSS = '#1A1A1A';

/**
 * Resting UI stroke: thin and grey until hovered/focused. Darker than a flat
 * line would need, because the pencil brush's grain lightens it (approved in
 * the brush lab: mean ~183/255).
 */
export const COLOR_STROKE_IDLE = 0x6e6e6e;
export const COLOR_STROKE_IDLE_CSS = '#6E6E6E';

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

/**
 * The filled look (user spec, 2026-10-04): on hover, keyboard focus, press,
 * or as the currently chosen option, a control is shaded in solid near-black
 * graphite and its text turns paper-white.
 */
export const COLOR_SELECTED_FILL = 0x1a1a1a;
export const COLOR_SELECTED_FILL_CSS = '#1A1A1A';
export const COLOR_SELECTED_TEXT_CSS = '#F4F1EA';
export const COLOR_SELECTED_TEXT = 0xf4f1ea;
/** How long the fill takes to shade in. */
export const SELECT_FILL_MS = 150;

/**
 * All visible UI text is lowercase (user, 2026-10-04), the title "fine line"
 * included. Accessible names stay sentence case and are set explicitly with
 * `ariaLabel`.
 */
export function uiText(s: string): string { return s.toLowerCase(); }

export const FONT_BRUSH = "'Nanum Brush Script', 'Bradley Hand', cursive";
/** Narration and story text (Figma story frames; user, 2026-10-04). */
export const FONT_SERIF = "'EB Garamond', Garamond, 'Times New Roman', serif";
/** Stack chosen for dyslexia-friendliness; overrides the brush face entirely. */
export const FONT_DYSLEXIC =
  "'OpenDyslexic', 'Comic Sans MS', 'Trebuchet MS', Verdana, sans-serif";

export const SCENE_BOOT = 'Boot';
export const SCENE_TITLE = 'Title';
export const SCENE_SETTINGS = 'Settings';
export const SCENE_AVATAR = 'AvatarSelect';
/** Placeholder for the first story screen (the story isn't written yet). */
export const SCENE_STORY = 'Story';

/**
 * Line-boil timing (src/systems/boil.ts). UI boils slower than scenery
 * (user, 2026-10-03), and stays at that slow rate on hover (2026-10-04).
 */
export const BOIL_FPS_SCENERY = 4;
export const BOIL_FPS_UI = 2;
export const BOIL_VARIANTS = 3;

/**
 * Upscale caps, in device pixels per source texel. The source heads are only
 * ~235–275 x 312–330 px. Characters: 2x (user, 2026-10-04) so they can fill
 * ~80% of the avatar frame on Retina screens (needs ~1.9x there; visibly a
 * little soft until the art is re-exported at higher resolution). Title art:
 * 1.5x (2026-10-03), enough for the tree group to fill the bottom-right.
 */
export const CHARACTER_MAX_UPSCALE = 2;
export const TITLE_ART_MAX_UPSCALE = 1.5;
