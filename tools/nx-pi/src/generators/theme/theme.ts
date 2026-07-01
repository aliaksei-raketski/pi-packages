import { formatFiles, generateFiles, joinPathFragments, type Tree } from '@nx/devkit';
import { join } from 'node:path';

import { addPiPackageResource, getPiPackageRoot, getPiResourceNames } from '../utils/pi-package';
import type { ThemeGeneratorSchema } from './schema';

export async function themeGenerator(tree: Tree, options: ThemeGeneratorSchema) {
  const projectRoot = getPiPackageRoot(tree, options.project);
  const resourceNames = getPiResourceNames(options.name, 'theme');

  assertCanCreateTheme(tree, projectRoot, resourceNames.name, !!options.overwrite);

  generateFiles(tree, join(__dirname, 'files'), projectRoot, {
    ...options,
    name: resourceNames.name,
    className: resourceNames.className,
    tmpl: '',
  });

  addPiPackageResource(tree, projectRoot, 'themes', './themes');

  if (!options.skipFormat) {
    await formatFiles(tree);
  }
}

export default themeGenerator;

function assertCanCreateTheme(
  tree: Tree,
  projectRoot: string,
  name: string,
  overwrite: boolean,
): void {
  assertCanCreateFiles(tree, [joinPathFragments(projectRoot, 'themes', `${name}.json`)], overwrite);
}

function assertCanCreateFiles(tree: Tree, filePaths: string[], overwrite: boolean): void {
  const existingFiles = filePaths.filter((filePath) => tree.exists(filePath));
  if (overwrite || existingFiles.length === 0) {
    return;
  }

  throw new Error(
    `Refusing to overwrite existing theme files:\n${existingFiles
      .map((filePath) => `- ${filePath}`)
      .join('\n')}\nPass --overwrite to replace them.`,
  );
}
