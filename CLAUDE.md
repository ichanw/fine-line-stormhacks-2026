# climate-game

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
src/scenes/     Boot, Title, Settings, AvatarSelect
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
