/**
 * F1 story controls: jump to any scene, set the avatar, set the score, force
 * an outcome. Installed from main.ts; the panel itself lives in debug.ts.
 */

import Phaser from 'phaser';
import { AVATARS, type AvatarId } from '@/data/characters';
import { debugPanel } from '@/systems/debug';
import { gameState, STORY_SCENES, type Outcome } from '@/systems/gameState';
import { profile } from '@/systems/profile';
import { SCENE_STORY } from '@/systems/constants';

export function installStoryDebug(game: Phaser.Game): void {
  const q = <T extends Element>(el: HTMLElement, k: string) => el.querySelector(`[data-story="${k}"]`) as T | null;
  debugPanel.storyHooks = {
    bind(el) {
      const scene = q<HTMLSelectElement>(el, 'scene');
      if (scene) scene.innerHTML = STORY_SCENES.map((id) => `<option>${id}</option>`).join('');
      q<HTMLSelectElement>(el, 'avatar')?.addEventListener('change', (e) => {
        const v = (e.target as HTMLSelectElement).value as AvatarId;
        if ((AVATARS as readonly string[]).includes(v)) profile.setAvatar(v);
      });
      q<HTMLInputElement>(el, 'score')?.addEventListener('change', (e) => gameState.setScore(Number((e.target as HTMLInputElement).value) || 0));
      q<HTMLSelectElement>(el, 'outcome')?.addEventListener('change', (e) => {
        const v = (e.target as HTMLSelectElement).value;
        gameState.forceOutcome(v ? (v as Outcome) : null);
      });
      el.querySelector('[data-act=story-go]')?.addEventListener('click', () => {
        const id = q<HTMLSelectElement>(el, 'scene')?.value ?? STORY_SCENES[0];
        // Jump straight there: no transition, and nothing left locked.
        // (SceneManager calls run now from a DOM event; the per-scene plugin
        // would queue the stop after the start and stop the new scene.)
        game.scene.getScenes(true).forEach((s) => { if (s.scene.key !== SCENE_STORY) game.scene.stop(s.scene.key); });
        game.scene.start(SCENE_STORY, { id, beat: 0 });
      });
    },
    sync(el) {
      const a = q<HTMLSelectElement>(el, 'avatar'); if (a) a.value = gameState.player.avatar;
      const s = q<HTMLInputElement>(el, 'score'); if (s) s.value = String(gameState.player.score);
      const o = q<HTMLSelectElement>(el, 'outcome'); if (o) o.value = gameState.forcedOutcome ?? '';
      const sc = q<HTMLSelectElement>(el, 'scene'); if (sc) sc.value = gameState.scene;
    },
  };
}
