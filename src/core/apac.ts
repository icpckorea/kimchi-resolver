/**
 * APAC advancement star derivation (spec §13). Pure and framework-free.
 *
 * ICPC APAC Championship rules digest:
 * - At most 3 teams per school can advance → only schoolRank 1..3 ever get a
 *   star (rule D3 removes 4th+ teams of a school from the ranking).
 * - Team score = (filteredRank − 1) / siteScore, where filteredRank is the
 *   team's 1-based position in the candidate list: all schoolRank ≤ 3 teams
 *   in ICPC standing order, champion included. Invited when score ≤ cutoff.
 *
 * Star tiers (semantics: bronze = 학내 3등 이내, silver = APAC championship
 * 초대 가능, gold = APAC championship 진출):
 * - `ceremony` phase (award mode, final standings not fully revealed yet):
 *   every schoolRank ≤ 3 team wears a BRONZE star for the current snapshot.
 * - `final` phase (award fully revealed, or publish mode):
 *   - the champion (`championTeamId`, i.e. standings[0]) turns GOLD;
 *   - schoolRank ≤ 3 teams of every school EXCEPT the champion's turn SILVER;
 *   - the champion's schoolmates keep BRONZE — WF takes one team per school,
 *     so they are not invitation candidates. They still OCCUPY slots in the
 *     filtered candidate list below.
 * - publish extra: a SILVER team whose (filteredRank − 1) / siteScore is ≤
 *   invitedScoreCutoff turns GOLD — evaluated only when BOTH numbers are
 *   present (bronze schoolmates of the champion are never promoted). The
 *   champion stays gold regardless of the cutoff.
 */

import type { ApacStar, Snapshot } from './types';

export type ApacPhase = 'ceremony' | 'final';

/** A team that has a star always has one of the three tiers (never null). */
export type ApacStarTier = Exclude<ApacStar, null>;

export interface ApacStarOptions {
  phase: ApacPhase;
  /**
   * Team id of the overall champion (standings[0] of the FINAL snapshot).
   * Only meaningful in the `final` phase; when null, no school is treated as
   * the champion's school (all starred teams become silver, promotion still
   * applies).
   */
  championTeamId: string | null;
  /** Site score (number of teams at the site); must be > 0 to take effect. */
  siteScore: number | null;
  /** Invited score cutoff; promotion is skipped when null. */
  invitedScoreCutoff: number | null;
}

/** Max school rank that can advance (per-school team cap). */
export const APAC_SCHOOL_RANK_CAP = 3;

/**
 * Compute the APAC star tier per team. Teams without a star are absent from
 * the returned map. Deterministic: same inputs → same output.
 */
export function computeApacStars(
  snapshot: Snapshot,
  opts: ApacStarOptions,
): Map<string, ApacStarTier> {
  const stars = new Map<string, ApacStarTier>();

  const championGroup =
    opts.phase === 'final' && opts.championTeamId !== null
      ? (snapshot.byTeam.get(opts.championTeamId)?.team.group ?? null)
      : null;

  const cutoffActive =
    opts.siteScore !== null &&
    opts.siteScore > 0 &&
    opts.invitedScoreCutoff !== null;

  // 1-based position in the filtered candidate list (schoolRank ≤ 3 teams in
  // ICPC standing order, champion included) — the rank APAC rule D3 scores.
  let filteredRank = 0;

  for (const standing of snapshot.standings) {
    if (standing.schoolRank > APAC_SCHOOL_RANK_CAP) continue;

    if (opts.phase === 'ceremony') {
      stars.set(standing.team.id, 'bronze');
      continue;
    }

    // final phase — every schoolRank ≤ 3 team occupies a filtered-rank slot,
    // champion and champion schoolmates included (APAC rule D3).
    filteredRank += 1;

    if (opts.championTeamId !== null && standing.team.id === opts.championTeamId) {
      stars.set(standing.team.id, 'gold');
      continue;
    }
    if (championGroup !== null && standing.team.group === championGroup) {
      // Champion's schoolmates keep bronze (WF: one team per school) and are
      // never promoted — but their slot above still counted.
      stars.set(standing.team.id, 'bronze');
      continue;
    }

    // Silver, promoted to gold when the invited-score rule matches (publish).
    const invited =
      cutoffActive &&
      (filteredRank - 1) / (opts.siteScore as number) <=
        (opts.invitedScoreCutoff as number);
    stars.set(standing.team.id, invited ? 'gold' : 'silver');
  }

  return stars;
}
