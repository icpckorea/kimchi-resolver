/**
 * Shared fixture: the bundled sample contest as a final Snapshot, plus a
 * publish-state builder. Used by the publish-state contract test and by the
 * `npm run publish` test.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSpotboardSource } from '@core/ingest/spotboard';
import { createRunFeeder } from '@core/feeder';
import { computeStandings } from '@core/standings';
import {
  buildPublishState,
  type PublishDisplay,
  type PublishState,
} from '@core/publishState';
import type { Contest, OrgsIndex, Snapshot } from '@core/types';

const ROOT = resolve(__dirname, '../..');

export const SAMPLE_NOW = new Date('2026-10-16T09:00:00.000Z');

export const SAMPLE_DISPLAY: PublishDisplay = {
  showTeamGroup: true,
  showFirstSolve: true,
  showBalloons: false,
  showSchoolLogos: true,
};

export interface Sample {
  contest: Contest;
  snapshot: Snapshot;
  orgs: OrgsIndex;
}

/** Loads public/sample and computes the final standings (all runs applied). */
export async function loadSample(): Promise<Sample> {
  const contestJson = JSON.parse(
    readFileSync(resolve(ROOT, 'public/sample/contest.json'), 'utf8'),
  );
  const runsJson = JSON.parse(readFileSync(resolve(ROOT, 'public/sample/runs.json'), 'utf8'));
  const orgs: OrgsIndex = JSON.parse(
    readFileSync(resolve(ROOT, 'public/orgs/orgs.json'), 'utf8'),
  );

  /** fetch stub serving the sample files from disk. */
  const fetchStub = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('contest.json')
      ? contestJson
      : url.includes('runs.json')
        ? runsJson
        : undefined;
    if (body === undefined) {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const source = createSpotboardSource({
    apiBase: './sample/',
    fetchTimeout: 5000,
    excludeTeamIds: [],
    foreign: { ids: [], groups: [] },
    orgs,
    fetchImpl: fetchStub,
  });
  const contest = await source.loadContest();
  const feeder = createRunFeeder(contest);
  feeder.ingest(await source.fetchRuns(null));
  feeder.feedAll();
  return { contest, snapshot: computeStandings(contest, feeder.appliedRuns), orgs };
}

/** buildPublishState over the sample with the usual fixture defaults. */
export function buildSampleState(
  sample: Sample,
  extra: Partial<Parameters<typeof buildPublishState>[0]> = {},
): PublishState {
  return buildPublishState({
    mode: 'off',
    title: sample.contest.title,
    display: SAMPLE_DISPLAY,
    problems: sample.contest.problems,
    orgs: sample.orgs,
    snapshot: sample.snapshot,
    manualLabels: null,
    now: SAMPLE_NOW,
    ...extra,
  });
}
