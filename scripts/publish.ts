/**
 * `npm run publish -- <publish-state.json> [--out <dir>]`
 *
 * Turns the file that the prepare page downloads into a static, credential-free
 * folder (default `publish-dist/`) that the operator uploads to S3 by hand
 * (publish-modes spec §4). Steps: validate the state, build the public page
 * (vite.publish.config.ts), embed the data, copy the school logos, scan the
 * output for secrets and feed code.
 */
import { build } from 'vite';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePublishState, type PublishState } from '../src/core/publishState';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_OUT_DIR = 'publish-dist';
const PLACEHOLDER = '<!--PUBLISH_DATA-->';
/** Marker of the Contest API adapter: proves feed code leaked into the bundle. */
const FEED_MARKER = 'judgement-types';
const FORBIDDEN_NAMES = new Set(['config.json', 'awards.json']);

/** Failure the CLI prints as is (no stack) before it exits with code 1. */
export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishError';
  }
}

export interface PublishRunResult {
  outDir: string;
  warnings: string[];
}

/** Every file under dir (absolute paths). */
function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

/**
 * Checks every output file. Returns one line per problem. A secret is never
 * printed, only the file it was found in.
 */
export function scanOutput(outDir: string, secrets: readonly string[]): string[] {
  const problems: string[] = [];
  for (const file of walk(outDir)) {
    const rel = relative(outDir, file).split(sep).join('/');
    if (FORBIDDEN_NAMES.has(basename(file))) {
      problems.push(`${rel}: this file name must not be published`);
    }
    const bytes = readFileSync(file);
    if (secrets.some((secret) => bytes.includes(secret))) {
      problems.push(`${rel}: contains a credential or the judge URL from config.json`);
    }
    if (file.endsWith('.js') && bytes.includes(FEED_MARKER)) {
      problems.push(`${rel}: contains feed code (${FEED_MARKER}); the bundle must not import ingest`);
    }
  }
  return problems;
}

/** Credential and judge URL strings from public/config.json (when it exists). */
function readSecrets(warnings: string[]): string[] {
  const path = join(PROJECT_ROOT, 'public', 'config.json');
  if (!existsSync(path)) return [];
  let source: { baseUrl?: unknown; auth?: { username?: unknown; password?: unknown } | null };
  try {
    source = JSON.parse(readFileSync(path, 'utf8'))?.source ?? {};
  } catch {
    warnings.push('public/config.json is not valid JSON; the secret scan skipped it');
    return [];
  }
  const secrets = [source.auth?.username, source.auth?.password, source.baseUrl];
  return secrets.filter((s): s is string => typeof s === 'string' && s !== '');
}

/** `<` as < keeps "</script>" and "<!--" inside the JSON from ending the tag. */
export function embedJson(state: PublishState): string {
  const json = JSON.stringify(state).replace(/</g, '\\u003c');
  return `<script type="application/json" id="publish-data">${json}</script>`;
}

/** The outDir is emptied, so never accept the project, a parent of it, or a root. */
function assertSafeOutDir(outDir: string): void {
  const rel = relative(outDir, PROJECT_ROOT);
  const holdsProject = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (holdsProject || dirname(outDir) === outDir) {
    throw new PublishError(`Refusing to empty ${outDir}: it holds the project. Use another --out folder.`);
  }
}

function readState(statePath: string): PublishState {
  let text: string;
  try {
    text = readFileSync(statePath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PublishError(`Cannot read ${statePath}: ${reason}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PublishError(`${statePath} is not valid JSON: ${reason}`);
  }
  const parsed = parsePublishState(json);
  if (!parsed.ok) {
    throw new PublishError(`${statePath} is not a valid publish-state.json:\n${parsed.errors.join('\n')}`);
  }
  return parsed.state;
}

function copyLogos(state: PublishState, outDir: string, warnings: string[]): void {
  if (!state.display.showSchoolLogos) return;
  const logoDir = join(PROJECT_ROOT, 'public', 'orgs', 'logos');
  for (const [group, org] of Object.entries(state.orgs)) {
    const logo = org.logo;
    if (logo === undefined) continue;
    // A hand-edited file must not read outside the logo folder.
    if (logo === '' || basename(logo) !== logo || logo === '.' || logo === '..') {
      warnings.push(`logo of "${group}" skipped: "${logo}" is not a plain file name`);
      continue;
    }
    const from = join(logoDir, logo);
    if (!existsSync(from)) {
      warnings.push(`logo of "${group}" is missing: public/orgs/logos/${logo}`);
      continue;
    }
    const to = join(outDir, 'orgs', 'logos', logo);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

export async function runPublish(opts: {
  statePath: string;
  outDir?: string;
}): Promise<PublishRunResult> {
  const warnings: string[] = [];
  const state = readState(resolve(opts.statePath));
  const outDir = resolve(opts.outDir ?? DEFAULT_OUT_DIR);
  assertSafeOutDir(outDir);

  rmSync(outDir, { recursive: true, force: true });
  await build({
    configFile: join(PROJECT_ROOT, 'vite.publish.config.ts'),
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
  });

  const pagePath = join(outDir, 'publish.html');
  const html = readFileSync(pagePath, 'utf8');
  if (!html.includes(PLACEHOLDER)) {
    throw new PublishError(`publish.html lost its ${PLACEHOLDER} placeholder; the build cannot embed the data`);
  }
  // A replacer function: the JSON may hold "$&" or "$'" that String.replace would expand.
  writeFileSync(join(outDir, 'index.html'), html.replace(PLACEHOLDER, () => embedJson(state)));
  rmSync(pagePath);

  copyLogos(state, outDir, warnings);

  const problems = scanOutput(outDir, readSecrets(warnings));
  if (problems.length > 0) {
    throw new PublishError(`The output failed the safety scan:\n${problems.join('\n')}`);
  }
  return { outDir, warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { statePath: string; outDir?: string } | null {
  const args = argv.filter((a) => a !== '--');
  let outDir: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') outDir = args[++i];
    else rest.push(args[i]);
  }
  if (rest.length !== 1 || (args.includes('--out') && !outDir)) return null;
  return { statePath: rest[0], outDir };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) {
    console.error('사용법: npm run publish -- <publish-state.json> [--out <폴더>]');
    process.exit(1);
  }
  try {
    const { outDir, warnings } = await runPublish(parsed);
    for (const warning of warnings) console.warn(`경고: ${warning}`);
    console.log(`\n공개용 폴더를 만들었습니다: ${outDir}`);
    console.log('S3에 이 폴더를 올리세요.');
  } catch (error) {
    if (error instanceof PublishError) console.error(`\n오류: ${error.message}`);
    else console.error(error);
    process.exit(1);
  }
}

// `vite-node scripts/publish.ts` is the CLI. A test that imports this file runs
// under vitest, where argv[1] is another binary, so nothing starts.
if (basename(process.argv[1] ?? '').startsWith('vite-node')) void main();
