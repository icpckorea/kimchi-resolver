/**
 * Preliminary (예선) advancement selection (publish-modes spec §5.1). Pure and
 * framework-free.
 *
 * Source: 2026 ICPC Seoul preliminary notice, item 6
 * (https://icpckorea.org/archives/3475). Spec §5.1, verbatim intent:
 *
 * 1. Every ineligible team is removed from the standings (never selected).
 * 2. Of the remaining teams, the top N in standings order are selected. The
 *    school is not looked at.
 * 3. Only schools with NO team selected in step 2 take part. If a school's
 *    best (eligible) team solved at least K problems, that team is selected.
 *    If the best team solved fewer than K, the school gets nothing in step 3:
 *    the school's next team is NOT looked at. (Operator ruling "해석 1".)
 * 4. While fewer than T teams are selected, the not-yet-selected teams are
 *    added in standings order until T teams are selected.
 *
 * Rules:
 * - When step 2 + step 3 exceeds T, step 4 selects nothing, but every step-3
 *   team is still kept (the notice puts no cap on step 3). `overflow` is set
 *   and a warning is emitted.
 * - A team with an empty school name ('') is its own school (same as the
 *   APAC rules in apac.ts): unrelated org-less teams never cover each other.
 * - Tied teams follow standings order. When a selection boundary (the N-th
 *   or the T-th team) splits teams that share an icpcRank, a warning names
 *   both teams. Ties are never resolved automatically.
 * - Each selected team records its stage ('top' = 2, 'school' = 3,
 *   'fill' = 4).
 *
 * Empty T or K (nothing to select yet) is the caller's concern: this function
 * takes concrete numbers only.
 */

import type { Snapshot, TeamStanding } from './types';

export type PrelimStage = 'top' | 'school' | 'fill';

export interface PrelimOptions {
  /** T ≥ 1: number of teams that advance to the regional. */
  totalTeams: number;
  /** N ≥ 0: step 2, top N teams regardless of school. */
  topN: number;
  /** K ≥ 0: step 3, minimum solved count for a school's best team. */
  k: number;
  ineligibleTeamIds: ReadonlySet<string>;
}

export interface PrelimResult {
  /** Team id → stage. Insertion order = selection order. */
  selected: Map<string, PrelimStage>;
  counts: { top: number; school: number; fill: number };
  /** True when top + school > totalTeams. */
  overflow: boolean;
  /** Human-readable Korean warnings: boundary ties, overflow. */
  warnings: string[];
}

/** Clamp a count input to a non-negative integer (NaN → 0). */
function toCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function tieWarning(boundary: string, a: TeamStanding, b: TeamStanding): string {
  return (
    `${boundary} 경계에서 같은 순위(${a.icpcRank}위)의 팀이 나뉩니다: ` +
    `'${a.team.name}' 선발, '${b.team.name}' 미선발. 직접 확인해 주세요.`
  );
}

export function selectPreliminary(snapshot: Snapshot, opts: PrelimOptions): PrelimResult {
  const totalTeams = toCount(opts.totalTeams);
  const topN = toCount(opts.topN);
  const k = toCount(opts.k);

  const selected = new Map<string, PrelimStage>();
  const counts = { top: 0, school: 0, fill: 0 };
  const warnings: string[] = [];

  // Step 1: drop ineligible teams; standings are already in ICPC order.
  const eligible = snapshot.standings.filter((s) => !opts.ineligibleTeamIds.has(s.team.id));

  // Step 2: top N regardless of school.
  const topCount = Math.min(topN, eligible.length);
  for (let i = 0; i < topCount; i++) {
    selected.set(eligible[i].team.id, 'top');
  }
  counts.top = topCount;

  // Step 3: the best eligible team of each school with no step-2 team.
  // Named schools are decided once (covered by step 2, or judged on their
  // first eligible team). An org-less team is its own school.
  const decidedSchools = new Set<string>();
  for (const s of eligible) {
    if (s.team.group !== '' && selected.has(s.team.id)) decidedSchools.add(s.team.group);
  }
  for (const s of eligible) {
    if (selected.has(s.team.id)) continue;
    const group = s.team.group;
    if (group !== '') {
      if (decidedSchools.has(group)) continue;
      decidedSchools.add(group);
    }
    if (s.solved >= k) {
      selected.set(s.team.id, 'school');
      counts.school++;
    }
  }

  const overflow = counts.top + counts.school > totalTeams;
  if (overflow) {
    warnings.push(`선발 팀 수가 진출 팀 수를 넘습니다 (${selected.size}팀)`);
  }

  // Step 4: fill up to T in standings order.
  if (selected.size < totalTeams) {
    let lastFill: TeamStanding | null = null;
    let nextIndex = 0;
    for (; nextIndex < eligible.length && selected.size < totalTeams; nextIndex++) {
      const s = eligible[nextIndex];
      if (selected.has(s.team.id)) continue;
      selected.set(s.team.id, 'fill');
      counts.fill++;
      lastFill = s;
    }
    if (lastFill !== null) {
      const next = eligible.slice(nextIndex).find((s) => !selected.has(s.team.id));
      if (next !== undefined && next.icpcRank === lastFill.icpcRank) {
        warnings.push(tieWarning(`진출 ${totalTeams}팀`, lastFill, next));
      }
    }
  }

  // The top-N tie is judged after all steps: a tied next team that step 3 or 4
  // selected anyway is not a lost team, so it needs no warning.
  if (topCount > 0 && topCount < eligible.length) {
    const last = eligible[topCount - 1];
    const next = eligible[topCount];
    if (last.icpcRank === next.icpcRank && !selected.has(next.team.id)) {
      // Before the fill-boundary warning, as in the order of the steps.
      warnings.unshift(tieWarning(`상위 ${topN}팀`, last, next));
    }
  }

  return { selected, counts, overflow, warnings };
}
