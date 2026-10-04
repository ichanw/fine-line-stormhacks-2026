/**
 * AvatarSelectScene — pick a look.
 *
 * This screen NEVER labels the avatars by gender: no "masc"/"fem"/"andro" text
 * reaches the UI. Players choose by look, and the accessible names are
 * positional ("Avatar 1", "Avatar 2", "Avatar 3"). See CLAUDE.md.
 *
 * Each head blinks, bobs and breathes on its own random phase, so the three
 * never move in step.
 */

import Phaser from 'phaser';
import config from '@/data/config.json';
import { AVATARS, AvatarId, accessibleName } from '@/data/characters';
import { A11yProxy, announce } from '@/systems/a11y';
import { Boiler, SketchShape, lineShape } from '@/systems/boil';
import { CharacterHead } from '@/systems/characters';
import { PaperBackground } from '@/systems/paper';
import { profile } from '@/systems/profile';
import { settings } from '@/systems/SettingsManager';
import { pencilWipeIn, pencilWipeOut } from '@/systems/transitions';
import { FocusableControl, FocusList, SketchButton } from '@/systems/ui';
import {
  BOIL_FPS_HOVER, BOIL_FPS_IDLE, COLOR_INK, COLOR_STROKE_IDLE,
  GAME_HEIGHT, GAME_WIDTH, SCENE_AVATAR, SCENE_SETTINGS, SCENE_TITLE,
} from '@/systems/constants';
import { debugPanel } from '@/systems/debug';

const BASE_SCALE = 0.78;
const SELECTED_SCALE = 0.88;
const HEAD_Y = 430;

class AvatarChoice implements FocusableControl {
  readonly proxy: A11yProxy;
  readonly head: CharacterHead;
  private underline: SketchShape;
  private focused = false;

  constructor(
    scene: Phaser.Scene,
    readonly avatar: AvatarId,
    cx: number,
    boiler: Boiler,
    private onChoose: (a: AvatarId) => void,
    private onFocusChoice: (a: AvatarId) => void,
  ) {
    this.head = new CharacterHead(scene, avatar, cx, HEAD_Y, BASE_SCALE).setDepth(5);
    this.underline = boiler.add(new SketchShape(
      scene, lineShape(cx - 84, HEAD_Y + 24, cx + 84, HEAD_Y + 24),
      { color: COLOR_STROKE_IDLE, width: 1, alpha: 1 },
      { jitter: 1.5, depth: 4 },
    ));

    this.proxy = new A11yProxy(scene, {
      label: accessibleName(avatar),
      x: cx - 110, y: HEAD_Y - 250, w: 220, h: 290,
      onActivate: () => this.onChoose(avatar),
      onFocus: () => this.onFocusChoice(avatar),
    });
  }

  setFocused(v: boolean): void {
    if (this.focused === v) return;
    this.focused = v;
    this.head.setScaleFactor(v ? SELECTED_SCALE : BASE_SCALE);
    this.head.setAlpha(v ? 1 : 0.68);
    this.restyle();
  }

  activate(): void { this.onChoose(this.avatar); }

  restyle(): void {
    const reduced = settings.get('reducedMotion');
    const variant = debugPanel.get().hoverVariant;
    if (this.focused) {
      // Same treatment as a focused button: darker, thicker, and it moves.
      this.underline.setStyle({ color: COLOR_INK, width: 1.5 });
      this.underline.setOffset(0, reduced ? 0 : -1.5);
      this.underline.setFps(!reduced && variant === 'A' ? BOIL_FPS_HOVER : BOIL_FPS_IDLE);
      this.underline.setTracer(!reduced && variant === 'B');
    } else {
      this.underline.setStyle({ color: COLOR_STROKE_IDLE, width: 1 });
      this.underline.setOffset(0, 0);
      this.underline.setFps(BOIL_FPS_IDLE);
      this.underline.setTracer(false);
    }
  }

  update(time: number): void { this.head.update(time); }

  destroy(): void {
    this.head.destroy();
    this.underline.destroy();
    this.proxy.destroy();
  }
}

export class AvatarSelectScene extends Phaser.Scene {
  private boiler = new Boiler();
  private focusList = new FocusList();
  private choices: AvatarChoice[] = [];
  private paper!: PaperBackground;
  private headingText!: Phaser.GameObjects.Text;
  private helpText!: Phaser.GameObjects.Text;
  private noteText!: Phaser.GameObjects.Text;
  private selected: AvatarId = AVATARS[0];
  private unsubscribe?: () => void;
  private unsubDebug?: () => void;

  constructor() { super(SCENE_AVATAR); }

  create(): void {
    // Reset per-run state — Phaser reuses scene instances.
    this.choices = [];
    this.boiler = new Boiler();
    this.focusList = new FocusList();
    this.selected = profile.avatar ?? AVATARS[0];

    this.paper = new PaperBackground(this);
    pencilWipeIn(this);

    const cx = GAME_WIDTH / 2;
    this.headingText = this.add.text(cx, 78, config.avatarSelect.heading, {}).setOrigin(0.5).setDepth(6);
    this.helpText = this.add.text(cx, 124, config.avatarSelect.help, {}).setOrigin(0.5).setDepth(6);
    this.noteText = this.add.text(cx, GAME_HEIGHT - 26, '', {}).setOrigin(0.5).setDepth(6);

    const spacing = 300;
    AVATARS.forEach((avatar, i) => {
      this.choices.push(new AvatarChoice(
        this, avatar, cx + (i - 1) * spacing, this.boiler,
        (a) => this.choose(a),
        (a) => { this.selected = a; },
      ));
    });

    const bw = 210, bh = 54, by = GAME_HEIGHT - 116;
    const back = new SketchButton(this, {
      x: cx - bw - 14, y: by, w: bw, h: bh,
      label: config.avatarSelect.back, fontScale: 1.3, boiler: this.boiler,
      onActivate: () => pencilWipeOut(this, () => this.scene.start(SCENE_TITLE)),
    });
    const confirm = new SketchButton(this, {
      x: cx + 14, y: by, w: bw, h: bh,
      label: config.avatarSelect.confirm, fontScale: 1.3, boiler: this.boiler,
      onActivate: () => this.choose(this.selected),
    });

    this.focusList.setItems([...this.choices, back, confirm]);

    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => {
      if (settings.matchesAction('right', e.code) || settings.matchesAction('down', e.code)) {
        this.focusList.move(1); e.preventDefault();
      } else if (settings.matchesAction('left', e.code) || settings.matchesAction('up', e.code)) {
        this.focusList.move(-1); e.preventDefault();
      } else if (settings.matchesAction('cancel', e.code)) {
        // Settings is reachable mid-game with Esc.
        pencilWipeOut(this, () => this.scene.start(SCENE_SETTINGS, { returnTo: SCENE_AVATAR }));
        e.preventDefault();
      }
    });

    this.unsubscribe = settings.subscribe(() => this.restyle());
    this.unsubDebug = debugPanel.subscribe(() => this.choices.forEach((c) => c.restyle()));
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribe?.();
      this.unsubDebug?.();
      this.scale.off(Phaser.Scale.Events.RESIZE, this.onResize, this);
      this.focusList.destroy();
      this.boiler.destroy();
      this.paper.destroy();
    });

    this.restyle();
    this.focusList.focus(Math.max(0, AVATARS.indexOf(this.selected)));
  }

  private onResize(): void { this.focusList.repositionProxies(); }

  private choose(avatar: AvatarId): void {
    this.selected = avatar;
    profile.setAvatar(avatar);
    announce(`${accessibleName(avatar)} chosen`);
    // The story isn't written yet, so say so plainly rather than inventing one.
    this.noteText.setText(`[placeholder] ${accessibleName(avatar)} chosen — the story starts here once it is written`);
  }

  private restyle(): void {
    const family = settings.fontFamily();
    const ink = settings.inkCss();
    this.headingText.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(2.4)}px`, color: ink });
    this.helpText.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(1.2)}px`, color: ink });
    this.helpText.setAlpha(0.65);
    this.noteText.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(1)}px`, color: ink });
    this.noteText.setAlpha(0.65);
    this.focusList.restyle();
  }

  update(time: number, delta: number): void {
    this.boiler.setFrozen(settings.get('reducedMotion'));
    this.boiler.update(time);
    this.paper.update(delta);
    this.choices.forEach((c) => c.update(time));
  }
}
