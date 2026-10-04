/**
 * SettingsScene — every option, grouped, with a plain-language description of
 * whichever row is focused.
 *
 * Toggles and sliders don't just change value: the shape is re-jittered and
 * boils fast for a moment, so the control reads as having been redrawn by hand.
 *
 * Reachable from the title and mid-game with Esc; launch it with
 * `{ returnTo: <sceneKey> }` so it knows where to go back to.
 */

import Phaser from 'phaser';
import { GROUP_ORDER, OptionDef, SETTINGS_SCHEMA } from '@/data/settingsSchema';
import { A11yProxy, announce } from '@/systems/a11y';
import { Boiler, SketchShape, boxShape, lineShape, pathShape } from '@/systems/boil';
import { PaperBackground } from '@/systems/paper';
import {
  GameAction, keyLabel, settings, Settings,
} from '@/systems/SettingsManager';
import { pencilWipeIn, pencilWipeOut } from '@/systems/transitions';
import { FocusableControl, FocusList, SketchButton } from '@/systems/ui';
import {
  BOIL_FPS_IDLE, COLOR_INK, COLOR_PAPER, COLOR_STROKE_IDLE,
  GAME_HEIGHT, GAME_WIDTH, SCENE_SETTINGS, SCENE_TITLE,
} from '@/systems/constants';

const LIST_X = 300;
const LIST_W = 680;
const ROW_H = 38;
const HEADING_H = 48;
const VIEW_TOP = 104;
const VIEW_H = 396;
/** Speed the boil runs at for a beat after a value changes. */
const REDRAW_FPS = 14;
const REDRAW_MS = 280;

const REBINDABLE: GameAction[] = ['up', 'down', 'left', 'right', 'confirm', 'cancel', 'menu', 'skip'];

class SettingRow implements FocusableControl {
  readonly proxy: A11yProxy;
  private labelText: Phaser.GameObjects.Text;
  private valueText: Phaser.GameObjects.Text;
  private marker: Phaser.GameObjects.Text;
  /** Checkbox for toggles, track for ranges; absent for enums and actions. */
  private indicator?: SketchShape;
  private fill?: SketchShape;
  private focused = false;
  private redrawTimer?: Phaser.Time.TimerEvent;

  constructor(
    private scene: Phaser.Scene,
    readonly def: OptionDef,
    private baseY: number,
    private boiler: Boiler,
    private onChanged: () => void,
    private onFocusRow: (row: SettingRow) => void,
    private onActivateRow: (row: SettingRow) => void,
  ) {
    this.marker = scene.add.text(LIST_X - 24, baseY, '›', {}).setOrigin(0, 0.5).setDepth(6);
    this.labelText = scene.add.text(LIST_X, baseY, def.label, {}).setOrigin(0, 0.5).setDepth(6);
    this.valueText = scene.add.text(LIST_X + LIST_W, baseY, '', {}).setOrigin(1, 0.5).setDepth(6);

    if (def.kind === 'toggle') {
      this.indicator = boiler.add(new SketchShape(
        scene, boxShape(LIST_X + LIST_W - 96, baseY - 11, 22, 22, 12),
        { color: COLOR_STROKE_IDLE, width: 1, alpha: 1 }, { jitter: 1.3, depth: 6 },
      ));
      this.fill = boiler.add(new SketchShape(
        scene, pathShape([]), { color: COLOR_INK, width: 1.6, alpha: 1 },
        { jitter: 1.1, depth: 7 },
      ));
    } else if (def.kind === 'range') {
      this.indicator = boiler.add(new SketchShape(
        scene, lineShape(LIST_X + LIST_W - 206, baseY, LIST_X + LIST_W - 86, baseY),
        { color: COLOR_STROKE_IDLE, width: 1, alpha: 1 }, { jitter: 1.2, depth: 6 },
      ));
      this.fill = boiler.add(new SketchShape(
        scene, pathShape([]), { color: COLOR_INK, width: 1.8, alpha: 1 },
        { jitter: 1.1, depth: 7 },
      ));
    }

    this.proxy = new A11yProxy(scene, {
      label: this.ariaLabel(),
      x: LIST_X - 30, y: baseY - ROW_H / 2, w: LIST_W + 40, h: ROW_H,
      onActivate: () => this.onActivateRow(this),
      onFocus: () => this.onFocusRow(this),
    });

    this.refreshValue();
  }

  get objects(): Phaser.GameObjects.GameObject[] {
    return [this.marker, this.labelText, this.valueText];
  }

  valueString(): string {
    const { def } = this;
    if (def.kind === 'action') return '↵';
    if (def.kind === 'rebind') return 'edit ›';
    const v = settings.get(def.id as keyof Settings);
    if (def.kind === 'toggle') return v ? 'on' : 'off';
    if (def.kind === 'range') return `${v}%`;
    const key = String(v);
    return def.valueLabels?.[key] ?? key;
  }

  private ariaLabel(): string { return `${this.def.label}, ${this.valueString()}`; }

  refreshValue(): void {
    this.valueText.setText(this.valueString());
    this.proxy.setLabel(this.ariaLabel());
    this.refreshIndicator();
  }

  /** Redraw the checkbox tick / slider fill for the current value. */
  private refreshIndicator(): void {
    if (!this.fill) return;
    const { def } = this;
    const y = this.baseY;
    if (def.kind === 'toggle') {
      const on = Boolean(settings.get(def.id as keyof Settings));
      const x = LIST_X + LIST_W - 96;
      this.fill.setVisible(on);
      if (on) {
        // A hand-drawn tick, not a glyph.
        this.fill.setGeometry(pathShape([
          { x: x + 4, y: y + 1 }, { x: x + 9, y: y + 7 }, { x: x + 19, y: y - 8 },
        ]));
      }
    } else if (def.kind === 'range') {
      const min = def.min ?? 0, max = def.max ?? 100;
      const v = Number(settings.get(def.id as keyof Settings));
      const t = Phaser.Math.Clamp((v - min) / (max - min), 0, 1);
      const x0 = LIST_X + LIST_W - 206;
      const x1 = x0 + 120 * t;
      this.fill.setVisible(t > 0.001);
      if (t > 0.001) this.fill.setGeometry(lineShape(x0, y, x1, y, 18));
    }
  }

  /** A short burst of fast boil, so the control looks re-sketched. */
  private redrawBurst(): void {
    if (settings.get('reducedMotion')) return;
    const shapes = [this.indicator, this.fill].filter(Boolean) as SketchShape[];
    shapes.forEach((s) => { s.regenerate(); s.setFps(REDRAW_FPS); });
    this.redrawTimer?.remove();
    this.redrawTimer = this.scene.time.delayedCall(REDRAW_MS, () => {
      shapes.forEach((s) => s.setFps(BOIL_FPS_IDLE));
    });
  }

  adjust(dir: -1 | 1): void {
    const { def } = this;
    if (def.kind === 'rebind' || def.kind === 'action') return;
    const key = def.id as keyof Settings;
    if (def.kind === 'toggle') {
      settings.set(key, !settings.get(key) as never);
    } else if (def.kind === 'range') {
      const cur = settings.get(key) as number;
      const next = Phaser.Math.Clamp(cur + dir * (def.step ?? 5), def.min ?? 0, def.max ?? 100);
      settings.set(key, next as never);
    } else if (def.kind === 'enum' && def.values) {
      const cur = String(settings.get(key));
      const i = def.values.indexOf(cur);
      settings.set(key, def.values[Phaser.Math.Wrap(i + dir, 0, def.values.length)] as never);
    }
    this.refreshValue();
    this.redrawBurst();
    announce(this.ariaLabel());
    this.onChanged();
  }

  activate(): void {
    if (this.def.kind === 'toggle' || this.def.kind === 'enum') this.adjust(1);
    else if (this.def.kind === 'rebind') this.onActivateRow(this);
  }

  setFocused(v: boolean): void {
    this.focused = v;
    this.marker.setVisible(v);
    this.labelText.setAlpha(v ? 1 : 0.68);
    this.valueText.setAlpha(v ? 1 : 0.68);
    this.indicator?.setStyle({ color: v ? COLOR_INK : COLOR_STROKE_IDLE, width: v ? 1.5 : 1 });
  }

  restyle(): void {
    const family = settings.fontFamily();
    const ink = settings.inkCss();
    const size = `${settings.fontSizePx(1.2)}px`;
    for (const t of [this.marker, this.labelText, this.valueText]) {
      t.setStyle({ fontFamily: family, fontSize: size, color: ink });
      t.setLetterSpacing(settings.letterSpacing());
    }
    this.marker.setVisible(this.focused);
    this.refreshValue();
  }

  /** Keep the DOM proxy and the boiled controls lined up with the scroll. */
  syncProxy(scrollY: number): void {
    const y = this.baseY + scrollY;
    this.proxy.setRect(LIST_X - 30, y - ROW_H / 2, LIST_W + 40, ROW_H);
    const visible = y > VIEW_TOP - 4 && y < VIEW_TOP + VIEW_H + 4;
    // An off-screen row stays focusable so arrows and Tab can reach it and
    // scroll it back; display:none would make .focus() silently fail.
    this.proxy.el.style.pointerEvents = visible ? 'auto' : 'none';
    this.indicator?.setVisible(visible);
    if (this.fill) this.fill.setVisible(visible && this.hasFill());
    this.indicator?.setOffset(0, scrollY);
    this.fill?.setOffset(0, scrollY);
  }

  private hasFill(): boolean {
    const { def } = this;
    if (def.kind === 'toggle') return Boolean(settings.get(def.id as keyof Settings));
    if (def.kind === 'range') {
      const min = def.min ?? 0, max = def.max ?? 100;
      return (Number(settings.get(def.id as keyof Settings)) - min) / (max - min) > 0.001;
    }
    return false;
  }

  setTabbable(on: boolean): void { this.proxy.el.style.display = on ? '' : 'none'; }

  get y(): number { return this.baseY; }

  destroy(): void {
    this.redrawTimer?.remove();
    this.objects.forEach((o) => o.destroy());
    if (this.indicator) { this.boiler.remove(this.indicator); this.indicator.destroy(); }
    if (this.fill) { this.boiler.remove(this.fill); this.fill.destroy(); }
    this.proxy.destroy();
  }
}

export class SettingsScene extends Phaser.Scene {
  private boiler = new Boiler();
  private focusList = new FocusList();
  private rows: SettingRow[] = [];
  private headings: Phaser.GameObjects.Text[] = [];
  private focusControls: FocusableControl[] = [];
  private footerButtons: SketchButton[] = [];
  private listContainer!: Phaser.GameObjects.Container;
  private paper!: PaperBackground;
  private heading!: Phaser.GameObjects.Text;
  private descriptionText!: Phaser.GameObjects.Text;
  private returnTo = SCENE_TITLE;
  private scrollY = 0;
  private contentH = 0;
  private unsubscribe?: () => void;

  private rebinding = false;
  private rebindIndex = 0;
  private rebindOverlay?: Phaser.GameObjects.Container;

  constructor() { super(SCENE_SETTINGS); }

  init(data: { returnTo?: string }): void {
    this.returnTo = data?.returnTo ?? SCENE_TITLE;
  }

  create(): void {
    // Reset per-run state — Phaser reuses scene instances.
    this.rows = [];
    this.headings = [];
    this.focusControls = [];
    this.footerButtons = [];
    this.boiler = new Boiler();
    this.focusList = new FocusList();
    this.scrollY = 0;
    this.rebinding = false;
    this.rebindOverlay = undefined;

    this.paper = new PaperBackground(this);
    pencilWipeIn(this);

    this.heading = this.add.text(GAME_WIDTH / 2, 54, 'settings', {}).setOrigin(0.5).setDepth(6);
    this.listContainer = this.add.container(0, 0).setDepth(6);

    this.buildRows();
    this.buildFooter();

    this.unsubscribe = settings.subscribe(() => this.restyle());
    this.scale.on(Phaser.Scale.Events.RESIZE, this.syncProxies, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribe?.();
      this.scale.off(Phaser.Scale.Events.RESIZE, this.syncProxies, this);
      this.focusList.destroy();
      this.headings.forEach((h) => h.destroy());
      this.boiler.destroy();
      this.paper.destroy();
    });

    this.bindKeyboard();
    this.restyle();
    this.focusList.focus(0);
  }

  private buildRows(): void {
    let y = VIEW_TOP + 14;
    for (const group of GROUP_ORDER) {
      const h = this.add.text(LIST_X - 24, y, group.toLowerCase(), {}).setOrigin(0, 0.5);
      this.headings.push(h);
      this.listContainer.add(h);
      y += HEADING_H;

      for (const def of SETTINGS_SCHEMA.filter((d) => d.group === group)) {
        const row = new SettingRow(
          this, def, y, this.boiler,
          () => this.updateDescription(),
          (r) => this.onRowFocus(r),
          (r) => this.onRowActivate(r),
        );
        this.listContainer.add(row.objects);
        this.rows.push(row);
        this.focusControls.push(row);
        y += ROW_H;
      }
      y += 10;
    }
    this.contentH = y - VIEW_TOP;

    const maskShape = this.make.graphics({});
    maskShape.fillRect(0, VIEW_TOP, GAME_WIDTH, VIEW_H);
    this.listContainer.setMask(maskShape.createGeometryMask());
  }

  private buildFooter(): void {
    this.descriptionText = this.add
      .text(GAME_WIDTH / 2, VIEW_TOP + VIEW_H + 32, '', { align: 'center' })
      .setOrigin(0.5).setDepth(6);

    const bw = 220, bh = 50, by = GAME_HEIGHT - 82;
    const reset = new SketchButton(this, {
      x: GAME_WIDTH / 2 - bw - 14, y: by, w: bw, h: bh,
      label: 'reset to defaults', fontScale: 1.15, boiler: this.boiler,
      onActivate: () => {
        settings.reset();
        this.rows.forEach((r) => r.refreshValue());
        announce('Settings reset to defaults');
      },
      onFocus: () => this.setDescription('Puts every setting on this screen back the way it started.'),
    });
    const back = new SketchButton(this, {
      x: GAME_WIDTH / 2 + 14, y: by, w: bw, h: bh,
      label: 'back', fontScale: 1.15, boiler: this.boiler,
      onActivate: () => this.goBack(),
      onFocus: () => this.setDescription('Returns to where you were.'),
    });

    this.footerButtons = [reset, back];
    this.focusList.setItems([...this.focusControls, reset, back]);
  }

  private onRowFocus(row: SettingRow): void {
    this.setDescription(row.def.description);
    this.ensureVisible(row);
  }

  private onRowActivate(row: SettingRow): void {
    if (row.def.kind === 'rebind') this.openRebind();
    else row.activate();
  }

  private ensureVisible(row: SettingRow): void {
    const y = row.y + this.scrollY;
    const pad = ROW_H;
    if (y < VIEW_TOP + pad) this.scrollY += VIEW_TOP + pad - y;
    else if (y > VIEW_TOP + VIEW_H - pad) this.scrollY -= y - (VIEW_TOP + VIEW_H - pad);
    this.scrollY = Phaser.Math.Clamp(this.scrollY, Math.min(0, VIEW_H - this.contentH - 20), 0);
    this.listContainer.setY(this.scrollY);
    this.syncProxies();
  }

  private syncProxies(): void {
    this.focusList.repositionProxies();
    this.rows.forEach((r) => r.syncProxy(this.scrollY));
  }

  private setDescription(text: string): void { this.descriptionText.setText(text); }

  private updateDescription(): void {
    const cur = this.focusList.current;
    if (cur instanceof SettingRow) this.setDescription(cur.def.description);
  }

  // --- key rebinding -----------------------------------------------------

  private openRebind(): void {
    if (this.rebindOverlay) return;
    this.rebinding = true;
    this.rebindIndex = 0;

    const panel = this.add.container(0, 0).setDepth(50);
    // Opaque backing so the list behind is genuinely hidden, not just dimmed.
    const bg = this.add.graphics();
    bg.fillStyle(COLOR_PAPER, 1);
    bg.fillRect(240, 90, 800, 520);
    panel.add(bg);

    const frame = new SketchShape(this, boxShape(240, 90, 800, 520),
      { color: COLOR_INK, width: 1.5, alpha: 1 }, { jitter: 1.8, depth: 51 });
    this.boiler.add(frame);

    const mk = (x: number, y: number, text: string, scale: number, origin: number) =>
      this.add.text(x, y, text, {
        fontFamily: settings.fontFamily(),
        fontSize: `${settings.fontSizePx(scale)}px`,
        color: settings.inkCss(),
      }).setOrigin(origin, 0.5).setDepth(52);

    panel.add(mk(GAME_WIDTH / 2, 132, 'keyboard controls', 1.7, 0.5));
    const hint = mk(GAME_WIDTH / 2, 566, 'up/down to choose · enter to set a new key · esc to close', 1, 0.5);
    hint.setAlpha(0.65);
    panel.add(hint);

    const labels: Phaser.GameObjects.Text[] = [];
    REBINDABLE.forEach((action, i) => {
      const y = 192 + i * 42;
      panel.add(mk(320, y, action, 1.2, 0));
      const keys = mk(960, y, '', 1.2, 1);
      panel.add(keys);
      labels.push(keys);
    });

    const underline = new SketchShape(this, lineShape(304, 208, 976, 208),
      { color: COLOR_INK, width: 1.4, alpha: 1 }, { jitter: 1.4, depth: 52 });
    this.boiler.add(underline);

    const refresh = (awaiting = false) => {
      REBINDABLE.forEach((action, i) => {
        const bound = settings.all().keyBindings[action].map(keyLabel).join(' / ');
        labels[i].setText(awaiting && i === this.rebindIndex ? 'press a key…' : bound);
      });
      const y = 192 + this.rebindIndex * 42 + 16;
      underline.setGeometry(lineShape(304, y, 976, y));
    };
    refresh();

    let awaitingKey = false;
    const onKey = (e: KeyboardEvent) => {
      if (!this.rebinding) return;
      e.preventDefault();
      e.stopPropagation();
      if (awaitingKey) {
        if (e.code !== 'Escape') {
          settings.rebind(REBINDABLE[this.rebindIndex], e.code);
          announce(`${REBINDABLE[this.rebindIndex]} set to ${keyLabel(e.code)}`);
        }
        awaitingKey = false;
        refresh(false);
        return;
      }
      if (e.code === 'ArrowDown') { this.rebindIndex = Phaser.Math.Wrap(this.rebindIndex + 1, 0, REBINDABLE.length); refresh(); }
      else if (e.code === 'ArrowUp') { this.rebindIndex = Phaser.Math.Wrap(this.rebindIndex - 1, 0, REBINDABLE.length); refresh(); }
      else if (e.code === 'Enter' || e.code === 'Space') { awaitingKey = true; refresh(true); }
      else if (e.code === 'Escape') { close(); }
    };

    const close = () => {
      window.removeEventListener('keydown', onKey, true);
      this.rebinding = false;
      this.boiler.remove(frame); frame.destroy();
      this.boiler.remove(underline); underline.destroy();
      panel.destroy(true);
      this.rebindOverlay = undefined;
      this.rows.forEach((r) => { r.setTabbable(true); r.syncProxy(this.scrollY); });
      this.footerButtons.forEach((b) => { b.proxy.el.style.display = ''; });
      this.focusList.focus(this.rows.findIndex((r) => r.def.kind === 'rebind'));
    };

    window.addEventListener('keydown', onKey, true);
    // Nothing behind the modal should be reachable by Tab while it is up.
    this.rows.forEach((r) => r.setTabbable(false));
    this.footerButtons.forEach((b) => { b.proxy.el.style.display = 'none'; });
    this.rebindOverlay = panel;
    announce('Keyboard controls. Up and Down to choose, Enter to set a new key, Escape to close.');
  }

  // --- input -------------------------------------------------------------

  private bindKeyboard(): void {
    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => {
      if (this.rebinding) return;
      if (settings.matchesAction('down', e.code)) { this.focusList.move(1); e.preventDefault(); }
      else if (settings.matchesAction('up', e.code)) { this.focusList.move(-1); e.preventDefault(); }
      else if (settings.matchesAction('left', e.code)) { this.adjustCurrent(-1); e.preventDefault(); }
      else if (settings.matchesAction('right', e.code)) { this.adjustCurrent(1); e.preventDefault(); }
      else if (settings.matchesAction('cancel', e.code)) { this.goBack(); e.preventDefault(); }
    });
  }

  private adjustCurrent(dir: -1 | 1): void {
    const cur = this.focusList.current;
    if (cur instanceof SettingRow) cur.adjust(dir);
  }

  private goBack(): void {
    pencilWipeOut(this, () => this.scene.start(this.returnTo));
  }

  private restyle(): void {
    const family = settings.fontFamily();
    const ink = settings.inkCss();
    this.heading.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(2.3)}px`, color: ink });
    this.descriptionText.setStyle({
      fontFamily: family, fontSize: `${settings.fontSizePx(1.05)}px`, color: ink,
      wordWrap: { width: GAME_WIDTH * 0.6 },
    });
    this.descriptionText.setAlpha(0.78);
    this.headings.forEach((h) => {
      h.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(0.95)}px`, color: ink });
      h.setAlpha(0.45);
      h.setLetterSpacing(2);
    });
    this.focusList.restyle();
    this.syncProxies();
  }

  update(time: number, delta: number): void {
    this.boiler.setFrozen(settings.get('reducedMotion'));
    this.boiler.update(time);
    this.paper.update(delta);
  }
}
