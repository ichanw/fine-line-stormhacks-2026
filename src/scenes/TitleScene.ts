/**
 * TitleScene — the first thing the player sees, and the showcase for the
 * art direction: graphite sketch on paper, monochrome everywhere except the
 * sea. It also proves out the core systems:
 *   - all text comes from /src/data/title.json (never hardcoded here);
 *   - every text style comes from the SettingsManager and updates live;
 *   - the menu is fully usable by keyboard alone AND mouse alone;
 *   - motion (the waves) respects the reduced-motion setting.
 */

import Phaser from 'phaser';
import titleData from '@/data/title.json';
import { placeArt } from '@/art/ArtLoader';
import { sketchLine, sketchStyle } from '@/art/sketchy';
import { settings, type GameAction } from '@/settings/SettingsManager';
import { COLOR_INK_CSS, COLOR_PAPER_CSS, COLOR_SEA } from '@/config/constants';

interface MenuItem {
  id: string;
  label: string;
  text: Phaser.GameObjects.Text;
}

export class TitleScene extends Phaser.Scene {
  private menuItems: MenuItem[] = [];
  private selectedIndex = 0;
  private titleText!: Phaser.GameObjects.Text;
  private subtitleText!: Phaser.GameObjects.Text;
  private taglineText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private seaGraphics!: Phaser.GameObjects.Graphics;
  private waveTime = 0;
  private unsubscribe?: () => void;

  constructor() {
    super('Title');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(COLOR_PAPER_CSS);
    this.drawWorld();
    this.buildText();
    this.buildMenu();
    this.bindKeyboard();
    this.refreshStyles();

    // Live-update everything when any setting changes.
    this.unsubscribe = settings.subscribe(() => this.refreshStyles());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.unsubscribe?.());
  }

  // --- The sketched scene ------------------------------------------------

  private drawWorld(): void {
    const { width, height } = this.scale;
    const horizon = height * 0.62;

    // The sea — the ONLY colour in the game. Drawn as a filled band with a
    // sketchy upper edge; waves animate in update() unless motion is reduced.
    this.seaGraphics = this.add.graphics();
    this.seaGraphics.setDepth(0);
    this.drawSea(horizon);

    // A faint ground line on the paper.
    const ground = this.add.graphics().setDepth(1);
    sketchLine(
      ground,
      0,
      horizon + 2,
      width,
      horizon + 2,
      sketchStyle({ width: 1.5, jitter: 2, passes: 2, alpha: 0.3 }),
    );

    // Props and characters, placed on the "shore". Depth over the sea.
    placeArt(this, 'house', width * 0.2, horizon - 10, 1).setDepth(2);
    placeArt(this, 'tree', width * 0.38, horizon + 4, 1).setDepth(2);
    placeArt(this, 'npc-neighbour', width * 0.7, horizon + 14, 0.9).setDepth(2);
    placeArt(this, 'player', width * 0.82, horizon + 20, 1).setDepth(3);
  }

  /** Redraw the sea band + its wavy surface at the current wave phase. */
  private drawSea(horizon: number): void {
    const { width, height } = this.scale;
    const g = this.seaGraphics;
    g.clear();

    g.fillStyle(COLOR_SEA, 0.9);
    g.fillRect(0, horizon, width, height - horizon);

    // Sketchy wave lines on the surface, slightly lighter.
    const reduced = settings.getValue('reducedMotion');
    const waveStyle = sketchStyle({ color: 0xffffff, width: 1.5, jitter: 1, passes: 1, alpha: 0.25 });
    for (let row = 0; row < 4; row++) {
      const y = horizon + 18 + row * 26;
      const phase = reduced ? 0 : this.waveTime + row;
      let prevX = 0;
      let prevY = y + Math.sin(phase) * 2;
      for (let x = 20; x <= width; x += 40) {
        const ny = y + Math.sin(phase + x * 0.03) * 3;
        sketchLine(g, prevX, prevY, x, ny, waveStyle);
        prevX = x;
        prevY = ny;
      }
    }
  }

  // --- Text & menu -------------------------------------------------------

  private buildText(): void {
    const { width } = this.scale;
    const cx = width / 2;

    this.titleText = this.add.text(cx, 90, titleData.title, {}).setOrigin(0.5).setDepth(5);
    this.subtitleText = this.add.text(cx, 134, titleData.subtitle, {}).setOrigin(0.5).setDepth(5);
    this.taglineText = this.add
      .text(cx, 176, titleData.tagline, { align: 'center' })
      .setOrigin(0.5)
      .setDepth(5);

    this.hintText = this.add
      .text(
        width / 2,
        this.scale.height - 28,
        '↑/↓ or mouse to choose · Enter to select · ' + titleData.footer,
        {},
      )
      .setOrigin(0.5)
      .setDepth(5);
  }

  private buildMenu(): void {
    const { width } = this.scale;
    const startY = 250;
    titleData.menu.forEach((entry, i) => {
      const text = this.add
        .text(width / 2, startY + i * 46, entry.label, {})
        .setOrigin(0.5)
        .setDepth(5)
        .setInteractive({ useHandCursor: true });

      text.on('pointerover', () => this.setSelected(i));
      text.on('pointerup', () => this.activate(entry.id));

      this.menuItems.push({ id: entry.id, label: entry.label, text });
    });
  }

  private setSelected(index: number): void {
    this.selectedIndex = Phaser.Math.Wrap(index, 0, this.menuItems.length);
    this.refreshMenuStyles();
  }

  private activate(id: string): void {
    switch (id) {
      case 'start':
        // Story isn't written yet — flash a placeholder note rather than
        // inventing plot or jumping to a scene that doesn't exist.
        this.flashHint('[placeholder] the story has not been written yet');
        break;
      case 'settings':
        this.scene.start('Settings');
        break;
      case 'about':
        this.flashHint('[placeholder] a hackathon game about climate change');
        break;
    }
  }

  private flashHint(message: string): void {
    this.hintText.setText(message);
    this.time.delayedCall(2200, () => {
      this.hintText.setText(
        '↑/↓ or mouse to choose · Enter to select · ' + titleData.footer,
      );
    });
  }

  // --- Keyboard (fully rebindable via settings) --------------------------

  private bindKeyboard(): void {
    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => {
      const is = (a: GameAction) => settings.matchesAction(a, e.code);
      if (is('up')) {
        this.setSelected(this.selectedIndex - 1);
        e.preventDefault();
      } else if (is('down')) {
        this.setSelected(this.selectedIndex + 1);
        e.preventDefault();
      } else if (is('confirm')) {
        this.activate(this.menuItems[this.selectedIndex].id);
        e.preventDefault();
      }
    });
  }

  // --- Styling driven entirely by SettingsManager ------------------------

  private refreshStyles(): void {
    const family = settings.fontFamily();
    const ink = settings.getValue('highContrast') ? '#000000' : COLOR_INK_CSS;

    this.titleText.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(2.4)}px`, color: ink });
    this.subtitleText.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(0.9)}px`, color: ink });
    this.subtitleText.setAlpha(0.6);
    this.taglineText.setStyle({
      fontFamily: family,
      fontSize: `${settings.fontSizePx(0.95)}px`,
      color: ink,
      wordWrap: { width: this.scale.width * 0.7 },
    });
    this.taglineText.setAlpha(0.75);
    this.hintText.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(0.7)}px`, color: ink });
    this.hintText.setAlpha(0.6);

    this.refreshMenuStyles();
  }

  private refreshMenuStyles(): void {
    const family = settings.fontFamily();
    const ink = settings.getValue('highContrast') ? '#000000' : COLOR_INK_CSS;
    this.menuItems.forEach((item, i) => {
      const selected = i === this.selectedIndex;
      item.text.setStyle({
        fontFamily: family,
        fontSize: `${settings.fontSizePx(selected ? 1.25 : 1.05)}px`,
        color: ink,
      });
      item.text.setText(selected ? `› ${item.label} ‹` : item.label);
      item.text.setAlpha(selected ? 1 : 0.65);
    });
  }

  update(_time: number, delta: number): void {
    if (settings.getValue('reducedMotion')) return;
    this.waveTime += delta * 0.002;
    // Redraw only the sea so the waves drift gently.
    this.drawSea(this.scale.height * 0.62);
  }
}
