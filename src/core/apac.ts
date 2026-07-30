/**
 * APAC advancement star derivation (spec §13). Pure and framework-free.
 *
 * ICPC APAC Championship rules digest — the filtered candidate list ("scored
 * list") that the invitation score is computed from is built like this
 * (validated against icpcapac.solved.ac/2026: the 58 published Seoul rows are
 * reproduced exactly, team name and 4-decimal score):
 *
 * 1. A school that ALREADY HAS AN INVITED TEAM drops out of this site's scored
 *    list ENTIRELY — every one of its teams. The invitation route does not
 *    matter: this regional's champion (auto-qualified by rule B1) and teams
 *    invited at another regional count the same. The invited team itself is
 *    still DISPLAYED, but it occupies NO rank slot.
 * 2. Teams with 0 solved problems are excluded.
 * 3. Of what remains, each school keeps its top 3 teams in ICPC standing
 *    order; `filteredRank` is the 1-based position in that list. Foreign teams
 *    occupy slots normally — the 3-per-school cap is per site.
 *
 * score = (filteredRank − 1) / siteScore; invited when score ≤ cutoff.
 *
 * Cross-site input: "already invited elsewhere" cannot be derived from
 * contest.json/orgs.json, so it arrives as config (`publish.alreadyInvited`)
 * and is passed in via {@link ApacStarOptions.alreadyInvited}. When it is
 * empty only the champion's school drops out, and ranks may be optimistic.
 *
 * Star tiers (semantics: bronze = 학내 3등 이내, silver = APAC championship
 * 초대 가능, gold = APAC championship 진출):
 * - `ceremony` phase (award mode, final standings not fully revealed yet):
 *   every schoolRank ≤ 3 team wears a BRONZE star for the current snapshot.
 * - `final` phase (award fully revealed, or publish mode):
 *   - every INVITED team (the champion, plus `alreadyInvited` teams) is GOLD —
 *     their advancement is settled, and they take no slot;
 *   - teams in the scored list are SILVER, promoted to GOLD when their score
 *     clears the cutoff (publish mode; needs BOTH siteScore and cutoff);
 *   - a team that is out of the running but still 학내 3등 이내 keeps BRONZE:
 *     the other teams of an already-invited school, and 0-solve teams. Bronze
 *     is never promoted.
 *   - schoolRank ≥ 4 teams get no star at all.
 */

import type { ApacStar, Snapshot } from './types';

export type ApacPhase = 'ceremony' | 'final';

/** A team that has a star always has one of the three tiers (never null). */
export type ApacStarTier = Exclude<ApacStar, null>;

/**
 * Teams already invited to the APAC championship through another route
 * (another regional). Config-supplied; the champion is added automatically.
 */
export interface AlreadyInvited {
  /** Team ids of invited teams competing at this site. */
  teamIds?: readonly string[];
  /** Group (school) names that already have an invited team anywhere. */
  groups?: readonly string[];
}

export interface ApacFilterOptions {
  /**
   * Team id of the overall champion (standings[0] of the FINAL snapshot).
   * Auto-qualified (rule B1), so the champion's school drops out of the list.
   */
  championTeamId: string | null;
  /** Cross-site invitations; empty when unknown. */
  alreadyInvited?: AlreadyInvited | null;
}

export interface ApacStarOptions extends ApacFilterOptions {
  phase: ApacPhase;
  /** Site score (number of teams at the site); must be > 0 to take effect. */
  siteScore: number | null;
  /** Invited score cutoff; promotion is skipped when null. */
  invitedScoreCutoff: number | null;
}

/** Max teams per school in the scored list (APAC per-school cap). */
export const APAC_SCHOOL_RANK_CAP = 3;

/** Resolved invitation state: the invited teams and the schools they remove. */
interface InvitationSet {
  teamIds: Set<string>;
  /** Group names removed from the scored list. Never contains ''. */
  groups: Set<string>;
}

/**
 * Champion + `alreadyInvited` → the invited team ids and the set of schools
 * they knock out. An empty group name ('' = unknown organization) is never a
 * school here: it would otherwise wipe out every org-less team at once.
 */
function resolveInvitations(
  snapshot: Snapshot,
  opts: ApacFilterOptions,
): InvitationSet {
  const teamIds = new Set<string>();
  if (opts.championTeamId !== null) teamIds.add(opts.championTeamId);
  for (const id of opts.alreadyInvited?.teamIds ?? []) teamIds.add(id);

  const groups = new Set<string>();
  for (const group of opts.alreadyInvited?.groups ?? []) {
    if (group !== '') groups.add(group);
  }
  for (const id of teamIds) {
    const group = snapshot.byTeam.get(id)?.team.group;
    if (group !== undefined && group !== '') groups.add(group);
  }

  return { teamIds, groups };
}

/** True when this team is out of the scored list because it is invited. */
function isInvited(teamId: string, group: string, invitations: InvitationSet): boolean {
  return invitations.teamIds.has(teamId) || (group !== '' && invitations.groups.has(group));
}

/**
 * The APAC scored list (spec §13 rule 3): team id → 1-based `filteredRank`.
 * Teams outside the list are absent. Pure; the snapshot is not mutated.
 */
export function computeApacFilteredRanks(
  snapshot: Snapshot,
  opts: ApacFilterOptions,
): Map<string, number> {
  const invitations = resolveInvitations(snapshot, opts);
  const ranks = new Map<string, number>();
  const perSchool = new Map<string, number>();
  let filteredRank = 0;

  for (const standing of snapshot.standings) {
    const group = standing.team.group;
    // 1. Already-invited teams and their schoolmates take no slot.
    if (isInvited(standing.team.id, group, invitations)) continue;
    // 2. 0-solve teams are excluded.
    if (standing.solved <= 0) continue;
    // 3. Top 3 per school, over what is left.
    const nth = (perSchool.get(group) ?? 0) + 1;
    perSchool.set(group, nth);
    if (nth > APAC_SCHOOL_RANK_CAP) continue;

    filteredRank += 1;
    ranks.set(standing.team.id, filteredRank);
  }

  return ranks;
}

/**
 * Compute the APAC star tier per team. Teams without a star are absent from
 * the returned map. Deterministic: same inputs → same output.
 */
export function computeApacStars(
  snapshot: Snapshot,
  opts: ApacStarOptions,
): Map<string, ApacStarTier> {
  const stars = new Map<string, ApacStarTier>();

  if (opts.phase === 'ceremony') {
    for (const standing of snapshot.standings) {
      if (standing.schoolRank <= APAC_SCHOOL_RANK_CAP) stars.set(standing.team.id, 'bronze');
    }
    return stars;
  }

  const invitations = resolveInvitations(snapshot, opts);
  const filteredRanks = computeApacFilteredRanks(snapshot, opts);
  const cutoffActive =
    opts.siteScore !== null &&
    opts.siteScore > 0 &&
    opts.invitedScoreCutoff !== null;

  for (const standing of snapshot.standings) {
    const teamId = standing.team.id;

    // Invited already (champion or cross-site): advancement settled → gold.
    if (invitations.teamIds.has(teamId)) {
      stars.set(teamId, 'gold');
      continue;
    }

    const filteredRank = filteredRanks.get(teamId);
    if (filteredRank === undefined) {
      // Out of the running (invited school's other teams, 0 solves, or beyond
      // the per-school cap) — bronze only while 학내 3등 이내, never promoted.
      if (standing.schoolRank <= APAC_SCHOOL_RANK_CAP) stars.set(teamId, 'bronze');
      continue;
    }

    const invited =
      cutoffActive &&
      (filteredRank - 1) / (opts.siteScore as number) <=
        (opts.invitedScoreCutoff as number);
    stars.set(teamId, invited ? 'gold' : 'silver');
  }

  return stars;
}
