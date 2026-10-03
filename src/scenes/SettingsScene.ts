/**
 * SettingsScene — a working, keyboard- and mouse-usable accessibility menu.
 * Every row reads and writes through the SettingsManager, so changes persist
 * to localStorage and apply everywhere immediately (see TitleScene reacting).
 *
 * This is intentionally compact for the hackathon scaffold; it covers the
 * core settings and is easy to extend (key rebinding UI comes later).
 */

import Phaser from 'phaser';
import {
  settings,
  type GameAction,
  type FontKey,
  type TextSizeKey,
} from '@/settings/SettingsManager';
import { COLOR_INK_CSS, COLOR_PAPER_CSS } from '@/config/constants';

interface Row {
  label: string;
  /** Current value as display text. */
  readValue: () => string;
  /** Adjust by a step: -1 (left) or +1 (right). */
  adjust: (dir: number) => void;
  labelText?: Phaser.GameObjects.Text;
  valueText?: Phaser.GameObjects.Text;
}

const TEXT_SIZES: TextSizeKey[] = ['small', 'medium', 'large', 'xlarge'];
const FONTS: FontKey[] = ['serif', 'sans', 'dyslexic'];

export class SettingsScene extends Phaser.Scene {
  private rows: Row[] = [];
  private selectedIndex = 0;
  private heading!: Phaser.GameObjects.Text;
  private unsubscribe?: () => void;

  constructor() {
    super('Settings');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(COLOR_PAPER_CSS);
    this.defineRows();
    this.buildUi();
    this.bindKeyboard();
    this.refreshStyles();

    this.unsubscribe = settings.subscribe(() => this.refreshStyles());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.unsubscribe?.());
  }

  private cycle<T>(list: T[], current: T, dir: number): T {
    const i = list.indexOf(current);
    return list[Phaser.Math.Wrap(i + dir, 0, list.length)];
  }

  private step(value: number, dir: number, by = 0.1): number {
    return Math.round(Phaser.Math.Clamp(value + dir * by, 0, 1) * 100) / 100;
  }

  private defineRows(): void {
    this.rows = [
      {
        label: 'Text size',
        readValue: () => settings.getValue('textSize'),
        adjust: (d) => settings.set({ textSize: this.cycle(TEXT_SIZES, settings.getValue('textSize'), d) }),
      },
      {
        label: 'Font',
        readValue: () => settings.getValue('font'),
        adjust: (d) => settings.set({ font: this.cycle(FONTS, settings.getValue('font'), d) }),
      },
      {
        label: 'Text speed',
        readValue: () => {
          const v = settings.getValue('textSpeed');
          return v <= 0 ? 'instant' : `${Math.round(v * 100)}%`;
        },
        adjust: (d) => settings.set({ textSpeed: this.step(settings.getValue('textSpeed'), d) }),
      },
      {
        label: 'High contrast',
        readValue: () => (settings.getValue('highContrast') ? 'on' : 'off'),
        adjust: () => settings.set({ highContrast: !settings.getValue('highContrast') }),
      },
      {
        label: 'Reduced motion',
        readValue: () => (settings.getValue('reducedMotion') ? 'on' : 'off'),
        adjust: () => settings.set({ reducedMotion: !settings.getValue('reducedMotion') }),
      },
      {
        label: 'Captions',
        readValue: () => (settings.getValue('captions') ? 'on' : 'off'),
        adjust: () => settings.set({ captions: !settings.getValue('captions') }),
      },
      {
        label: 'Master volume',
        readValue: () => `${Math.round(settings.getValue('masterVolume') * 100)}%`,
        adjust: (d) => settings.set({ masterVolume: this.step(settings.getValue('masterVolume'), d) }),
      },
      {
        label: 'Music volume',
        readValue: () => `${Math.round(settings.getValue('musicVolume') * 100)}%`,
        adjust: (d) => settings.set({ musicVolume: this.step(settings.getValue('musicVolume'), d) }),
      },
      {
        label: 'SFX volume',
        readValue: () => `${Math.round(settings.getValue('sfxVolume') * 100)}%`,
        adjust: (d) => settings.set({ sfxVolume: this.step(settings.getValue('sfxVolume'), d) }),
      },
      {
        label: 'Voice volume',
        readValue: () => `${Math.round(settings.getValue('voiceVolume') * 100)}%`,
        adjust: (d) => settings.set({ voiceVolume: this.step(settings.getValue('voiceVolume'), d) }),
      },
      {
        label: 'Reset to defaults',
        readValue: () => '↵',
        adjust: () => settings.reset(),
      },
      {
        label: 'Back',
        readValue: () => '↵',
        adjust: () => this.scene.start('Title'),
      },
    ];
  }

  private buildUi(): void {
    const { width } = this.scale;
    this.heading = this.add.text(width / 2, 60, 'Settings', {}).setOrigin(0.5, 0.5);

    const startY = 130;
    const rowH = 42;
    const labelX = width * 0.3;
    const valueX = width * 0.7;

    this.rows.forEach((row, i) => {
      const y = startY + i * rowH;
      row.labelText = this.add
        .text(labelX, y, row.label, {})
        .setOrigin(0, 0.5)
        .setInteractive({ useHandCursor: true });
      row.valueText = this.add.text(valueX, y, row.readValue(), {}).setOrigin(1, 0.5);

      row.labelText.on('pointerover', () => this.select(i));
      row.labelText.on('pointerup', () => {
        this.select(i);
        row.adjust(+1);
      });
    });
  }

  private select(i: number): void {
    this.selectedIndex = Phaser.Math.Wrap(i, 0, this.rows.length);
    this.refreshStyles();
  }

  private bindKeyboard(): void {
    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => {
      const is = (a: GameAction) => settings.matchesAction(a, e.code);
      if (is('up')) this.select(this.selectedIndex - 1);
      else if (is('down')) this.select(this.selectedIndex + 1);
      else if (is('left')) this.rows[this.selectedIndex].adjust(-1);
      else if (is('right')) this.rows[this.selectedIndex].adjust(+1);
      else if (is('confirm')) this.rows[this.selectedIndex].adjust(+1);
      else if (is('cancel') || is('menu')) this.scene.start('Title');
      else return;
      e.preventDefault();
    });
  }

  private refreshStyles(): void {
    const family = settings.fontFamily();
    const ink = settings.getValue('highContrast') ? '#000000' : COLOR_INK_CSS;

    this.heading.setStyle({ fontFamily: family, fontSize: `${settings.fontSizePx(1.8)}px`, color: ink });

    this.rows.forEach((row, i) => {
      const selected = i === this.selectedIndex;
      const size = `${settings.fontSizePx(selected ? 1.05 : 0.95)}px`;
      row.labelText?.setStyle({ fontFamily: family, fontSize: size, color: ink });
      row.labelText?.setText(selected ? `› ${row.label}` : row.label);
      row.labelText?.setAlpha(selected ? 1 : 0.65);
      row.valueText?.setStyle({ fontFamily: family, fontSize: size, color: ink });
      row.valueText?.setText(row.readValue());
      row.valueText?.setAlpha(selected ? 1 : 0.65);
    });
  }
}
