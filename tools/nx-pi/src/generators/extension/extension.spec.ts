import { addProjectConfiguration, readJson, type Tree, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { extensionGenerator } from './extension';
import type { ExtensionGeneratorSchema } from './schema';

describe('extension generator', () => {
  let tree: Tree;
  const options: ExtensionGeneratorSchema = {
    name: 'hello-world',
    project: '@scope/pi-demo',
  };

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    setupPiPackageProject(tree);
  });

  it('creates an extension with source, test, and entrypoint files', async () => {
    await extensionGenerator(tree, options);

    expect(tree.exists('packages/demo/extensions/hello-world/index.ts')).toBe(true);
    expect(tree.exists('packages/demo/extensions/hello-world/src/hello-world.ts')).toBe(true);
    expect(tree.exists('packages/demo/extensions/hello-world/test/hello-world.spec.ts')).toBe(true);

    expect(tree.read('packages/demo/extensions/hello-world/index.ts', 'utf-8')).toContain(
      "export { helloWorld as default } from './src/hello-world.ts';",
    );
    expect(tree.read('packages/demo/extensions/hello-world/src/hello-world.ts', 'utf-8')).toContain(
      'export function helloWorld(pi: ExtensionAPI)',
    );
    expect(
      tree.read('packages/demo/extensions/hello-world/test/hello-world.spec.ts', 'utf-8'),
    ).toContain("import { helloWorld } from '../src/hello-world.ts';");
  });

  it('configures Vitest and TypeScript for extension tests', async () => {
    await extensionGenerator(tree, options);

    expect(tree.exists('packages/demo/vitest.config.mts')).toBe(true);
    expect(tree.read('packages/demo/vitest.config.mts', 'utf-8')).toContain(
      'extensions/**/test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
    );
    expect(readJson(tree, 'packages/demo/tsconfig.lib.json')).toMatchObject({
      compilerOptions: {
        rootDir: '.',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        emitDeclarationOnly: true,
        allowImportingTsExtensions: true,
      },
      include: expect.arrayContaining(['extensions/**/*.ts']),
    });
    expect(readJson(tree, 'packages/demo/tsconfig.spec.json')).toMatchObject({
      compilerOptions: {
        allowImportingTsExtensions: true,
      },
      references: [{ path: './tsconfig.lib.json' }],
    });
  });

  it('patches an existing Vitest config include list', async () => {
    writeJson(tree, 'packages/demo/tsconfig.spec.json', {
      extends: './tsconfig.json',
      compilerOptions: {},
      include: ['src/**/*.spec.ts'],
    });
    tree.write(
      'packages/demo/vitest.config.mts',
      `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
`,
    );

    await extensionGenerator(tree, options);

    expect(tree.read('packages/demo/vitest.config.mts', 'utf-8')).toContain('src/**/*.spec.ts');
    expect(tree.read('packages/demo/vitest.config.mts', 'utf-8')).toContain(
      'extensions/**/test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
    );
  });

  it('registers extensions and the Pi peer dependency', async () => {
    await extensionGenerator(tree, options);

    const packageJson = readJson(tree, 'packages/demo/package.json');
    expect(packageJson).toMatchObject({
      pi: {
        extensions: ['./extensions'],
      },
      files: ['README.md', 'extensions'],
      peerDependencies: {
        '@earendil-works/pi-coding-agent': '*',
      },
    });
    expect(packageJson.keywords).toEqual(
      expect.arrayContaining(['pi-package', 'pi', 'pi-extension']),
    );
  });

  it('adds required test and Pi dependencies to the workspace root only', async () => {
    await extensionGenerator(tree, options);

    expect(readJson(tree, 'package.json')).toMatchObject({
      devDependencies: {
        '@earendil-works/pi-coding-agent': '*',
        '@nx/vitest': expect.any(String),
        '@vitest/coverage-v8': '~4.1.0',
        vitest: '~4.1.0',
      },
    });
    expect(readJson(tree, 'packages/demo/package.json').dependencies).toBeUndefined();
    expect(readJson(tree, 'nx.json').plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ plugin: '@nx/vitest' })]),
    );
  });

  it('creates a safe named export for reserved words', async () => {
    await extensionGenerator(tree, { ...options, name: 'class' });

    expect(tree.read('packages/demo/extensions/class/index.ts', 'utf-8')).toContain(
      "export { extensionClass as default } from './src/class.ts';",
    );
    expect(tree.read('packages/demo/extensions/class/src/class.ts', 'utf-8')).toContain(
      'export function extensionClass(pi: ExtensionAPI)',
    );
  });

  it('rejects existing extension files unless overwrite is enabled', async () => {
    await extensionGenerator(tree, options);

    await expect(extensionGenerator(tree, options)).rejects.toThrow(
      'Refusing to overwrite existing extension files',
    );
    await expect(extensionGenerator(tree, { ...options, overwrite: true })).resolves.toBeDefined();
  });

  it('rejects unsafe resource names', async () => {
    await expect(extensionGenerator(tree, { ...options, name: '../../evil' })).rejects.toThrow(
      'Invalid resource name',
    );
  });

  it('rejects non-Pi package projects', async () => {
    writeJson(tree, 'packages/demo/package.json', {
      name: '@scope/not-pi-demo',
    });

    await expect(extensionGenerator(tree, options)).rejects.toThrow('is not a Pi package');
  });
});

function setupPiPackageProject(tree: Tree): void {
  writeJson(tree, 'package.json', {
    name: '@scope/workspace',
    private: true,
  });
  addProjectConfiguration(tree, '@scope/pi-demo', {
    root: 'packages/demo',
    projectType: 'library',
    targets: {},
  });
  writeJson(tree, 'packages/demo/package.json', {
    name: '@scope/pi-demo',
    type: 'module',
    pi: {},
    files: ['README.md'],
  });
  writeJson(tree, 'packages/demo/tsconfig.json', {
    extends: '../../tsconfig.base.json',
    files: [],
    include: [],
    references: [{ path: './tsconfig.lib.json' }],
  });
  writeJson(tree, 'packages/demo/tsconfig.lib.json', {
    extends: './tsconfig.json',
    compilerOptions: {
      outDir: '../../dist/out-tsc',
      rootDir: '.',
    },
    include: ['*.ts'],
  });
}
