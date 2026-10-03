# Art drop-in folder

Real hand-drawn art goes here as **PNG files with transparent backgrounds**.
The code looks for each filename below; if the PNG is present it is used
automatically, and if it is missing the game draws a procedural sketchy
placeholder instead. **No code changes are needed** — just drop the file in.

## Art direction (must match)

- Hand-drawn **graphite / pencil** look, soft sketchy lines.
- Drawn on off-white paper `#F4F1EA`; lines in graphite `#2B2B2B`.
- Everything is **monochrome** (greys). The **only** colour allowed anywhere
  is the sea/water `#3B6EA5`. Do not colour anything else.
- Simple faces: dot eyes, minimal features. All designs original.
- The main character has **no name** and no distinguishing marks — just a kid.

## Expected files

| Filename             | Key             | What it is                                  | Suggested size |
| -------------------- | --------------- | ------------------------------------------- | -------------- |
| `player.png`         | `player`        | The nameless main character, standing       | ~140×220       |
| `npc-neighbour.png`  | `npc-neighbour` | A neighbour NPC in a coat                    | ~140×240       |
| `tree.png`           | `tree`          | A spare, wind-bent tree                      | ~160×200       |
| `house.png`          | `house`         | A small house with a pitched roof            | ~220×220       |

Transparent PNG, roughly centred on its subject. The engine places art by its
centre point, so keep the subject centred in the canvas. Oversized images are
fine — scale is applied in code per placement.

## Adding a new asset

1. Add a `registerArt({ key, file, placeholder })` entry in
   `src/art/placeholders.ts` (give it a procedural placeholder).
2. Reference it in a scene with `placeArt(scene, key, x, y, scale)`.
3. Drop `key`'s PNG here when the real art is ready.
