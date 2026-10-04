/**
 * Loading and drawing the layered character heads.
 *
 * The source PNGs are 2360x1640 with an opaque white background and the drawn
 * head tucked into a small region, and the "closed" artwork sits at a fixed
 * offset from the "opened" artwork. All of that is handled here so scenes just
 * say `new CharacterHead(scene, 'fem', x, y)`.
 *
 * See CLAUDE.md for the measurements behind this.
 */

import Phaser from 'phaser';
import {
  AVATARS, AvatarId, CLOSED_OFFSET, EyeState, FACE_ANCHOR, HEAD_FRAME, HEAD_RECT, HEAD_SCALE,
  allCharacterAssets, layersOf, textureKey,
} from '@/data/characters';
import { CHARACTER_MAX_UPSCALE } from '@/systems/constants';
import { debugPanel } from '@/systems/debug';
import { displaceCanvas } from '@/systems/displace';
import { viewport } from '@/systems/viewport';
import { settings } from '@/systems/SettingsManager';

/**
 * Hair boil (avatar select). The hair layer — the hat for `andro` — has two
 * extra whole-texel-displaced frames per eye state, cycled at ~4 fps so the
 * hairline boils like a redrawn line. Face and eyes stay still. ~1.2 texels is
 * ~1–1.5 device px at the heads' on-screen scale on a 2x display.
 */
const HAIR_BOIL_AMP = 1.2;
const HAIR_BOIL_FPS = 4;
const HAIR_BOIL_FRAMES = 3;

/** Texture key of hair boil frame `v` (0 = the untouched original). */
export function boilKey(base: string, v: number): string {
  return v === 0 ? base : `${base}~${v}`;
}

const isHair = (avatar: AvatarId, layer: string) => layer === layersOf(avatar)[2];

/**
 * Bounding box of each avatar's visible (non-white) pixels across all its
 * layers, in head-frame texels (the frame is HEAD_RECT, so the eyes layer's
 * stray mark is already cropped away). Measured at boot from the actual PNGs;
 * falls back to the whole frame if the art is missing.
 */
const headInk: Partial<Record<AvatarId, { x: number; y: number; w: number; h: number }>> = {};

export function headInkRect(avatar: AvatarId): { x: number; y: number; w: number; h: number } {
  const r = HEAD_RECT[avatar];
  return headInk[avatar] ?? { x: 0, y: 0, w: r.w, h: r.h };
}

/** Grow `avatar`'s ink box to include this layer's non-white pixels. */
function measureInk(avatar: AvatarId, ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 232) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return;
  const b = headInk[avatar];
  if (!b) { headInk[avatar] = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; return; }
  const nx0 = Math.min(b.x, x0), ny0 = Math.min(b.y, y0);
  const nx1 = Math.max(b.x + b.w - 1, x1), ny1 = Math.max(b.y + b.h - 1, y1);
  headInk[avatar] = { x: nx0, y: ny0, w: nx1 - nx0 + 1, h: ny1 - ny0 + 1 };
}

/** Queue every character PNG. Call from a scene's preload(). */
export function preloadCharacters(scene: Phaser.Scene): void {
  for (const a of allCharacterAssets()) {
    scene.load.image(a.key, a.path);
  }
}

function nextPow2(n: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, n)));
}

/**
 * Repack every character texture into a small power-of-two texture holding just
 * the head, copied 1:1 (pixels are never resampled or altered).
 *
 * Why: the source PNGs are 2360x1640. Phaser runs WebGL1, which only builds
 * mipmaps for power-of-two textures, so the raw files would be minified with no
 * mipmaps (aliased, shimmering pencil grain). The repack also frees ~280 MB of
 * GPU memory, because the 18 full-size canvases are dropped once copied.
 *
 * Call once, after loading completes. Afterwards each texture has a `head`
 * frame at (0,0) of size HEAD_RECT[avatar], so the rest of the code is unchanged.
 */
export function registerHeadFrames(scene: Phaser.Scene): void {
  for (const a of allCharacterAssets()) {
    const tex = scene.textures.get(a.key);
    if (!tex || tex.key === '__MISSING' || tex.has(HEAD_FRAME)) continue;

    const r = HEAD_RECT[a.avatar];
    const dx = a.eyes === 'closed' ? CLOSED_OFFSET.x : 0;
    const dy = a.eyes === 'closed' ? CLOSED_OFFSET.y : 0;
    const size = nextPow2(Math.max(r.w, r.h));

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) continue;
    // White padding is a no-op under the MULTIPLY blend the heads use.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(tex.getSourceImage() as CanvasImageSource, r.x + dx, r.y + dy, r.w, r.h, 0, 0, r.w, r.h);
    if (a.eyes === 'opened') measureInk(a.avatar, ctx, r.w, r.h);

    scene.textures.remove(a.key);
    const packed = scene.textures.addCanvas(a.key, canvas);
    packed?.add(HEAD_FRAME, 0, 0, 0, r.w, r.h);

    // Hair boil frames, for both eye states so the boil carries through blinks.
    if (isHair(a.avatar, a.layer)) {
      for (let v = 1; v < HAIR_BOIL_FRAMES; v++) {
        const seed = 500 + v * 37 + AVATARS.indexOf(a.avatar) * 11;   // same field opened & closed
        const key = boilKey(a.key, v);
        if (scene.textures.exists(key)) scene.textures.remove(key);
        scene.textures.addCanvas(key, displaceCanvas(canvas, r.w, r.h, HAIR_BOIL_AMP, seed, 1.4))
          ?.add(HEAD_FRAME, 0, 0, 0, r.w, r.h);
      }
    }
  }
}

/**
 * A character head built from its layers.
 *
 * Blinking swaps EVERY layer from _opened to _closed together, never just the
 * eyes — the layers are authored as a set (see CLAUDE.md).
 */
export class CharacterHead {
  private images: Phaser.GameObjects.Image[] = [];
  private blinkTimer?: Phaser.Time.TimerEvent;
  private state: EyeState = 'opened';
  private unsubscribe?: () => void;
  private baseX: number;
  private baseY: number;
  private baseScale: number;
  /** Largest scale this head is ever asked for; the cap is sized off it so
   *  relative sizes (e.g. the focused head being bigger) survive the cap. */
  private maxScale: number;
  /** Random phases so heads never bob or breathe in step with each other. */
  private idlePhase = Math.random() * Math.PI * 2;
  private shimmerPhase = Math.random() * 1000;
  /** Current hair boil frame, and a random phase so heads boil out of step. */
  private hairFrame = 0;
  private hairPhase = Math.random() * 1000;

  constructor(
    private scene: Phaser.Scene,
    readonly avatar: AvatarId,
    x: number,
    y: number,
    scale = HEAD_SCALE,
    /** `centre`: anchor on the centre of the ink box (avatar frames), not the chin. */
    opts: { maxScale?: number; centre?: boolean } = {},
  ) {
    this.baseX = x;
    this.baseY = y;
    this.baseScale = scale;
    this.maxScale = opts.maxScale ?? scale;
    let anchor = FACE_ANCHOR[avatar];
    if (opts.centre) {
      const ink = headInkRect(avatar), r = HEAD_RECT[avatar];
      anchor = { ox: (ink.x + ink.w / 2) / r.w, oy: (ink.y + ink.h / 2) / r.h };
    }
    for (const layer of layersOf(avatar)) {
      const img = scene.add
        .image(x, y, textureKey(avatar, layer, 'opened'), HEAD_FRAME)
        .setOrigin(anchor.ox, anchor.oy)
        .setScale(this.displayScale());
      // The art is ink on opaque white; multiply keeps the paper showing
      // through and lets the layers actually stack.
      img.setBlendMode(Phaser.BlendModes.MULTIPLY);
      this.images.push(img);
    }

    this.unsubscribe = settings.subscribe(() => this.applyMotionSetting());
    this.applyMotionSetting();
  }

  setDepth(d: number): this {
    this.images.forEach((img, i) => img.setDepth(d + i));
    return this;
  }

  setScaleFactor(s: number): this {
    this.baseScale = s;
    this.images.forEach((img) => img.setScale(this.displayScale()));
    return this;
  }

  /**
   * The requested scale, shrunk if needed so the art is never drawn at more
   * than CHARACTER_MAX_UPSCALE device pixels per source texel. On a 2x screen
   * this makes the heads smaller rather than blurry.
   */
  private displayScale(): number {
    const limit = CHARACTER_MAX_UPSCALE / viewport.zoom;
    return this.baseScale * Math.min(1, limit / this.maxScale);
  }

  setPosition(x: number, y: number): this {
    this.baseX = x;
    this.baseY = y;
    this.images.forEach((img) => img.setPosition(x, y));
    return this;
  }

  setAlpha(a: number): this {
    this.images.forEach((img) => img.setAlpha(a));
    return this;
  }

  /** Swap every layer to the given eye state. */
  setEyes(state: EyeState): void {
    if (this.state === state) return;
    this.state = state;
    this.applyTextures();
  }

  /** Every layer in the current eye state; the hair also in its boil frame. */
  private applyTextures(): void {
    const layers = layersOf(this.avatar);
    this.images.forEach((img, i) => {
      const base = textureKey(this.avatar, layers[i], this.state);
      const key = isHair(this.avatar, layers[i]) ? boilKey(base, this.hairFrame) : base;
      img.setTexture(this.scene.textures.exists(key) ? key : base, HEAD_FRAME);
    });
  }

  /** Set false to drive the eyes by hand (e.g. dozing off). */
  autoBlink = true;

  private applyMotionSetting(): void {
    if (!this.autoBlink) { this.stopBlinking(); return; }
    if (settings.get('reducedMotion')) {
      this.stopBlinking();
      this.setEyes('opened');
    } else {
      this.startBlinking();
    }
  }

  startBlinking(): void {
    if (this.blinkTimer) return;
    const schedule = () => {
      const delay = Phaser.Math.Between(2200, 6000);
      this.blinkTimer = this.scene.time.delayedCall(delay, () => {
        this.blinkOnce(() => {
          // Every so often, a quick double blink — reads as alive, not twitchy.
          if (Phaser.Math.Between(0, 4) === 0) {
            this.scene.time.delayedCall(160, () => this.blinkOnce(schedule));
          } else {
            schedule();
          }
        });
      });
    };
    schedule();
  }

  private blinkOnce(done: () => void): void {
    this.setEyes('closed');
    this.scene.time.delayedCall(120, () => {
      this.setEyes('opened');
      done();
    });
  }

  /**
   * A "happy blink" — eyes closed a little longer, with a small bounce — when
   * this head lands in the centre of the carousel. No bounce under reduced motion.
   */
  happyBlink(): void {
    this.setEyes('closed');
    this.scene.time.delayedCall(380, () => this.setEyes('opened'));
    if (settings.get('reducedMotion')) return;
    const state = { k: 0 };
    this.scene.tweens.add({
      targets: state, k: 1, duration: 420, ease: 'Sine.easeOut',
      onUpdate: () => { this.bounce = Math.sin(state.k * Math.PI) * 0.045; },
      onComplete: () => { this.bounce = 0; },
    });
  }

  /** Extra scale from happyBlink(), applied in update(). */
  private bounce = 0;

  /** Extra rotation / drop (units), e.g. a head drooping as it dozes off. */
  pose = { rot: 0, dy: 0 };

  stopBlinking(): void {
    this.blinkTimer?.remove();
    this.blinkTimer = undefined;
  }

  /**
   * Idle life: a soft bob and a 1-2% breathing scale, plus the optional pencil
   * shimmer. Call every frame from the scene.
   */
  update(timeMs: number): void {
    // Hair boil: stepped, out of sync between heads; none under reduced motion.
    const frame = settings.get('reducedMotion')
      ? 0
      : Math.floor(((timeMs + this.hairPhase) / 1000) * HAIR_BOIL_FPS) % HAIR_BOIL_FRAMES;
    if (frame !== this.hairFrame) {
      this.hairFrame = frame;
      this.applyTextures();
    }

    if (settings.get('reducedMotion')) {
      this.images.forEach((img) => {
        img.setPosition(this.baseX, this.baseY + this.pose.dy);
        img.setScale(this.displayScale());
        img.setRotation(this.pose.rot);
      });
      return;
    }

    const t = timeMs * 0.001 + this.idlePhase;
    const bob = Math.sin(t * 0.9) * 3;
    // Breathe *down* from full size (0.976–1), so breathing never pushes the
    // art past the upscale cap.
    const breathe = 1 - (0.5 + 0.5 * Math.sin(t * 0.62)) * 0.024;

    let dx = 0, dy = 0, rot = 0;
    if (debugPanel.get().characterShimmer) {
      // Held in steps like the line boil rather than jittered per frame:
      // per-frame sub-pixel motion just resamples the line art into mush.
      const step = Math.floor((timeMs + this.shimmerPhase) / 220);
      const h = (n: number) => {
        const v = Math.sin((step + 1) * (12.9898 + n * 4.1414)) * 43758.5453;
        return (v - Math.floor(v)) - 0.5;
      };
      dx = h(0) * 1.2;
      dy = h(1) * 1.2;
      rot = h(2) * 0.0035;
    }

    this.images.forEach((img) => {
      img.setPosition(this.baseX + dx, this.baseY + bob + dy + this.pose.dy);
      img.setScale(this.displayScale() * breathe * (1 + this.bounce));
      img.setRotation(rot + this.pose.rot);
    });
  }

  destroy(): void {
    this.stopBlinking();
    this.unsubscribe?.();
    this.images.forEach((i) => i.destroy());
    this.images = [];
  }
}
