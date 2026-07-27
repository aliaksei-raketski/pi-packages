#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const workflowsDirectory = join(process.cwd(), '.github', 'workflows');
const directoryEntries = await readdir(workflowsDirectory);
const workflowNames = directoryEntries.filter((name) => name.endsWith('.yml'));
const workflows = new Map(
  await Promise.all(
    workflowNames.map(async (name) => [
      name,
      await readFile(join(workflowsDirectory, name), 'utf8'),
    ]),
  ),
);

for (const [name, source] of workflows) {
  assert.doesNotMatch(
    source,
    /^\s*GH_TOKEN\s*:/mu,
    `${name} must use the canonical GITHUB_TOKEN environment name`,
  );

  for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)) {
    const action = match[1];
    if (action.startsWith('./')) continue;

    assert.match(
      action,
      /^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/u,
      `${name} uses a mutable or invalid action reference: ${action}`,
    );
  }
}

const publish = workflows.get('publish-npm.yml');
assert.ok(publish, 'publish-npm.yml must exist');
assert.match(publish, /^\s{2}workflow_call:/mu);
assert.doesNotMatch(publish, /^\s{2}workflow_dispatch:/mu);
assert.match(publish, /^\s{4}environment:\s*npm$/mu);
assert.match(publish, /id-token:\s*write/u);
assert.match(publish, /git merge-base --is-ancestor "\$CI_SHA" "\$RELEASE_SHA"/u);
assert.match(publish, /git merge-base --is-ancestor "\$RELEASE_SHA" origin\/main/u);
assert.match(publish, /git tag --points-at "\$RELEASE_SHA"/u);
assert.match(publish, /pnpm run check/u);
assert.doesNotMatch(publish, /pnpm run test(?::ci)?/u);

const ci = workflows.get('ci.yml');
assert.ok(ci, 'ci.yml must exist');
assert.match(ci, /pnpm run test:ci/u);
assert.match(ci, /needs:\s*main/u);
assert.match(ci, /uses:\s*\.\/\.github\/workflows\/release\.yml/u);
assert.match(ci, /github\.event_name == 'push'/u);
assert.match(ci, /id-token:\s*write/u);

const release = workflows.get('release.yml');
assert.ok(release, 'release.yml must exist');
assert.match(release, /^\s{2}workflow_call:/mu);
assert.doesNotMatch(release, /^\s{2}workflow_(?:dispatch|run):/mu);
assert.doesNotMatch(release, /actions:\s*write/u);
assert.match(release, /id-token:\s*write/u);
assert.match(release, /ref: \$\{\{ inputs\.ci_sha \}\}/u);
assert.match(release, /uses:\s*\.\/\.github\/workflows\/publish-npm\.yml/u);
assert.doesNotMatch(release, /actions\/workflows\/publish-npm\.yml\/dispatches/u);
assert.doesNotMatch(release, /pnpm run test(?::ci)?/u);

process.stdout.write(`Workflow policy passed for ${workflows.size} workflows.\n`);
