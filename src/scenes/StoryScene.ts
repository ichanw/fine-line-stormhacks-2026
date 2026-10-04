/**
 * StoryScene — every story screen, driven by data:
 *   src/data/story.json     scenes, art, beats, boxes, ambient fx (frame px)
 *   src/data/dialogue.json  all story text ([placeholder] where unwritten)
 *   src/data/choices.json   choices, scores, outcome bands
 *
 * The art is the user's flattened Figma frames (public/art/scenes/), fitted to
 * the window and line-boiled on the GPU (FrameFX). Our narration box / choice
 * panel sit exactly over the boxes baked into each frame. Moving parts that
 * exist only inside a frame (bus handles, cars) are lifted out by their ink at
 * load time (sceneArt.ts); everything else alive is generated (ambient.ts).
 *
 * Scenes chain with the scrapbook transition; Esc opens Settings and comes
 * back to the same beat.
 */

import Phaser from 'phaser';
import story from '@/data/story.json';
import dialogue from '@/data/dialogue.json';
import config from '@/data/config.json';
import { AvatarId } from '@/data/characters';
import { Ambient, type Area } from '@/systems/ambient';
import { HATCH_ANGLE, StrokeGroups, hatchPolygon, scribbleMark, sketchLine, sketchPath, type StrokeLayer } from '@/systems/sketchKit';
import { mulberry32 } from '@/systems/rng';
import { dabPolyline, defaultBrush, finishRegion } from '@/systems/brush';
import { Boiler, SketchShape, boxShape, pathShape, type Pt } from '@/systems/boil';
import { CharacterHead, headInkRect } from '@/systems/characters';
import { frameFx, type FrameFX } from '@/systems/frameFx';
import { CHOICE_SETS, gameState, type ChoiceSetId } from '@/systems/gameState';
import { PaperBackground } from '@/systems/paper';
import { artKey, freeArt, loadArt, prepareArt, type CutoutSpec, type PreparedArt } from '@/systems/sceneArt';
import { settings } from '@/systems/SettingsManager';
import { ChoicePanel, NarrationBox, timeChip, type URect } from '@/systems/storyUi';
import { inputLocked, transitionIn, transitionOut } from '@/systems/transitions';
import { FocusList, SketchButton, type FocusableControl } from '@/systems/ui';
import { viewport } from '@/systems/viewport';
import { FADES, music } from '@/systems/music';
import { brushUnderline } from '@/systems/underline';
import { reflectionText } from '@/systems/reflection';
import { A11yProxy, announce } from '@/systems/a11y';
import { BOIL_FPS_SCENERY, BOIL_FPS_UI, COLOR_INK, COLOR_PAPER, COLOR_REFLECTION_PAPER, SCENE_SETTINGS, SCENE_STORY, SCENE_TITLE, uiText } from '@/systems/constants';

type Beat = { text: string; choices?: string };
type SceneDef = {
  type?: string; art?: string; layout?: string; fit?: string; artWide?: string; crowdFigures?: string[]; box?: number[]; beats?: Beat[]; next?: string; fx?: string[]; time?: string;
  eyes?: Record<string, number[][]>; cars?: number[][]; vanish?: number[];
  handles?: Array<{ ring: number[]; pivot: number[]; lines: number[] }>; windows?: number[][]; vignette?: number[]; zoomFrom?: number[];
};
const SCENES = story.scenes as Record<string, SceneDef>;
const TEXT = dialogue as unknown as Record<string, string>;
const FW = story.frame.w, FH = story.frame.h;

interface StoryData { id?: string; beat?: number; resized?: boolean }

export class StoryScene extends Phaser.Scene {
  private runData: StoryData = {};
  private id = story.start;
  private def!: SceneDef;
  private beat = 0;
  private built = false;
  private boiler = new Boiler();
  private focusList = new FocusList();
  private art: PreparedArt | null = null;
  private world!: Phaser.GameObjects.Container;
  private frameImg?: Phaser.GameObjects.Image;
  private fx: FrameFX | null = null;
  private ambient?: Ambient;
  private narration?: NarrationBox;
  private panel?: ChoicePanel;
  private heads: CharacterHead[] = [];
  private updaters: Array<(t: number, dt: number, reduced: boolean) => void> = [];
  private extra: Array<{ destroy(): void }> = [];
  private paper?: PaperBackground;
  private unsubscribe?: () => void;
  /** Frame fit: units per frame px, and the frame's top-left in units. */
  private s = 1; private ox = 0; private oy = 0;
  private zoomPending = false;
  /** This scene fills the window (outcome, finale) instead of fitting inside it. */
  private cover = false;
  /** The art's horizontal extent in frame px ([0, FW], or wider with a _wide version). */
  private artX: [number, number] = [0, 2880];
  private endButton?: SketchButton;

  constructor() { super(SCENE_STORY); }

  init(data: StoryData): void { this.runData = data ?? {}; }

  create(): void {
    viewport.attach(this);
    // Phaser reuses scene instances: reset all per-run state.
    this.built = false;
    this.boiler = new Boiler();
    this.focusList = new FocusList();
    this.art = null;
    this.frameImg = undefined;
    this.fx = null;
    this.ambient = undefined;
    this.narration = undefined;
    this.panel = undefined;
    this.heads = [];
    this.updaters = [];
    this.extra = [];
    this.paper = undefined;
    this.zoomPending = false;
    this.endButton = undefined;
    this.busMask = undefined;
    this.extraKeys = [];

    this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
    this.id = this.runData.id ?? gameState.scene;
    if (!SCENES[this.id]) this.id = story.start;
    this.def = SCENES[this.id];
    // Soundtrack: the dream track fades in as the outcome appears (after the
    // doze scene faded the day's track out); everything else keeps flowing.
    music.forScene(this.id, this.id === 'outcome' ? FADES.dreamIn : undefined);
    this.beat = this.runData.beat ?? (this.runData.id ? 0 : gameState.beat);
    gameState.setPosition(this.id, this.beat);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.bindKeys();
    viewport.restartOnResize(this, () => ({ id: this.id, beat: this.beat }));
    this.unsubscribe = settings.subscribe(() => this.restyle());

    let ready: Promise<void> = Promise.resolve();
    if (this.def.type !== 'end' && this.def.type !== 'reflection') {
      const path = this.artPath();
      const queue: string[] = [];
      if (!this.textures.exists(artKey(path))) queue.push(path);
      // Optional extras, only when story.json lists them (probing for missing
      // files would log load errors): a wider version of the art, and whole
      // crowd figures to extend the crowd with.
      if (this.def.artWide && !this.textures.exists(artKey(this.def.artWide))) queue.push(this.def.artWide);
      for (const f of this.def.crowdFigures ?? []) if (!this.textures.exists(artKey(f))) queue.push(f);
      if (queue.length) {
        queue.forEach((q) => loadArt(this, q));
        ready = new Promise((res) => { this.load.once(Phaser.Loader.Events.COMPLETE, () => res()); this.load.start(); });
      }
    }
    const built = ready.then(() => { if (this.sys.isActive()) this.build(); });
    if (!this.runData.resized) transitionIn(this, built);
  }

  // --- building ------------------------------------------------------------------------

  private artPath(): string {
    return (this.def.art ?? '').replace('{avatar}', gameState.player.avatar);
  }

  private U(x: number, y: number) { return { x: this.ox + x * this.s, y: this.oy + y * this.s }; }
  private R(r: number[]): URect { const p = this.U(r[0], r[1]); return { x: p.x, y: p.y, w: r[2] * this.s, h: r[3] * this.s }; }
  private frameArea(x: number, y: number, w: number, h: number): Area { return this.R([x, y, w, h]); }

  private build(): void {
    const { W, H } = viewport;
    if (this.def.type === 'end') { this.buildEnd(); this.built = true; return; }
    if (this.def.type === 'reflection') { this.buildReflection(); this.built = true; return; }

    this.cover = this.def.fit === 'extend';
    const sContain = Math.min(W / FW, H / FH);
    if (this.cover) {
      // Fill the window by EXTENDING, never zooming (user, 2026-10-04): the art
      // is shown at its native fit — full height on a wide window, full width
      // on a tall one (anchored to the bottom) — and the rest of the window is
      // a wider version of the art if one exists, else generated (extendCity).
      this.s = sContain;
      this.ox = (W - FW * this.s) / 2;
      this.oy = H - FH * this.s;
    } else {
      this.s = sContain;
      this.ox = (W - FW * this.s) / 2;
      this.oy = (H - FH * this.s) / 2;
    }
    const k = Math.min(1, this.s * viewport.zoom);
    const fx = this.def.fx ?? [];

    const cutouts: CutoutSpec[] = [];
    if (fx.includes('handles')) for (const h of this.def.handles ?? []) {
      // Only the loop swings: an elliptical ring around it (a few px of
      // margin), never the window it's drawn over. The window's top lines the
      // ring crosses are redrawn in place.
      const [cx, cy, rxo, ryo, rxi, ryi] = h.ring;
      const ring = { cx, cy, rxo: rxo + 6, ryo: ryo + 6, rxi: rxi - 6, ryi: ryi - 6 };
      const patches: Array<{ x0: number; x1: number; y: number }> = [];
      for (const ly of h.lines) {
        const t = Math.max(0, 1 - ((ly - cy) / ring.ryi) ** 2), inner = ring.rxi * Math.sqrt(t);
        const outer = ring.rxo * Math.sqrt(Math.max(0, 1 - ((ly - cy) / ring.ryo) ** 2));
        patches.push({ x0: cx - outer - 10, x1: cx - inner + 3, y: ly }, { x0: cx + inner - 3, x1: cx + outer + 10, y: ly });
      }
      // The drawn band itself (a little inside the measured contours) is opaque.
      const band = { cx, cy, rxo: rxo - 1, ryo: ryo - 1, rxi: rxi + 2, ryi: ryi + 2 };
      cutouts.push({ rect: { x: cx - ring.rxo, y: cy - ring.ryo, w: ring.rxo * 2, h: ring.ryo * 2 }, ring, patches, band });
    }
    if (fx.includes('cars')) for (const c of this.def.cars ?? []) {
      // The whole car: everything reaching into its box, within a padded region.
      const pad = 45;
      cutouts.push({ rect: { x: c[0] - pad, y: c[1] - pad, w: c[2] + pad * 2, h: c[3] + pad * 2 }, inside: true,
        core: { x: c[0] + c[2] * 0.2, y: c[1] + c[3] * 0.2, w: c[2] * 0.6, h: c[3] * 0.6 } });
    }

    this.world = this.add.container(0, 0).setDepth(0);
    if (this.cover) {
      // An opaque paper base over the whole window, so the dimming, greying and
      // heat shimmer apply evenly to the extension as well as the art.
      this.world.add(this.add.rectangle(-W, -H, W * 3, H * 3, 0xfdfbf4, 1).setOrigin(0, 0));
    }
    // A wider version of the art, if present: same height, centred on the
    // original, so story.json coordinates still hold.
    const wide = this.cover && this.def.artWide && this.textures.exists(artKey(this.def.artWide)) ? this.def.artWide : null;
    let q = 1, wx0 = 0;
    if (wide) {
      const src = this.textures.get(artKey(wide)).getSourceImage() as HTMLImageElement;
      q = src.height / FH;
      wx0 = -(src.width / q - FW) / 2;
      this.artX = [wx0, FW - wx0];
    } else this.artX = [0, FW];
    const kk = wide ? Math.min(1, (this.s / q) * viewport.zoom) : k;
    this.art = prepareArt(this, wide ?? this.artPath(), kk, cutouts);
    if (this.art) {
      this.cameras.main.setBackgroundColor(this.art.paper);
      const at = this.U(wx0, 0);
      this.frameImg = this.add.image(at.x, at.y, this.art.key).setOrigin(0, 0).setScale(this.s / (q * kk));
      this.world.add(this.frameImg);
      // Cover scenes: the boil / dim / heat shimmer run on the whole world
      // (art, generated extension and effects), so nothing is left out of them.
      this.fx = frameFx(this.cover ? this.world : this.frameImg);
    } else {
      // Missing art: say so plainly rather than show a broken frame.
      this.paper = new PaperBackground(this);
      this.world.add(this.add.text(W / 2, H * 0.3, `[missing art: public/art/scenes/${this.artPath()}]`,
        { fontFamily: settings.serifFamily(), fontSize: `${settings.fontSizePx(1.2)}px`, color: settings.inkCss() }).setOrigin(0.5));
    }
    this.ambient = new Ambient(this, this.boiler, 5);
    this.world.add(this.ambient.layer);
    this.setupFx(fx);

    // UI.
    if (this.def.layout === 'choice') {
      const L = story.choiceLayout;
      const [px, py, , ph] = L.panel;
      const panel = this.R([px - 28, py - 26, 2040 - (px - 28), ph + 26 + 36]);
      const buttons = L.buttons.map((b) => this.R([b[0] - 10, b[1] - 10, b[2] + 20, b[3] + 20]));
      const cover = this.R([2030, 1372, 480, 528]);
      this.panel = new ChoicePanel(this, this.boiler, panel, buttons, cover, 64 * this.s, 42 * this.s, () => this.advance(), this.art?.paper);
    } else {
      const b = this.def.box ?? [644, 1544, 1592, 300];
      let rect = this.R([b[0] - 28, b[1] - 26, b[2] + 56, b[3] + 26 + 40]);
      if (this.cover) {
        // The art may be cropped: keep the box on screen, bottom-centred.
        const w = Math.min(W * 0.7, rect.w), h = rect.h;
        rect = { x: (W - w) / 2, y: H - h - Math.max(14, H * 0.045), w, h };
      }
      this.narration = new NarrationBox(this, this.boiler,
        { rect, fontUnits: 62 * this.s, align: 'center', pad: 40 * this.s }, () => this.advance());
    }
    if (this.def.time) {
      const objs = timeChip(this, this.boiler, TEXT[this.def.time] ?? '', Math.max(14, this.ox + 30 * this.s), Math.max(12, this.oy + 30 * this.s));
      this.extra.push({ destroy: () => objs.forEach((o) => o.destroy()) });
    }
    this.built = true;
    this.showBeat();
  }

  private outcomeText(key: string): string {
    const k = key.replace('{outcome}', gameState.outcome());
    return TEXT[k] ?? `[placeholder] ${k}`;
  }

  private showBeat(): void {
    const beats = this.def.beats ?? [];
    const b = beats[Math.min(this.beat, beats.length - 1)];
    if (!b) return;
    gameState.setPosition(this.id, this.beat);
    const text = this.outcomeText(b.text);
    const items: FocusableControl[] = [];
    if (this.panel) {
      if (b.choices) {
        this.panel.narration.setText(text, false);
        const set = b.choices as ChoiceSetId;
        items.push(...this.panel.setChoices(CHOICE_SETS[set].map((c) => ({
          label: c.label, aria: c.label, onPick: () => this.pick(set, c.id),
        }))));
      } else {
        this.panel.setChoices([]);
        this.panel.narration.setText(text, true);
        items.push(this.panel.narration);
      }
    } else if (this.narration) {
      this.narration.setText(text, true);
      items.push(this.narration);
    }
    announce(text);
    this.focusList.setItems(items);
    this.focusList.focus(0);
    // The finale opens on the crowd: the box waits for the zoom-out.
    if (this.zoomPending) { this.narration?.setVisible(false); }
  }

  private advance(): void {
    if (inputLocked()) return;
    const beats = this.def.beats ?? [];
    if (this.beat < beats.length - 1) { this.beat++; this.showBeat(); return; }
    if (this.def.next) this.go(this.def.next);
  }

  private pick(set: ChoiceSetId, id: string): void {
    if (inputLocked()) return;
    const c = gameState.choose(set, id);
    this.go(c.next);
  }

  private go(next: string): void {
    gameState.setPosition(next, 0);
    transitionOut(this, () => this.scene.restart({ id: next, beat: 0 }));
  }

  private bindKeys(): void {
    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => {
      if (settings.matchesAction('cancel', e.code)) {
        gameState.setPosition(this.id, this.beat);
        transitionOut(this, () => this.scene.start(SCENE_SETTINGS, { returnTo: SCENE_STORY }));
        e.preventDefault();
      } else if (settings.matchesAction('down', e.code)) { this.focusList.move(1); e.preventDefault(); }
      else if (settings.matchesAction('up', e.code)) { this.focusList.move(-1); e.preventDefault(); }
    });
  }

  // --- scene fx --------------------------------------------------------------------------

  private setupFx(fx: string[]): void {
    const amb = this.ambient!;
    if (fx.includes('eyes')) this.setupEyes();
    if (fx.includes('leaves')) amb.leaves(this.frameArea(0, 0, FW, 1300), 6);
    if (fx.includes('leavesFast')) amb.leaves(this.frameArea(300, 300, 2280, 1500), 9, true);
    if (fx.includes('birds')) amb.birds(this.frameArea(0, 0, FW, 700));
    if (fx.includes('bob') && this.frameImg) {
      const img = this.frameImg, y0 = img.y;
      this.updaters.push((t, _dt, reduced) => {
        img.setY(reduced ? y0 : y0 + Math.sin(t / 1000 * 2.4) * 2.2 + Math.sin(t / 1000 * 5.1) * 0.6);
        img.setRotation(reduced ? 0 : Math.sin(t / 1000 * 1.2) * 0.0025);
      });
    }
    if (fx.includes('busWindows')) this.setupBusWindows();
    if (fx.includes('handles')) this.setupHandles();
    if (fx.includes('cars')) this.setupCars();
    if (fx.includes('drowsy')) this.setupDrowsy();
    if (fx.includes('city')) this.setupCity();
    if (fx.includes('zoomOut') && !settings.get('reducedMotion')) this.setupZoom();
  }

  /** Blink the player's baked face: cover the eye dots, draw closed lids. */
  private setupEyes(): void {
    const eyes = this.def.eyes?.[gameState.player.avatar as AvatarId];
    if (!eyes || !this.art) return;
    const g = this.add.graphics().fillStyle(this.art.paper, 1);
    const lids: SketchShape[] = [];
    for (const [ex, ey] of eyes) {
      const p = this.U(ex, ey), r = 14 * this.s;
      g.fillEllipse(p.x, p.y, r * 2, r * 2);
      const w = 13 * this.s;
      lids.push(this.boiler.add(new SketchShape(this, pathShape([{ x: p.x - w, y: p.y - 1 * this.s }, { x: p.x, y: p.y + 4 * this.s }, { x: p.x + w, y: p.y - 1 * this.s }]),
        { color: COLOR_INK, width: 1.1, alpha: 1 }, { jitter: 0.3, fps: BOIL_FPS_UI, depth: 3 })));
    }
    this.world.add(g);
    lids.forEach((l) => this.world.add(l.object));
    const show = (v: boolean) => { g.setVisible(v); lids.forEach((l) => l.setVisible(v)); };
    show(false);
    let next = 2.5;
    let closed = 0;
    this.updaters.push((_t, dt, reduced) => {
      if (reduced) { show(false); return; }
      if (closed > 0) { closed -= dt; if (closed <= 0) show(false); return; }
      next -= dt;
      if (next <= 0) { show(true); closed = 0.13; next = 2.2 + Math.random() * 3.8; }
    });
  }

  /**
   * Bus: each handle's loop swings like a pendulum from its pivot on the bar,
   * out of sync, with an occasional shared lurch when the bus bumps — which
   * also gives the whole interior a small bounce. Windows never sway.
   */
  private setupHandles(): void {
    if (!this.art) return;
    const k = this.art.k;
    const hs = (this.def.handles ?? []).map((h, i) => {
      const cut = this.art!.cutouts[i];
      const r = cut.rect, [px, py] = h.pivot;
      const p = this.U(px, py);
      const img = this.add.image(p.x, p.y, cut.key).setOrigin((px - r.x) / r.w, (py - r.y) / r.h).setScale(this.s / k);
      this.world.add(img);            // above the window scenery
      return { img, w: 1.6 + i * 0.27, ph: i * 2.1, a: 0.05 + i * 0.006 };
    });
    let lurch = 99, nextLurch = 4 + Math.random() * 4;
    const y0 = this.world.y;
    this.updaters.push((t, dt, reduced) => {
      if (!reduced) {
        nextLurch -= dt; lurch += dt;
        if (nextLurch <= 0) { lurch = 0; nextLurch = 5 + Math.random() * 5; }
      }
      const env = Math.exp(-lurch * 1.6);
      const kick = 0.09 * env * Math.sin(lurch * 4.5);
      for (const h of hs) h.img.setRotation(reduced ? 0 : h.a * Math.sin((t / 1000) * h.w + h.ph) + kick);
      // The shared bump: a quick small drop and settle of the whole interior.
      const bump = reduced ? 0 : -3.5 * env * Math.sin(lurch * 9) * this.s / 0.35;
      this.world.setY(y0 + bump);
      this.busMask?.setY(bump);
    });
  }

  private busMask?: Phaser.GameObjects.Graphics;

  /**
   * Scenery scrolling past the bus windows: generated pencil buildings (far,
   * slow), trees and lamp posts (mid), telephone poles and wires (near, fast),
   * looping seamlessly, clipped to the window interiors.
   */
  private setupBusWindows(): void {
    const wins = this.def.windows ?? [];
    if (!wins.length) return;
    const inset = 12;
    const ys = wins.map((w) => w[1]), ye = wins.map((w) => w[1] + w[3]);
    const band = this.R([wins[0][0], Math.min(...ys), wins[wins.length - 1][0] + wins[wins.length - 1][2] - wins[0][0], Math.max(...ye) - Math.min(...ys)]);
    const mask = this.make.graphics({}).fillStyle(0xffffff, 1);
    for (const w of wins) { const r = this.R([w[0] + inset, w[1] + inset, w[2] - inset * 2, w[3] - inset * 2]); mask.fillRect(r.x, r.y, r.w, r.h); }
    this.busMask = mask;
    const gm = mask.createGeometryMask();
    const z = viewport.zoom, H = Math.ceil(band.h * z), TW = 1024;
    const g = H * 0.8;                                   // ground line in the tile
    const amb = this.ambient!;
    // Loose pencil, like the user's drawing: multi-pass jittered strokes that
    // start late or overshoot, light hatching, windows as a few scribbles.
    // Far = fainter and looser; near = darker. (Tile px.)
    const J = z * 0.6;
    const far = amb.tileTextures(`busFar2-${H}`, TW, H, (r) => {
      const out: Pt[][] = [];
      for (let x = 0; x < TW;) {
        const w = 80 + r() * 120, h = H * (0.3 + r() * 0.4), top = g - h;
        out.push(...sketchPath([{ x, y: g }, { x: x + (r() - 0.5) * 4, y: top }, { x: x + w, y: top + (r() - 0.5) * 6 }, { x: x + w, y: g }], r, { amp: 2.4 * J }));
        if (r() < 0.6) out.push(...hatchPolygon([{ x: x + 3, y: top + 4 }, { x: x + w * 0.3, y: top + 4 }, { x: x + w * 0.3, y: g }, { x: x + 3, y: g }], HATCH_ANGLE, 7 * J, r, 0.3));
        for (let n = 0; n < 2 + r() * 4; n++) out.push(...scribbleMark({ x: x + 14 + r() * (w - 28), y: top + 14 + r() * (h - 30) }, 10 * J, 12 * J, r));
        x += w + 6 + r() * 40;
      }
      return out;
    }, { width: 0.5, alpha: 0.4 }, () => 1);
    const mid = amb.tileTextures(`busMid2-${H}`, TW, H, (r) => {
      const out: Pt[][] = sketchLine({ x: -20, y: g }, { x: TW + 20, y: g + 2 }, r, { amp: 2 * J, passes: 2 });
      for (let x = 60; x < TW; x += 150 + r() * 90) {
        if (r() < 0.65) {                                   // a tree: scribbled crown, two-line trunk
          const th = H * (0.22 + r() * 0.08), cr = H * (0.1 + r() * 0.04), cy = g - th - cr * 0.7;
          out.push(...sketchLine({ x: x - 3, y: g }, { x: x - 1, y: g - th }, r, { amp: J }));
          out.push(...sketchLine({ x: x + 4, y: g }, { x: x + 3, y: g - th }, r, { amp: J }));
          const loop: Pt[] = [];
          for (let k2 = 0; k2 <= 22; k2++) { const a = (k2 / 22) * Math.PI * 2.15, rr = cr * (0.8 + 0.3 * Math.sin(a * 5 + x) + (r() - 0.5) * 0.15); loop.push({ x: x + Math.cos(a) * rr * 1.2, y: cy + Math.sin(a) * rr }); }
          out.push(loop);
          out.push(...hatchPolygon(loop.slice(6, 14).concat([{ x, y: cy }]), HATCH_ANGLE, 5 * J, r, 0.3));
        } else {                                            // a lamp post, overshooting strokes
          const ph = H * 0.62;
          out.push(...sketchLine({ x, y: g + 4 }, { x: x + 1, y: g - ph }, r, { amp: J, passes: 2 }));
          out.push(...sketchPath([{ x, y: g - ph }, { x: x + 10, y: g - ph - 12 }, { x: x + 36, y: g - ph - 9 }], r, { amp: J }));
          out.push(...scribbleMark({ x: x + 34, y: g - ph - 4 }, 10, 6, r));
        }
      }
      return out;
    }, { width: 0.7, alpha: 0.65 }, () => 1);
    const near = amb.tileTextures(`busNear2-${H}`, TW, H, (r) => {
      // One telephone pole per tile, wires sagging to the next (wraps).
      const x = TW * 0.3, arm = H * 0.12;
      const out: Pt[][] = [
        ...sketchLine({ x, y: H + 10 }, { x: x + 3, y: -10 }, r, { amp: 1.5 * J, passes: 3, lift: 0.05 }),
        ...sketchLine({ x: x - 46, y: arm }, { x: x + 48, y: arm + 3 }, r, { amp: J, passes: 2 }),
      ];
      out.push(...hatchPolygon([{ x: x - 6, y: 0 }, { x: x - 1, y: 0 }, { x: x - 1, y: H }, { x: x - 6, y: H }], HATCH_ANGLE, 4, r, 0.2));
      for (const dx of [-38, 0, 40]) {
        const sag: Pt[] = [];
        for (let t = 0; t <= 1.0001; t += 0.08) sag.push({ x: x + dx + TW * t, y: arm + 3 + Math.sin(Math.PI * t) * H * 0.12 + (r() - 0.5) * 1.5 });
        out.push(sag);
      }
      return out;
    }, { width: 1.1, alpha: 0.9 }, () => 1);
    for (const [keys, alpha, speed] of [[far, 0.55, -22], [mid, 0.8, -70], [near, 0.9, -170]] as Array<[string[], number, number]>) {
      const ts = amb.tiled(band, keys, alpha, speed);
      ts.setMask(gm);
    }
  }

  /** Cars drive on toward the vanishing point, fade, and loop — staggered, bouncing. */
  private setupCars(): void {
    if (!this.art) return;
    const k = this.art.k, V = this.U(this.def.vanish![0], this.def.vanish![1]);
    const EXT = 1.35, t0 = 1 - 1 / EXT;
    const cars = (this.def.cars ?? []).map((c, i) => {
      const cut = this.art!.cutouts[i];
      const c0 = this.U(c[0] + c[2] / 2, c[1] + c[3] / 2);
      const img = this.add.image(c0.x, c0.y, cut.key).setScale(this.s / k);
      this.world.addAt(img, 1);
      return { img, c0, period: 26 + i * 4.3, t: t0 + i * 0.013 };
    });
    this.updaters.push((_t, dt, reduced) => {
      for (const [i, c] of cars.entries()) {
        if (!reduced) c.t = (c.t + dt / c.period) % 1;
        const t = reduced ? t0 : c.t, f = EXT * (1 - t);
        const a = t < 0.06 ? t / 0.06 : t > 0.78 ? Math.max(0, 1 - (t - 0.78) / 0.16) : 1;
        const bounce = reduced ? 0 : Math.sin(this.time.now / 1000 * 11 + i * 1.7) * 0.8 * f;
        c.img.setPosition(V.x + (c.c0.x - V.x) * f, V.y + (c.c0.y - V.y) * f + bounce)
          .setScale((this.s / k) * f).setAlpha(a);
      }
    });
  }

  /** Placeholder for the missing face frame: the player's head dozes off in a vignette. */
  private setupDrowsy(): void {
    const v = this.def.vignette ?? [2380, 330, 420];
    const size = v[2] * this.s, c = this.U(v[0], v[1]);
    const fill = this.add.graphics().setDepth(28).fillStyle(COLOR_PAPER, 1).fillRect(c.x - size / 2, c.y - size / 2, size, size);
    const frame = this.boiler.add(new SketchShape(this, boxShape(c.x - size / 2, c.y - size / 2, size, size),
      { color: COLOR_INK, width: 1.2, alpha: 0.9 }, { jitter: 1.2, fps: BOIL_FPS_UI, depth: 29 }));
    const avatar = gameState.player.avatar as AvatarId;
    const ink = headInkRect(avatar);
    const scale = (size * 0.78) / ink.h;
    const head = new CharacterHead(this, avatar, c.x, c.y, scale, { maxScale: scale, centre: true }).setDepth(30);
    head.autoBlink = false;
    head.stopBlinking();
    this.heads.push(head);
    this.extra.push(fill, frame);
    const droop = () => {
      head.setEyes('closed');
      // As the eyes close, the day's music slowly drifts away.
      music.fadeOut(FADES.dozeOut);
      if (settings.get('reducedMotion')) { head.pose = { rot: 0.2, dy: size * 0.05 }; return; }
      const st = { k: 0 };
      this.tweens.add({ targets: st, k: 1, duration: 1400, ease: 'Sine.easeInOut', onUpdate: () => { head.pose = { rot: 0.2 * st.k, dy: size * 0.05 * st.k }; } });
    };
    if (settings.get('reducedMotion')) { droop(); return; }
    // Heavy blinks first, each longer, then the eyes stay shut and the head drops.
    const blink = (at: number, ms: number) => this.time.delayedCall(at, () => {
      head.setEyes('closed');
      this.time.delayedCall(ms, () => head.setEyes('opened'));
    });
    blink(900, 420);
    blink(2100, 700);
    this.time.delayedCall(3300, droop);
  }

  /** The 2080 city in its outcome state. Neutral and bad are generated over the good frame. */
  /** The visible window in frame px (can extend beyond the art). */
  private viewFrame() {
    const { W, H } = viewport;
    return { x0: -this.ox / this.s, y0: -this.oy / this.s, x1: (W - this.ox) / this.s, y1: (H - this.oy) / this.s };
  }

  /**
   * The 2080 city in its outcome state, across the WHOLE window. Neutral and
   * bad are generated over the good frame. Every effect spans the visible
   * area (viewFrame), not just the art's rectangle.
   */
  private setupCity(): void {
    const amb = this.ambient!, C = story.city;
    const o = gameState.outcome();
    const v = this.viewFrame(), vw = v.x1 - v.x0;
    const area = (r: number[]) => this.R(r);
    const ext = this.extendCity(o);
    const roofs = [...C.roofs, ...ext.roofs].map(([x, y]) => this.U(x, y));
    const groundY = C.ground[1], groundH = C.ground[3];
    const ground = area([v.x0, groundY, vw, groundH]);
    const sky = area([v.x0, v.y0, vw, C.sky[3] - v.y0]);
    const whole = { x: 0, y: 0, w: viewport.W, h: viewport.H };
    const perW = vw / FW;                       // effect counts scale with the width shown
    if (o === 'good') {
      amb.birds(area([v.x0, v.y0, vw, 800 - v.y0]), 'happy', 1.1);
      amb.sparkles(area([v.x0, Math.max(v.y0, 150 + Math.min(0, v.y0)), vw, 1300]), Math.round(16 * perW));
      amb.walkers(ground, Math.round(9 * perW));
      amb.traffic(ground, 1, 'tram');
      amb.leaves(area([v.x0, 600, vw, 900]), Math.round(4 * perW));
    } else if (o === 'neutral') {
      // An ordinary city: some traffic and exhaust, a little smoke and litter, a faint haze.
      if (this.fx) this.fx.dim = 0.06;
      amb.veil(whole, 0x6f6f6f, 0.08);
      amb.smog(area([v.x0, 150, vw, 700]), 1);
      amb.traffic(ground, Math.round(6 * perW), 'car', true);
      amb.smoke(roofs.slice(0, 3 + ext.roofs.length), false, 0.8);
      amb.litter(ground, Math.round(18 * perW));
      amb.birds(area([v.x0, v.y0, vw, 700 - v.y0]), 'normal');
    } else {
      if (this.fx) { this.fx.dim = 0.24; this.fx.shimmer = 2.4 * viewport.dpr; }
      amb.hatching(sky, 0.5);
      amb.smog(area([v.x0, Math.min(100, v.y0 + 60), vw, 1200]), 3);
      amb.smoke(roofs, true, 1.3);
      amb.traffic(ground, Math.round(7 * perW), 'car', true);
      amb.litter(ground, Math.max(3, Math.round(6 * perW)), true);
      amb.veil(whole, 0x1e1e1e, 0.12);
      amb.birds(area([v.x0, v.y0, vw, 900 - v.y0]), 'sad');
    }
  }

  /**
   * Extends the city beyond the art's edges, at the art's own scale and line
   * weight, layer by layer: sky (ridge and shading), buildings in the
   * outcome's character (good: clean towers among trees; neutral: ordinary
   * blocks; bad: smokestacks and ruins), the tree row, ground line, road and
   * pavement, and the crowd — copies of the user's own crowd, mirrored and
   * varied in size, position and darkness. A soft hatched band hides each
   * seam. Returns rooftops / stacks for smoke.
   */
  private extendCity(o: string): { roofs: number[][] } {
    const v = this.viewFrame(), roofs: number[][] = [];
    const [ax0, ax1] = this.artX;
    const g = new StrokeGroups();
    const s = this.s, P = (x: number, y: number) => this.U(x, y);
    const L: StrokeLayer = { name: 'cityExt', depth: 0, jitter: 0.8, fps: BOIL_FPS_SCENERY, cell: 240 };
    // Weight matched to the art's city lines (~7 frame px, near-black).
    const ink = { color: 0x161616, width: 3.4 * s, alpha: 1 };
    const mid = { color: 0x222222, width: 2.2 * s, alpha: 0.85 };
    const thin = { color: 0x2a2a2a, width: 1.5 * s, alpha: 0.6 };
    const r = mulberry32(2080 + o.length * 7);
    const sk = (pts: Pt[], st: typeof ink, closed = false) => g.add(L, sketchPath(pts.map((p) => P(p.x, p.y)), r, { closed, amp: 2.2 * s }), st);
    const line = (a: Pt, b: Pt, st: typeof ink) => g.add(L, sketchLine(P(a.x, a.y), P(b.x, b.y), r, { amp: 2 * s }), st);
    const GROUND = 1470, ROAD = 1535, BASE = 1090;

    const side = (a: number, b: number, dir: 1 | -1) => {
      if (b - a < 6) return;
      const from = dir > 0 ? a : b, w = b - a;
      const xs = (f: number) => from + dir * f;          // f: distance out from the art's edge
      // Sky: the far ridge carries on, with the art's diagonal shading under it.
      const ridge: Pt[] = [];
      const y0 = dir > 0 ? 40 : 330;
      for (let f = -40; f <= w + 40; f += 120) ridge.push({ x: xs(f), y: y0 + Math.sin(f * 0.004) * 90 + f * 0.12 });
      sk(ridge, mid);
      for (let f = 30; f < w; f += 26 + r() * 20) {
        if (r() < 0.45) continue;
        const ry = y0 + Math.sin(f * 0.004) * 90 + f * 0.12;
        line({ x: xs(f), y: ry + 20 }, { x: xs(f) - dir * 60, y: ry + 200 + r() * 120 }, thin);
      }
      // Buildings, from the edge outward.
      for (let f = 10; f < w;) {
        const bw = 150 + r() * 200, top = 160 + r() * 460, x0 = dir > 0 ? xs(f) : xs(f) - bw;
        if (o === 'bad' && r() < 0.35) {
          // Smokestack: a tall tapering chimney with bands.
          const sw = 60 + r() * 30, sx = x0 + bw / 2, st = 120 + r() * 200;
          sk([{ x: sx - sw / 2, y: BASE }, { x: sx - sw * 0.35, y: st }, { x: sx + sw * 0.35, y: st }, { x: sx + sw / 2, y: BASE }], ink);
          for (const t of [0.15, 0.3]) line({ x: sx - sw * 0.4, y: st + (BASE - st) * t }, { x: sx + sw * 0.4, y: st + (BASE - st) * t }, mid);
          g.add(L, hatchPolygon([P(sx - sw * 0.45, st + 10), P(sx - sw * 0.05, st + 10), P(sx - sw * 0.05, BASE), P(sx - sw * 0.5, BASE)], HATCH_ANGLE, 7 * s, r), { ...thin, alpha: 0.7 });
          roofs.push([sx, st - 20]);
        } else if (o === 'bad') {
          // Ruin: a broken, jagged top and a gaping hole.
          const jag: Pt[] = [{ x: x0, y: BASE }, { x: x0, y: top + 80 }];
          for (let t = 1; t <= 5; t++) jag.push({ x: x0 + (bw * t) / 5, y: top + (t % 2 ? 0 : 90) + r() * 140 });
          jag.push({ x: x0 + bw, y: BASE });
          sk(jag, ink);
          sk([{ x: x0 + bw * 0.3, y: top + 300 }, { x: x0 + bw * 0.62, y: top + 260 }, { x: x0 + bw * 0.58, y: top + 420 }, { x: x0 + bw * 0.28, y: top + 440 }], mid, true);
          g.add(L, hatchPolygon([P(x0 + bw * 0.3, top + 300), P(x0 + bw * 0.62, top + 260), P(x0 + bw * 0.58, top + 420), P(x0 + bw * 0.28, top + 440)], -0.35, 6 * s, r), { ...mid, alpha: 0.7 });
          g.add(L, hatchPolygon([P(x0 + 6, top + 90), P(x0 + bw * 0.3, top + 90), P(x0 + bw * 0.3, BASE), P(x0 + 6, BASE)], HATCH_ANGLE, 8 * s, r), { ...thin, alpha: 0.7 });
          roofs.push([x0 + bw * 0.5, top + 40]);
        } else {
          // Good: clean slim towers, few lines, rooftop trees. Neutral: ordinary blocks.
          const clean = o === 'good', bt = clean ? top - 60 : top + 60;
          sk([{ x: x0, y: BASE }, { x: x0, y: bt }, { x: x0 + bw, y: bt }, { x: x0 + bw, y: BASE }], ink);
          g.add(L, hatchPolygon([P(x0 + 6, bt + 6), P(x0 + bw * (clean ? 0.22 : 0.32), bt + 6), P(x0 + bw * (clean ? 0.22 : 0.32), BASE), P(x0 + 6, BASE)], HATCH_ANGLE, (clean ? 11 : 8) * s, r), { ...thin, alpha: clean ? 0.45 : 0.65 });
          if (clean) {
            for (let fy = bt + 120; fy < BASE - 40; fy += 140) line({ x: x0 + 10, y: fy }, { x: x0 + bw - 10, y: fy }, thin);
            const tree: Pt[] = [];
            for (let k2 = 0; k2 <= 12; k2++) { const an = Math.PI + (k2 / 12) * Math.PI, rr = 40 + 10 * Math.sin(k2 * 2); tree.push({ x: x0 + bw / 2 + Math.cos(an) * rr * 1.3, y: bt + Math.sin(an) * rr }); }
            sk(tree, mid);
          } else {
            for (let wy = bt + 70; wy < BASE - 50; wy += 64) for (let wx = x0 + bw * 0.4; wx < x0 + bw - 30; wx += 48) {
              if (r() < 0.6) g.add(L, scribbleMark(P(wx, wy), 22 * s, 26 * s, r), thin);
            }
            if (r() < 0.4) { sk([{ x: x0 + bw * 0.7, y: bt }, { x: x0 + bw * 0.7, y: bt - 70 }, { x: x0 + bw * 0.82, y: bt - 70 }, { x: x0 + bw * 0.82, y: bt }], mid); roofs.push([x0 + bw * 0.76, bt - 90]); }
          }
        }
        f += bw + 25 + r() * 50;
      }
      // The tree row (bare and broken for bad), and green space for good.
      // The first tree stands across the seam (whole, in front of the art's cut-off one).
      for (let f = 0; f < w + 60; f += (o === 'good' ? 200 : 260) + r() * 60) {
        const x = xs(f);
        if (o === 'bad') {
          const top = 1150 + r() * 60;
          line({ x, y: GROUND }, { x: x + 6, y: top }, ink);
          for (let k2 = 0; k2 < 4; k2++) { const by = top + 30 + k2 * 50, sd = k2 % 2 ? 1 : -1; line({ x: x + 3, y: by }, { x: x + sd * (50 + r() * 40), y: by - 50 - r() * 30 }, mid); }
          continue;
        }
        const cy = 1160 + r() * 40, R = 100 + r() * 30, loop: Pt[] = [];
        for (let k2 = 0; k2 <= 18; k2++) { const an = (k2 / 18) * Math.PI * 2, rr = R * (0.85 + 0.22 * Math.sin(an * 5 + f)); loop.push({ x: x + Math.cos(an) * rr * 1.15, y: cy + Math.sin(an) * rr * 0.8 }); }
        sk(loop, ink);
        line({ x: x - 12, y: cy + R * 0.7 }, { x: x - 20, y: GROUND }, mid);
        line({ x: x + 12, y: cy + R * 0.7 }, { x: x + 20, y: GROUND }, mid);
        if (o === 'good') for (let t = 0; t < 3; t++) { const gx = x + 60 + t * 30; line({ x: gx, y: GROUND - 2 }, { x: gx - 6, y: GROUND - 30 }, thin); line({ x: gx + 6, y: GROUND - 2 }, { x: gx + 12, y: GROUND - 26 }, thin); }
      }
      // Ground line, road and pavement, carried out from the art.
      line({ x: xs(-20), y: GROUND }, { x: xs(w + 20), y: GROUND + 2 }, ink);
      line({ x: xs(-20), y: ROAD }, { x: xs(w + 20), y: ROAD - 2 }, mid);
      for (let f = 30; f < w; f += 70 + r() * 80) {
        const px = xs(f), py = 1620 + r() * 60;
        g.add(L, sketchPath([P(px, py), P(px + 22, py - 14), P(px + 44, py), P(px + 22, py + 10)], r, { closed: true, amp: 1.5 * s }), thin);
      }
    };
    side(v.x0, ax0, -1);
    side(ax1, v.x1, 1);

    // The crowd: the user's own crowd strip, repeated outward from each edge.
    this.extendCrowd(v, ax0, ax1, r);

    // Soft hatched bands over each seam, so the join never reads as an edge.
    for (const ex of [ax0, ax1]) {
      if ((ex === ax0 && v.x0 >= ax0 - 2) || (ex === ax1 && v.x1 <= ax1 + 2)) continue;
      const band = [P(ex - 80, Math.max(v.y0, 0)), P(ex + 80, Math.max(v.y0, 0)), P(ex + 80, 1590), P(ex - 80, 1590)];
      g.add(L, hatchPolygon(band, HATCH_ANGLE, 10 * s, r, 0.3), { ...thin, alpha: 0.3 });
      g.add(L, hatchPolygon(band, -0.35, 13 * s, r, 0.3), { ...thin, alpha: 0.2 });
    }

    // Taller than the art: a few hand-drawn clouds in the sky above it.
    if (v.y0 < -30) {
      for (let row = 0; row < 4; row++) {
        const y = v.y0 * (0.15 + row * 0.22);
        if (y > -60) continue;
        for (let x = v.x0 + r() * 400; x < v.x1; x += 600 + r() * 400) {
          const wC = 280 + r() * 260, pts: Pt[] = [];
          for (let k2 = 0; k2 <= 16; k2++) { const t = k2 / 16; pts.push({ x: x + t * wC, y: y - Math.abs(Math.sin(t * Math.PI * 3)) * 34 - Math.sin(t * Math.PI) * 30 }); }
          sk(pts, { ...thin, alpha: 0.45 });
        }
      }
    }
    const built = g.build(this, this.boiler);
    built.forEach((b) => this.world.addAt(b.object, 2));
    return { roofs };
  }

  /**
   * The crowd beyond the art's edges, as WHOLE figures only — never sliced,
   * mirrored in halves or filled with rectangles (user, 2026-10-04).
   *
   * The user's crowd can't be separated into people automatically (every
   * front figure joins one connected dark mass through the bodies; back
   * figures are partly hidden), so figures come from `crowdFigures` in story.json (e.g. person_1..6.png)
   * when listed, else are generated: a head and shoulders in
   * soft graphite with a brushed, grainy edge, front row near-black, back row
   * grey, matching the art's head size and baselines. Bodies run past the
   * bottom of the screen, so the only edge that crops a person is the screen's.
   * One front figure stands across each seam, hiding where the art ends.
   */
  private extendCrowd(v: { x0: number; x1: number; y1: number }, ax0: number, ax1: number, r: () => number): void {
    if (v.x0 >= ax0 - 2 && v.x1 <= ax1 + 2) return;
    this.featherArtCrowd(v.x0 < ax0 - 2, v.x1 > ax1 + 2);
    const bottom = Math.max(FH, v.y1) + 40;
    const given = (this.def.crowdFigures ?? []).map((f) => artKey(f)).filter((k) => this.textures.exists(k));
    const figures = given.length ? given.map((k, i) => this.personTexture(k, i)) : null;
    const make = (variant: number, back: boolean): { key: string; w: number; top: number; unit: number } => {
      if (figures) return figures[variant % figures.length];
      return this.figureTexture(variant, back, bottom);
    };
    type Fig = { x: number; top: number; scale: number; flip: boolean; back: boolean; variant: number; shade: number };
    const figs: Fig[] = [];
    const row = (back: boolean, a: number, b: number) => {
      const gap = back ? 250 : 320;
      for (let x = a + (r() - 0.5) * 80; x < b; x += gap * (0.85 + r() * 0.3)) {
        figs.push({
          x, back, variant: Math.floor(r() * 6), flip: r() < 0.5,
          top: back ? 1630 + r() * 60 : 1575 + r() * 50, scale: (back ? 0.9 : 0.95) + r() * 0.15,
          shade: back ? 0.85 + r() * 0.15 : 1,
        });
      }
    };
    if (v.x0 < ax0 - 2) { row(true, v.x0 - 200, ax0 + 60); row(false, v.x0 - 260, ax0 - 120); }
    if (v.x1 > ax1 + 2) { row(true, ax1 - 60, v.x1 + 200); row(false, ax1 + 120, v.x1 + 260); }
    // A front figure straddling each seam, in front of the art's cut-off people.
    // Centred on the feathered band, so the art's cut-off edge person is hidden.
    if (v.x0 < ax0 - 2) figs.push({ x: ax0 + 40, top: 1580, scale: 1.08, flip: false, back: false, variant: 1, shade: 1 });
    if (v.x1 > ax1 + 2) figs.push({ x: ax1 - 40, top: 1585, scale: 1.08, flip: true, back: false, variant: 4, shade: 1 });
    // Back rows first, front rows over them.
    figs.sort((p, q) => Number(q.back) - Number(p.back));
    for (const f of figs) {
      const t = make(f.variant, f.back);
      const p = this.U(f.x, f.top);
      const img = this.add.image(p.x, p.y, t.key).setOrigin(0.5, t.top).setScale(t.unit * f.scale)
        .setFlipX(f.flip).setAlpha(f.shade);
      this.world.add(img);
    }
  }

  /**
   * Fade the art's crowd band out over its last ~110 frame px at each extended
   * side, so a person the art's edge cuts in half dissolves under the seam
   * figure instead of ending on a hard vertical line.
   */
  private featherArtCrowd(left: boolean, right: boolean): void {
    if (!this.art) return;
    const tex = this.textures.get(this.art.key);
    const c = tex.getSourceImage() as HTMLCanvasElement;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const k = c.width / (this.artX[1] - this.artX[0]);
    const y0 = Math.round(1540 * k), h = c.height - y0, fw = Math.round(110 * k);
    const img = ctx.getImageData(0, y0, c.width, h), d = img.data;
    const paper = [(this.art.paper >> 16) & 255, (this.art.paper >> 8) & 255, this.art.paper & 255];
    for (let y = 0; y < h; y++) {
      const vy = Math.min(1, y / (40 * k));               // ease in below the road
      for (const [on, x0, sign] of [[left, 0, 1], [right, c.width - 1, -1]] as Array<[boolean, number, number]>) {
        if (!on) continue;
        for (let i = 0; i < fw; i++) {
          const t = 1 - (i / fw) * vy, p = (y * c.width + x0 + sign * i) * 4;
          const f = Math.min(1, Math.max(0, 1 - t)) ** 1.5;       // 0 at the edge → 1 inside
          for (let ch = 0; ch < 3; ch++) d[p + ch] = d[p + ch] * f + paper[ch] * (1 - f);
        }
      }
    }
    ctx.putImageData(img, 0, y0);
    (tex as Phaser.Textures.CanvasTexture).refresh();
  }

  /**
   * A generated person (head and shoulders) as a texture at device
   * resolution: filled graphite with a brushed edge and paper grain, like the
   * user's crowd. `back` = the greyer back row. Cached per variant.
   */
  private figureTexture(variant: number, back: boolean, bottom: number): { key: string; w: number; top: number; unit: number } {
    const z = viewport.zoom, s = this.s, k = s * z;            // texture px per frame px
    const key = `crowd-fig-${variant}-${back ? 'b' : 'f'}-${Math.round(k * 1000)}-${Math.round(bottom)}`;
    const r = mulberry32(700 + variant * 31 + (back ? 7 : 0));
    const headW = (back ? 235 : 225) + r() * 30, headH = headW * (1.18 + r() * 0.1);
    const shW = (back ? 470 : 560) + r() * 80, neck = 70 + r() * 20;
    const topY = 1600, H = bottom - topY;                       // frame px, head top at 0
    const W = shW + 80, cx = W / 2, pad = 20;
    if (!this.textures.exists(key)) {
      const c = document.createElement('canvas');
      c.width = Math.ceil(W * k); c.height = Math.ceil((H + pad) * k);
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.scale(k, k);
      ctx.translate(0, pad);
      // Head: an egg, with a tuft or two of hair on some variants.
      const outline: Pt[] = [];
      for (let i = 0; i <= 40; i++) {
        const a = -Math.PI / 2 + (i / 40) * Math.PI * 2;
        let rr = 1 + (Math.sin(a * 3 + variant) * 0.03);
        if (variant % 3 === 0 && Math.abs(a + Math.PI / 2 - 0.3) < 0.25) rr += 0.07;
        outline.push({ x: cx + Math.cos(a) * (headW / 2) * rr, y: headH / 2 + Math.sin(a) * (headH / 2) * rr * (Math.sin(a) > 0 ? 0.95 : 1) });
      }
      ctx.fillStyle = '#000';
      ctx.beginPath(); outline.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
      // Neck and shoulders, running down past the bottom.
      const sy = headH * 0.92 + 25;
      ctx.beginPath();
      ctx.moveTo(cx - neck / 2, headH * 0.8);
      ctx.lineTo(cx - neck / 2, sy);
      ctx.bezierCurveTo(cx - shW * 0.32, sy + 10, cx - shW / 2, sy + 40, cx - shW / 2, sy + 160);
      ctx.lineTo(cx - shW / 2 - 6, H + 10);
      ctx.lineTo(cx + shW / 2 + 6, H + 10);
      ctx.lineTo(cx + shW / 2, sy + 160);
      ctx.bezierCurveTo(cx + shW / 2, sy + 40, cx + shW * 0.32, sy + 10, cx + neck / 2, sy);
      ctx.lineTo(cx + neck / 2, headH * 0.8);
      ctx.closePath(); ctx.fill();
      // A brushed edge: pencil dabs all round the head, in device px.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // A rough crayon edge like the user's: two jittered dab passes.
      const style = defaultBrush({ color: '#000000', width: 14, alpha: 0.45, pressureNoise: 0.8 });
      for (let pass = 0; pass < 2; pass++) {
        dabPolyline(ctx, outline.map((p) => ({ x: (p.x + (r() - 0.5) * 9) * k, y: (p.y + pad + (r() - 0.5) * 9) * k })), (9 + pass * 4) * k, style, r);
      }
      // Solid like the user's crowd (front near-black, back mid-grey); grain only at the edge.
      finishRegion(ctx, 0, 0, c.width, c.height, defaultBrush({ color: back ? '#5c5c5c' : '#080808', grain: back ? 0.06 : 0.03 }), 0, 0);
      this.textures.addCanvas(key, c);
      this.extraKeys.push(key);
    }
    // Texture px are 1/zoom units (drawn at device resolution).
    return { key, w: W, top: pad / (H + pad), unit: 1 / z };
  }

  /** A user-supplied person_N.png as a crowd figure (opaque white → graphite on transparent). */
  private personTexture(srcKey: string, i: number): { key: string; w: number; top: number; unit: number } {
    const key = `${srcKey}~fig`;
    const img = this.textures.get(srcKey).getSourceImage() as HTMLImageElement;
    if (!this.textures.exists(key)) {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      for (let p = 0; p < d.data.length; p += 4) {
        const lum = d.data[p] * 0.299 + d.data[p + 1] * 0.587 + d.data[p + 2] * 0.114;
        const a = (d.data[p + 3] / 255) * Math.min(1, (1 - lum / 250) * 1.1);
        d.data[p] = d.data[p + 1] = d.data[p + 2] = 20; d.data[p + 3] = a * 255;
      }
      ctx.putImageData(d, 0, 0);
      this.textures.addCanvas(key, c);
      this.extraKeys.push(key);
    }
    void i;
    // Sized so the shoulders span ~560 frame px, like the generated figures.
    return { key, w: img.width, top: 0, unit: (560 * this.s) / img.width };
  }

  private extraKeys: string[] = [];

  /** Finale: open close on one person in the crowd, then pull back to all of them. */
  private setupZoom(): void {
    const [fx, fy, z] = this.def.zoomFrom ?? [1440, 1660, 3.2];
    const f = this.U(fx, fy), { W, H } = viewport;
    // At zoom zz the screen centre shows a point sliding from the person (zz = z)
    // to the frame centre (zz = 1), so the pull-back stays on them throughout.
    const set = (zz: number) => {
      const k = (zz - 1) / (z - 1);
      const px = W / 2 + (f.x - W / 2) * k, py = H / 2 + (f.y - H / 2) * k;
      this.world.setScale(zz).setPosition(W / 2 - px * zz, H / 2 - py * zz);
    };
    set(z);
    this.zoomPending = true;
    this.updaters.push(() => {
      if (!this.zoomPending || inputLocked()) return;
      this.zoomPending = false;
      const st = { zz: z };
      this.tweens.add({
        targets: st, zz: 1, duration: 7000, ease: 'Sine.easeInOut',
        onUpdate: () => set(st.zz),
        onComplete: () => { set(1); this.narration?.setVisible(true); this.focusList.focus(0); },
      });
    });
  }

  // --- end card ------------------------------------------------------------------------------

  /**
   * Ending reflection: a blank sheet of warm paper with ONE paragraph — the
   * outcome's template filled with the player's own commute and lunch
   * choices (systems/reflection.ts) — centred, in the narration serif, ~60
   * characters per line. It fades in gently as a single block (reduced
   * motion: appears at once), then "continue ›" appears. A click or key
   * during the fade shows it immediately. If XL text on a small window makes
   * it taller than the screen, wheel / arrow keys scroll it.
   */
  private buildReflection(): void {
    const { W, H } = viewport;
    const reduced = settings.get('reducedMotion');
    const text = reflectionText(gameState.outcome(), gameState.player.choices);

    // The page: warm paper with the grain multiplied over it.
    this.cameras.main.setBackgroundColor(COLOR_REFLECTION_PAPER);
    const page = this.add.rectangle(0, 0, W, H, COLOR_REFLECTION_PAPER, 1).setOrigin(0, 0).setDepth(-1001);
    this.paper = new PaperBackground(this);
    this.paper.setBlendMode(Phaser.BlendModes.MULTIPLY);
    this.extra.push(page);

    const size = settings.fontSizePx(1.7);
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: settings.serifFamily(), fontSize: `${size}px`, color: settings.inkCss(),
      align: 'center', lineSpacing: Math.round(size * 0.55),
    };
    const probe = this.add.text(0, 0, 'x'.repeat(60), style).setVisible(false);
    const wrapW = Math.min(W - 64, probe.width);
    probe.destroy();
    const para = this.add.text(W / 2, 0, text, { ...style, wordWrap: { width: wrapW, useAdvancedWrap: true } })
      .setOrigin(0.5, 0).setDepth(10).setAlpha(0);
    const margin = Math.max(40, H * 0.1), avail = H - margin * 2;
    const maxScroll = Math.max(0, para.height - avail);
    const top0 = maxScroll > 0 ? margin : (H - para.height) / 2;
    let scroll = 0;
    const setScroll = (v: number) => { scroll = Phaser.Math.Clamp(v, 0, maxScroll); para.setY(top0 - scroll); };
    setScroll(0);
    this.extra.push(para);

    // "continue ›", bottom right, like the narration hint.
    const hint = this.add.text(W - Math.max(24, W * 0.04), H - Math.max(20, H * 0.05), `${uiText(config.story.continue)} ›`, {
      fontFamily: settings.serifFamily(), fontStyle: 'italic', fontSize: `${Math.round(settings.fontSizePx(1.15))}px`, color: settings.inkCss(),
    }).setOrigin(1, 1).setDepth(12).setAlpha(0).setVisible(false);
    this.extra.push(hint);
    const hb = hint.getBounds();
    let done = false, leaving = false;
    const proxy = new A11yProxy(this, {
      label: config.story.continueAria, x: hb.x - 12, y: hb.y - 8, w: hb.width + 24, h: hb.height + 16,
      onActivate: () => { if (!done) { finish(); return; } if (leaving || inputLocked()) return; leaving = true; this.go(this.def.next ?? 'end'); },
      onHover: (over) => hint.setAlpha(over ? 1 : 0.7),
    });
    proxy.el.style.display = 'none';
    this.extra.push(proxy);
    const control: FocusableControl = {
      proxy, activate: () => proxy.trigger(), restyle: () => undefined, destroy: () => undefined,
      setFocused: (v) => hint.setFontStyle(v ? 'bold italic' : 'italic'),
    };
    const finish = () => {
      if (done) return;
      done = true;
      this.tweens.killTweensOf(para);
      para.setAlpha(1);
      hint.setVisible(true);
      if (reduced) hint.setAlpha(0.7); else this.tweens.add({ targets: hint, alpha: 0.7, duration: 400 });
      proxy.el.style.display = '';
      this.focusList.setItems([control]);
      this.focusList.focus(0);
    };
    announce(text);

    this.input.on('pointerdown', () => { if (!done && !inputLocked()) finish(); });
    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => {
      if (settings.matchesAction('cancel', e.code)) return;
      if (done && maxScroll > 0 && (settings.matchesAction('up', e.code) || settings.matchesAction('down', e.code))) {
        setScroll(scroll + (settings.matchesAction('down', e.code) ? size * 3 : -size * 3));
        return;
      }
      if (!done && !inputLocked()) { finish(); e.preventDefault(); }
    });
    if (maxScroll > 0) this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => setScroll(scroll + dy * 0.5));

    if (reduced || this.runData.resized) { finish(); return; }
    // One gentle fade once the arrival transition has finished.
    let started = false;
    this.updaters.push(() => {
      if (started || inputLocked()) return;
      started = true;
      this.tweens.add({ targets: para, alpha: 1, duration: 1600, delay: 300, ease: 'Sine.easeInOut', onComplete: finish });
    });
  }


  /**
   * The end card: "fine line", the same brush underline as the "play as?"
   * heading, "thank you for playing!", and play again — stacked and centred at
   * any size, sized from the text-size setting.
   *
   * Reveal, once the arrival transition has finished: title → underline draws
   * itself left to right (~0.6 s) → thank-you fades in → play again. Reduced
   * motion (or a resize rebuild): everything simply appears.
   */
  private buildEnd(): void {
    const { W, H } = viewport;
    this.paper = new PaperBackground(this);
    const ink = settings.inkCss(), fam = settings.fontFamily();
    const title = this.add.text(W / 2, 0, uiText(TEXT['end.heading'] ?? 'fine line'),
      { fontFamily: fam, fontSize: `${settings.fontSizePx(3.4)}px`, color: ink }).setOrigin(0.5).setDepth(6);
    // Same font as the title, ~45% of its size.
    const thanks = this.add.text(W / 2, 0, uiText(TEXT['end.thanks'] ?? 'thank you for playing!'),
      { fontFamily: fam, fontSize: `${settings.fontSizePx(3.4 * 0.45)}px`, color: ink, align: 'center', wordWrap: { width: W * 0.8 } })
      .setOrigin(0.5).setDepth(6);
    this.extra.push(title, thanks);

    // Vertical stack, centred as a block. The underline sits where it does
    // under "play as?" (0.043 H below the heading's centre there), scaled to
    // this title's height so larger text sizes keep the same proportions.
    const bw = Math.max(H * 0.2, 150), bh = Math.max(H * 0.056, 40, thanks.height * 1.1);
    const ulGap = title.height * 0.62;               // title centre → underline
    const thanksGap = Math.max(H * 0.045, thanks.height * 0.9);
    const buttonGap = Math.max(H * 0.07, thanks.height * 1.6);
    const total = title.height / 2 + ulGap + thanksGap + thanks.height / 2 + buttonGap + bh;
    const top = Math.max(16, (H - total) / 2 - H * 0.02);
    const titleY = top + title.height / 2;
    const ulY = titleY + ulGap;
    const thanksY = ulY + thanksGap + thanks.height / 2;
    const buttonY = thanksY + thanks.height / 2 + buttonGap;
    title.setY(titleY);
    thanks.setY(thanksY);
    const tb = title.getBounds();
    const underline = brushUnderline(this, this.boiler, tb.x - 4, tb.right + 8, ulY, 6);

    this.endButton = new SketchButton(this, {
      x: W / 2 - bw / 2, y: buttonY, w: bw, h: bh, primary: true,
      label: config.story.playAgain, ariaLabel: config.story.playAgainAria, fontScale: 1.4, boiler: this.boiler,
      onActivate: () => {
        gameState.reset();
        // The dream track fades out; the day's track starts again from the top.
        music.play('ticking_softly', { restart: true, fadeOut: FADES.playAgainOut, fadeIn: 1 });
        transitionOut(this, () => this.scene.start(SCENE_TITLE));
      },
    });
    this.focusList.setItems([this.endButton]);
    this.focusList.focus(0);
    announce(`${TEXT['end.heading'] ?? ''}. ${TEXT['end.thanks'] ?? ''}`);

    if (settings.get('reducedMotion') || this.runData.resized) return;

    // Hidden until the scrapbook arrival has finished, then revealed in order.
    title.setAlpha(0);
    thanks.setAlpha(0);
    const reveal = this.add.graphics().setVisible(false);
    const mask = reveal.createGeometryMask();
    underline.object.setMask(mask);
    const x0 = tb.x - 14, x1 = tb.right + 18, y0 = ulY - 30, h = 60;
    const setReveal = (k: number) => reveal.clear().fillStyle(0xffffff, 1).fillRect(x0, y0, (x1 - x0) * k, h);
    setReveal(0);
    this.endButton.hide();
    let started = false;
    this.updaters.push(() => {
      if (started || inputLocked()) return;
      started = true;
      const tl = this.tweens.chain({
        tweens: [
          { targets: title, alpha: 1, duration: 380, ease: 'Sine.easeOut' },
          { targets: { k: 0 }, k: 1, duration: 600, ease: 'Sine.easeInOut', onUpdate: (tw: Phaser.Tweens.Tween) => setReveal(tw.getValue() ?? 0) },
          { targets: thanks, alpha: 1, duration: 450, ease: 'Sine.easeOut', onComplete: () => this.endButton?.fadeIn(80) },
        ],
        onComplete: () => { underline.object.clearMask(true); },
      });
      void tl;
    });
    this.extra.push(reveal);
  }

  // --- lifecycle -------------------------------------------------------------------------------

  private restyle(): void {
    // The end card and reflection are laid out from text sizes: rebuild in place.
    if (this.def.type === 'end' && this.built) { this.scene.restart({ id: this.id, beat: 0, resized: true }); return; }
    if (this.def.type === 'reflection' && this.built) { this.scene.restart({ id: this.id, beat: 0, resized: true }); return; }
    this.panel?.restyle();
    this.narration?.restyle();
    this.focusList.restyle();
  }

  update(time: number, delta: number): void {
    const reduced = settings.get('reducedMotion');
    this.boiler.setFrozen(reduced);
    this.boiler.update(time);
    this.paper?.update(delta);
    if (!this.built) return;
    const dt = Math.min(0.05, delta / 1000);
    this.updaters.forEach((u) => u(time, dt, reduced));
    this.ambient?.update(time, delta);
    this.heads.forEach((h) => h.update(time));
    this.narration?.update(delta);
    this.panel?.update(delta);
  }

  private teardown(): void {
    this.unsubscribe?.();
    // FocusList.destroy() would destroy its items too; they're destroyed below.
    this.narration?.destroy();
    this.endButton?.destroy();
    this.panel?.destroy();
    this.heads.forEach((h) => h.destroy());
    this.extra.forEach((e) => e.destroy());
    this.ambient?.destroy();
    this.boiler.destroy();
    this.paper?.destroy();
    freeArt(this, this.art);
    this.extraKeys.forEach((k) => { if (this.textures.exists(k)) this.textures.remove(k); });
    this.busMask?.destroy();
  }
}
