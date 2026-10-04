/**
 * The ending reflection paragraph (dialogue.json → endingReflection): the
 * outcome's template with {choices} filled from the player's commute and lunch
 * picks.
 *
 *   bad      only picks with a negative score
 *   good     only picks with a positive score
 *   neutral  both picks
 *
 * One fragment → "X"; two → "X and Y"; first letter capitalised; none → the
 * fallback ("The choices you made today"). The neutral template's verb agrees
 * with the subject: one fragment → "keeps" (neutral) / "it could help"
 * (good), otherwise "keep" / "they could help".
 */

import dialogue from '@/data/dialogue.json';
import { CHOICE_SETS, type ChoiceSetId, type Outcome } from '@/systems/gameState';

const R = dialogue.endingReflection;
const SETS: ChoiceSetId[] = ['commute', 'lunch'];

export function reflectionText(outcome: Outcome, choices: Partial<Record<ChoiceSetId, string>>): string {
  const picked = SETS.map((set) => CHOICE_SETS[set].find((c) => c.id === choices[set])).filter((c) => !!c);
  const keep = picked.filter((c) => (outcome === 'bad' ? c!.score < 0 : outcome === 'good' ? c!.score > 0 : true));
  const frags = keep.map((c) => (R.fragments as Record<string, string>)[(c as { fragment?: string }).fragment ?? '']).filter(Boolean);
  let subject = frags.length === 0 ? R.fallback : frags.join(' and ');
  subject = subject.charAt(0).toUpperCase() + subject.slice(1);
  let text = (R.templates as Record<Outcome, string>)[outcome].replace('{choices}', subject);
  // Subject–verb agreement: a single fragment is singular.
  if (outcome === 'neutral' && frags.length === 1) text = text.replace(`${subject} keep `, `${subject} keeps `);
  if (outcome === 'good' && frags.length === 1) text = text.replace(', they could help', ', it could help');
  return text;
}
