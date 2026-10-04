/** The player's own choices (distinct from accessibility settings). */

import { AVATARS, AvatarId } from '@/data/characters';

const KEY = 'climate-game/profile/v1';

interface Profile {
  avatar: AvatarId | null;
}

function read(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Profile;
      if (p.avatar && (AVATARS as readonly string[]).includes(p.avatar)) return p;
    }
  } catch { /* storage unavailable — fall through to the default */ }
  return { avatar: null };
}

let current = read();

export const profile = {
  get avatar(): AvatarId | null {
    return current.avatar;
  },
  setAvatar(a: AvatarId): void {
    current = { ...current, avatar: a };
    try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* non-fatal */ }
  },
};
