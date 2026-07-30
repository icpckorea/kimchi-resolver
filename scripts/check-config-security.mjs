#!/usr/bin/env node
/**
 * Build-time guard against publishing secrets or spoilers.
 *
 * Everything under public/ is copied verbatim into dist/ and served as a static
 * file, so anything in it is readable by every visitor. Two mistakes are easy
 * to make and expensive on contest day:
 *
 *   1. credentials in config.json (source.auth) — a reader account is enough to
 *      query unfrozen judgements straight from DOMjudge during the freeze;
 *   2. awards.json sitting in the public deployment — it names the winners.
 *
 * Run as part of `npm run build`. Override deliberately with ALLOW_PUBLIC_AUTH=1
 * (e.g. the operator's own award machine, which is not publicly served).
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = join(root, 'public');
const problems = [];

// --- 1. credentials in config.json ------------------------------------------
const configPath = join(publicDir, 'config.json');
if (existsSync(configPath)) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    problems.push(`public/config.json is not valid JSON: ${err.message}`);
  }
  const auth = config?.source?.auth;
  if (auth !== undefined && auth !== null) {
    problems.push(
      'public/config.json sets source.auth. config.json is served as a static file, so those\n' +
        '  credentials are readable by every visitor — and with them anyone can read unfrozen\n' +
        '  verdicts straight from the judge. Use a reverse proxy or an exporter instead.\n' +
        '  If this build is NOT publicly served, set ALLOW_PUBLIC_AUTH=1.',
    );
  }
}

// --- 2. awards.json anywhere under public/ ----------------------------------
// Only the exact name `awards.json` is flagged: that is the file an operator
// drops in with the real results. The bundled demo is `awards.sample.json`,
// which contains made-up placings and is safe to publish.
function findAwards(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findAwards(full));
    else if (entry.name === 'awards.json') found.push(full);
  }
  return found;
}
if (existsSync(publicDir)) {
  for (const file of findAwards(publicDir)) {
    problems.push(
      `${relative(root, file)} ships in the build and names the winners.\n` +
        '  Serve it only from the award machine, never from the public scoreboard.\n' +
        '  If this build is the award build, set ALLOW_PUBLIC_AUTH=1.',
    );
  }
}

if (problems.length === 0) {
  console.log('config security check: OK');
  process.exit(0);
}

if (process.env.ALLOW_PUBLIC_AUTH === '1') {
  console.warn('config security check: OVERRIDDEN (ALLOW_PUBLIC_AUTH=1)');
  for (const problem of problems) console.warn(`  - ${problem}`);
  process.exit(0);
}

console.error('config security check FAILED:\n');
for (const problem of problems) console.error(`  - ${problem}\n`);
console.error('Set ALLOW_PUBLIC_AUTH=1 to build anyway (non-public deployments only).');
process.exit(1);
