import { formatFiles, generateFiles, joinPathFragments, type Tree } from '@nx/devkit';
import { join } from 'node:path';

import {
  addPiPackageResource,
  getPiPackageRoot,
  getPiResourceNames,
  toYamlString,
} from '../utils/pi-package';
import type { PromptGeneratorSchema } from './schema';

export async function promptGenerator(tree: Tree, options: PromptGeneratorSchema) {
  const projectRoot = getPiPackageRoot(tree, options.project);
  const resourceNames = getPiResourceNames(options.name, 'prompt');
  const description = options.description ?? `${resourceNames.className} prompt template.`;
  const argumentHint = options.argumentHint ?? '[instructions]';

  assertCanCreatePrompt(tree, projectRoot, resourceNames.name, !!options.overwrite);

  generateFiles(tree, join(__dirname, 'files'), projectRoot, {
    ...options,
    name: resourceNames.name,
    argumentHint,
    className: resourceNames.className,
    description,
    yamlArgumentHint: toYamlString(argumentHint),
    yamlDescription: toYamlString(description),
    tmpl: '',
  });

  addPiPackageResource(tree, projectRoot, 'prompts', './prompts');

  if (!options.skipFormat) {
    await formatFiles(tree);
  }
}

export default promptGenerator;

function assertCanCreatePrompt(
  tree: Tree,
  projectRoot: string,
  name: string,
  overwrite: boolean,
): void {
  assertCanCreateFiles(tree, [joinPathFragments(projectRoot, 'prompts', `${name}.md`)], overwrite);
}

function assertCanCreateFiles(tree: Tree, filePaths: string[], overwrite: boolean): void {
  const existingFiles = filePaths.filter((filePath) => tree.exists(filePath));
  if (overwrite || existingFiles.length === 0) {
    return;
  }

  throw new Error(
    `Refusing to overwrite existing prompt files:\n${existingFiles
      .map((filePath) => `- ${filePath}`)
      .join('\n')}\nPass --overwrite to replace them.`,
  );
}
