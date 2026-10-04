/**
 * The run in progress: who the player is, what they chose, and where they are.
 *
 * Kept in memory (a reload starts again at the title). `player.avatar` lives in
 * the profile so avatar select remembers it; everything else resets with
 * `reset()` ("play again").
 *
 * Scoring and outcome bands come from src/data/choices.json.
 */

import choicesData from '@/data/choices.json';
import storyData from '@/data/story.json';
import { AVATARS, type AvatarId } from '@/data/characters';
import { profile } from '@/systems/profile';

export type Outcome = 'good' | 'neutral' | 'bad';
export type ChoiceSetId = keyof typeof choicesData.sets;
export interface ChoiceDef { id: string; label: string; score: number; next: string; correct?: boolean }

export const CHOICE_SETS = choicesData.sets as Record<ChoiceSetId, ChoiceDef[]>;
export const STORY_START = storyData.start;
export const STORY_SCENES = Object.keys(storyData.scenes);

interface RunState {
  score: number;
  /** Choice id taken per set, in the order taken. */
  choices: Partial<Record<ChoiceSetId, string>>;
  /** Current story scene and beat, so Settings (Esc) can return here. */
  scene: string;
  beat: number;
  /** Debug (F1): overrides the score-based outcome. */
  forcedOutcome: Outcome | null;
}

const fresh = (): RunState => ({ score: 0, choices: {}, scene: STORY_START, beat: 0, forcedOutcome: null });
let run = fresh();

export const gameState = {
  get player() {
    return { avatar: (profile.avatar ?? AVATARS[0]) as AvatarId, score: run.score, choices: { ...run.choices } };
  },
  get scene(): string { return run.scene; },
  get beat(): number { return run.beat; },
  setPosition(scene: string, beat = 0): void { run.scene = scene; run.beat = beat; },

  /** Record a choice and add its score. Returns the choice (for `next`). */
  choose(set: ChoiceSetId, id: string): ChoiceDef {
    const c = CHOICE_SETS[set].find((x) => x.id === id);
    if (!c) throw new Error(`unknown choice ${set}.${id}`);
    // Re-choosing (e.g. after a debug jump back) replaces the earlier pick.
    const prev = run.choices[set];
    if (prev) run.score -= CHOICE_SETS[set].find((x) => x.id === prev)?.score ?? 0;
    run.choices[set] = id;
    run.score += c.score;
    return c;
  },

  outcome(): Outcome {
    if (run.forcedOutcome) return run.forcedOutcome;
    const o = choicesData.outcomes as Record<Outcome, { min?: number; max?: number }>;
    if (o.good.min !== undefined && run.score >= o.good.min) return 'good';
    if (o.bad.max !== undefined && run.score <= o.bad.max) return 'bad';
    return 'neutral';
  },

  // Debug (F1).
  setScore(n: number): void { run.score = n; },
  forceOutcome(o: Outcome | null): void { run.forcedOutcome = o; },
  get forcedOutcome(): Outcome | null { return run.forcedOutcome; },

  /** "play again": a fresh run (the avatar is kept in the profile). */
  reset(): void { run = fresh(); },
};
