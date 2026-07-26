import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { workspaceRoot, type Tree } from '@nx/devkit';

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
  const configPaths = globSync(
    [
      'packages/*/{vite,vitest}.config.{js,mjs,ts,mts}',
      'tools/*/{vite,vitest}.config.{js,mjs,ts,mts}',
    ],
    { cwd: workspaceRoot },
  );
  for (const configPath of configPaths) {
    mkdirSync(join(root, dirname(configPath)), { recursive: true });
  }
  (tree as Tree & { root: string }).root = root;
  mirrorTreeWrites(tree, root);
  testWorkspaceRoots.add(root);
  return tree;
}

function mirrorTreeWrites(tree: Tree, root: string): void {
  const writeToTree = tree.write.bind(tree);

  tree.write = (filePath, content) => {
    writeToTree(filePath, content);
    const diskPath = join(root, filePath);
    mkdirSync(dirname(diskPath), { recursive: true });
    writeFileSync(diskPath, content);
  };
}

export function cleanupTestWorkspaceRoots(): void {
  for (const root of testWorkspaceRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  testWorkspaceRoots.clear();
}
