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
import { A11yProxy, announce, keyboardNav, onNavModeChange } from '@/systems/a11y';
import { Boiler, SketchShape, boxShape, lineShape, pathShape } from '@/systems/boil';
import { PaperBackground } from '@/systems/paper';
import {
  GameAction, keyLabel, settings, Settings,
} from '@/systems/SettingsManager';
import { viewport } from '@/systems/viewport';
import { transitionIn, transitionOut } from '@/systems/transitions';
import { FocusableControl, FocusList, SketchButton } from '@/systems/ui';
import { ShadeFill } from '@/systems/shadeFill';
import {
  BOIL_FPS_UI, COLOR_INK, COLOR_PAPER, COLOR_SELECTED_TEXT, COLOR_SELECTED_TEXT_CSS, COLOR_STROKE_IDLE,
  SCENE_SETTINGS, SCENE_TITLE, uiText,
} from '@/systems/constants';

/**
 * Live layout, recomputed from the window at every create(). Module-level
 * because rows read it too; the scene is a singleton so there is only ever one.
 */
const L = { W: 1280, H: 720, listX: 300, listW: 680, viewTop: 104, viewH: 396, footerY: 638 };

function computeLayout(): void {
  const { W, H } = viewport;
  L.W = W;
  L.H = H;
  L.listW = Math.min(680, W - 140);
  L.listX = (W - L.listW) / 2;
  L.viewTop = 104;
  L.footerY = H - 82;
  // Whatever height is left between the heading and the description line.
  L.viewH = Math.max(160, L.footerY - 76 - L.viewTop);
}

const ROW_H = 38;
const HEADING_H = 48;
/** Speed the boil runs at for a beat after a value changes. */
const REDRAW_FPS = 14;
const REDRAW_MS = 280;

/** Text-size chips: one small box per value, the chosen one shaded in. */
const CHIP_W = 34, CHIP_H = 26, CHIP_GAP = 6;

const REBINDABLE: GameAction[] = ['up', 'down', 'left', 'right', 'confirm', 'cancel', 'menu', 'skip', 'fullscreen'];

/** Fullscreen is browser state, not a stored setting; everything else is. */
function readToggle(def: OptionDef): boolean {
  return def.id === 'fullscreen' ? viewport.isFullscreen : Boolean(settings.get(def.id as keyof Settings));
}

class SettingRow implements FocusableControl {
  readonly proxy: A11yProxy;
  private labelText: Phaser.GameObjects.Text;
  private valueText: Phaser.GameObjects.Text;
  private marker: Phaser.GameObjects.Text;
  /** Checkbox for toggles, track for ranges; absent for enums and actions. */
  private indicator?: SketchShape;
  /** Slider fill (ranges). */
  private fill?: SketchShape;
  /** A toggle that is on is the chosen option: its box is shaded in. */
  private check?: ShadeFill;
  /** Enum choices, e.g. text size s / m / l / xl. */
  private chips: Array<{ value: string; x: number; box: SketchShape; shade: ShadeFill; text: Phaser.GameObjects.Text }> = [];
  private focused = false;
  private hovered = false;
  /**
   * The row is an option like any button: on hover or keyboard focus it is
   * shaded in near-black, its text paper-white (user, 2026-10-04).
   */
  private rowShade: ShadeFill;
  private unsubMode: () => void;
  /** False while constructing: the initial state appears without animating. */
  private ready = false;
  private redrawTimer?: Phaser.Time.TimerEvent;

  constructor(
    private scene: Phaser.Scene,
    readonly def: OptionDef,
    private baseY: number,
    private boiler: Boiler,
    private onChanged: () => void,
    private onFocusRow: (row: SettingRow) => void,
    private onActivateRow: (row: SettingRow, e?: MouseEvent) => void,
  ) {
    this.rowShade = new ShadeFill(scene, { x: L.listX - 30, y: baseY - ROW_H / 2 + 2, w: L.listW + 40, h: ROW_H - 4 }, {
      depth: 5, inset: 0, onFilledChange: () => this.paint(),
    });
    this.marker = scene.add.text(L.listX - 24, baseY, '›', {}).setOrigin(0, 0.5).setDepth(6);
    this.labelText = scene.add.text(L.listX, baseY, uiText(def.label), {}).setOrigin(0, 0.5).setDepth(6);
    this.valueText = scene.add.text(L.listX + L.listW, baseY, '', {}).setOrigin(1, 0.5).setDepth(6);

    if (def.kind === 'toggle') {
      const bx = L.listX + L.listW - 96, by = baseY - 11;
      this.check = new ShadeFill(scene, { x: bx, y: by, w: 22, h: 22 }, { depth: 6, inset: 1 });
      this.indicator = boiler.add(new SketchShape(
        scene, boxShape(bx, by, 22, 22),
        { color: COLOR_STROKE_IDLE, width: 1, alpha: 1 }, { jitter: 1.3, fps: BOIL_FPS_UI, depth: 6 },
      ));
    } else if (def.kind === 'enum' && def.values) {
      const n = def.values.length;
      let x = L.listX + L.listW - n * CHIP_W - (n - 1) * CHIP_GAP;
      for (const value of def.values) {
        const cy = baseY - CHIP_H / 2;
        const shade = new ShadeFill(scene, { x, y: cy, w: CHIP_W, h: CHIP_H }, {
          depth: 6, inset: 1, onFilledChange: () => this.paint(),
        });
        const box = boiler.add(new SketchShape(scene, boxShape(x, cy, CHIP_W, CHIP_H),
          { color: COLOR_STROKE_IDLE, width: 1, alpha: 1 }, { jitter: 1.2, fps: BOIL_FPS_UI, depth: 6 }));
        const text = scene.add.text(x + CHIP_W / 2, baseY, uiText(def.valueLabels?.[value] ?? value), {}).setOrigin(0.5).setDepth(7);
        this.chips.push({ value, x, box, shade, text });
        x += CHIP_W + CHIP_GAP;
      }
    } else if (def.kind === 'range') {
      this.indicator = boiler.add(new SketchShape(
        scene, lineShape(L.listX + L.listW - 206, baseY, L.listX + L.listW - 86, baseY),
        { color: COLOR_STROKE_IDLE, width: 1, alpha: 1 }, { jitter: 1.2, fps: BOIL_FPS_UI, depth: 6 },
      ));
      this.fill = boiler.add(new SketchShape(
        scene, pathShape([]), { color: COLOR_INK, width: 1.8, alpha: 1 },
        { jitter: 1.1, fps: BOIL_FPS_UI, depth: 7 },
      ));
    }

    this.proxy = new A11yProxy(scene, {
      label: this.ariaLabel(),
      x: L.listX - 30, y: baseY - ROW_H / 2, w: L.listW + 40, h: ROW_H,
      onActivate: (e) => this.onActivateRow(this, e),
      onFocus: () => this.onFocusRow(this),
      onHover: (over) => { this.hovered = over; this.paint(); },
    });
    this.unsubMode = onNavModeChange(() => this.paint());

    this.refreshValue();
    this.ready = true;
  }

  /**
   * Everything the list container should hold. The sketched controls go in
   * too, so they scroll with their row and are clipped by the list mask (they
   * used to sit outside it and poke out half-scrolled rows).
   */
  get objects(): Phaser.GameObjects.GameObject[] {
    const out: Phaser.GameObjects.GameObject[] = [this.rowShade.img, this.marker, this.labelText, this.valueText];
    if (this.check) out.push(this.check.img);              // under its outline
    if (this.indicator) out.push(this.indicator.object);
    if (this.fill) out.push(this.fill.object);
    for (const c of this.chips) out.push(c.shade.img, c.box.object, c.text);
    return out;
  }

  valueString(): string {
    const { def } = this;
    if (def.kind === 'action') return '↵';
    if (def.kind === 'rebind') return 'edit ›';
    if (def.kind === 'toggle') return readToggle(def) ? 'on' : 'off';
    const v = settings.get(def.id as keyof Settings);
    if (def.kind === 'range') return `${v}%`;
    const key = String(v);
    return def.valueLabels?.[key] ?? key;
  }

  private ariaLabel(): string { return `${this.def.label}, ${this.valueString()}`; }

  refreshValue(): void {
    // Chips show the value themselves.
    this.valueText.setText(this.chips.length ? '' : uiText(this.valueString()));
    this.proxy.setLabel(this.ariaLabel());
    this.refreshIndicator();
  }

  /** Shade the chosen option (toggle box / text-size chip) and redraw slider fills. */
  private refreshIndicator(): void {
    const { def } = this;
    const y = this.baseY;
    if (def.kind === 'toggle') {
      this.check?.set(readToggle(def), !this.ready);
      return;
    }
    if (def.kind === 'enum') {
      const cur = String(settings.get(def.id as keyof Settings));
      for (const c of this.chips) c.shade.set(c.value === cur, !this.ready);
      this.paint();
      return;
    }
    if (!this.fill) return;
    if (def.kind === 'range') {
      const min = def.min ?? 0, max = def.max ?? 100;
      const v = Number(settings.get(def.id as keyof Settings));
      const t = Phaser.Math.Clamp((v - min) / (max - min), 0, 1);
      const x0 = L.listX + L.listW - 206;
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
      shapes.forEach((s) => s.setFps(BOIL_FPS_UI));
    });
  }

  adjust(dir: -1 | 1): void {
    const { def } = this;
    if (def.kind === 'rebind' || def.kind === 'action') return;
    const key = def.id as keyof Settings;
    if (def.id === 'fullscreen') {
      // The value flips when the browser confirms (see the fullscreenchange
      // listener in the scene); the redraw burst below still plays now.
      viewport.toggleFullscreen();
    } else if (def.kind === 'toggle') {
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

  private get active(): boolean { return this.hovered || (this.focused && keyboardNav()); }

  /**
   * Draw the row for its state. On a filled (dark) row everything inverts so it
   * stays readable: text and outlines paper-white, and the chosen chip / on
   * toggle becomes a paper-coloured fill with ink letters.
   */
  private paint(): void {
    const on = this.active;
    this.rowShade.set(on);
    const dark = this.rowShade.filled;
    const ink = settings.inkCss();
    this.marker.setVisible(on);
    for (const t of [this.marker, this.labelText, this.valueText]) {
      t.setColor(dark ? COLOR_SELECTED_TEXT_CSS : ink);
      t.setAlpha(on || dark ? 1 : 0.68);
    }
    const tint = (o: Phaser.GameObjects.Image | undefined) => {
      if (!o) return;
      if (dark) o.setTintFill(COLOR_SELECTED_TEXT); else o.clearTint();
    };
    tint(this.indicator?.object);
    tint(this.fill?.object);
    this.indicator?.setStyle({ color: on ? COLOR_INK : COLOR_STROKE_IDLE, width: on ? 1.5 : 1 });
    this.check?.invert(dark);
    for (const c of this.chips) {
      c.shade.invert(dark);
      tint(c.box.object);
      c.box.setStyle({ color: on ? COLOR_INK : COLOR_STROKE_IDLE, width: on ? 1.4 : 1 });
      // Chosen chip: graphite on a light row, paper on a dark one — the letter
      // is always the opposite.
      const lightLetter = c.shade.filled !== dark;
      c.text.setColor(lightLetter ? COLOR_SELECTED_TEXT_CSS : ink);
      c.text.setAlpha(c.shade.filled || on || dark ? 1 : 0.68);
    }
  }

  /** `e` is a real mouse click when present: pick the chip under the pointer. */
  activate(e?: MouseEvent): void {
    const { def } = this;
    if (def.kind === 'enum' && e && e.detail > 0 && this.chips.length) {
      const x = e.clientX / viewport.unit;   // canvas fills the window from (0,0)
      const hit = this.chips.find((c) => x >= c.x - CHIP_GAP / 2 && x <= c.x + CHIP_W + CHIP_GAP / 2);
      if (hit) { this.choose(hit.value); return; }
    }
    if (def.kind === 'toggle' || def.kind === 'enum') this.adjust(1);
    else if (def.kind === 'rebind') this.onActivateRow(this);
  }

  /** Set an enum to a specific value (a clicked chip). */
  private choose(value: string): void {
    if (String(settings.get(this.def.id as keyof Settings)) === value) return;
    settings.set(this.def.id as keyof Settings, value as never);
    this.refreshValue();
    this.redrawBurst();
    announce(this.ariaLabel());
    this.onChanged();
  }

  setFocused(v: boolean): void {
    this.focused = v;
    this.paint();
  }

  restyle(): void {
    const family = settings.fontFamily();
    const ink = settings.inkCss();
    const size = `${settings.fontSizePx(1.2)}px`;
    for (const t of [this.marker, this.labelText, this.valueText]) {
      t.setStyle({ fontFamily: family, fontSize: size, color: ink });
      t.setLetterSpacing(settings.letterSpacing());
    }
    for (const c of this.chips) c.text.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(1)}px` });
    this.refreshValue();
    this.paint();
  }

  /** Keep the DOM proxy and the boiled controls lined up with the scroll. */
  syncProxy(scrollY: number): void {
    const y = this.baseY + scrollY;
    this.proxy.setRect(L.listX - 30, y - ROW_H / 2, L.listW + 40, ROW_H);
    const visible = y > L.viewTop - 4 && y < L.viewTop + L.viewH + 4;
    // An off-screen row stays focusable so arrows and Tab can reach it and
    // scroll it back; display:none would make .focus() silently fail.
    this.proxy.el.style.pointerEvents = visible ? 'auto' : 'none';
  }

  setTabbable(on: boolean): void { this.proxy.el.style.display = on ? '' : 'none'; }

  get y(): number { return this.baseY; }

  destroy(): void {
    this.redrawTimer?.remove();
    [this.marker, this.labelText, this.valueText].forEach((o) => o.destroy());
    if (this.indicator) { this.boiler.remove(this.indicator); this.indicator.destroy(); }
    if (this.fill) { this.boiler.remove(this.fill); this.fill.destroy(); }
    this.check?.destroy();
    this.unsubMode();
    this.rowShade.destroy();
    for (const c of this.chips) { this.boiler.remove(c.box); c.box.destroy(); c.shade.destroy(); c.text.destroy(); }
    this.proxy.destroy();
  }
}

interface SettingsData { returnTo?: string; resized?: boolean; focusIndex?: number; scrollY?: number }

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

  private runData: SettingsData = {};

  init(data: SettingsData): void {
    this.runData = data ?? {};
    this.returnTo = this.runData.returnTo ?? SCENE_TITLE;
  }

  create(): void {
    // Camera zoom + device-resolution text; must run before anything is added.
    viewport.attach(this);
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

    computeLayout();
    this.paper = new PaperBackground(this);
    if (!this.runData.resized) transitionIn(this);

    this.heading = this.add.text(L.W / 2, 54, 'settings', {}).setOrigin(0.5).setDepth(6);
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

    if (this.runData.scrollY) {
      this.scrollY = this.runData.scrollY;
      this.listContainer.setY(this.scrollY);
    }
    this.focusList.focus(this.runData.focusIndex ?? 0);

    viewport.restartOnResize(this, () => ({
      returnTo: this.returnTo,
      focusIndex: this.focusList.currentIndex,
      scrollY: this.scrollY,
    }));

    // Fullscreen can change without our input (Esc, browser UI), and doesn't
    // always change the layout size, so refresh the row directly.
    const onFs = () => this.rows.forEach((r) => r.refreshValue());
    document.addEventListener('fullscreenchange', onFs);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => document.removeEventListener('fullscreenchange', onFs));
  }

  private buildRows(): void {
    let y = L.viewTop + 14;
    for (const group of GROUP_ORDER) {
      const h = this.add.text(L.listX - 24, y, group.toLowerCase(), {}).setOrigin(0, 0.5);
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
    this.contentH = y - L.viewTop;

    const maskShape = this.make.graphics({});
    maskShape.fillRect(0, L.viewTop, L.W, L.viewH);
    this.listContainer.setMask(maskShape.createGeometryMask());
  }

  private buildFooter(): void {
    this.descriptionText = this.add
      .text(L.W / 2, L.viewTop + L.viewH + 32, '', { align: 'center' })
      .setOrigin(0.5).setDepth(6);

    const bw = 220, bh = 50, by = L.footerY;
    const reset = new SketchButton(this, {
      x: L.W / 2 - bw - 14, y: by, w: bw, h: bh,
      label: 'reset to defaults', ariaLabel: 'Reset to defaults', fontScale: 1.15, boiler: this.boiler,
      onActivate: () => {
        settings.reset();
        this.rows.forEach((r) => r.refreshValue());
        announce('Settings reset to defaults');
      },
      onFocus: () => this.setDescription('Puts every setting on this screen back the way it started.'),
    });
    const back = new SketchButton(this, {
      x: L.W / 2 + 14, y: by, w: bw, h: bh,
      label: 'back', ariaLabel: 'Back', fontScale: 1.15, boiler: this.boiler,
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

  private onRowActivate(row: SettingRow, e?: MouseEvent): void {
    if (row.def.kind === 'rebind') this.openRebind();
    else row.activate(e);
  }

  private ensureVisible(row: SettingRow): void {
    const y = row.y + this.scrollY;
    const pad = ROW_H;
    if (y < L.viewTop + pad) this.scrollY += L.viewTop + pad - y;
    else if (y > L.viewTop + L.viewH - pad) this.scrollY -= y - (L.viewTop + L.viewH - pad);
    this.scrollY = Phaser.Math.Clamp(this.scrollY, Math.min(0, L.viewH - this.contentH - 20), 0);
    this.listContainer.setY(this.scrollY);
    this.syncProxies();
  }

  private syncProxies(): void {
    this.focusList.repositionProxies();
    this.rows.forEach((r) => r.syncProxy(this.scrollY));
  }

  private setDescription(text: string): void { this.descriptionText.setText(uiText(text)); }

  private updateDescription(): void {
    const cur = this.focusList.current;
    if (cur instanceof SettingRow) this.setDescription(cur.def.description);
  }

  // --- key rebinding -----------------------------------------------------

  private openRebind(): void {
    if (this.rebindOverlay) return;
    this.rebinding = true;
    this.rebindIndex = 0;

    // Centred in the live layout area.
    const PW = 800, PH = 560;
    const px = (L.W - PW) / 2, py = (L.H - PH) / 2;
    const rowY = (i: number) => py + 104 + i * 42;

    const panel = this.add.container(0, 0).setDepth(50);
    // Opaque backing so the list behind is genuinely hidden, not just dimmed.
    const bg = this.add.graphics();
    bg.fillStyle(COLOR_PAPER, 1);
    bg.fillRect(px, py, PW, PH);
    panel.add(bg);

    const frame = new SketchShape(this, boxShape(px, py, PW, PH),
      { color: COLOR_INK, width: 1.5, alpha: 1 }, { jitter: 1.8, fps: BOIL_FPS_UI, depth: 51 });
    this.boiler.add(frame);

    const mk = (x: number, y: number, text: string, scale: number, origin: number) =>
      this.add.text(x, y, uiText(text), {
        fontFamily: settings.fontFamily(),
        fontSize: `${settings.fontSizePx(scale)}px`,
        color: settings.inkCss(),
      }).setOrigin(origin, 0.5).setDepth(52);

    panel.add(mk(L.W / 2, py + 44, 'keyboard controls', 1.7, 0.5));
    const hint = mk(L.W / 2, py + PH - 36, 'up/down to choose · enter to set a new key · esc to close', 1, 0.5);
    hint.setAlpha(0.65);
    panel.add(hint);

    const labels: Phaser.GameObjects.Text[] = [];
    REBINDABLE.forEach((action, i) => {
      panel.add(mk(px + 80, rowY(i), action, 1.2, 0));
      const keys = mk(px + PW - 80, rowY(i), '', 1.2, 1);
      panel.add(keys);
      labels.push(keys);
    });

    const underline = new SketchShape(this, lineShape(px + 64, rowY(0) + 16, px + PW - 64, rowY(0) + 16),
      { color: COLOR_INK, width: 1.4, alpha: 1 }, { jitter: 1.4, fps: BOIL_FPS_UI, depth: 52 });
    this.boiler.add(underline);

    const refresh = (awaiting = false) => {
      REBINDABLE.forEach((action, i) => {
        const bound = settings.all().keyBindings[action].map(keyLabel).join(' / ');
        labels[i].setText(uiText(awaiting && i === this.rebindIndex ? 'press a key…' : bound));
      });
      const y = rowY(this.rebindIndex) + 16;
      underline.setGeometry(lineShape(px + 64, y, px + PW - 64, y));
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
    // If the scene restarts (e.g. a resize) with the panel open, close() never
    // runs; without this the listener leaks and double-handles the next panel.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => window.removeEventListener('keydown', onKey, true));
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
    transitionOut(this, () => this.scene.start(this.returnTo));
  }

  private restyle(): void {
    const family = settings.fontFamily();
    const ink = settings.inkCss();
    this.heading.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(2.3)}px`, color: ink });
    this.descriptionText.setStyle({
      fontFamily: family, fontSize: `${settings.fontSizePx(1.05)}px`, color: ink,
      wordWrap: { width: Math.min(760, L.W * 0.7) },
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
