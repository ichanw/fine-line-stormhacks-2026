/**
 * AvatarSelectScene — "play as?" (Figma: design/figma/avatar_select.png).
 *
 * A looping carousel of three sketchy, paper-filled frames: the selected one
 * large and centred, the other two either side at ~70%, slightly lower and
 * dimmed. Rotate with the arrow buttons, the keyboard arrows, a click on a side
 * frame, or a swipe. Continue selects the centred avatar.
 *
 * Never labels avatars by gender: accessible names are "Avatar 1/2/3".
 */

import Phaser from 'phaser';
import { music } from '@/systems/music';
import config from '@/data/config.json';
import { AVATARS, AvatarId, accessibleName } from '@/data/characters';
import { A11yProxy, announce, keyboardNav, onNavModeChange, setTabOrder } from '@/systems/a11y';
import { ShadeFill } from '@/systems/shadeFill';
import { Boiler, SketchShape, boxShape, pathShape } from '@/systems/boil';
import { CharacterHead, headInkRect } from '@/systems/characters';
import { PaperBackground } from '@/systems/paper';
import { profile } from '@/systems/profile';
import { gameState, STORY_START } from '@/systems/gameState';
import { settings } from '@/systems/SettingsManager';
import { transitionIn, transitionOut } from '@/systems/transitions';
import { FocusableControl, FocusList, SketchButton } from '@/systems/ui';
import { brushUnderline } from '@/systems/underline';
import { viewport } from '@/systems/viewport';
import {
  BOIL_FPS_UI, COLOR_INK, COLOR_PAPER, COLOR_SELECTED_TEXT, COLOR_STROKE_IDLE,
  SCENE_AVATAR, SCENE_SETTINGS, SCENE_STORY, SCENE_TITLE,
} from '@/systems/constants';

/** Layout, as fractions of the layout height (Figma, measured). */
const L = {
  headingY: 0.115, underlineY: 0.158,
  carouselY: 0.442, frame: 0.37,
  sideScale: 0.7, sideDrop: 0.04, sideAlpha: 0.5, gap: 0.04,
  buttonY: 0.712, buttonW: 0.2, buttonH: 0.056,
};
const ROTATE_MS = 400;
/**
 * Each character's visible pixels (all layers) fill this much of its frame's
 * height, centred both ways (user, 2026-10-04). Same rule in the side frames.
 * Scaled per avatar, so the hat makes that face a little smaller.
 */
const HEAD_FILL = 0.8;

/** One avatar in its frame. Geometry is built at full size, scaled for sides. */
class Card {
  readonly head: CharacterHead;
  readonly frame: SketchShape;
  readonly fill: Phaser.GameObjects.Rectangle;
  readonly zone: Phaser.GameObjects.Zone;
  /** Continuous carousel position: 0 centre, -1 left, +1 right. */
  pos = 0;

  /** Scale at which this character's ink box is HEAD_FILL of the full-size frame. */
  readonly headScale: number;

  constructor(scene: Phaser.Scene, boiler: Boiler, readonly avatar: AvatarId, readonly size: number) {
    const ink = headInkRect(avatar);
    // Height rules; a wide character also keeps its width inside the frame.
    const headScale = Math.min((size * HEAD_FILL) / ink.h, (size * 0.92) / ink.w);
    this.headScale = headScale;
    this.fill = scene.add.rectangle(0, 0, size - 3, size - 3, COLOR_PAPER, 1).setDepth(20);
    this.frame = boiler.add(new SketchShape(scene, boxShape(-size / 2, -size / 2, size, size),
      { color: COLOR_STROKE_IDLE, width: 1.1, alpha: 1 }, { jitter: 1.4, fps: BOIL_FPS_UI, depth: 21 }));
    this.frame.setPivot(0, 0);
    this.head = new CharacterHead(scene, avatar, 0, 0, headScale, { maxScale: headScale, centre: true }).setDepth(22);
    this.zone = scene.add.zone(0, 0, size, size).setInteractive({ useHandCursor: true });
  }

  /** Place at continuous position `p` (beyond ±1 the card slides out and fades). */
  place(p: number, cx: number, cy: number, spacing: number): void {
    this.pos = p;
    const a = Math.min(1, Math.abs(p));
    const k = 1 - (1 - L.sideScale) * a;
    const x = cx + p * spacing;
    const y = cy + viewport.H * L.sideDrop * a;
    // The wrapping card is gone by |p| 1.4, before it reaches the arrows.
    const fade = Math.abs(p) > 1 ? Math.max(0, 1 - (Math.abs(p) - 1) * 2.5) : 1;
    const alpha = (1 - (1 - L.sideAlpha) * a) * fade;
    this.fill.setPosition(x, y).setScale(k).setAlpha(fade);
    this.frame.setOffset(x, y).setDisplayScale(k).setAlpha(alpha);
    // Centred in the frame (the head's anchor is the centre of its ink box).
    this.head.setPosition(x, y);
    this.head.setScaleFactor(this.headScale * k);
    this.head.setAlpha(alpha);
    this.zone.setPosition(x, y).setSize(this.size * k, this.size * k);
    const depth = 20 + Math.round((1 - a) * 10) * 3;   // centre card on top while sliding
    this.fill.setDepth(depth); this.frame.setDepth(depth + 1); this.head.setDepth(depth + 2);
  }

  setFocused(on: boolean): void {
    this.frame.setStyle(on ? { color: COLOR_INK, width: 1.6 } : { color: COLOR_STROKE_IDLE, width: 1.1 });
  }

  update(time: number): void { this.head.update(time); }

  destroy(): void { this.head.destroy(); this.frame.destroy(); this.fill.destroy(); this.zone.destroy(); }
}

/**
 * A hand-drawn chevron arrow button. Like every button it fills on hover,
 * keyboard focus and press: a sketchy graphite box shades in behind the
 * chevron, which turns paper-white; a press also squashes it.
 */
class Arrow implements FocusableControl {
  readonly proxy: A11yProxy;
  private shape: SketchShape;
  private shade: ShadeFill;
  private hovered = false;
  private focused = false;
  private pressing = false;
  private timer?: Phaser.Time.TimerEvent;
  private unsubMode: () => void;

  constructor(private scene: Phaser.Scene, boiler: Boiler, x: number, y: number, dir: -1 | 1, label: string, onActivate: () => void) {
    const s = 26;
    // Like the Figma arrows: a loose open chevron with a slight hook.
    const pts = dir < 0
      ? [{ x: x + s * 0.35, y: y - s }, { x: x - s * 0.55, y: y + s * 0.05 }, { x: x - s * 0.35, y: y + s * 0.45 }, { x: x + s * 0.4, y: y + s * 0.75 }]
      : [{ x: x - s * 0.45, y: y - s * 0.65 }, { x: x + s * 0.55, y: y + s * 0.1 }, { x: x - s * 0.25, y: y + s * 0.8 }];
    const box = { x: x - s * 1.05, y: y - s * 1.2, w: s * 2.1, h: s * 2.2 };
    this.shade = new ShadeFill(scene, box, { depth: 39, inset: 0, onFilledChange: () => this.applyState() });
    this.shape = boiler.add(new SketchShape(scene, pathShape(pts),
      { color: COLOR_INK, width: 1.2, alpha: 0.9 }, { jitter: 1, fps: BOIL_FPS_UI, depth: 40 }));
    this.shape.setPivot(x, y);
    this.proxy = new A11yProxy(scene, {
      label, ...box,
      onActivate: () => { this.press(); onActivate(); },
      onHover: (over) => { this.hovered = over; this.applyState(); },
      onPress: () => this.press(),
    });
    this.unsubMode = onNavModeChange(() => this.applyState());
  }

  private get active(): boolean { return this.hovered || (this.focused && keyboardNav()) || this.pressing; }

  private press(): void {
    this.pressing = true;
    if (!settings.get('reducedMotion')) this.shape.setSquash(0.9, 0.9);
    this.timer?.remove();
    this.timer = this.scene.time.delayedCall(160, () => {
      this.pressing = false;
      this.shape.setSquash(1, 1);
      this.applyState();
    });
    this.applyState();
  }

  private applyState(): void {
    const on = this.active;
    this.shade.set(on);
    this.shape.setStyle(on ? { width: 1.6, alpha: 1 } : { width: 1.2, alpha: 0.9 });
    // Paper-white once the box behind is dark enough.
    if (this.shade.filled) this.shape.object.setTintFill(COLOR_SELECTED_TEXT);
    else this.shape.object.clearTint();
  }

  setFocused(on: boolean): void { this.focused = on; this.applyState(); }
  activate(): void { this.proxy.el.click(); }
  restyle(): void {}
  destroy(): void {
    this.timer?.remove();
    this.unsubMode();
    this.shade.destroy();
    this.shape.destroy();
    this.proxy.destroy();
  }
}

/** The centred card as a single focus stop, named "Avatar N". */
class CentreStop implements FocusableControl {
  readonly proxy: A11yProxy;
  private focused = false;
  constructor(scene: Phaser.Scene, rect: { x: number; y: number; w: number; h: number }, private cardFor: () => Card, onActivate: () => void) {
    this.proxy = new A11yProxy(scene, { label: accessibleName(cardFor().avatar), ...rect, onActivate });
    this.proxy.el.setAttribute('aria-pressed', 'true');
  }
  refresh(): void {
    this.proxy.setLabel(accessibleName(this.cardFor().avatar));
    this.setFocused(this.focused);
  }
  setFocused(on: boolean): void { this.focused = on; this.cardFor().setFocused(on); }
  activate(): void { this.proxy.el.click(); }
  restyle(): void {}
  destroy(): void { this.proxy.destroy(); }
}

interface AvatarData { resized?: boolean; focusIndex?: number; centre?: number }

export class AvatarSelectScene extends Phaser.Scene {
  private boiler = new Boiler();
  private focusList = new FocusList();
  private cards: Card[] = [];
  private paper!: PaperBackground;
  private heading!: Phaser.GameObjects.Text;
  private note!: Phaser.GameObjects.Text;
  private centreStop!: CentreStop;
  /** Index into AVATARS of the centred avatar. */
  private centre = 0;
  private rotating = false;
  private geo = { cx: 0, cy: 0, spacing: 0, size: 0 };
  private runData: AvatarData = {};
  private unsubscribe?: () => void;
  private swipeStart: { x: number; y: number } | null = null;

  constructor() { super(SCENE_AVATAR); }

  init(data: AvatarData): void { this.runData = data ?? {}; }

  create(): void {
    // Camera zoom + device-resolution text; must run before anything is added.
    viewport.attach(this);
    music.forScene('AvatarSelect');   // keeps flowing if it's already playing
    // Reset per-run state — Phaser reuses scene instances.
    this.cards = [];
    this.boiler = new Boiler();
    this.focusList = new FocusList();
    this.rotating = false;
    this.centre = this.runData.centre ?? Math.max(0, AVATARS.indexOf(profile.avatar ?? AVATARS[0]));

    this.paper = new PaperBackground(this);
    if (!this.runData.resized) transitionIn(this);

    const { W, H } = viewport;
    const cx = W / 2;
    this.heading = this.add.text(cx, H * L.headingY, config.avatarSelect.heading, {}).setOrigin(0.5).setDepth(6);
    this.note = this.add.text(cx, H - 22, '', {}).setOrigin(0.5).setDepth(6);
    this.restyle();
    const hb = this.heading.getBounds();
    brushUnderline(this, this.boiler, hb.x - 4, hb.right + 8, H * L.underlineY, 6);

    // Carousel geometry. Narrow windows squeeze the spacing and the frames.
    let size = H * L.frame;
    const sideHalf = (size * L.sideScale) / 2;
    let spacing = size / 2 + H * L.gap + sideHalf;
    const room = W / 2 - 70;                       // leave space for the arrows
    if (spacing + sideHalf > room) {
      const f = room / (spacing + sideHalf);
      size *= f; spacing *= f;
    }
    this.geo = { cx, cy: H * L.carouselY, spacing, size };

    AVATARS.forEach((a) => this.cards.push(new Card(this, this.boiler, a, size)));
    this.cards.forEach((card, i) => {
      card.zone.on('pointerup', () => {
        if (card.pos <= -0.5) this.rotate(-1);
        else if (card.pos >= 0.5) this.rotate(1);
      });
      void i;
    });
    this.layoutCards();

    // Arrows at the far edges, as in Figma (clamped near the carousel on wide screens).
    const arrowOff = Math.min(W / 2 - 40, spacing + sideHalf + 70);
    const prev = new Arrow(this, this.boiler, cx - arrowOff, H * L.carouselY, -1, config.avatarSelect.previous, () => this.rotate(-1));
    const next = new Arrow(this, this.boiler, cx + arrowOff, H * L.carouselY, 1, config.avatarSelect.next, () => this.rotate(1));
    this.centreStop = new CentreStop(this,
      { x: cx - size / 2, y: H * L.carouselY - size / 2, w: size, h: size },
      () => this.cards[this.centre], () => this.choose());   // Enter on the centred avatar = continue

    // Back and Continue as a centred pair under the selected frame: same
    // width, one gap between them (user, 2026-10-04).
    const bw = Math.max(H * L.buttonW * 0.8, 130), bh = Math.max(H * L.buttonH, 40);
    const by = H * L.buttonY - bh / 2, gap = H * 0.03;
    const confirm = new SketchButton(this, {
      x: cx + gap / 2, y: by, w: bw, h: bh, primary: true,
      label: config.avatarSelect.confirm, ariaLabel: 'Continue', fontScale: 1.3, boiler: this.boiler,
      onActivate: () => this.choose(),
    });
    const back = new SketchButton(this, {
      x: cx - gap / 2 - bw, y: by, w: bw, h: bh,
      label: config.avatarSelect.back, ariaLabel: 'Back', fontScale: 1.2, boiler: this.boiler,
      onActivate: () => transitionOut(this, () => this.scene.start(SCENE_TITLE)),
    });

    // Visual order, left to right then down; Tab must follow it too.
    this.focusList.setItems([prev, this.centreStop, next, back, confirm]);
    setTabOrder([prev, this.centreStop, next, back, confirm].map((c) => c.proxy));
    this.bindInput();

    this.unsubscribe = settings.subscribe(() => this.restyle());
    viewport.restartOnResize(this, () => ({ focusIndex: this.focusList.currentIndex, centre: this.centre }));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribe?.();
      this.focusList.destroy();
      this.cards.forEach((c) => c.destroy());
      this.boiler.destroy();
      this.paper.destroy();
    });

    this.focusList.focus(this.runData.focusIndex ?? 1);
  }

  /** Put every card at its slot for the current centre. */
  private layoutCards(): void {
    const { cx, cy, spacing } = this.geo;
    this.cards.forEach((card, i) => card.place(this.slotOf(i), cx, cy, spacing));
  }

  /** -1, 0 or +1: where card i sits relative to the centre, looping. */
  private slotOf(i: number): number {
    const d = (i - this.centre + AVATARS.length) % AVATARS.length;
    return d === 0 ? 0 : d === 1 ? 1 : -1;
  }

  /** Rotate by one: dir -1 brings the left card to the centre, +1 the right. */
  private rotate(dir: -1 | 1): void {
    if (this.rotating) return;
    const from = this.cards.map((_, i) => this.slotOf(i));
    this.centre = (this.centre + dir + AVATARS.length) % AVATARS.length;
    const to = this.cards.map((_, i) => this.slotOf(i));
    const landing = this.cards[this.centre];
    announce(`${accessibleName(landing.avatar)}`);
    this.centreStop.refresh();

    const { cx, cy, spacing } = this.geo;
    if (settings.get('reducedMotion')) {
      // Instant swap with a quick fade.
      this.cameras.main.fadeOut(80, 255, 255, 255);
      this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
        this.layoutCards();
        this.cameras.main.fadeIn(120, 255, 255, 255);
        landing.head.happyBlink();
      });
      return;
    }

    this.rotating = true;
    const state = { p: 0 };
    this.tweens.add({
      targets: state, p: 1, duration: ROTATE_MS, ease: 'Sine.easeInOut',
      onUpdate: () => {
        this.cards.forEach((card, i) => {
          const a = from[i], b = to[i];
          let pos: number;
          if (Math.abs(b - a) <= 1) {
            pos = a + (b - a) * state.p;
          } else {
            // The card that wraps slides out past its side, then in from the other.
            const out = a + Math.sign(a) * 1;            // -1 → -2, +1 → +2
            pos = state.p < 0.5 ? a + (out - a) * (state.p * 2) : -out + (b + out) * ((state.p - 0.5) * 2);
          }
          card.place(pos, cx, cy, spacing);
        });
      },
      onComplete: () => {
        this.rotating = false;
        this.layoutCards();
        landing.head.happyBlink();
      },
    });
  }

  private bindInput(): void {
    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => {
      if (settings.matchesAction('left', e.code)) { this.rotate(-1); e.preventDefault(); }
      else if (settings.matchesAction('right', e.code)) { this.rotate(1); e.preventDefault(); }
      else if (settings.matchesAction('down', e.code)) { this.focusList.move(1); e.preventDefault(); }
      else if (settings.matchesAction('up', e.code)) { this.focusList.move(-1); e.preventDefault(); }
      else if (settings.matchesAction('cancel', e.code)) {
        // Settings is reachable mid-game with Esc.
        transitionOut(this, () => this.scene.start(SCENE_SETTINGS, { returnTo: SCENE_AVATAR }));
        e.preventDefault();
      }
    });
    // Swipe on touch (or a mouse drag) across the carousel.
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => { this.swipeStart = { x: p.worldX, y: p.worldY }; });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      const s = this.swipeStart;
      this.swipeStart = null;
      if (!s) return;
      const dx = p.worldX - s.x, dy = p.worldY - s.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) this.rotate(dx < 0 ? 1 : -1);
    });
  }

  private choose(): void {
    const avatar = AVATARS[this.centre];
    profile.setAvatar(avatar);
    announce(`${accessibleName(avatar)} chosen`);
    this.cards[this.centre].head.happyBlink();
    // A fresh run, starting at the first story scene.
    gameState.reset();
    transitionOut(this, () => this.scene.start(SCENE_STORY, { id: STORY_START, beat: 0 }));
  }

  private restyle(): void {
    const family = settings.fontFamily();
    const ink = settings.inkCss();
    this.heading.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(3.1)}px`, color: ink });
    this.note.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(1)}px`, color: ink });
    this.note.setAlpha(0.65);
    this.focusList.restyle();
  }

  update(time: number, delta: number): void {
    this.boiler.setFrozen(settings.get('reducedMotion'));
    this.boiler.update(time);
    this.paper.update(delta);
    this.cards.forEach((c) => c.update(time));
  }
}
