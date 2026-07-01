import { addProjectConfiguration, readJson, type Tree, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { skillGenerator } from './skill';
import type { SkillGeneratorSchema } from './schema';

describe('skill generator', () => {
  let tree: Tree;
  const options: SkillGeneratorSchema = {
    name: 'code-review',
    project: '@scope/pi-demo',
    description: 'Review code changes with a helper script.',
  };

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    setupPiPackageProject(tree);
  });

  it('creates a skill with a helper script', async () => {
    await skillGenerator(tree, options);

    expect(tree.exists('packages/demo/skills/code-review/SKILL.md')).toBe(true);
    expect(tree.exists('packages/demo/skills/code-review/scripts/example.mjs')).toBe(true);

    expect(tree.read('packages/demo/skills/code-review/SKILL.md', 'utf-8')).toContain(
      "description: 'Review code changes with a helper script.'",
    );
    expect(tree.read('packages/demo/skills/code-review/scripts/example.mjs', 'utf-8')).toContain(
      'Usage: node scripts/example.mjs [OPTIONS]',
    );
  });

  it('registers skills in the target Pi package', async () => {
    await skillGenerator(tree, options);

    const packageJson = readJson(tree, 'packages/demo/package.json');
    expect(packageJson).toMatchObject({
      pi: {
        skills: ['./skills'],
      },
      files: ['README.md', 'skills'],
    });
    expect(packageJson.keywords).toEqual(
      expect.arrayContaining(['pi-package', 'pi', 'pi-skill', 'agent-skills']),
    );
  });

  it('quotes frontmatter values', async () => {
    await skillGenerator(tree, {
      ...options,
      description: 'Review: code with "quotes"',
    });

    expect(tree.read('packages/demo/skills/code-review/SKILL.md', 'utf-8')).toContain(
      'description: \'Review: code with "quotes"\'',
    );
  });

  it('does not create a files allowlist when the package does not have one', async () => {
    writeJson(tree, 'packages/demo/package.json', {
      name: '@scope/pi-demo',
      type: 'module',
      pi: {},
    });

    await skillGenerator(tree, options);

    expect(readJson(tree, 'packages/demo/package.json').files).toBeUndefined();
  });

  it('rejects existing skill files unless overwrite is enabled', async () => {
    await skillGenerator(tree, options);

    await expect(skillGenerator(tree, options)).rejects.toThrow(
      'Refusing to overwrite existing skill files',
    );
    await expect(skillGenerator(tree, { ...options, overwrite: true })).resolves.toBeUndefined();
  });

  it('rejects unsafe resource names', async () => {
    await expect(skillGenerator(tree, { ...options, name: '../../evil' })).rejects.toThrow(
      'Invalid resource name',
    );
  });

  it('rejects non-Pi package projects', async () => {
    writeJson(tree, 'packages/demo/package.json', {
      name: '@scope/not-pi-demo',
    });

    await expect(skillGenerator(tree, options)).rejects.toThrow('is not a Pi package');
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
