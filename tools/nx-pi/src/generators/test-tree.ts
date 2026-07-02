import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Tree } from '@nx/devkit';

const testWorkspaceRoots = new Set<string>();

export function createTreeWithExistingWorkspaceRoot(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  const root = mkdtempSync(join(tmpdir(), 'nx-pi-tree-'));
  writeFileSync(join(root, '.prettierrc'), JSON.stringify({ singleQuote: true }));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@proj/source', dependencies: {}, devDependencies: {} }),
  );
  writeFileSync(
    join(root, 'nx.json'),
    JSON.stringify({
      affected: { defaultBase: 'main' },
      targetDefaults: { build: { cache: true }, lint: { cache: true } },
    }),
  );
  writeFileSync(
    join(root, 'tsconfig.base.json'),
    JSON.stringify({ compilerOptions: { paths: {} } }),
  );
  for (const projectRoot of ['packages/fast-mode', 'packages/statusline', 'tools/nx-pi']) {
    mkdirSync(join(root, projectRoot), { recursive: true });
  }
  (tree as Tree & { root: string }).root = root;
  testWorkspaceRoots.add(root);
  return tree;
}

export function cleanupTestWorkspaceRoots(): void {
  for (const root of testWorkspaceRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  testWorkspaceRoots.clear();
}
