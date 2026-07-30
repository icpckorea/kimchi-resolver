#!/usr/bin/env node
/**
 * Asset consistency check (spec §8):
 *   - every team's `group` must have an entry in public/orgs/orgs.json
 *   - every orgs.json entry with a `logo` must have the file in public/orgs/logos/
 *
 * Usage: node scripts/check-assets.mjs [path/to/contest.json]
 * Defaults to public/sample/contest.json. Exits 1 when problems are found.
 */
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTEST_PATH = path.resolve(process.argv[2] ?? path.join(ROOT, 'public', 'sample', 'contest.json'));
const ORGS_PATH = path.join(ROOT, 'public', 'orgs', 'orgs.json');
const LOGOS_DIR = path.join(ROOT, 'public', 'orgs', 'logos');

const useColor = process.stdout.isTTY || process.env.FORCE_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const red = (t) => paint('31', t);
const green = (t) => paint('32', t);
const yellow = (t) => paint('33', t);
const bold = (t) => paint('1', t);
const dim = (t) => paint('2', t);

async function readJson(filePath, label) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    console.error(red(`error: cannot read ${label}: ${filePath}`));
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(red(`error: ${label} is not valid JSON: ${filePath}`));
    console.error(dim(String(err)));
    process.exit(1);
  }
}

const contest = await readJson(CONTEST_PATH, 'contest.json');
const orgs = await readJson(ORGS_PATH, 'orgs.json');

const teams = Array.isArray(contest.teams) ? contest.teams : [];
if (teams.length === 0) {
  console.error(red('error: contest.json has no teams array (or it is empty).'));
  process.exit(1);
}

console.log(bold('kimchi-resolver asset check'));
console.log(dim(`  contest : ${CONTEST_PATH}`));
console.log(dim(`  orgs    : ${ORGS_PATH}`));
console.log(dim(`  logos   : ${LOGOS_DIR}`));
console.log(dim(`  teams   : ${teams.length}, orgs entries: ${Object.keys(orgs).length}`));
console.log('');

let problemCount = 0;

// 1. teams whose group is missing from orgs.json
const missingGroups = new Map(); // group -> [team labels]
for (const team of teams) {
  const group = team.group;
  if (group == null || group === '') {
    problemCount += 1;
    console.log(`${red('MISSING GROUP')}  team ${bold(String(team.id))} (${team.name ?? '?'}) has no group field`);
    continue;
  }
  if (!Object.prototype.hasOwnProperty.call(orgs, group)) {
    if (!missingGroups.has(group)) missingGroups.set(group, []);
    missingGroups.get(group).push(`${team.id} (${team.name ?? '?'})`);
  }
}

if (missingGroups.size > 0) {
  console.log(red(`Groups missing from orgs.json: ${missingGroups.size}`));
  for (const [group, teamLabels] of missingGroups) {
    problemCount += 1;
    console.log(`  ${red('MISSING ORG')}  ${bold(group)}`);
    console.log(dim(`    teams: ${teamLabels.join(', ')}`));
  }
  console.log('');
}

// 2. orgs entries whose logo file is missing under public/orgs/logos/
const missingLogos = [];
for (const [group, meta] of Object.entries(orgs)) {
  const logo = meta && typeof meta === 'object' ? meta.logo : undefined;
  if (!logo) continue;
  try {
    await access(path.join(LOGOS_DIR, logo));
  } catch {
    missingLogos.push([group, logo]);
  }
}

if (missingLogos.length > 0) {
  console.log(red(`Logo files missing under public/orgs/logos/: ${missingLogos.length}`));
  for (const [group, logo] of missingLogos) {
    problemCount += 1;
    console.log(`  ${yellow('MISSING LOGO')}  ${bold(logo)} ${dim(`(org: ${group})`)}`);
  }
  console.log('');
}

if (problemCount > 0) {
  console.log(red(bold(`${problemCount} problem(s) found.`)));
  process.exit(1);
}

console.log(green(bold('All assets OK.')));
