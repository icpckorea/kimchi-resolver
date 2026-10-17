/**
 * publish-state.json contract (publish-modes spec §4): build → JSON → parse →
 * restore must give back the same Snapshot, and a stale, hand-edited or
 * other-mode file must be refused with the zod path in the message.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { DEFAULT_SITE_SCORE_COEFFICIENTS } from '@core/apac';
import {
  PUBLISH_STATE_VERSION,
  buildPublishState,
  parsePublishState,
  restoreSnapshot,
  type PreliminaryResultState,
  type PublishState,
  type RegionalSimInputs,
} from '@core/publishState';
import type { Contest, OrgsIndex, Snapshot } from '@core/types';
import { SAMPLE_NOW as NOW, buildSampleState, loadSample } from '../helpers/sampleState';

/** JSON round trip: what the browser downloads and the script reads back. */
function viaJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function expectOk(result: ReturnType<typeof parsePublishState>): PublishState {
  if (!result.ok) throw new Error(`expected ok, got: ${result.errors.join('\n')}`);
  return result.state;
}

function expectErrors(result: ReturnType<typeof parsePublishState>): string[] {
  if (result.ok) throw new Error('expected errors, got ok');
  return result.errors;
}

describe('publish-state.json contract', () => {
  let contest: Contest;
  let snapshot: Snapshot;
  let orgs: OrgsIndex;

  beforeAll(async () => {
    const sample = await loadSample();
    contest = sample.contest;
    snapshot = sample.snapshot;
    orgs = sample.orgs;
  });

  function build(extra: Partial<Parameters<typeof buildPublishState>[0]> = {}): PublishState {
    return buildSampleState({ contest, snapshot, orgs }, extra);
  }

  it('round-trips the sample contest', () => {
    const labels = new Map<string, readonly string[]>([
      [snapshot.standings[0].team.id, ['대상']],
    ]);
    const state = build({ manualLabels: labels });
    expect(state.schemaVersion).toBe(PUBLISH_STATE_VERSION);
    expect(state.generatedAt).toBe(NOW.toISOString());
    expect(state.mode).toBe('off');

    const parsed = expectOk(parsePublishState(viaJson(state)));
    expect(parsed.problems).toEqual(contest.problems);
    expect(parsed.manualLabels).toEqual({ [snapshot.standings[0].team.id]: ['대상'] });

    const restored = restoreSnapshot(parsed);
    expect(restored.standings.map((s) => s.team.id)).toEqual(
      snapshot.standings.map((s) => s.team.id),
    );
    expect(restored).toEqual(snapshot);
    // Cell map order follows the problem order, like computeStandings.
    expect([...restored.standings[0].cells.keys()]).toEqual([
      ...snapshot.standings[0].cells.keys(),
    ]);
    // byTeam points at the same objects as standings.
    for (const s of restored.standings) expect(restored.byTeam.get(s.team.id)).toBe(s);
  });

  it('never stores the run list', () => {
    const json = JSON.stringify(build());
    expect(json).not.toContain('"runs"');
    expect(json).not.toContain('"seq"');
  });

  it('round-trips the preliminary and regional payloads', () => {
    const preliminary: PreliminaryResultState = {
      totalTeams: 3,
      topN: 2,
      k: 4,
      ineligibleTeamIds: [snapshot.standings[5].team.id],
      selected: [
        { teamId: snapshot.standings[0].team.id, stage: 'top' },
        { teamId: snapshot.standings[1].team.id, stage: 'top' },
        { teamId: snapshot.standings[7].team.id, stage: 'school' },
      ],
    };
    const prelim = expectOk(parsePublishState(viaJson(build({ mode: 'preliminary', preliminary }))));
    expect(prelim.mode === 'preliminary' && prelim.preliminary).toEqual(preliminary);

    const regional: RegionalSimInputs = {
      prelimSchools: 60,
      prelimTeams: 250,
      coefficients: { ...DEFAULT_SITE_SCORE_COEFFICIENTS },
      regionalOverride: { schools: null, teams: 120, foreign: null },
      wfMedalGroups: ['Seoul National University'],
      winnerGroups: [],
      invitedGroups: ['National Taiwan University'],
      invitedTeamIds: [],
      cutoff: 0.1838,
    };
    const reg = expectOk(parsePublishState(viaJson(build({ mode: 'regional', regional }))));
    expect(reg.mode === 'regional' && reg.regional).toEqual(regional);
  });

  it('rejects a wrong schemaVersion with the path', () => {
    const json = viaJson(build()) as Record<string, unknown>;
    json.schemaVersion = 2;
    const errors = expectErrors(parsePublishState(json));
    expect(errors.some((e) => e.startsWith('publish-state.schemaVersion:'))).toBe(true);

    delete json.schemaVersion;
    const missing = expectErrors(parsePublishState(json));
    expect(missing.some((e) => e.startsWith('publish-state.schemaVersion:'))).toBe(true);
  });

  it('rejects a non-object file', () => {
    for (const bad of [null, [], 'x', 1]) {
      const errors = expectErrors(parsePublishState(bad));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.startsWith('publish-state'))).toBe(true);
    }
  });

  it('rejects mode/payload mismatch', () => {
    const json = viaJson(build()) as Record<string, unknown>;
    json.mode = 'preliminary';
    const errors = expectErrors(parsePublishState(json));
    expect(errors.some((e) => e.startsWith('publish-state.preliminary:'))).toBe(true);

    // A payload of the other mode is an unknown key.
    const regional = viaJson(build()) as Record<string, unknown>;
    regional.preliminary = { totalTeams: 1, topN: 0, k: 0, ineligibleTeamIds: [], selected: [] };
    expect(expectErrors(parsePublishState(regional)).join('\n')).toContain('preliminary');

    const unknownMode = viaJson(build()) as Record<string, unknown>;
    unknownMode.mode = 'final';
    expect(
      expectErrors(parsePublishState(unknownMode)).some((e) =>
        e.startsWith('publish-state.mode:'),
      ),
    ).toBe(true);
  });

  it('buildPublishState throws when the mode payload is missing', () => {
    expect(() => build({ mode: 'preliminary' })).toThrow(/preliminary/);
    expect(() => build({ mode: 'regional' })).toThrow(/regional/);
  });

  it('rejects unknown keys', () => {
    const top = viaJson(build()) as Record<string, unknown>;
    top.config = { source: {} };
    expect(expectErrors(parsePublishState(top)).join('\n')).toContain('config');

    const nested = viaJson(build()) as {
      snapshot: { standings: { team: Record<string, unknown> }[] };
    };
    nested.snapshot.standings[0].team.password = 'secret';
    const errors = expectErrors(parsePublishState(nested));
    expect(errors.some((e) => e.startsWith('publish-state.snapshot.standings.0.team:'))).toBe(
      true,
    );
    expect(errors.join('\n')).toContain('password');
  });

  it('rejects a cell of an unknown problem and a duplicated team', () => {
    const cell = viaJson(build()) as {
      snapshot: { standings: { cells: { problemId: string }[] }[] };
    };
    cell.snapshot.standings[0].cells[0].problemId = 'nope';
    expect(expectErrors(parsePublishState(cell)).join('\n')).toContain(
      'publish-state.snapshot.standings.0.cells',
    );

    const dup = viaJson(build()) as { snapshot: { standings: unknown[] } };
    dup.snapshot.standings.push(dup.snapshot.standings[0]);
    expect(expectErrors(parsePublishState(dup)).join('\n')).toContain(
      'publish-state.snapshot.standings',
    );
  });

  it('keeps only orgs of participating groups', () => {
    const extra: OrgsIndex = { ...orgs, 'Nowhere University': { country: 'KR' } };
    const state = build({ orgs: extra });
    const groups = new Set(snapshot.standings.map((s) => s.team.group));
    expect(Object.keys(state.orgs).length).toBeGreaterThan(0);
    for (const name of Object.keys(state.orgs)) expect(groups.has(name)).toBe(true);
    expect(state.orgs['Nowhere University']).toBeUndefined();
    for (const name of groups) {
      if (extra[name] !== undefined) expect(state.orgs[name]).toEqual(extra[name]);
    }
  });

  it('keeps manual labels of present teams only', () => {
    const labels = new Map<string, readonly string[]>([
      [snapshot.standings[0].team.id, ['대상']],
      ['no-such-team', ['금상']],
    ]);
    const state = build({ manualLabels: labels });
    expect(state.manualLabels).toEqual({ [snapshot.standings[0].team.id]: ['대상'] });
  });
});
