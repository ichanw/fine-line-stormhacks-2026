/**
 * The settings menu, as data. Each option carries the one-line plain-language
 * description shown while it is focused — keep those jargon-free and concrete
 * about what the player will notice.
 */

import type { Settings } from '@/systems/SettingsManager';

export type OptionKind = 'toggle' | 'enum' | 'range' | 'action' | 'rebind';
export type SettingGroup = 'Visual' | 'Audio' | 'Gameplay';

export interface OptionDef {
  /**
   * A key of Settings, or a pseudo-id: 'fullscreen' is browser state (never
   * stored), 'reset' / 'back' are action rows.
   */
  id: keyof Settings | 'fullscreen' | 'reset' | 'back';
  group: SettingGroup;
  label: string;
  description: string;
  kind: OptionKind;
  values?: readonly string[];
  valueLabels?: Record<string, string>;
  min?: number;
  max?: number;
  step?: number;
}

export const SETTINGS_SCHEMA: readonly OptionDef[] = [
  // --- Visual ---
  {
    id: 'fullscreen', group: 'Visual', kind: 'toggle',
    label: 'Fullscreen',
    description: 'Fills the whole screen with the game. Shortcut: F (change it in keyboard controls).',
  },
  {
    id: 'textSize', group: 'Visual', kind: 'enum',
    label: 'Text size',
    description: 'Makes all writing in the game bigger or smaller.',
    values: ['small', 'medium', 'large', 'xlarge'],
    valueLabels: { small: 'S', medium: 'M', large: 'L', xlarge: 'XL' },
  },
  {
    id: 'dyslexiaFont', group: 'Visual', kind: 'toggle',
    label: 'Dyslexia-friendly font',
    description: 'Switches to a rounder typeface with more space between letters.',
  },
  {
    id: 'highContrast', group: 'Visual', kind: 'toggle',
    label: 'High contrast',
    description: 'Darkens text and thickens outlines so edges are easier to see.',
  },
  {
    id: 'waterPattern', group: 'Visual', kind: 'toggle',
    label: 'Water pattern',
    description: 'Adds a stripe pattern to water, so you need not rely on colour.',
  },
  {
    id: 'reducedMotion', group: 'Visual', kind: 'toggle',
    label: 'Reduced motion',
    description: 'Stops drifting clouds, moving water and other gentle animation.',
  },
  {
    id: 'brightness', group: 'Visual', kind: 'range',
    label: 'Brightness',
    description: 'Lightens or darkens the whole picture.',
    min: 70, max: 130, step: 5,
  },

  // --- Audio ---
  {
    id: 'masterVolume', group: 'Audio', kind: 'range',
    label: 'Master volume',
    description: 'Overall loudness of everything you hear.',
    min: 0, max: 100, step: 5,
  },
  {
    id: 'musicVolume', group: 'Audio', kind: 'range',
    label: 'Music volume',
    description: 'Loudness of background music only.',
    min: 0, max: 100, step: 5,
  },
  {
    id: 'voiceVolume', group: 'Audio', kind: 'range',
    label: 'Voice volume',
    description: 'Loudness of spoken lines only.',
    min: 0, max: 100, step: 5,
  },
  {
    id: 'sfxVolume', group: 'Audio', kind: 'range',
    label: 'Sound effects volume',
    description: 'Loudness of small sounds like rain, doors and footsteps.',
    min: 0, max: 100, step: 5,
  },
  {
    id: 'captions', group: 'Audio', kind: 'toggle',
    label: 'Captions',
    description: 'Shows written text for everything that is spoken.',
  },
  {
    id: 'captionOpacity', group: 'Audio', kind: 'range',
    label: 'Caption background',
    description: 'How solid the band behind caption text is.',
    min: 0, max: 100, step: 10,
  },
  {
    id: 'speakerNames', group: 'Audio', kind: 'toggle',
    label: 'Speaker names',
    description: 'Shows who is talking above each line of dialogue.',
  },
  {
    id: 'visualSoundCues', group: 'Audio', kind: 'toggle',
    label: 'Visual sound cues',
    description: 'Shows an on-screen mark for sounds you would otherwise only hear.',
  },

  // --- Gameplay ---
  {
    id: 'textSpeed', group: 'Gameplay', kind: 'enum',
    label: 'Text speed',
    description: 'How quickly dialogue appears on screen.',
    values: ['slow', 'normal', 'fast', 'instant'],
    valueLabels: { slow: 'Slow', normal: 'Normal', fast: 'Fast', instant: 'Instant' },
  },
  {
    id: 'autoAdvance', group: 'Gameplay', kind: 'toggle',
    label: 'Auto-advance',
    description: 'Moves to the next line on its own, without you pressing anything.',
  },
  {
    id: 'interactionMode', group: 'Gameplay', kind: 'enum',
    label: 'Hold or toggle',
    description: 'Whether actions need a key held down, or just pressed once.',
    values: ['hold', 'toggle'],
    valueLabels: { hold: 'Hold', toggle: 'Toggle' },
  },
  {
    id: 'choiceTimers', group: 'Gameplay', kind: 'toggle',
    label: 'Timed choices',
    description: 'Puts a time limit on choices. Off means you can take as long as you like.',
  },
  {
    id: 'keyBindings', group: 'Gameplay', kind: 'rebind',
    label: 'Keyboard controls',
    description: 'Change which key does what. Select to edit.',
  },
];

export const GROUP_ORDER: readonly SettingGroup[] = ['Visual', 'Audio', 'Gameplay'];
