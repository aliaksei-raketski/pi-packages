import { addProjectConfiguration, readJson, type Tree, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { themeGenerator } from './theme';
import type { ThemeGeneratorSchema } from './schema';

describe('theme generator', () => {
  let tree: Tree;
  const options: ThemeGeneratorSchema = {
    name: 'solarized-dark',
    project: '@scope/pi-demo',
  };

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    setupPiPackageProject(tree);
  });

  it('creates a theme file', async () => {
    await themeGenerator(tree, options);

    expect(tree.exists('packages/demo/themes/solarized-dark.json')).toBe(true);
    expect(readJson(tree, 'packages/demo/themes/solarized-dark.json')).toMatchObject({
      name: 'solarized-dark',
      colors: expect.objectContaining({
        accent: 'primary',
      }),
    });
  });

  it('registers themes in the target Pi package', async () => {
    await themeGenerator(tree, options);

    const packageJson = readJson(tree, 'packages/demo/package.json');
    expect(packageJson).toMatchObject({
      pi: {
        themes: ['./themes'],
      },
      files: ['README.md', 'themes'],
    });
    expect(packageJson.keywords).toEqual(expect.arrayContaining(['pi-package', 'pi', 'pi-theme']));
  });

  it('rejects existing theme files unless overwrite is enabled', async () => {
    await themeGenerator(tree, options);

    await expect(themeGenerator(tree, options)).rejects.toThrow(
      'Refusing to overwrite existing theme files',
    );
    await expect(themeGenerator(tree, { ...options, overwrite: true })).resolves.toBeUndefined();
  });
});

function setupPiPackageProject(tree: Tree): void {
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
}
