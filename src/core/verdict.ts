/**
 * Verdict normalization (spec §4).
 *
 * Both feed adapters normalize raw judgement information into
 * `{ verdict, penaltyCounts }` at ingest time, so downstream scoring never
 * inspects raw result strings. This kills the original spotboard bug where
 * "Pending - Judging" was counted both as pending AND as a failed (penalized)
 * attempt (analysis doc §2.2).
 */

import type { Verdict } from './types';

export interface NormalizedVerdict {
  verdict: Verdict;
  /**
   * True only when the run is a penalized rejection. Meaningless (false) for
   * 'accepted' and 'pending'.
   */
  penaltyCounts: boolean;
}

/**
 * Spotboard result-string normalization. Prefix matching, case-sensitive:
 * - "Yes" prefix → accepted
 * - ""(empty) or "Pending" prefix → pending
 * - {@link SPOTBOARD_NO_PENALTY_RESULT} prefix → failed, NOT penalized (our own
 *   extension; the exporter writes it so a compile error stays penalty-free)
 * - anything else → failed, penalized (classic spotboard has no no-penalty verdicts)
 */
export function normalizeSpotboardResult(result: string): NormalizedVerdict {
  if (result.startsWith('Yes')) {
    return { verdict: 'accepted', penaltyCounts: false };
  }
  if (result === '' || result.startsWith('Pending')) {
    return { verdict: 'pending', penaltyCounts: false };
  }
  if (result.startsWith(SPOTBOARD_NO_PENALTY_RESULT)) {
    return { verdict: 'failed', penaltyCounts: false };
  }
  return { verdict: 'failed', penaltyCounts: true };
}

/**
 * Result string for a rejection that costs no penalty (compile error). Classic
 * spotboard feeds never send it, so their "No - *" strings stay penalized.
 */
export const SPOTBOARD_NO_PENALTY_RESULT = 'No (no penalty)';

/**
 * Inverse of {@link normalizeSpotboardResult}: the result string that maps back
 * to the same verdict and penalty behavior. Pending is "" (the freeze mask).
 */
export function toSpotboardResult(verdict: Verdict, penaltyCounts: boolean): string {
  if (verdict === 'accepted') return 'Yes';
  if (verdict === 'pending') return '';
  return penaltyCounts ? 'No' : SPOTBOARD_NO_PENALTY_RESULT;
}

/** Shape of a Contest API `/judgement-types` entry (the flags we need). */
export interface JudgementTypeFlags {
  solved: boolean;
  penalty: boolean;
}

/**
 * Contest API normalization. A submission with no judgement yet is pending
 * (pass null). Otherwise the judgement-type flags decide: solved → accepted;
 * not solved → failed, with penaltyCounts taken from the `penalty` flag so
 * no-penalty rejections (e.g. compile error) are excluded from scoring.
 */
export function normalizeJudgementType(judgementType: JudgementTypeFlags | null): NormalizedVerdict {
  if (judgementType === null) {
    return { verdict: 'pending', penaltyCounts: false };
  }
  if (judgementType.solved) {
    return { verdict: 'accepted', penaltyCounts: false };
  }
  return { verdict: 'failed', penaltyCounts: judgementType.penalty };
}
