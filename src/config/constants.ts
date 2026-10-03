/**
 * Global constants for the game. The art direction is strict:
 * the world is monochrome graphite on off-white paper, and the ONLY
 * colour anywhere is the sea/water. Keep all palette decisions here.
 */

export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

/** The paper the whole world is drawn on. */
export const COLOR_PAPER = 0xf4f1ea;
export const COLOR_PAPER_CSS = '#F4F1EA';

/** Graphite line / ink colour. Everything non-water is some grey of this. */
export const COLOR_INK = 0x2b2b2b;
export const COLOR_INK_CSS = '#2B2B2B';

/** The single exception to the monochrome rule: the sea. */
export const COLOR_SEA = 0x3b6ea5;
export const COLOR_SEA_CSS = '#3B6EA5';

/** A few greys for shading, all derived from the ink tone. */
export const GREY_SOFT = 0x7a7772;
export const GREY_FAINT = 0xb8b4ab;

/** Serif face for the hand-made, storybook feel (overridable in settings). */
export const DEFAULT_FONT_FAMILY = "Georgia, 'Times New Roman', serif";
