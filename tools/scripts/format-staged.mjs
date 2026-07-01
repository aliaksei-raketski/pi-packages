import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const PRETTIER_CHUNK_SIZE = 50;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout ?? '';
}

function git(args) {
  return run('git', args);
}

function parseNullDelimited(output) {
  return output.split('\0').filter(Boolean);
}

const stagedFiles = parseNullDelimited(
  git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']),
).filter((file) => existsSync(file));

if (stagedFiles.length === 0) {
  process.exit(0);
}

const stagedFileSet = new Set(stagedFiles);
const unstagedFiles = parseNullDelimited(git(['diff', '--name-only', '-z']));
const partiallyStagedFiles = unstagedFiles.filter((file) => stagedFileSet.has(file));

if (partiallyStagedFiles.length > 0) {
  console.error('Prettier pre-commit hook found files with both staged and unstaged changes.');
  console.error(
    'Stage or stash these files first so formatting does not accidentally stage unrelated edits:',
  );
  for (const file of partiallyStagedFiles) {
    console.error(`  - ${file}`);
  }
  process.exit(1);
}

for (let index = 0; index < stagedFiles.length; index += PRETTIER_CHUNK_SIZE) {
  const chunk = stagedFiles.slice(index, index + PRETTIER_CHUNK_SIZE);
  run('pnpm', ['exec', 'prettier', '--write', '--ignore-unknown', ...chunk], {
    stdio: 'inherit',
  });
}

run('git', ['add', '--', ...stagedFiles], { stdio: 'inherit' });
