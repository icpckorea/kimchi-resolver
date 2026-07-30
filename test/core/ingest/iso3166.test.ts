import { describe, it, expect } from 'vitest';
import {
  ISO3166_ALPHA3_TO_ALPHA2,
  NON_ISO_ALPHA3_ALIASES,
  normalizeCountryCode,
} from '@core/ingest/iso3166';

describe('ISO3166_ALPHA3_TO_ALPHA2', () => {
  it('is the complete ISO 3166-1 table (249 assigned codes)', () => {
    expect(Object.keys(ISO3166_ALPHA3_TO_ALPHA2)).toHaveLength(249);
  });

  it('holds only uppercase alpha-3 → alpha-2 pairs, with unique alpha-2 values', () => {
    const alpha2 = new Set<string>();
    for (const [a3, a2] of Object.entries(ISO3166_ALPHA3_TO_ALPHA2)) {
      expect(a3).toMatch(/^[A-Z]{3}$/);
      expect(a2).toMatch(/^[A-Z]{2}$/);
      expect(alpha2.has(a2)).toBe(false); // no two countries share a flag code
      alpha2.add(a2);
    }
  });

  it('never lets a non-ISO alias shadow a real ISO code', () => {
    for (const [alias, a2] of Object.entries(NON_ISO_ALPHA3_ALIASES)) {
      expect(alias).toMatch(/^[A-Z]{3}$/);
      expect(a2).toMatch(/^[A-Z]{2}$/);
      expect(ISO3166_ALPHA3_TO_ALPHA2[alias]).toBeUndefined();
    }
    // The collision that motivates the rule: BRN is Brunei in ISO and Bahrain
    // in IOC. ISO wins; Bahrain must be sent as BHR.
    expect(normalizeCountryCode('BRN')).toBe('BN');
    expect(normalizeCountryCode('BHR')).toBe('BH');
  });
});

describe('normalizeCountryCode', () => {
  it('maps the APAC codes the old 5-entry map got wrong', () => {
    // The old slice(0, 2) fallback produced BG (Bulgaria), BR (Brazil), MA
    // (Morocco) — three wrong flags at an Asia regional.
    expect(normalizeCountryCode('BGD')).toBe('BD'); // Bangladesh
    expect(normalizeCountryCode('BRN')).toBe('BN'); // Brunei Darussalam
    expect(normalizeCountryCode('MAC')).toBe('MO'); // Macao
  });

  it('maps the rest of the APAC region', () => {
    const expected: Record<string, string> = {
      KOR: 'KR',
      JPN: 'JP',
      CHN: 'CN',
      TWN: 'TW',
      HKG: 'HK',
      SGP: 'SG',
      MYS: 'MY',
      IDN: 'ID',
      PHL: 'PH',
      THA: 'TH',
      VNM: 'VN',
      MMR: 'MM',
      KHM: 'KH',
      LAO: 'LA',
      IND: 'IN',
      NPL: 'NP',
      LKA: 'LK',
      PAK: 'PK',
      MNG: 'MN',
      AUS: 'AU',
      NZL: 'NZ',
      USA: 'US',
      DEU: 'DE',
      CAN: 'CA',
    };
    for (const [a3, a2] of Object.entries(expected)) {
      expect(normalizeCountryCode(a3)).toBe(a2);
    }
  });

  it('resolves the IOC codes ICPC feeds sometimes carry', () => {
    expect(normalizeCountryCode('TPE')).toBe('TW'); // Chinese Taipei
    expect(normalizeCountryCode('INA')).toBe('ID');
    expect(normalizeCountryCode('SIN')).toBe('SG');
    expect(normalizeCountryCode('GER')).toBe('DE');
  });

  it('passes alpha-2 through, case-insensitively, trimming whitespace', () => {
    expect(normalizeCountryCode('KR')).toBe('KR');
    expect(normalizeCountryCode('kr')).toBe('KR');
    expect(normalizeCountryCode(' kor ')).toBe('KR');
  });

  it('returns undefined instead of guessing for absent or unresolvable codes', () => {
    expect(normalizeCountryCode(undefined)).toBeUndefined();
    expect(normalizeCountryCode(null)).toBeUndefined();
    expect(normalizeCountryCode('')).toBeUndefined();
    expect(normalizeCountryCode('   ')).toBeUndefined();
    expect(normalizeCountryCode('XXX')).toBeUndefined(); // unassigned
    expect(normalizeCountryCode('Korea')).toBeUndefined(); // a name, not a code
    expect(normalizeCountryCode('K')).toBeUndefined();
  });
});
