#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFile(join(root, path), 'utf8');
const rootReadme = await read('README.md');
const packageEntries = await readdir(join(root, 'packages'), { withFileTypes: true });
let publicPackages = 0;

for (const entry of packageEntries) {
  if (!entry.isDirectory()) continue;
  const packageJsonPath = join(root, 'packages', entry.name, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }
  if (packageJson.private) continue;

  publicPackages += 1;
  assert.equal(typeof packageJson.name, 'string', `${entry.name} must have a package name`);
  assert.ok(
    rootReadme.includes(`| \`packages/${entry.name}\``) &&
      rootReadme.includes(`\`${packageJson.name}\``),
    `README package table is missing packages/${entry.name} (${packageJson.name})`,
  );
}
assert.ok(publicPackages > 0, 'expected at least one public package');

const fastReadme = await read('packages/fast-mode/README.md');
for (const label of ['fast on', 'fast off', 'no fast']) {
  assert.ok(fastReadme.includes(`\`${label}\``), `fast-mode README is missing ${label}`);
}

const tmuxReadme = await read('packages/tmux-bash/README.md');
const tmuxPrompt = await read('packages/tmux-bash/extensions/tmux-bash/src/prompt.ts');
assert.match(tmuxReadme, /required finite asynchronous work/u);
assert.match(tmuxReadme, /persistent servers/u);
assert.match(tmuxReadme, /watchers, or REPLs/u);
assert.match(tmuxPrompt, /required finite work/u);
assert.match(tmuxPrompt, /expected to remain alive indefinitely/u);
assert.doesNotMatch(tmuxReadme, /nothing productive to do until the result/u);

const generatedTheme = await read(
  'tools/nx-pi/src/generators/theme/files/themes/__name__.json.template',
);
assert.match(generatedTheme, /"thinkingMax"/u);

process.stdout.write(`Documentation checks passed for ${publicPackages} public packages.\n`);
