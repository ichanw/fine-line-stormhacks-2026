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

export const embed = {
  install(game: Phaser.Game): void {
    if (!isEmbedded()) return;

    window.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as { source?: string; type?: string; muted?: unknown } | null;
      if (data?.source !== 'portfolio' || data.type !== 'set-muted') return;
      game.sound.mute = !!data.muted;
      post({ type: 'muted', muted: game.sound.mute });
    });

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
