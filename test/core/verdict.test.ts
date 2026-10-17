import { describe, expect, it } from 'vitest';
import {
  SPOTBOARD_NO_PENALTY_RESULT,
  normalizeJudgementType,
  normalizeSpotboardResult,
  toSpotboardResult,
} from '@core/verdict';

describe('normalizeSpotboardResult', () => {
  it('maps "Yes" to accepted', () => {
    expect(normalizeSpotboardResult('Yes')).toEqual({ verdict: 'accepted', penaltyCounts: false });
  });

  it('maps any "Yes"-prefixed result to accepted', () => {
    expect(normalizeSpotboardResult('Yes - Correct').verdict).toBe('accepted');
    expect(normalizeSpotboardResult('Yes!').verdict).toBe('accepted');
  });

  it('is case-sensitive: "yes"/"YES" are NOT accepted', () => {
    expect(normalizeSpotboardResult('yes')).toEqual({ verdict: 'failed', penaltyCounts: true });
    expect(normalizeSpotboardResult('YES')).toEqual({ verdict: 'failed', penaltyCounts: true });
  });

  it('maps empty string to pending', () => {
    expect(normalizeSpotboardResult('')).toEqual({ verdict: 'pending', penaltyCounts: false });
  });

  it('maps "Pending"-prefixed results to pending', () => {
    expect(normalizeSpotboardResult('Pending')).toEqual({
      verdict: 'pending',
      penaltyCounts: false,
    });
    expect(normalizeSpotboardResult('Pending - Judging')).toEqual({
      verdict: 'pending',
      penaltyCounts: false,
    });
  });

  it('"" and "Pending - Judging" normalize identically (original penalty-asymmetry bug not ported)', () => {
    expect(normalizeSpotboardResult('')).toEqual(normalizeSpotboardResult('Pending - Judging'));
  });

  it('lowercase "pending" is NOT pending (case-sensitive prefix)', () => {
    expect(normalizeSpotboardResult('pending')).toEqual({ verdict: 'failed', penaltyCounts: true });
  });

  it('maps every other result to failed with penaltyCounts=true', () => {
    for (const result of [
      'No - Wrong Answer',
      'No - Time Limit Exceeded',
      'No - Run-time Error',
      'No - Compile Error',
      'No - Other',
      'No',
      'What Is This',
    ]) {
      expect(normalizeSpotboardResult(result)).toEqual({ verdict: 'failed', penaltyCounts: true });
    }
  });
});

describe('SPOTBOARD_NO_PENALTY_RESULT', () => {
  it('maps to failed without penalty, also with a suffix', () => {
    expect(normalizeSpotboardResult(SPOTBOARD_NO_PENALTY_RESULT)).toEqual({ verdict: 'failed', penaltyCounts: false });
    expect(normalizeSpotboardResult(`${SPOTBOARD_NO_PENALTY_RESULT} - Compile Error`).penaltyCounts).toBe(false);
  });

  it('does not change classic "No - *" strings', () => {
    expect(normalizeSpotboardResult('No - Compile Error')).toEqual({ verdict: 'failed', penaltyCounts: true });
  });
});

describe('toSpotboardResult', () => {
  it('writes strings that normalizeSpotboardResult reads back', () => {
    expect(toSpotboardResult('accepted', false)).toBe('Yes');
    expect(toSpotboardResult('pending', false)).toBe('');
    expect(toSpotboardResult('failed', true)).toBe('No');
    expect(toSpotboardResult('failed', false)).toBe(SPOTBOARD_NO_PENALTY_RESULT);
  });
});

describe('normalizeJudgementType', () => {
  it('maps null (no judgement yet) to pending', () => {
    expect(normalizeJudgementType(null)).toEqual({ verdict: 'pending', penaltyCounts: false });
  });

  it('maps solved judgement types to accepted', () => {
    expect(normalizeJudgementType({ solved: true, penalty: false })).toEqual({
      verdict: 'accepted',
      penaltyCounts: false,
    });
    // solved wins regardless of the penalty flag
    expect(normalizeJudgementType({ solved: true, penalty: true }).verdict).toBe('accepted');
  });

  it('maps penalized rejections (e.g. WA) to failed with penaltyCounts=true', () => {
    expect(normalizeJudgementType({ solved: false, penalty: true })).toEqual({
      verdict: 'failed',
      penaltyCounts: true,
    });
  });

  it('maps no-penalty rejections (e.g. compile error) to failed with penaltyCounts=false', () => {
    expect(normalizeJudgementType({ solved: false, penalty: false })).toEqual({
      verdict: 'failed',
      penaltyCounts: false,
    });
  });
});
