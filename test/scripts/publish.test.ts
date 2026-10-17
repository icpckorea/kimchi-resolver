// @vitest-environment node
/**
 * `npm run publish` (publish-modes spec §4): publish-state.json in, a static,
 * credential-free folder out. These tests run the real Vite build, so they
 * take a few seconds each.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsePublishState, type PublishState } from '@core/publishState';
import { PublishError, runPublish, scanOutput } from '../../scripts/publish';
import { buildSampleState, loadSample, type Sample } from '../helpers/sampleState';

const NASTY_NAME = 'x</script><b>';
const DATA_TAG = '<script type="application/json" id="publish-data">';

/** Every file under dir, relative paths with forward slashes. */
function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(full.slice(base.length + 1).split('\\').join('/'));
  }
  return out;
}

describe('npm run publish', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kimchi-publish-'));
  let sample: Sample;
  let state: PublishState;
  let outDir: string;
  let html: string;
  let warnings: string[];

  function writeState(name: string, value: unknown): string {
    const path = join(tmp, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  beforeAll(async () => {
    sample = await loadSample();
    state = buildSampleState(sample);
    // Review Focus 2: a team name that tries to close the embedding tag.
    state.snapshot.standings[0].team.name = NASTY_NAME;

    outDir = join(tmp, 'out');
    const result = await runPublish({ statePath: writeState('state.json', state), outDir });
    warnings = result.warnings;
    html = readFileSync(join(outDir, 'index.html'), 'utf8');
  }, 120_000);

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('builds index.html with embedded, parseable data', () => {
    expect(existsSync(join(outDir, 'publish.html'))).toBe(false);
    expect(html).not.toContain('<!--PUBLISH_DATA-->');
    const start = html.indexOf(DATA_TAG);
    expect(start).toBeGreaterThan(-1);
    const end = html.indexOf('</script>', start);
    const parsed = parsePublishState(JSON.parse(html.slice(start + DATA_TAG.length, end)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state.title).toBe(sample.contest.title);
      expect(parsed.state.snapshot.standings).toHaveLength(sample.snapshot.standings.length);
    }
    // The page script is relative, so the folder works under any S3 prefix.
    expect(html).toMatch(/<script type="module"[^>]*src="\.\/assets\//);
  });

  it('escapes </script> in team names', () => {
    const start = html.indexOf(DATA_TAG);
    // The first </script> after the opening tag is the data block's own.
    const dataEnd = html.indexOf('</script>', start);
    const between = html.slice(start + DATA_TAG.length, dataEnd);
    expect(between).not.toContain('<');
    expect(dataEnd).toBeGreaterThan(start);
    const parsed = parsePublishState(JSON.parse(between));
    expect(parsed.ok && parsed.state.snapshot.standings[0].team.name).toBe(NASTY_NAME);
  });

  it('keeps "$&" style text in the data literally', async () => {
    const dollar = buildSampleState(sample);
    dollar.title = "Seoul $& $' $` $1";
    const dir = join(tmp, 'out-dollar');
    await runPublish({ statePath: writeState('dollar.json', dollar), outDir: dir });
    const page = readFileSync(join(dir, 'index.html'), 'utf8');
    const start = page.indexOf(DATA_TAG) + DATA_TAG.length;
    const parsed = parsePublishState(JSON.parse(page.slice(start, page.indexOf('</script>', start))));
    expect(parsed.ok && parsed.state.title).toBe("Seoul $& $' $` $1");
  }, 120_000);

  it('refuses an invalid state with the zod path', async () => {
    const bad = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    bad.schemaVersion = 2;
    const target = join(tmp, 'out-bad');
    const error = await runPublish({ statePath: writeState('bad.json', bad), outDir: target }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PublishError);
    expect((error as PublishError).message).toContain('publish-state.schemaVersion');
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a missing file and a file that is not JSON', async () => {
    await expect(
      runPublish({ statePath: join(tmp, 'nope.json'), outDir: join(tmp, 'o1') }),
    ).rejects.toBeInstanceOf(PublishError);
    const junk = join(tmp, 'junk.json');
    writeFileSync(junk, '{ not json');
    await expect(runPublish({ statePath: junk, outDir: join(tmp, 'o2') })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('will not empty a folder that holds the project', async () => {
    await expect(
      runPublish({ statePath: writeState('s.json', state), outDir: resolve(__dirname, '../..') }),
    ).rejects.toThrow(/refusing/i);
  });

  it('output has no config.json, no awards.json, and no judgement-types', () => {
    const files = listFiles(outDir);
    expect(files).toContain('index.html');
    for (const file of files) {
      expect(file).not.toMatch(/(^|\/)(config|awards)\.json$/);
      expect(file).not.toMatch(/(^|\/)sample\//);
    }
    for (const file of files.filter((f) => f.endsWith('.js'))) {
      expect(readFileSync(join(outDir, file), 'utf8')).not.toContain('judgement-types');
    }
  });

  it('copies only the logos of schools on the board, and warns about a missing file', () => {
    const logos = listFiles(outDir).filter((f) => f.startsWith('orgs/logos/'));
    const wanted = Object.values(state.orgs)
      .map((o) => o.logo)
      .filter((l): l is string => l !== undefined);
    expect(wanted.length).toBeGreaterThan(0);
    expect(warnings.filter((w) => w.includes('logo'))).toHaveLength(
      wanted.filter((l) => !existsSync(resolve(__dirname, '../../public/orgs/logos', l))).length,
    );
    expect(logos.length).toBe(wanted.length - warnings.filter((w) => w.includes('logo')).length);
    expect(logos.length).toBeLessThanOrEqual(wanted.length);
  });

  it('skips logos when showSchoolLogos is off', async () => {
    const quiet = buildSampleState(sample, {
      display: {
        showTeamGroup: true,
        showFirstSolve: true,
        showBalloons: false,
        showSchoolLogos: false,
      },
    });
    const dir = join(tmp, 'out-nologo');
    await runPublish({ statePath: writeState('nologo.json', quiet), outDir: dir });
    expect(existsSync(join(dir, 'orgs'))).toBe(false);
  }, 120_000);

  it('ignores a logo name that leaves the logo folder', async () => {
    const evil = JSON.parse(JSON.stringify(state)) as PublishState;
    const group = Object.keys(evil.orgs)[0];
    evil.orgs[group] = { ...evil.orgs[group], logo: '../config.json' };
    const dir = join(tmp, 'out-evil');
    const result = await runPublish({ statePath: writeState('evil.json', evil), outDir: dir });
    expect(result.warnings.some((w) => w.includes('../config.json'))).toBe(true);
    expect(listFiles(dir)).not.toContain('config.json');
  }, 120_000);
});

describe('scanOutput', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kimchi-scan-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('passes a clean folder', () => {
    const dir = join(tmp, 'clean');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<p>ok</p>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    expect(scanOutput(dir, ['hunter2-secret'])).toEqual([]);
  });

  it('reports a secret, a forbidden file name and feed code', () => {
    const dir = join(tmp, 'dirty');
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'config.json'), '{}');
    writeFileSync(join(dir, 'awards.json'), '[]');
    writeFileSync(join(dir, 'app.js'), 'fetch("https://judge.example/api/judgement-types")');
    writeFileSync(join(dir, 'page.html'), '<p>hunter2-secret</p>');
    const problems = scanOutput(dir, ['hunter2-secret']).join('\n');
    expect(problems).toContain('a/config.json');
    expect(problems).toContain('awards.json');
    expect(problems).toContain('judgement-types');
    expect(problems).toContain('page.html');
    // The secret itself never appears in the message.
    expect(problems).not.toContain('hunter2-secret');
  });
});
