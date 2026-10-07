#!/usr/bin/env node
/**
 * Bump the version for the whole reporter monorepo in lockstep.
 *
 *   node scripts/bump-version.mjs <major|minor|patch|X.Y.Z> [--commit]
 *   pnpm run version:bump patch
 *
 * Every workspace (root + packages/* + apps/*) shares one version — that single
 * number is what the desktop About view, `reporter-term --version`, the server
 * Docker tag, and the CI release tag all report. This script:
 *   1. rewrites the `version` field of every workspace package.json,
 *   2. updates the `reporter-term` CLI `.version()` literal,
 *   3. opens a dated section in CHANGELOG.md,
 *   4. optionally commits and tags (`--commit`) so the tag trips the release CI.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const doCommit = args.includes('--commit');
const bump = args.find((a) => !a.startsWith('--'));
if (!bump) {
  fail('Usage: node scripts/bump-version.mjs <major|minor|patch|X.Y.Z> [--commit]');
}

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) fail(`Cannot parse version "${v}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const [maj, min, pat] = parse(current);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  return fail(`Unknown bump "${kind}" — use major | minor | patch | X.Y.Z`);
}

/** Discover every workspace package.json (robust to new packages/apps). */
function discoverManifests() {
  const list = ['package.json'];
  for (const group of ['packages', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const rel = `${group}/${name}/package.json`;
      if (existsSync(join(root, rel))) list.push(rel);
    }
  }
  return list;
}

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const current = rootPkg.version;
const next = nextVersion(current, bump);

if (next === current) fail(`Version is already ${next}.`);

console.log(`reporter ${current} → ${next}\n`);

// Exact set of files this run rewrote — the only paths we stage on `--commit`,
// so an unrelated dirty working tree never leaks into the release commit/tag.
const changed = [];

for (const rel of discoverManifests()) {
  const abs = join(root, rel);
  const json = JSON.parse(readFileSync(abs, 'utf8'));
  if (!('version' in json)) continue;
  json.version = next;
  writeFileSync(abs, JSON.stringify(json, null, 2) + '\n');
  changed.push(rel);
  console.log(`  ${rel}`);
}

// Keep the reporter-term CLI banner in lockstep (it hard-codes the literal).
const termIndex = join(root, 'apps/term/src/index.ts');
if (existsSync(termIndex)) {
  const src = readFileSync(termIndex, 'utf8');
  const updated = src.replace(/(\.version\(')\d+\.\d+\.\d+('\))/, `$1${next}$2`);
  if (updated === src) {
    // Silence here is how a version literal drifts: the file still exists, the
    // regex quietly stops matching after a refactor, and the release ships a CLI
    // reporting the wrong version. Fail the bump instead.
    throw new Error(
      'bump: could not find the .version() literal in apps/term/src/index.ts — ' +
        'update the regex in scripts/bump-version.mjs or the literal in that file.',
    );
  }
  writeFileSync(termIndex, updated);
  changed.push('apps/term/src/index.ts');
  console.log('  apps/term/src/index.ts (.version literal)');
}

// Open a dated CHANGELOG section under Unreleased.
const changelogPath = join(root, 'CHANGELOG.md');
if (existsSync(changelogPath)) {
  const today = new Date().toISOString().slice(0, 10);
  const cl = readFileSync(changelogPath, 'utf8');
  const marker = '## [Unreleased]';
  if (!cl.includes(marker)) {
    throw new Error(`bump: CHANGELOG.md has no "${marker}" heading to open a release under.`);
  }
  if (cl.includes(`## [${next}]`)) {
    throw new Error(`bump: CHANGELOG.md already has a "## [${next}]" section.`);
  }
  writeFileSync(changelogPath, cl.replace(marker, `${marker}\n\n## [${next}] - ${today}`));
  changed.push('CHANGELOG.md');
  console.log(`  CHANGELOG.md (## [${next}] - ${today})`);
}

if (doCommit) {
  // Stage only the files we rewrote — never `git add -A` (would sweep in
  // unrelated modified/untracked files, tagging them into the release commit).
  execFileSync('git', ['add', '--', ...changed], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['commit', '-m', `chore(release): v${next}`], {
    cwd: root,
    stdio: 'inherit',
  });
  execFileSync('git', ['tag', `v${next}`], { cwd: root, stdio: 'inherit' });
  console.log(`\n✔ Committed and tagged v${next}.`);
  console.log(`  Push with: git push && git push origin v${next}`);
} else {
  console.log(`\n✔ Bumped to v${next}. Next:`);
  console.log('  1. Review the diff; move CHANGELOG "Unreleased" notes under the new heading.');
  console.log(`  2. git commit -am "chore(release): v${next}"`);
  console.log(`  3. git tag v${next} && git push origin v${next}   # trips release.yml`);
}
