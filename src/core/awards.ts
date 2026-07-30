/**
 * awards.json v2 (spec §6) — schema + tolerant parser.
 *
 * Core-level, because the award state machine needs the ENTRY IDS at
 * construction time: finalize raises a full-screen slide ONLY for a team that
 * has an entry, and that decision must be made by the machine itself (a UI
 * "raise it, then auto-close it" workaround loses keypresses — see
 * `createAwardMachine`). The store therefore loads awards.json during boot,
 * before the machine exists, and hands the ids in.
 *
 * Rendering helpers that depend on UI utilities (rank humanization) stay in
 * `ui/award/awardsData.ts`, which re-exports this module's types.
 */

/** One awards.json v2 entry. */
export interface AwardEntry {
  teamId: string;
  /** Number → ordinal "3rd Place"; string → rendered verbatim (e.g. "대상"). */
  rank: string | number;
  /** iconRegistry key (medal_gold, trophy, ...). */
  icon?: string;
  /** Free-form label badges. */
  labels: string[];
  /** Co-recipients: team ids (resolved against the contest) or free strings. */
  others: string[];
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === 'string');
}

/**
 * Parses a fetched awards.json value into entries keyed by team id.
 * Tolerant: malformed items are skipped (award UI must never crash the
 * ceremony over bad data). Numeric ids/ranks are accepted; ids stringified.
 */
export function parseAwardsJson(json: unknown): Map<string, AwardEntry> {
  const byTeam = new Map<string, AwardEntry>();
  if (!Array.isArray(json)) return byTeam;
  for (const item of json) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const rawId = record.teamId;
    if (typeof rawId !== 'string' && typeof rawId !== 'number') continue;
    const rawRank = record.rank;
    const rank: string | number =
      typeof rawRank === 'number' || typeof rawRank === 'string' ? rawRank : '';
    const entry: AwardEntry = {
      teamId: String(rawId),
      rank,
      icon: typeof record.icon === 'string' ? record.icon : undefined,
      labels: asStringArray(record.labels),
      others: Array.isArray(record.others)
        ? (record.others as unknown[])
            .filter((o): o is string | number => typeof o === 'string' || typeof o === 'number')
            .map(String)
        : [],
    };
    byTeam.set(entry.teamId, entry);
  }
  return byTeam;
}
