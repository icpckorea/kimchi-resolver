/**
 * APAC advancement star derivation (spec §13; publish modes spec §6). Pure and
 * framework-free.
 *
 * ICPC APAC Championship rules digest, 2026-27 (icpc.jp/apac/2026-27/rules,
 * D3 for one regional). The filtered candidate list ("scored list") that the
 * invitation value is computed from is built like this:
 *
 * 1. Super-region teams (South Pacific: country code AU or NZ) are removed.
 *    They still count in the site score S.
 * 2. Teams with 0 solved problems are excluded.
 * 3. A school that ALREADY HAS AN INVITED TEAM drops out of this site's scored
 *    list ENTIRELY — every one of its teams. The invitation route does not
 *    matter: this regional's champion (auto-qualified by rule B1), winners of
 *    other regionals, and teams invited by any other route count the same
 *    (operator decision "B": D3(3) names only winner schools, but this keeps
 *    the published 2025-26 Seoul list reproducible). The invited team itself
 *    is still DISPLAYED, but it occupies NO rank slot.
 * 4. Of what remains, each school keeps its top Q teams in ICPC standing
 *    order: Q = 3 for a school that won a medal at the previous World Finals,
 *    2 for every other school. (2025-26: 3 for every school. With that
 *    `quota` and S = 68.98 the 58 published Seoul rows at
 *    icpcapac.solved.ac/2026 are reproduced exactly, team name and 4-decimal
 *    value.) `filteredRank` R is the 1-based position in
 *    that list. Foreign teams occupy slots normally — the quota is per site. A
 *    team with an unknown organization ('') is its own school: unrelated
 *    org-less teams must not spend one shared budget.
 *
 * value = (R − 1) / S; invited when value ≤ cutoff. The site score is
 *   S = 0.56·U_r + 0.24·T_r + 0.14·U_p + 0.06·T_p + 0.30·F_r
 * over teams that solved ≥ 1 problem (U = schools, T = teams, F = foreign
 * teams; r = this regional, p = its preliminary). See {@link computeSiteScore}.
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
 *   - teams in the scored list are SILVER, promoted to GOLD when their value
 *     clears the cutoff (publish mode; needs BOTH siteScore and cutoff);
 *   - a team that is out of the running but still 학내 3등 이내 keeps BRONZE:
 *     the other teams of an already-invited school, 0-solve teams, teams over
 *     the school quota, and super-region teams. Bronze is never promoted.
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
  /** Per-school cap of the scored list. Default: 2 per school, no medal schools. */
  quota?: SchoolQuota;
  /** Country codes removed from the scored list. Default: {@link SUPER_REGION_COUNTRIES}. */
  superRegionCountries?: readonly string[];
}

export interface ApacStarOptions extends ApacFilterOptions {
  phase: ApacPhase;
  /** Site score S (see computeSiteScore); must be > 0 to take effect. */
  siteScore: number | null;
  /** Invited score cutoff; promotion is skipped when null. */
  invitedScoreCutoff: number | null;
}

/**
 * 학내 N등 이내 for the bronze star. The scored-list cap is the per-school
 * {@link SchoolQuota}, not this constant.
 */
export const APAC_SCHOOL_RANK_CAP = 3;

/** Scored-list cap of a school that won a medal at the previous World Finals. */
export const WF_MEDAL_QUOTA = 3;
/** Scored-list cap of every other school (2026-27). */
export const DEFAULT_SCHOOL_QUOTA = 2;
/** Super-region (South Pacific) country codes, ISO 3166-1 alpha-2. */
export const SUPER_REGION_COUNTRIES: readonly string[] = ['AU', 'NZ'];

/** Per-school scored-list cap: `base` for every school, WF_MEDAL_QUOTA for a medal school. */
export interface SchoolQuota {
  base: number;
  /** Group (school) names that won a medal at the previous World Finals. */
  wfMedalGroups: readonly string[];
}

const DEFAULT_QUOTA: SchoolQuota = { base: DEFAULT_SCHOOL_QUOTA, wfMedalGroups: [] };

/** Site score coefficients (rule C1). */
export interface SiteScoreCoefficients {
  /** U_r: schools in the regional. */
  regionalSchools: number;
  /** T_r: teams in the regional. */
  regionalTeams: number;
  /** U_p: schools in the preliminary. */
  prelimSchools: number;
  /** T_p: teams in the preliminary. */
  prelimTeams: number;
  /** F_r: foreign teams in the regional. */
  foreignTeams: number;
}

export const DEFAULT_SITE_SCORE_COEFFICIENTS: SiteScoreCoefficients = {
  regionalSchools: 0.56,
  regionalTeams: 0.24,
  prelimSchools: 0.14,
  prelimTeams: 0.06,
  foreignTeams: 0.3,
};

/** Regional site score inputs counted from the standings. */
export interface SiteCounts {
  schools: number;
  teams: number;
  foreign: number;
}

export interface SiteScoreInputs {
  regional: SiteCounts;
  prelimSchools: number;
  prelimTeams: number;
  coefficients: SiteScoreCoefficients;
}

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
 * The APAC scored list (header rules 1-4): team id → 1-based `filteredRank`.
 * Teams outside the list are absent. Pure; the snapshot is not mutated.
 */
export function computeApacFilteredRanks(
  snapshot: Snapshot,
  opts: ApacFilterOptions,
): Map<string, number> {
  const invitations = resolveInvitations(snapshot, opts);
  const quota = opts.quota ?? DEFAULT_QUOTA;
  const medalGroups = new Set(quota.wfMedalGroups);
  const superRegion = new Set(opts.superRegionCountries ?? SUPER_REGION_COUNTRIES);
  const ranks = new Map<string, number>();
  const perSchool = new Map<string, number>();
  let filteredRank = 0;

  for (const standing of snapshot.standings) {
    const group = standing.team.group;
    // 1. Super-region teams are not ranked at this site.
    const country = standing.team.countryCode;
    if (country !== undefined && superRegion.has(country)) continue;
    // 2. 0-solve teams are excluded.
    if (standing.solved <= 0) continue;
    // 3. Already-invited teams and their schoolmates take no slot.
    if (isInvited(standing.team.id, group, invitations)) continue;
    // 4. Top Q per school, over what is left. '' (unknown organization) is not
    //    a school — the same reason isInvited() special-cases it — so every
    //    org-less team is its own school and is never capped away by another.
    if (group !== '') {
      const nth = (perSchool.get(group) ?? 0) + 1;
      perSchool.set(group, nth);
      const cap = medalGroups.has(group) ? WF_MEDAL_QUOTA : quota.base;
      if (nth > cap) continue;
    }

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

/**
 * Regional site score inputs (rule C1) from the standings: teams that solved
 * ≥ 1 problem, the schools that have such a team, and the foreign teams among
 * them. Foreign = a country code that is not 'KR' (`team.foreign`, the
 * domestic-rank flag, is not used); a team without a country code is
 * domestic. Super-region teams count here even though they are not ranked.
 * Every org-less ('') team is its own school, as in the scored list.
 */
export function countSiteInputs(snapshot: Snapshot): SiteCounts {
  const schools = new Set<string>();
  let orglessSchools = 0;
  let teams = 0;
  let foreign = 0;

  for (const standing of snapshot.standings) {
    if (standing.solved <= 0) continue;
    teams += 1;
    const { group, countryCode } = standing.team;
    if (group === '') orglessSchools += 1;
    else schools.add(group);
    if (countryCode !== undefined && countryCode !== 'KR') foreign += 1;
  }

  return { schools: schools.size + orglessSchools, teams, foreign };
}

/** S = 0.56·U_r + 0.24·T_r + 0.14·U_p + 0.06·T_p + 0.30·F_r (default coefficients). */
export function computeSiteScore(inputs: SiteScoreInputs): number {
  const { regional, prelimSchools, prelimTeams, coefficients: c } = inputs;
  return (
    c.regionalSchools * regional.schools +
    c.regionalTeams * regional.teams +
    c.prelimSchools * prelimSchools +
    c.prelimTeams * prelimTeams +
    c.foreignTeams * regional.foreign
  );
}

export interface RegionalSimulation {
  siteScore: number;
  stars: Map<string, ApacStarTier>;
  /** team id → (R−1)/S for every team in the scored list; empty when siteScore ≤ 0. */
  values: Map<string, number>;
}

/**
 * The regional-mode simulation over FINAL standings: champion = standings[0].
 * A site score that is not a finite number > 0 yields no values and promotes
 * nobody (no division by zero, no Infinity shown).
 */
export function simulateRegional(
  snapshot: Snapshot,
  opts: {
    siteScore: number;
    cutoff: number | null;
    quota: SchoolQuota;
    alreadyInvited: AlreadyInvited | null;
  },
): RegionalSimulation {
  const usable = Number.isFinite(opts.siteScore) && opts.siteScore > 0;
  const filter: ApacFilterOptions = {
    championTeamId: snapshot.standings[0]?.team.id ?? null,
    alreadyInvited: opts.alreadyInvited,
    quota: opts.quota,
  };

  const stars = computeApacStars(snapshot, {
    ...filter,
    phase: 'final',
    siteScore: usable ? opts.siteScore : null,
    invitedScoreCutoff: opts.cutoff,
  });

  const values = new Map<string, number>();
  if (usable) {
    for (const [teamId, rank] of computeApacFilteredRanks(snapshot, filter)) {
      values.set(teamId, (rank - 1) / opts.siteScore);
    }
  }

  return { siteScore: opts.siteScore, stars, values };
}
