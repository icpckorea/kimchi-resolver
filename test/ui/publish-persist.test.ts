/**
 * Prepare-page input persistence (publish-modes spec §4 step 2): keys are
 * per mode and per contest (Review Focus 4), and every storage failure reads
 * as "nothing stored" instead of throwing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, type AppConfig } from '@core/config';
import {
  clearPublishInputs,
  loadPublishInputs,
  parseStoredPrelimInputs,
  parseStoredRegionalInputs,
  publishStorageKey,
  savePublishInputs,
  type StorageLike,
} from '../../src/ui/publish/persist';

function configWith(source: Partial<AppConfig['source']>): AppConfig {
  const config = defaultConfig();
  return { ...config, source: { ...config.source, ...source } };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('publishStorageKey', () => {
  it('keys differ by mode and by contest', () => {
    const seoul = configWith({ contestId: 'seoul2026' });
    const prelim = publishStorageKey(seoul, 'Seoul Regional', 'preliminary');
    const regional = publishStorageKey(seoul, 'Seoul Regional', 'regional');
    expect(prelim).toBe('kimchi.publish:preliminary:seoul2026:Seoul Regional');
    expect(regional).not.toBe(prelim);

    // Another contest id, or the same id with another title, is another key.
    expect(publishStorageKey(configWith({ contestId: 'prelim2026' }), 'Seoul Regional', 'regional')).not.toBe(
      regional,
    );
    expect(publishStorageKey(seoul, 'Seoul Preliminary', 'regional')).not.toBe(regional);
  });

  it('falls back to the spotboard apiBase when there is no contest id', () => {
    const key = publishStorageKey(configWith({ apiBase: './data/seoul/' }), 'T', 'regional');
    expect(key).toBe('kimchi.publish:regional:./data/seoul/:T');
  });
});

describe('load / save / clear', () => {
  it('round-trips a value through localStorage', () => {
    savePublishInputs('k1', { topN: 25 });
    expect(loadPublishInputs<{ topN: number }>('k1')).toEqual({ topN: 25 });
    clearPublishInputs('k1');
    expect(loadPublishInputs('k1')).toBeNull();
  });

  it('a value saved under one mode is not read under the other', () => {
    const config = configWith({ contestId: 'c' });
    savePublishInputs(publishStorageKey(config, 'T', 'preliminary'), { topN: 25 });
    expect(loadPublishInputs(publishStorageKey(config, 'T', 'regional'))).toBeNull();
  });

  it('corrupt JSON returns null', () => {
    localStorage.setItem('k2', '{not json');
    expect(loadPublishInputs('k2')).toBeNull();
  });

  it('storage access that throws returns null', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(loadPublishInputs('k3')).toBeNull();
  });

  it('a throwing setItem / removeItem is swallowed', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => savePublishInputs('k4', { a: 1 })).not.toThrow();
    expect(() => clearPublishInputs('k4')).not.toThrow();
  });

  it('an injected storage is used instead of localStorage; null storage reads nothing', () => {
    const data = new Map<string, string>();
    const storage: StorageLike = {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
    savePublishInputs('k5', [1, 2], storage);
    expect(data.get('k5')).toBe('[1,2]');
    expect(localStorage.getItem('k5')).toBeNull();
    expect(loadPublishInputs('k5', storage)).toEqual([1, 2]);
    expect(loadPublishInputs('k5', null)).toBeNull();
  });

  it('a parser refuses a stale shape', () => {
    savePublishInputs('k6', { topN: 25, siteScore: 3 });
    expect(loadPublishInputs('k6', undefined, parseStoredPrelimInputs)).toBeNull();
  });
});

describe('stored value parsers', () => {
  it('accept the store shapes', () => {
    const prelim = { totalTeams: 60, topN: 30, k: null, ineligibleTeamIds: ['a'] };
    expect(parseStoredPrelimInputs(prelim)).toEqual(prelim);
    const regional = {
      prelimSchools: null,
      prelimTeams: 100,
      coefficients: {
        regionalSchools: 0.56,
        regionalTeams: 0.24,
        prelimSchools: 0.14,
        prelimTeams: 0.06,
        foreignTeams: 0.3,
      },
      regionalOverride: { schools: null, teams: null, foreign: 2 },
      wfMedalGroups: ['A'],
      winnerGroups: [],
      invitedGroups: ['B'],
      invitedTeamIds: [],
      cutoff: 1.5,
    };
    expect(parseStoredRegionalInputs(regional)).toEqual(regional);
  });

  it('refuse wrong types and unknown keys', () => {
    expect(parseStoredPrelimInputs({ totalTeams: '60', topN: 30, k: null, ineligibleTeamIds: [] })).toBeNull();
    expect(parseStoredPrelimInputs(null)).toBeNull();
    expect(parseStoredRegionalInputs({ cutoff: 1 })).toBeNull();
  });
});
