/**
 * Embed bridge: when the game runs in an iframe with `?embed=1` (the
 * portfolio case study), it talks to the host page with postMessage.
 *
 *   game → host  { source: 'fine-line', type: 'ready' }
 *                { source: 'fine-line', type: 'muted', muted }
 *                { source: 'fine-line', type: 'pointer', inside }
 *                { source: 'fine-line', type: 'wheel', deltaY }
 *   host → game  { source: 'portfolio', type: 'set-muted', muted }
 *
 * The game never scrolls, so wheel input is handed back for the host page to
 * scroll with; `pointer` lets the host hide its own custom cursor exactly
 * while the pointer is over the game. Only mute is accepted from the host,
 * which is harmless from any origin, so no origin allow-list is needed.
 */

import Phaser from 'phaser';

const isEmbedded = (): boolean =>
  window.parent !== window && new URLSearchParams(window.location.search).get('embed') === '1';

function post(message: Record<string, unknown>): void {
  window.parent.postMessage({ source: 'fine-line', ...message }, '*');
}

let muted = false;

/**
 * Phaser's `sound.mute` schedules the change on the audio clock, which
 * doesn't run until audio unlocks, and its getter reads the live gain — so
 * before the first click it reports "not muted". Set the gain value directly
 * as well, and report what was asked for rather than reading it back.
 */
function applyMute(game: Phaser.Game): void {
  game.sound.mute = muted;
  const node = (game.sound as Partial<Phaser.Sound.WebAudioSoundManager>).masterMuteNode;
  if (node) node.gain.value = muted ? 0 : 1;
}

export const embed = {
  install(game: Phaser.Game): void {
    if (!isEmbedded()) return;

    window.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as { source?: string; type?: string; muted?: unknown } | null;
      if (data?.source !== 'portfolio' || data.type !== 'set-muted') return;
      muted = !!data.muted;
      applyMute(game);
      post({ type: 'muted', muted });
    });
    // Audio starts locked until the first click; set it again once it's live
    game.sound.on(Phaser.Sound.Events.UNLOCKED, () => applyMute(game));

    document.addEventListener('pointerenter', () => post({ type: 'pointer', inside: true }));
    document.addEventListener('pointerleave', () => post({ type: 'pointer', inside: false }));

    window.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        // Lines (Firefox) → roughly pixels
        const deltaY = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
        post({ type: 'wheel', deltaY });
      },
      { passive: true },
    );

    post({ type: 'ready' });
  },
};
