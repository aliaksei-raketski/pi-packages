import { formatFiles, generateFiles, joinPathFragments, type Tree } from '@nx/devkit';
import { join } from 'node:path';

import {
  addPiPackageResource,
  getPiPackageRoot,
  getPiResourceNames,
  toYamlString,
} from '../utils/pi-package';
import type { SkillGeneratorSchema } from './schema';

export async function skillGenerator(tree: Tree, options: SkillGeneratorSchema) {
  const projectRoot = getPiPackageRoot(tree, options.project);
  const resourceNames = getPiResourceNames(options.name, 'skill');
  const description =
    options.description ??
    `${resourceNames.className} workflow helper. Use when a task needs ${resourceNames.name} guidance or scripts.`;

  assertCanCreateSkill(tree, projectRoot, resourceNames.name, !!options.overwrite);

  generateFiles(tree, join(__dirname, 'files'), projectRoot, {
    ...options,
    name: resourceNames.name,
    className: resourceNames.className,
    description,
    yamlDescription: toYamlString(description),
    yamlName: toYamlString(resourceNames.name),
    tmpl: '',
  });

  addPiPackageResource(tree, projectRoot, 'skills', './skills');

  if (!options.skipFormat) {
    await formatFiles(tree);
  }
}

export default skillGenerator;

function assertCanCreateSkill(
  tree: Tree,
  projectRoot: string,
  name: string,
  overwrite: boolean,
): void {
  assertCanCreateFiles(
    tree,
    [
      joinPathFragments(projectRoot, 'skills', name, 'SKILL.md'),
      joinPathFragments(projectRoot, 'skills', name, 'scripts', 'example.mjs'),
    ],
    overwrite,
  );
}

function assertCanCreateFiles(tree: Tree, filePaths: string[], overwrite: boolean): void {
  const existingFiles = filePaths.filter((filePath) => tree.exists(filePath));
  if (overwrite || existingFiles.length === 0) {
    return;
  }

  throw new Error(
    `Refusing to overwrite existing skill files:\n${existingFiles
      .map((filePath) => `- ${filePath}`)
      .join('\n')}\nPass --overwrite to replace them.`,
  );
}
