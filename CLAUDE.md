# Fine-Line -- a climate narrative story

A short narrative game about climate change. Everyday choices shape the world.
Phaser 3 + TypeScript + Vite. No backend.

## Commands

```bash
npm run dev      # vite dev server on :5173
npm run build    # tsc --noEmit && vite build
npm run preview  # serve the production build
```

## Layout

```
src/scenes/     Boot, Title, Settings, AvatarSelect, Story (every story screen)
src/systems/    SettingsManager, art/character loading, drawing helpers, UI widgets
src/data/       config.json and other content data — NEVER hardcode copy in a scene
public/art/     image assets (characters/ holds the layered heads)
public/audio/   audio assets
```

`@/` is aliased to `src/` (see [vite.config.ts](vite.config.ts) and [tsconfig.json](tsconfig.json)).

## Art direction

The world is **monochrome graphite on off-white paper**. The ONLY colour
anywhere is the sea/water (`#3B6EA5`). All palette decisions live in
[src/systems/constants.ts](src/systems/constants.ts) — add colours there, not inline.

- LINE BOIL: all procedurally drawn lines (buttons, boxes, loading bar, UI, filler art) gently
  "boil" like hand-drawn animation — cycle between 3 pre-generated jittered versions of each
  line at ~4 fps. Slow and subtle, never jittery.
- UI boxes/buttons: sketchy, NON-solid (no fill or only a faint paper tint), ONE single
  stroke only — never double borders or multi-pass outlines on UI.
- Button hover AND keyboard focus (always identical): outline darkens and thickens slightly,
  and the line moves (boils faster, as if being re-sketched).
- Everything should feel slightly alive: idle motion on most elements, nothing fully static.
- Reduced motion: no boil, no idle motion; hover = darker/thicker outline only.
- Visual design source of truth: Figma exports in /design/figma/. Match layout, spacing,
  type and hierarchy from these. Where Figma conflicts with CLAUDE.md style rules, ask me.

## Character art

Head-only **layered PNGs** in `public/art/characters/`.

- **Naming:** `{avatar}_{layer}_eyes_{opened|closed}.png`
- **Avatars:** `masc`, `fem`, `andro`
- **Layers, bottom → top:** `face`, `eyes`, `hair` — except `andro`, which uses
  `hat` instead of `hair`.
- **Blinking:** swap **every** layer of that avatar from `_opened` to `_closed`
  together, then back. Never swap only the eyes layer.

That is 3 avatars x 3 layers x 2 states = **18 files**, all present.

### Non-obvious facts about these files (verified, not assumed)

These were measured from the actual PNGs. Re-measure before trusting them if the
art is ever redrawn.

1. **Every file is 2360x1640**, and the drawn head occupies only a small region
   of that canvas. Each avatar sits at a *different* canvas position.
2. **The PNGs are opaque white, not transparent.** Alpha is 255 everywhere.
   Stacking them naively hides every layer but the top one. Layers must be drawn
   with **multiply blending** (`Phaser.BlendModes.MULTIPLY`), which turns white
   into a no-op and keeps the pencil texture over paper.
3. **`_closed` is NOT aligned with `_opened`.** The whole closed set is drawn at
   an offset of exactly **(+1090, -20)** from the opened set. Blink code must
   compensate, or heads jump. `CLOSED_OFFSET` in
   [src/data/characters.ts](src/data/characters.ts) is the single source of truth.
4. **`face` and `hair`/`hat` are pixel-identical between opened and closed** —
   only `eyes` actually differs. Swapping all layers (per the rule above) is still
   correct and stays correct if the art is redrawn; do not "optimise" it away.
5. Layers are only mutually aligned **within one state**. Within a state they
   share a canvas, so one crop rect per avatar works for all three of its layers.
6. `fem_eyes_eyes_opened.png` has a **stray pencil mark** outside the head box.
   Cropping to the avatar's head rect removes it. Don't compute bounds from the
   `eyes` layer — derive them from `face` + `hair`/`hat`.

Crop rects (in *opened* coordinates; add `CLOSED_OFFSET` for closed) live in
[src/data/characters.ts](src/data/characters.ts) as `HEAD_RECT`. Boot registers a
cropped sub-frame per texture so scenes never deal with the raw 2360x1640 canvas.

## Avatar select

- **Never label avatars by gender.** The screen shows no "masc"/"fem"/"andro" text.
  Players choose by look alone.
- Accessible names are **"Avatar 1" / "Avatar 2" / "Avatar 3"**, in that order.
- `masc`/`fem`/`andro` are internal asset keys only. They must not reach the UI.

## Accessibility is a requirement, not a feature

Everything must be fully usable by **mouse alone** and by **keyboard alone**
(arrows/Tab to move, Enter/Space to activate). Every focusable control needs a
visible focus outline.

All of the following are player settings and must be respected wherever relevant:

- **Reduced motion** — ambient motion (sea, clouds, loading bar sketching, text
  cycling) must become static. Check `settings.get('reducedMotion')` before
  animating anything decorative.
- **Text size** (S/M/L/XL), **dyslexia-friendly font**, **high contrast**,
  **brightness**, **water visibility pattern** (adds a hatch pattern to water so
  it does not rely on colour alone).
- **Captions default to ON.**

Settings are global, persisted to `localStorage`, and emit change events —
scenes subscribe and restyle live rather than reading values once at create().

Settings must be reachable mid-game with **Esc**. Launch it with
`{ returnTo: <sceneKey> }` so it knows where to go back to.

## Scene gotchas

**Phaser reuses a scene instance across `scene.start()`.** Instance fields
initialised at declaration (`private items: X[] = []`) are NOT reset on restart.
Always reset per-run state at the top of `create()`, or the second visit will
operate on destroyed objects from the first:

```ts
create(): void {
  this.items = [];       // required — not optional
  this.selectedIndex = 0;
}
```

Getting this wrong throws `Cannot read properties of null (reading 'drawImage')`
from deep inside Phaser's text renderer, which does not obviously point back here.

## Story, game state, scoring, outcomes

- **One data-driven scene** ([src/scenes/StoryScene.ts](src/scenes/StoryScene.ts)) plays every story
  screen. Content lives in data only:
  - [src/data/story.json](src/data/story.json): scene order, art, beats, box positions (Figma frame px,
    frames are 2880x2048), ambient fx.
  - [src/data/dialogue.json](src/data/dialogue.json): ALL story text. `[placeholder]` marks text the user
    hasn't written. Never invent plot.
  - [src/data/choices.json](src/data/choices.json): choices, scores, outcome bands (approved 2026-10-04).
- **Flow:** house (commute choice) → bike | car | bus interior → lunch → packed | buy | takeout →
  classroom → lecture question → answer → doze → outcome → finale → ending reflection → end card →
  play again. The ending reflection (once, at the very end) is one paragraph: the outcome's template with
  {choices} filled from the commute and lunch picks (`systems/reflection.ts`; bad = negative-score picks,
  good = positive, neutral = both; each choice's `fragment` in choices.json). Nothing is shown after
  individual choices. (The bus-stop
  scene was removed 2026-10-04.)
- **State** ([src/systems/gameState.ts](src/systems/gameState.ts)): `player.avatar` (from the profile),
  `player.score`, choices, current scene/beat (Esc → Settings returns to the same beat). Outcome: score ≥ 3
  good, ≤ −2 bad, otherwise neutral. "play again" calls `gameState.reset()`.
- **Art:** the user's flattened frames in `public/art/scenes/<scene>/frame.png` (house has one per avatar).
  Loaded per scene and downscaled to device resolution ([sceneArt.ts](src/systems/sceneArt.ts)); line
  boil on raster frames is a whole-pixel GPU displacement at 4 fps ([frameFx.ts](src/systems/frameFx.ts)).
  Moving parts that only exist inside a frame (bus handles, cars) are lifted out by their ink at load.
  Everything else alive (birds, leaves, smoke, smog, litter, traffic, walkers, sparkles) is generated in
  the pencil style ([ambient.ts](src/systems/ambient.ts)).
- **Fit:** story frames fit inside the window (letterboxed) EXCEPT outcome and finale (`"fit": "extend"`).
  Those are NEVER zoomed (user, 2026-10-04). The art keeps its native fit, anchored to the bottom, and the
  rest of the window is filled by:
  - a wider version of the art (`<art>_wide.png` in the same folder) if one exists; otherwise
  - generated pencil city, layer by layer (`extendCity`): ridge and sky shading, buildings in the outcome's
    character (good: clean towers with rooftop trees; neutral: ordinary blocks with scribbled windows;
    bad: smokestacks and ruins), the tree row (bare trees for bad), ground, road and pavement. Each seam
    gets a soft hatched band.

  Effects use `viewFrame()` (the visible window in frame px). FrameFX runs on the whole world container.
- **Crowd extension: whole figures only.** Never slice, tile or mirror strips of people, and never use
  solid rectangles as filler. Your crowd is one connected dark mass, so figures can't be extracted from
  it automatically. Figures come from `person_1..6.png` in the outcome folder if present; otherwise they
  are generated head-and-shoulders silhouettes:
  - front row near-black, back row grey, with a crayon edge;
  - back row drawn first, front row over it;
  - bodies run off the bottom of the screen.

  Your crowd band is feathered for ~110 px at each extended edge, and one front figure straddles each
  seam. The same rule applies to everything extended: trees, buildings, cars and birds are generated as
  whole objects.
- **Choice panel:** choices are paper cards resting ON the narration box's right edge (~13% overlap),
  each with a drop shadow and a ±1–2° tilt; the narration reflows clear of them. No connector lines.
- **Bus:** only the handle LOOPS swing (cut as elliptical rings, `ring`; the window lines they cross are
  redrawn). Layer order: window scenery → window frames → handles. Each handle's drawn band (`band`) is
  fully opaque, so nothing shows through it; only the hole in the middle is see-through. The window
  scenery is loose pencil: multi-pass, overshooting strokes, light hatching and scribbled windows
  (`sketchLine`, `sketchPath` and `scribbleMark` in sketchKit.ts). Far layers are fainter. Generated scenery scrolls past inside the window interiors (`windows`, parallax: buildings
  slow, trees/lamps mid, poles + wires fast), plus a shared bump with each lurch.
- **Car:** each whole car is lifted out (all ink reaching its `core` box, within a padded rect) and drives
  toward the vanishing point, fading and looping. Wheels can't spin: they aren't separate from the body.
- **Narration text is serif** (EB Garamond; the dyslexia font replaces it). Choice buttons use the shared
  black-fill look. Boxes sit exactly over the boxes baked into the frames and grow upward at large text
  sizes.
- **Placeholders (no art yet):** classroom (reuses the lecture-hall frame), the player's face while dozing
  (a vignette of their head), neutral/bad cities (generated over the good city frame), end card.
- **F1 → Story:** jump to any scene, set avatar, set score, force outcome.

## Soundtrack

[src/systems/music.ts](src/systems/music.ts) + [src/data/audio.json](src/data/audio.json). One long-lived
player on Phaser's Web Audio context; scenes call `music.forScene(key)` and an already-playing track just
keeps flowing (it never restarts between scenes; Settings isn't mapped, so it keeps whatever plays).

- `ticking_softly`: Boot/loading → title → avatar → every story scene through doze.
  `suspended_in_the_static`: outcome, finale, end.
- Handover: as the dozing eyes close, ticking fades out (3 s); the dream track fades in as the outcome
  appears (2 s). "play again" fades the dream track out and restarts ticking from the top.
- Fades are equal-power curves on the audio clock. Volume = master × music sliders, live; routed through
  Phaser's master node (so `game.sound.mute` applies). Audible from the first click (autoplay policy).
- Looping: each file ends in ~1.5 s of silence after an ~8 s fade-out, and starts with a quiet intro. The
  player trims the silence and starts the next pass 3 s (`crossfade`) before the end, so there is never a
  silent gap, but the level still dips 20–33 dB for ~10 s at each loop, because the tracks are composed as
  whole pieces. Loop-ready exports (no intro/outro) would fix it with no code change.
