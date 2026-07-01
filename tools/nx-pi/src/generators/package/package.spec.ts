import { readJson, type Tree, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { packageGenerator } from './package';
import type { PackageGeneratorSchema } from './schema';

describe('package generator', () => {
  let tree: Tree;
  const options: PackageGeneratorSchema = {
    name: 'demo',
    repositoryUrl: 'git@github.com:aliaksei-raketski/pi-packages.git',
  };

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'package.json', {
      name: '@aliaksei-raketski/pi-packages',
      private: true,
    });
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
      repository: {
        type: 'git',
        url: 'git+ssh://git@github.com/aliaksei-raketski/pi-packages.git',
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
