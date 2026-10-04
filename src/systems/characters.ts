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
  AvatarId, CLOSED_OFFSET, EyeState, FACE_ANCHOR, HEAD_FRAME, HEAD_RECT, HEAD_SCALE,
  allCharacterAssets, layersOf, textureKey,
} from '@/data/characters';
import { debugPanel } from '@/systems/debug';
import { settings } from '@/systems/SettingsManager';

/** Queue every character PNG. Call from a scene's preload(). */
export function preloadCharacters(scene: Phaser.Scene): void {
  for (const a of allCharacterAssets()) {
    scene.load.image(a.key, a.path);
  }
}

/**
 * Register the cropped `head` sub-frame on each loaded texture, so nothing
 * downstream deals with the raw canvas. Call once after loading completes.
 */
export function registerHeadFrames(scene: Phaser.Scene): void {
  for (const a of allCharacterAssets()) {
    const tex = scene.textures.get(a.key);
    if (!tex || tex.key === '__MISSING') continue;
    if (tex.has(HEAD_FRAME)) continue;
    const r = HEAD_RECT[a.avatar];
    const dx = a.eyes === 'closed' ? CLOSED_OFFSET.x : 0;
    const dy = a.eyes === 'closed' ? CLOSED_OFFSET.y : 0;
    tex.add(HEAD_FRAME, 0, r.x + dx, r.y + dy, r.w, r.h);
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
  /** Random phases so heads never bob or breathe in step with each other. */
  private idlePhase = Math.random() * Math.PI * 2;
  private shimmerPhase = Math.random() * 1000;

  constructor(
    private scene: Phaser.Scene,
    readonly avatar: AvatarId,
    x: number,
    y: number,
    scale = HEAD_SCALE,
  ) {
    this.baseX = x;
    this.baseY = y;
    this.baseScale = scale;
    const anchor = FACE_ANCHOR[avatar];
    for (const layer of layersOf(avatar)) {
      const img = scene.add
        .image(x, y, textureKey(avatar, layer, 'opened'), HEAD_FRAME)
        .setOrigin(anchor.ox, anchor.oy)
        .setScale(scale);
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
    this.images.forEach((img) => img.setScale(s));
    return this;
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
    const layers = layersOf(this.avatar);
    this.images.forEach((img, i) => {
      img.setTexture(textureKey(this.avatar, layers[i], state), HEAD_FRAME);
    });
  }

  private applyMotionSetting(): void {
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

  stopBlinking(): void {
    this.blinkTimer?.remove();
    this.blinkTimer = undefined;
  }

  /**
   * Idle life: a soft bob and a 1-2% breathing scale, plus the optional pencil
   * shimmer. Call every frame from the scene.
   */
  update(timeMs: number): void {
    if (settings.get('reducedMotion')) {
      this.images.forEach((img) => {
        img.setPosition(this.baseX, this.baseY);
        img.setScale(this.baseScale);
        img.setRotation(0);
      });
      return;
    }

    const t = timeMs * 0.001 + this.idlePhase;
    const bob = Math.sin(t * 0.9) * 3;
    const breathe = 1 + Math.sin(t * 0.62) * 0.012;

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
      img.setPosition(this.baseX + dx, this.baseY + bob + dy);
      img.setScale(this.baseScale * breathe);
      img.setRotation(rot);
    });
  }

  destroy(): void {
    this.stopBlinking();
    this.unsubscribe?.();
    this.images.forEach((i) => i.destroy());
    this.images = [];
  }
}
