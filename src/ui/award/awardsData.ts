/**
 * awards.json v2 helpers (spec §6): entry parsing + rank humanization.
 * UI-layer module — the core is unaware of awards.json.
 */
import { ordinalSuffix } from '@ui/scoreboard/util';

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

/**
 * Rank display text (spec §6): numbers become "Nth Place" with the ordinal
 * suffix as plain text (shared scoreboard ordinal rules); strings pass
 * through verbatim (e.g. "대상").
 */
export function humanizeRank(rank: string | number): string {
  if (typeof rank === 'number') return `${rank}${ordinalSuffix(rank)} Place`;
  return rank;
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
