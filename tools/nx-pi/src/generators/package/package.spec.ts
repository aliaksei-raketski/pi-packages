import { readJson, type Tree, writeJson } from '@nx/devkit';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupTestWorkspaceRoots, createTreeWithExistingWorkspaceRoot } from '../test-tree';

import { packageGenerator } from './package';
import type { PackageGeneratorSchema } from './schema';

describe('package generator', () => {
  let tree: Tree;
  const options: PackageGeneratorSchema = {
    name: 'demo',
    repositoryUrl: 'git@github.com:aliaksei-raketski/pi-packages.git',
  };

  afterEach(() => {
    cleanupTestWorkspaceRoots();
  });

  beforeEach(() => {
    tree = createTreeWithExistingWorkspaceRoot();
    writeJson(tree, 'package.json', {
      name: '@aliaksei-raketski/pi-packages',
      private: true,
    });
    tree.write('eslint.config.mjs', 'export default [];\n');
  });

  it('scaffolds a publishable Pi package without default source files', async () => {
    await packageGenerator(tree, options);

    expect(tree.exists('packages/demo/package.json')).toBe(true);
    expect(tree.exists('packages/demo/src')).toBe(false);
    expect(tree.exists('packages/demo/src/index.ts')).toBe(false);
    expect(tree.exists('packages/demo/index.ts')).toBe(false);

    expect(readJson(tree, 'packages/demo/package.json')).toMatchObject({
      name: '@aliaksei-raketski/pi-demo',
      version: '0.0.1',
      type: 'module',
      description: 'Pi package for demo.',
      keywords: ['pi-package', 'pi', 'demo'],
      license: 'MIT',
      homepage: 'https://github.com/aliaksei-raketski/pi-packages/tree/main/packages/demo',
      bugs: {
        url: 'https://github.com/aliaksei-raketski/pi-packages/issues',
      },
      repository: {
        type: 'git',
        url: 'git+https://github.com/aliaksei-raketski/pi-packages.git',
        directory: 'packages/demo',
      },
      publishConfig: {
        access: 'public',
        registry: 'https://registry.npmjs.org/',
      },
      engines: {
        node: '>=18',
      },
      pi: {},
      files: ['README.md'],
    });
    expect(readJson(tree, 'packages/demo/package.json').private).toBeUndefined();
    expect(readJson(tree, 'packages/demo/package.json').dependencies).toBeUndefined();
    expect(tree.read('packages/demo/README.md', 'utf-8')).toContain(
      'pi install npm:@aliaksei-raketski/pi-demo',
    );
    expect(tree.read('packages/demo/eslint.config.mjs', 'utf-8')).toContain(
      '../../eslint.config.mjs',
    );
    expect(readJson(tree, 'packages/demo/tsconfig.json')).toMatchObject({
      compilerOptions: {
        module: 'nodenext',
        moduleResolution: 'nodenext',
      },
    });
    expect(readJson(tree, 'packages/demo/tsconfig.lib.json')).toMatchObject({
      compilerOptions: {
        rootDir: '.',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        emitDeclarationOnly: true,
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
      },
      include: expect.arrayContaining(['package.json', '*.ts', 'extensions/**/*.ts']),
    });
  });

  it('normalizes scoped and pi-prefixed package names', async () => {
    await packageGenerator(tree, {
      ...options,
      name: '@other/pi-fast-mode',
    });

    expect(tree.exists('packages/fast-mode/package.json')).toBe(true);
    expect(readJson(tree, 'packages/fast-mode/package.json')).toMatchObject({
      name: '@aliaksei-raketski/pi-fast-mode',
      keywords: ['pi-package', 'pi', 'fast-mode'],
    });
  });

  it('uses explicit description and import path', async () => {
    await packageGenerator(tree, {
      ...options,
      description: 'Custom package description.',
      importPath: '@custom/pi-demo',
    });

    expect(readJson(tree, 'packages/demo/package.json')).toMatchObject({
      name: '@custom/pi-demo',
      description: 'Custom package description.',
    });
    expect(tree.read('packages/demo/README.md', 'utf-8')).toContain(
      '# @custom/pi-demo\n\nCustom package description.',
    );
  });

  it('writes browser metadata for https repository URLs', async () => {
    await packageGenerator(tree, {
      ...options,
      repositoryUrl: 'https://github.com/owner/repo',
    });

    expect(readJson(tree, 'packages/demo/package.json')).toMatchObject({
      homepage: 'https://github.com/owner/repo/tree/main/packages/demo',
      bugs: {
        url: 'https://github.com/owner/repo/issues',
      },
      repository: {
        url: 'git+https://github.com/owner/repo.git',
      },
    });
  });

  it('normalizes GitHub SSH aliases from ssh config', async () => {
    const originalHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), 'nx-pi-home-'));
    try {
      mkdirSync(join(home, '.ssh'), { recursive: true });
      writeFileSync(join(home, '.ssh', 'config'), 'Host github-main\n  HostName github.com\n');
      process.env.HOME = home;

      await packageGenerator(tree, {
        ...options,
        repositoryUrl: 'git@github-main:owner/repo.git',
      });

      expect(readJson(tree, 'packages/demo/package.json')).toMatchObject({
        homepage: 'https://github.com/owner/repo/tree/main/packages/demo',
        bugs: {
          url: 'https://github.com/owner/repo/issues',
        },
        repository: {
          url: 'git+https://github.com/owner/repo.git',
        },
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps explicit repository URLs for unsupported remotes', async () => {
    await packageGenerator(tree, {
      ...options,
      repositoryUrl: 'ssh://git@git.example.test/team/repo.git',
    });

    expect(readJson(tree, 'packages/demo/package.json')).toMatchObject({
      homepage: 'https://git.example.test/team/repo/tree/main/packages/demo',
      bugs: {
        url: 'https://git.example.test/team/repo/issues',
      },
      repository: {
        url: 'git+ssh://git@git.example.test/team/repo.git',
      },
    });
  });

  it('rejects unsafe package names and directories', async () => {
    await expect(packageGenerator(tree, { ...options, name: '../evil' })).rejects.toThrow(
      'Invalid package name',
    );
    await expect(packageGenerator(tree, { ...options, name: 'pi-' })).rejects.toThrow(
      'Invalid package name',
    );
    await expect(packageGenerator(tree, { ...options, directory: '' })).rejects.toThrow(
      'Package directory cannot be empty',
    );
    await expect(packageGenerator(tree, { ...options, directory: '..' })).rejects.toThrow(
      'Invalid package directory',
    );
    await expect(packageGenerator(tree, { ...options, directory: '/tmp/pi-demo' })).rejects.toThrow(
      'Invalid package directory',
    );
  });

  it('rejects invalid npm import paths', async () => {
    await expect(
      packageGenerator(tree, { ...options, importPath: '@Bad/pi-demo' }),
    ).rejects.toThrow('Invalid import path');
    await expect(
      packageGenerator(tree, { ...options, importPath: '@scope/../demo' }),
    ).rejects.toThrow('Invalid import path');
  });
});
