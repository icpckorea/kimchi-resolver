import { describe, expect, it } from 'vitest';
import {
  applyUrlOverrides,
  DEFAULT_ANIMATION_SPEEDS,
  defaultConfig,
  parseConfig,
  selectMode,
} from '@core/config';

describe('parseConfig — defaults', () => {
  it('empty object yields every spec §9 default with no errors', () => {
    const { config, errors } = parseConfig({});
    expect(errors).toEqual([]);
    expect(config).toEqual({
      source: {
        type: 'spotboard',
        apiBase: './sample/',
        baseUrl: '',
        contestId: '',
        auth: null,
        eventsWs: null,
      },
      fetchTimeout: 5000,
      autoRefreshInterval: 10000,
      autoPlay: true,
      autoPlayDelay: 100,
      animation: true,
      showTeamGroup: true,
      showFirstSolve: true,
      showBalloons: true,
      showSchoolLogos: false,
      showEvents: false,
      lockMode: false,
      timeTravel: false,
      maxNotifications: 100,
      pagination: false,
      paginationSize: 50,
      useFollowedTeamSticky: true,
      excludeTeams: [],
      foreign: { ids: [], groups: [] },
      apac: { enabled: false },
      publish: {
        enabled: false,
        mode: 'off',
        invitedScoreCutoff: null,
        alreadyInvited: { teamIds: [], winnerGroups: [], invitedGroups: [] },
        preliminary: { totalTeams: null, topN: 30, k: null, ineligibleTeamIds: [] },
        regional: {
          prelimSchools: null,
          prelimTeams: null,
          coefficients: {
            regionalSchools: 0.56,
            regionalTeams: 0.24,
            prelimSchools: 0.14,
            prelimTeams: 0.06,
            foreignTeams: 0.3,
          },
          wfMedalGroups: [],
        },
      },
      award: {
        mode: false,
        hideName: true,
        showBalloons: false,
        rankBegin: null,
        awardsUrl: './sample/awards.sample.json',
        revealOrder: [],
        focusBlinking: { minSolved: 7, maxRank: 10 },
        gachaEffectRequirement: 8,
        gachaEffectForNoRatio: 30,
        finaleFlipSlowdown: 3,
        finaleIntermediateFlipSlowdown: 2,
        animationSpeeds: [
          { minSolved: 10, fastFlip: 200, slowFlip: 800, moveUpMsPerRow: 200 },
          { minSolved: 0, fastFlip: 300, slowFlip: 700, moveUpMsPerRow: 100 },
        ],
      },
    });
  });

  it('null and undefined behave like an empty config', () => {
    expect(parseConfig(null).config).toEqual(defaultConfig());
    expect(parseConfig(undefined).config).toEqual(defaultConfig());
    expect(parseConfig(null).errors).toEqual([]);
  });

  it('non-object input falls back to defaults with one error', () => {
    for (const bad of ['hello', 42, true, ['x']]) {
      const { config, errors } = parseConfig(bad);
      expect(config).toEqual(defaultConfig());
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/expected an object/);
    }
  });

  it('partial config keeps defaults for missing keys (top level and nested)', () => {
    const { config, errors } = parseConfig({
      autoPlay: false,
      source: { type: 'contest-api', baseUrl: 'https://judge/api' },
      award: { mode: true },
      publish: { enabled: true },
    });
    expect(errors).toEqual([]);
    expect(config.autoPlay).toBe(false);
    expect(config.source.type).toBe('contest-api');
    expect(config.source.baseUrl).toBe('https://judge/api');
    expect(config.source.apiBase).toBe('./sample/'); // untouched sibling default
    expect(config.award.mode).toBe(true);
    expect(config.award.hideName).toBe(true);
    expect(config.award.focusBlinking).toEqual({ minSolved: 7, maxRank: 10 });
    expect(config.publish.enabled).toBe(true);
    expect(config.publish.mode).toBe('off');
    expect(config.fetchTimeout).toBe(5000);
  });

  it('accepts the full spec §9 sample config verbatim', () => {
    const { config, errors } = parseConfig({
      source: {
        type: 'spotboard',
        apiBase: './sample/',
        baseUrl: '',
        contestId: '',
        auth: null,
        eventsWs: null,
      },
      fetchTimeout: 5000,
      autoRefreshInterval: 10000,
      autoPlay: true,
      autoPlayDelay: 100,
      animation: true,
      showTeamGroup: true,
      showFirstSolve: true,
      showBalloons: true,
      showSchoolLogos: false,
      showEvents: false,
      maxNotifications: 100,
      pagination: false,
      paginationSize: 50,
      useFollowedTeamSticky: true,
      excludeTeams: [],
      foreign: { ids: [], groups: [] },
      apac: { enabled: false },
      publish: {
        enabled: false,
        mode: 'off',
        invitedScoreCutoff: null,
        alreadyInvited: { teamIds: [], winnerGroups: [], invitedGroups: [] },
        preliminary: { totalTeams: null, topN: 30, k: null, ineligibleTeamIds: [] },
        regional: {
          prelimSchools: null,
          prelimTeams: null,
          coefficients: {
            regionalSchools: 0.56,
            regionalTeams: 0.24,
            prelimSchools: 0.14,
            prelimTeams: 0.06,
            foreignTeams: 0.3,
          },
          wfMedalGroups: [],
        },
      },
      award: {
        mode: false,
        hideName: true,
        showBalloons: false,
        rankBegin: null,
        awardsUrl: './sample/awards.sample.json',
        revealOrder: [],
        focusBlinking: { minSolved: 7, maxRank: 10 },
        gachaEffectRequirement: 8,
        gachaEffectForNoRatio: 30,
        finaleFlipSlowdown: 3,
        finaleIntermediateFlipSlowdown: 2,
        animationSpeeds: [
          { minSolved: 10, fastFlip: 200, slowFlip: 800, moveUpMsPerRow: 200 },
          { minSolved: 0, fastFlip: 300, slowFlip: 700, moveUpMsPerRow: 100 },
        ],
      },
    });
    expect(errors).toEqual([]);
    expect(config).toEqual(defaultConfig());
  });

  it('stringifies numeric ids in excludeTeams, foreign.ids and revealOrder', () => {
    const { config, errors } = parseConfig({
      excludeTeams: [3, '17'],
      foreign: { ids: [2229881430, 'x9'] },
      award: { revealOrder: [2229881430, 'A'] },
    });
    expect(errors).toEqual([]);
    expect(config.excludeTeams).toEqual(['3', '17']);
    expect(config.foreign.ids).toEqual(['2229881430', 'x9']);
    expect(config.award.revealOrder).toEqual(['2229881430', 'A']);
  });

  it('parses publish.alreadyInvited, stringifying numeric team ids (spec §13)', () => {
    const { config, errors } = parseConfig({
      publish: {
        enabled: true,
        alreadyInvited: { teamIds: [1024, 'x9'], groups: ['National Taiwan University'] },
      },
    });
    expect(errors).toEqual([]);
    expect(config.publish.alreadyInvited).toEqual({
      teamIds: ['1024', 'x9'],
      winnerGroups: [],
      invitedGroups: ['National Taiwan University'],
    });
  });

  it('falls back to empty alreadyInvited lists when the value is malformed', () => {
    const { config, errors } = parseConfig({
      publish: { alreadyInvited: { teamIds: 'nope', groups: [7] } },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(config.publish.alreadyInvited).toEqual({
      teamIds: [],
      winnerGroups: [],
      invitedGroups: [],
    });
  });

  it('publish.mode defaults to off', () => {
    expect(defaultConfig().publish.mode).toBe('off');
    expect(parseConfig({ publish: { enabled: true } }).config.publish.mode).toBe('off');
  });

  it('parses publish.mode, preliminary and regional blocks', () => {
    const { config, errors } = parseConfig({
      publish: {
        mode: 'preliminary',
        preliminary: { totalTeams: 60, topN: 25, k: 3, ineligibleTeamIds: [7, 'x'] },
        regional: {
          prelimSchools: 40,
          prelimTeams: 120,
          coefficients: { foreignTeams: 0.5 },
          wfMedalGroups: ['Seoul National University'],
        },
      },
    });
    expect(errors).toEqual([]);
    expect(config.publish.mode).toBe('preliminary');
    expect(config.publish.preliminary).toEqual({
      totalTeams: 60,
      topN: 25,
      k: 3,
      ineligibleTeamIds: ['7', 'x'],
    });
    expect(config.publish.regional.prelimSchools).toBe(40);
    expect(config.publish.regional.prelimTeams).toBe(120);
    // A partial coefficients object keeps the other defaults.
    expect(config.publish.regional.coefficients).toEqual({
      regionalSchools: 0.56,
      regionalTeams: 0.24,
      prelimSchools: 0.14,
      prelimTeams: 0.06,
      foreignTeams: 0.5,
    });
    expect(config.publish.regional.wfMedalGroups).toEqual(['Seoul National University']);
  });

  it('rejects a bad publish.mode and bad preliminary counts with defaults', () => {
    const { config, errors } = parseConfig({
      publish: { mode: 'final', preliminary: { totalTeams: 0, topN: -1, k: 1.5 } },
    });
    expect(errors.some((e) => e.startsWith('config.publish.mode'))).toBe(true);
    expect(errors.some((e) => e.startsWith('config.publish.preliminary.totalTeams'))).toBe(true);
    expect(config.publish.mode).toBe('off');
    expect(config.publish.preliminary).toEqual({
      totalTeams: null,
      topN: 30,
      k: null,
      ineligibleTeamIds: [],
    });
  });

  it('legacy alreadyInvited.groups reads as invitedGroups', () => {
    const { config, errors } = parseConfig({
      publish: { alreadyInvited: { teamIds: ['t1'], groups: ['KAIST'] } },
    });
    expect(errors).toEqual([]);
    expect(config.publish.alreadyInvited).toEqual({
      teamIds: ['t1'],
      winnerGroups: [],
      invitedGroups: ['KAIST'],
    });
  });

  it('new alreadyInvited keys win over the legacy groups key, with a warning', () => {
    const { config, errors } = parseConfig({
      publish: {
        alreadyInvited: { groups: ['Old'], invitedGroups: ['New'], winnerGroups: ['W'] },
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^config\.publish\.alreadyInvited\.groups/);
    expect(config.publish.alreadyInvited).toEqual({
      teamIds: [],
      winnerGroups: ['W'],
      invitedGroups: ['New'],
    });
  });

  it('siteScore is gone: the key is ignored without an error', () => {
    const { config, errors } = parseConfig({ publish: { enabled: true, siteScore: 68.98 } });
    expect(errors).toEqual([]);
    expect('siteScore' in config.publish).toBe(false);
  });

  it('accepts contest-api auth and eventsWs', () => {
    const { config, errors } = parseConfig({
      source: {
        type: 'contest-api',
        baseUrl: 'https://cds/api',
        contestId: 'seoul2025',
        auth: { username: 'u', password: 'p' },
        eventsWs: 'wss://cds/doorbell',
      },
    });
    expect(errors).toEqual([]);
    expect(config.source.auth).toEqual({ username: 'u', password: 'p' });
    expect(config.source.eventsWs).toBe('wss://cds/doorbell');
  });

  it('allows focusBlinking: null (blink disabled)', () => {
    const { config, errors } = parseConfig({ award: { focusBlinking: null } });
    expect(errors).toEqual([]);
    expect(config.award.focusBlinking).toBeNull();
  });
});

describe('parseConfig — bad values collected as errors, never thrown', () => {
  it('a bad key is reported by name and reset to its default; valid keys survive', () => {
    const { config, errors } = parseConfig({
      autoPlay: 'yes',
      pagination: true,
      fetchTimeout: 1234,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('config.autoPlay');
    expect(config.autoPlay).toBe(true); // default restored
    expect(config.pagination).toBe(true); // valid sibling kept
    expect(config.fetchTimeout).toBe(1234);
  });

  it('collects multiple bad keys in one pass', () => {
    const { config, errors } = parseConfig({
      fetchTimeout: 'soon',
      maxNotifications: -1,
      award: { rankBegin: 'three' },
    });
    expect(errors.some((e) => e.includes('config.fetchTimeout'))).toBe(true);
    expect(errors.some((e) => e.includes('config.maxNotifications'))).toBe(true);
    expect(errors.some((e) => e.includes('config.award.rankBegin'))).toBe(true);
    expect(config.fetchTimeout).toBe(5000);
    expect(config.maxNotifications).toBe(100);
    expect(config.award.rankBegin).toBeNull();
  });

  it('bad nested key resets only that key; nested siblings survive', () => {
    const { config, errors } = parseConfig({
      award: { mode: true, hideName: 'nope' },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('config.award.hideName');
    expect(config.award.hideName).toBe(true); // default restored
    expect(config.award.mode).toBe(true); // sibling kept
  });

  it('invalid enum value for source.type is reported', () => {
    const { config, errors } = parseConfig({ source: { type: 'ftp' } });
    expect(errors.some((e) => e.includes('config.source.type'))).toBe(true);
    expect(config.source.type).toBe('spotboard');
  });

  it('normalizes animationSpeeds to minSolved-descending order (spec §6: no ordering trap)', () => {
    const { config, errors } = parseConfig({
      award: {
        animationSpeeds: [
          { minSolved: 0, fastFlip: 300, slowFlip: 700, moveUpMsPerRow: 100 },
          { minSolved: 10, fastFlip: 200, slowFlip: 800, moveUpMsPerRow: 200 },
        ],
      },
    });
    expect(errors).toHaveLength(0);
    // An ascending config must not shadow the minSolved:10 band.
    expect(config.award.animationSpeeds.map((s) => s.minSolved)).toEqual([10, 0]);
    expect(config.award.animationSpeeds[0].fastFlip).toBe(200);
  });

  it('invalid animationSpeeds entry restores the default table', () => {
    const { config, errors } = parseConfig({
      award: {
        animationSpeeds: [{ minSolved: 5, fastFlip: 'quick', slowFlip: 800, moveUpMsPerRow: 100 }],
      },
    });
    expect(errors.some((e) => e.includes('animationSpeeds'))).toBe(true);
    expect(config.award.animationSpeeds).toEqual(DEFAULT_ANIMATION_SPEEDS);
  });

  it('gachaEffectForNoRatio outside [0, 100] is rejected to default 30', () => {
    const { config, errors } = parseConfig({ award: { gachaEffectForNoRatio: 150 } });
    expect(errors.some((e) => e.includes('gachaEffectForNoRatio'))).toBe(true);
    expect(config.award.gachaEffectForNoRatio).toBe(30);
  });

  it('accepts custom finale flip slowdowns (spec §7)', () => {
    const { config, errors } = parseConfig({
      award: { finaleFlipSlowdown: 5, finaleIntermediateFlipSlowdown: 1.5 },
    });
    expect(errors).toEqual([]);
    expect(config.award.finaleFlipSlowdown).toBe(5);
    expect(config.award.finaleIntermediateFlipSlowdown).toBe(1.5);
  });

  it('non-positive finale slowdowns are rejected to their defaults (3 / 2)', () => {
    const { config, errors } = parseConfig({
      award: { finaleFlipSlowdown: 0, finaleIntermediateFlipSlowdown: -2 },
    });
    expect(errors.some((e) => e.includes('finaleFlipSlowdown'))).toBe(true);
    expect(errors.some((e) => e.includes('finaleIntermediateFlipSlowdown'))).toBe(true);
    expect(config.award.finaleFlipSlowdown).toBe(3);
    expect(config.award.finaleIntermediateFlipSlowdown).toBe(2);
  });

  it('does not mutate the input object', () => {
    const input = { autoPlay: false, award: { mode: true, hideName: 12 } };
    const snapshot = JSON.parse(JSON.stringify(input));
    parseConfig(input);
    expect(input).toEqual(snapshot);
  });
});

describe('applyUrlOverrides', () => {
  const base = () => defaultConfig();

  it('empty search leaves config unchanged with no warnings', () => {
    const { config, warnings } = applyUrlOverrides(base(), '');
    expect(warnings).toEqual([]);
    expect(config).toMatchObject(base());
    expect(config.replayRunId).toBeNull();
    expect(config.replayTimeMinutes).toBeNull();
    expect(config.searchQuery).toBeNull();
    expect(config.followTeamId).toBeNull();
  });

  it('lockMode ignores the award and publish params silently; others still apply', () => {
    const { config: parsed } = parseConfig({ lockMode: true });
    const { config, warnings } = applyUrlOverrides(
      parsed,
      '?award=true&award_rank_begin=3&publish=true&publish_mode=preliminary&invited_cutoff=1&animation=false&q=kaist',
    );
    expect(warnings).toEqual([]);
    expect(config.award.mode).toBe(false);
    expect(config.award.rankBegin).toBeNull();
    expect(config.publish.enabled).toBe(false);
    expect(config.publish.mode).toBe('off');
    expect(config.publish.invitedScoreCutoff).toBeNull();
    expect(selectMode(config)).toBe('spectator');
    expect(config.animation).toBe(false);
    expect(config.searchQuery).toBe('kaist');
  });

  it('timeTravel defaults to false and is read from config.json', () => {
    expect(defaultConfig().timeTravel).toBe(false);
    expect(parseConfig({ timeTravel: true }).config.timeTravel).toBe(true);
  });

  it('lockMode defaults to false', () => {
    expect(defaultConfig().lockMode).toBe(false);
    const { config } = applyUrlOverrides(defaultConfig(), '?award=true');
    expect(config.award.mode).toBe(true);
  });

  it('URL parameters take precedence over config.json values', () => {
    const { config: parsed } = parseConfig({ animation: true, award: { mode: false } });
    const { config, warnings } = applyUrlOverrides(parsed, '?animation=false&award=true');
    expect(warnings).toEqual([]);
    expect(config.animation).toBe(false);
    expect(config.award.mode).toBe(true);
  });

  it('r= sets replayRunId', () => {
    const { config, warnings } = applyUrlOverrides(base(), '?r=1024');
    expect(warnings).toEqual([]);
    expect(config.replayRunId).toBe(1024);
  });

  it('time= sets replayTimeMinutes and forces autoPlay off', () => {
    const cfg = base();
    cfg.autoPlay = true;
    const { config, warnings } = applyUrlOverrides(cfg, '?time=240');
    expect(warnings).toEqual([]);
    expect(config.replayTimeMinutes).toBe(240);
    expect(config.autoPlay).toBe(false);
  });

  it('invalid time= is ignored with a warning and does NOT force autoPlay off', () => {
    const { config, warnings } = applyUrlOverrides(base(), '?time=abc');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"time"');
    expect(config.replayTimeMinutes).toBeNull();
    expect(config.autoPlay).toBe(true);
  });

  it('negative or fractional r=/time= are rejected with warnings', () => {
    const { config, warnings } = applyUrlOverrides(base(), '?r=-5&time=1.5');
    expect(warnings).toHaveLength(2);
    expect(config.replayRunId).toBeNull();
    expect(config.replayTimeMinutes).toBeNull();
  });

  it('award and bare-presence booleans parse; award_rank_begin parses', () => {
    const { config, warnings } = applyUrlOverrides(base(), '?award&award_rank_begin=3');
    expect(warnings).toEqual([]);
    expect(config.award.mode).toBe(true);
    expect(config.award.rankBegin).toBe(3);
  });

  it('award_rank_begin=0 and non-numeric values are ignored with warnings', () => {
    const { config, warnings } = applyUrlOverrides(base(), '?award_rank_begin=0');
    expect(warnings).toHaveLength(1);
    expect(config.award.rankBegin).toBeNull();

    const second = applyUrlOverrides(base(), '?award_rank_begin=first');
    expect(second.warnings).toHaveLength(1);
    expect(second.config.award.rankBegin).toBeNull();
  });

  it('invalid boolean value is ignored with a warning', () => {
    const { config, warnings } = applyUrlOverrides(base(), '?animation=maybe');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"animation"');
    expect(config.animation).toBe(true);
  });

  it('q= and t= set searchQuery and followTeamId', () => {
    const { config, warnings } = applyUrlOverrides(base(), '?q=seoul%20national&t=41');
    expect(warnings).toEqual([]);
    expect(config.searchQuery).toBe('seoul national');
    expect(config.followTeamId).toBe('41');
  });

  it('empty q= and t= are ignored', () => {
    const { config } = applyUrlOverrides(base(), '?q=&t=');
    expect(config.searchQuery).toBeNull();
    expect(config.followTeamId).toBeNull();
  });

  it('publish= and invited_cutoff= override publish config', () => {
    const { config, warnings } = applyUrlOverrides(base(), '?publish=true&invited_cutoff=2.5');
    expect(warnings).toEqual([]);
    expect(config.publish.enabled).toBe(true);
    expect(config.publish.invitedScoreCutoff).toBe(2.5);
  });

  it('invited_cutoff must be non-negative', () => {
    const { config, warnings } = applyUrlOverrides(base(), '?invited_cutoff=-1');
    expect(warnings).toHaveLength(1);
    expect(config.publish.invitedScoreCutoff).toBeNull();
  });

  it('publish=false can disable a config-enabled publish mode', () => {
    const { config: parsed } = parseConfig({ publish: { enabled: true, mode: 'regional' } });
    const { config } = applyUrlOverrides(parsed, '?publish=false');
    expect(config.publish.enabled).toBe(false);
    expect(config.publish.mode).toBe('regional'); // untouched
  });

  it('publish_mode=regional overrides config', () => {
    const { config: parsed } = parseConfig({ publish: { mode: 'preliminary' } });
    const { config, warnings } = applyUrlOverrides(parsed, '?publish=true&publish_mode=regional');
    expect(warnings).toEqual([]);
    expect(config.publish.mode).toBe('regional');
    expect(applyUrlOverrides(parsed, '?publish_mode=off').config.publish.mode).toBe('off');
    expect(applyUrlOverrides(base(), '?publish_mode=preliminary').config.publish.mode).toBe(
      'preliminary',
    );
  });

  it('invalid publish_mode warns and keeps the config mode', () => {
    const { config: parsed } = parseConfig({ publish: { mode: 'preliminary' } });
    const { config, warnings } = applyUrlOverrides(parsed, '?publish_mode=final');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/publish_mode/);
    expect(config.publish.mode).toBe('preliminary');
  });

  it('site_score is gone: the URL parameter is not applied and needs no warning', () => {
    const { config, warnings } = applyUrlOverrides(base(), '?publish=true&site_score=13');
    expect(warnings).toEqual([]);
    expect('siteScore' in config.publish).toBe(false);
  });

  it('does not mutate the input config', () => {
    const cfg = base();
    const snapshot = JSON.parse(JSON.stringify(cfg));
    applyUrlOverrides(cfg, '?award=true&time=10&publish=1&publish_mode=regional');
    expect(JSON.parse(JSON.stringify(cfg))).toEqual(snapshot);
  });

  it('search string works with or without the leading "?"', () => {
    const a = applyUrlOverrides(base(), '?r=7');
    const b = applyUrlOverrides(base(), 'r=7');
    expect(a.config.replayRunId).toBe(7);
    expect(b.config.replayRunId).toBe(7);
  });
});

describe('selectMode', () => {
  it('defaults to spectator', () => {
    expect(selectMode(defaultConfig())).toBe('spectator');
  });

  it('award.mode selects award', () => {
    const { config } = parseConfig({ award: { mode: true } });
    expect(selectMode(config)).toBe('award');
  });

  it('publish.enabled selects publish', () => {
    const { config } = parseConfig({ publish: { enabled: true } });
    expect(selectMode(config)).toBe('publish');
  });

  it('publish takes precedence over award when both are on', () => {
    const { config } = parseConfig({
      award: { mode: true },
      publish: { enabled: true },
    });
    expect(selectMode(config)).toBe('publish');
  });

  it('publish.mode only selects features: every mode still selects publish', () => {
    for (const mode of ['off', 'preliminary', 'regional'] as const) {
      const { config } = parseConfig({ publish: { enabled: true, mode } });
      expect(selectMode(config)).toBe('publish');
    }
    const { config } = parseConfig({ publish: { enabled: false, mode: 'regional' } });
    expect(selectMode(config)).toBe('spectator');
  });

  it('URL ?publish=true&award=true resolves to publish', () => {
    const { config } = applyUrlOverrides(defaultConfig(), '?publish=true&award=true');
    expect(selectMode(config)).toBe('publish');
    expect(config.award.mode).toBe(true); // both set; precedence decides
  });
});
