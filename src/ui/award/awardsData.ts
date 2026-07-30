/**
 * awards.json v2 UI helpers (spec §6): rank humanization.
 *
 * The schema and the parser live in `@core/awards` — the award state machine
 * consumes the entry ids at construction (a slide is raised only for a team
 * that HAS an entry, spec §6), so they cannot sit above the store. This module
 * re-exports them so the award UI keeps one import site.
 */
import { ordinalSuffix } from '@ui/scoreboard/util';

export { parseAwardsJson, type AwardEntry } from '@core/awards';

/**
 * Rank display text (spec §6): numbers become "Nth Place" with the ordinal
 * suffix as plain text (shared scoreboard ordinal rules); strings pass
 * through verbatim (e.g. "대상").
 */
export function humanizeRank(rank: string | number): string {
  if (typeof rank === 'number') return `${rank}${ordinalSuffix(rank)} Place`;
  return rank;
}
