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

const ci = workflows.get('ci.yml');
assert.ok(ci, 'ci.yml must exist');
assert.equal(workflows.has('release.yml'), false, 'release must be an inline ci.yml job');
assert.equal(workflows.has('publish-npm.yml'), false, 'publish must be an inline ci.yml job');
assert.match(ci, /^\s{2}ci:\n\s{4}name:\s*CI$/mu);
assert.match(ci, /^\s{2}release:\n\s{4}name:\s*Release$/mu);
assert.match(ci, /^\s{2}publish:\n\s{4}name:\s*Publish$/mu);
assert.match(ci, /needs:\s*ci/u);
assert.match(ci, /needs:\s*release/u);
assert.match(ci, /github\.event_name == 'push'/u);
assert.match(ci, /id-token:\s*write/u);
assert.match(ci, /^\s{4}environment:\s*npm$/mu);
assert.doesNotMatch(ci, /actions:\s*write/u);
assert.match(ci, /ref: \$\{\{ github\.sha \}\}/u);
assert.match(ci, /ref: \$\{\{ needs\.release\.outputs\.release_sha \}\}/u);
assert.match(ci, /git merge-base --is-ancestor "\$CI_SHA" "\$RELEASE_SHA"/u);
assert.match(ci, /git merge-base --is-ancestor "\$RELEASE_SHA" origin\/main/u);
assert.match(ci, /git tag --points-at "\$RELEASE_SHA"/u);
assert.match(ci, /NPM_CONFIG_PROVENANCE:\s*'true'/u);
assert.match(ci, /pnpm nx release publish/u);
assert.equal([...ci.matchAll(/pnpm run test:ci/gu)].length, 1, 'CI tests must run exactly once');
assert.doesNotMatch(ci, /pnpm run test(?!:ci)/u);

process.stdout.write(`Workflow policy passed for ${workflows.size} workflows.\n`);
