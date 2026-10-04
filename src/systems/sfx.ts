/**
 * Sound effects on the SFX channel, plus visual sound cues.
 *
 * Sounds are listed in src/data/sfx.json. An entry with `file: null` is a
 * placeholder hook: playSfx() still runs (and shows its visual cue), it just
 * has nothing to play yet. Adding the ElevenLabs files is then a data change:
 * set `file` (e.g. "audio/sfx/paper-rustle.mp3") and Boot preloads it.
 *
 * Volume is master x sfx (both 0–100 settings). The visual cue — a small
 * lowercase mark at the bottom left — shows whenever "Visual sound cues" is on,
 * at any volume, so players who can't hear the sound still get the event. It
 * is DOM, not canvas, so it survives scene changes and is never captured into
 * a transition's snapshot.
 */

import Phaser from 'phaser';
import sfxData from '@/data/sfx.json';
import { settings } from '@/systems/SettingsManager';
import { viewport } from '@/systems/viewport';
import { uiText } from '@/systems/constants';

interface SfxDef { file: string | null; volume?: number; cue: string }
const SOUNDS = sfxData.sounds as Record<string, SfxDef>;
export type SfxId = keyof typeof sfxData.sounds;

const key = (id: string) => `sfx-${id}`;

/** Queue every sound that has a file. Call from Boot's preload(). */
export function preloadSfx(scene: Phaser.Scene): void {
  for (const [id, def] of Object.entries(SOUNDS)) if (def.file) scene.load.audio(key(id), def.file);
}

const noted = new Set<string>();

export function playSfx(scene: Phaser.Scene, id: SfxId): void {
  const def = SOUNDS[id];
  if (!def) return;
  const vol = (settings.get('masterVolume') / 100) * (settings.get('sfxVolume') / 100) * (def.volume ?? 1);
  if (vol > 0 && scene.cache.audio.exists(key(id))) {
    scene.sound.play(key(id), { volume: vol });
  } else if (!def.file && import.meta.env.DEV && !noted.has(id)) {
    noted.add(id);
    console.debug(`[sfx] "${id}" is a placeholder hook (no file in src/data/sfx.json yet)`);
  }
  if (settings.get('visualSoundCues')) showCue(def.cue);
}

// --- visual sound cues ---------------------------------------------------------

let box: HTMLDivElement | null = null;
const live = new Map<string, { el: HTMLDivElement; timer: number }>();

function showCue(text: string): void {
  if (!box) {
    box = document.createElement('div');
    box.setAttribute('aria-hidden', 'true');   // visual only; not for screen readers
    box.style.cssText = 'position:fixed;left:16px;bottom:14px;z-index:2147483600;display:flex;flex-direction:column;gap:6px;pointer-events:none;';
    document.body.appendChild(box);
  }
  // Several rustles at once show as one cue, refreshed — not a stack.
  const old = live.get(text);
  if (old) { window.clearTimeout(old.timer); old.el.style.opacity = '1'; old.timer = window.setTimeout(() => fade(text), 700); return; }
  const el = document.createElement('div');
  el.textContent = `( ${uiText(text)} )`;
  el.style.cssText = [
    `font-family:${settings.fontFamily()}`,
    `font-size:${Math.round(settings.fontSizePx(1.1) * viewport.unit)}px`,
    `color:${settings.inkCss()}`, 'background:#ffffff', 'border:1px solid #6e6e6e',
    'padding:2px 10px', 'border-radius:2px', 'opacity:1',
    settings.get('reducedMotion') ? '' : 'transition:opacity 300ms ease-in',
  ].join(';');
  box.appendChild(el);
  live.set(text, { el, timer: window.setTimeout(() => fade(text), 700) });
}

function fade(text: string): void {
  const c = live.get(text);
  if (!c) return;
  c.el.style.opacity = '0';
  c.timer = window.setTimeout(() => { c.el.remove(); live.delete(text); }, settings.get('reducedMotion') ? 0 : 320);
}
