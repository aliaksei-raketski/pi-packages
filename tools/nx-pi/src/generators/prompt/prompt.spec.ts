import { addProjectConfiguration, readJson, type Tree, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { promptGenerator } from './prompt';
import type { PromptGeneratorSchema } from './schema';

describe('prompt generator', () => {
  let tree: Tree;
  const options: PromptGeneratorSchema = {
    name: 'review-pr',
    project: '@scope/pi-demo',
    description: 'Review a pull request.',
    argumentHint: '<PR-URL>',
  };

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    setupPiPackageProject(tree);
  });

  it('creates a prompt template', async () => {
    await promptGenerator(tree, options);

    expect(tree.exists('packages/demo/prompts/review-pr.md')).toBe(true);
    expect(tree.read('packages/demo/prompts/review-pr.md', 'utf-8')).toContain(
      "argument-hint: '<PR-URL>'",
    );
    expect(tree.read('packages/demo/prompts/review-pr.md', 'utf-8')).toContain(
      'User arguments: $ARGUMENTS',
    );
  });

  it('registers prompts in the target Pi package', async () => {
    await promptGenerator(tree, options);

    const packageJson = readJson(tree, 'packages/demo/package.json');
    expect(packageJson).toMatchObject({
      pi: {
        prompts: ['./prompts'],
      },
      files: ['README.md', 'prompts'],
    });
    expect(packageJson.keywords).toEqual(expect.arrayContaining(['pi-package', 'pi', 'pi-prompt']));
  });

  it('rejects existing prompt files unless overwrite is enabled', async () => {
    await promptGenerator(tree, options);

    await expect(promptGenerator(tree, options)).rejects.toThrow(
      'Refusing to overwrite existing prompt files',
    );
    await expect(promptGenerator(tree, { ...options, overwrite: true })).resolves.toBeUndefined();
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
