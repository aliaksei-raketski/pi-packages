import {
  addDependenciesToPackageJson,
  formatFiles,
  generateFiles,
  joinPathFragments,
  logger,
  offsetFromRoot,
  readJson,
  readNxJson,
  runTasksInSerial,
  updateJson,
  updateNxJson,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { configurationGenerator } from '@nx/vitest/generators';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { addPiPackageResource, getPiPackageRoot, getPiResourceNames } from '../utils/pi-package';
import type { ExtensionGeneratorSchema } from './schema';

const PI_CODING_AGENT_PACKAGE = '@earendil-works/pi-coding-agent';
const EXTENSION_TEST_INCLUDE =
  'extensions/**/test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}';
const requireFromGenerator = createRequire(__filename);

export async function extensionGenerator(tree: Tree, options: ExtensionGeneratorSchema) {
  const projectRoot = getPiPackageRoot(tree, options.project);
  const resourceNames = getPiResourceNames(options.name, 'extension');
  const packageName = readJson<{ name?: string }>(
    tree,
    joinPathFragments(projectRoot, 'package.json'),
  ).name;
  const projectName = packageName ?? options.project;
  const tasks: GeneratorCallback[] = [];

  assertCanCreateExtension(tree, projectRoot, resourceNames.name, !!options.overwrite);

  const vitestTask = await ensureVitest(tree, options.project, projectRoot, projectName);
  if (vitestTask) {
    tasks.push(vitestTask);
  }
  tasks.push(ensureVitestWorkspaceSupport(tree));

  generateFiles(tree, join(__dirname, 'files'), projectRoot, {
    ...options,
    name: resourceNames.name,
    className: resourceNames.className,
    propertyName: resourceNames.propertyName,
    tmpl: '',
  });

  addPiPackageResource(tree, projectRoot, 'extensions', './extensions');
  addPiExtensionPeerDependency(tree, projectRoot);
  tasks.push(addPiCodingAgentDevDependency(tree));
  updateTypeScriptLibConfig(tree, projectRoot);
  updateTypeScriptSpecConfig(tree, projectRoot);
  ensureVitestConfig(tree, projectRoot, projectName);

  if (!options.skipFormat) {
    await formatFiles(tree);
  }

  return runTasksInSerial(...tasks);
}

export default extensionGenerator;

async function ensureVitest(
  tree: Tree,
  project: string,
  projectRoot: string,
  projectName: string,
): Promise<GeneratorCallback | undefined> {
  const vitestConfigPath = joinPathFragments(projectRoot, 'vitest.config.mts');
  const tsconfigSpecPath = joinPathFragments(projectRoot, 'tsconfig.spec.json');

  if (tree.exists(vitestConfigPath) && tree.exists(tsconfigSpecPath)) {
    return undefined;
  }

  const task = await configurationGenerator(tree, {
    project,
    uiFramework: 'none',
    testEnvironment: 'node',
    coverageProvider: 'v8',
    compiler: 'babel',
    runtimeTsconfigFileName: 'tsconfig.lib.json',
    addPlugin: true,
    skipViteConfig: true,
    skipFormat: true,
  });

  ensureVitestConfig(tree, projectRoot, projectName);

  return task;
}

function ensureVitestConfig(tree: Tree, projectRoot: string, projectName: string): void {
  const vitestConfigPath = joinPathFragments(projectRoot, 'vitest.config.mts');
  if (!tree.exists(vitestConfigPath)) {
    tree.write(
      vitestConfigPath,
      `import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '${joinPathFragments(
    offsetFromRoot(projectRoot),
    'node_modules/.vite',
    projectRoot === '.' ? projectName : projectRoot,
  )}',
  test: {
    name: '${projectName}',
    watch: false,
    globals: true,
    environment: 'node',
    include: [
      '${EXTENSION_TEST_INCLUDE}',
    ],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
`,
    );
    return;
  }

  const currentConfig = tree.read(vitestConfigPath, 'utf-8');
  if (!currentConfig || currentConfig.includes(EXTENSION_TEST_INCLUDE)) {
    return;
  }

  const updatedConfig = addExtensionIncludeToVitestConfig(currentConfig);
  if (updatedConfig === currentConfig) {
    logger.warn(
      `Could not automatically add ${EXTENSION_TEST_INCLUDE} to ${vitestConfigPath}. Add it to test.include so generated extension tests run.`,
    );
    return;
  }

  tree.write(vitestConfigPath, updatedConfig);
}

function addExtensionIncludeToVitestConfig(config: string): string {
  const includeArrayPattern = /include\s*:\s*\[([\s\S]*?)\]/m;
  if (includeArrayPattern.test(config)) {
    return config.replace(includeArrayPattern, (match, entries: string) =>
      appendEntryToIncludeArray(match, entries, `'${EXTENSION_TEST_INCLUDE}'`),
    );
  }

  const testBlockPattern = /test\s*:\s*\{/m;
  if (testBlockPattern.test(config)) {
    return config.replace(
      testBlockPattern,
      (match) => `${match}\n    include: ['${EXTENSION_TEST_INCLUDE}'],`,
    );
  }

  return config;
}

function appendEntryToIncludeArray(match: string, entries: string, entry: string): string {
  if (!match.includes('\n')) {
    const trimmedEntries = entries.trim();
    const separator = trimmedEntries.endsWith(',') ? ' ' : ', ';
    return `include: [${trimmedEntries}${trimmedEntries ? separator : ''}${entry}]`;
  }

  const closingIndent = match.match(/\n(\s*)\]$/)?.[1] ?? '    ';
  const entryIndent = `${closingIndent}  `;
  const trimmedEntries = entries.trimEnd();
  const separator = trimmedEntries.trim()
    ? trimmedEntries.trimEnd().endsWith(',')
      ? '\n'
      : ',\n'
    : '\n';

  return `include: [${trimmedEntries}${separator}${entryIndent}${entry},\n${closingIndent}]`;
}

function updateTypeScriptLibConfig(tree: Tree, projectRoot: string): void {
  const tsconfigLibPath = joinPathFragments(projectRoot, 'tsconfig.lib.json');
  if (!tree.exists(tsconfigLibPath)) {
    return;
  }

  updateJson(tree, tsconfigLibPath, (json) => {
    json.compilerOptions ??= {};
    json.compilerOptions.rootDir = '.';
    json.compilerOptions.module = 'nodenext';
    json.compilerOptions.moduleResolution = 'nodenext';
    json.compilerOptions.emitDeclarationOnly = true;
    json.compilerOptions.allowImportingTsExtensions = true;
    json.include = unique([...toStringArray(json.include), 'extensions/**/*.ts']);
    json.exclude = unique([
      ...toStringArray(json.exclude),
      'extensions/**/*.test.ts',
      'extensions/**/*.spec.ts',
      'extensions/**/*.test.tsx',
      'extensions/**/*.spec.tsx',
      'extensions/**/*.test.js',
      'extensions/**/*.spec.js',
      'extensions/**/*.test.jsx',
      'extensions/**/*.spec.jsx',
    ]);

    return json;
  });
}

function updateTypeScriptSpecConfig(tree: Tree, projectRoot: string): void {
  const tsconfigSpecPath = joinPathFragments(projectRoot, 'tsconfig.spec.json');
  if (!tree.exists(tsconfigSpecPath)) {
    return;
  }

  updateJson(tree, tsconfigSpecPath, (json) => {
    json.compilerOptions ??= {};
    json.compilerOptions.allowImportingTsExtensions = true;
    json.references = addReference(json.references, './tsconfig.lib.json');
    json.include = unique([
      ...toStringArray(json.include),
      'extensions/**/*.test.ts',
      'extensions/**/*.spec.ts',
      'extensions/**/*.test.tsx',
      'extensions/**/*.spec.tsx',
      'extensions/**/*.test.js',
      'extensions/**/*.spec.js',
      'extensions/**/*.test.jsx',
      'extensions/**/*.spec.jsx',
      'extensions/**/*.d.ts',
    ]);

    return json;
  });
}

function addPiExtensionPeerDependency(tree: Tree, projectRoot: string): void {
  updateJson(tree, joinPathFragments(projectRoot, 'package.json'), (json) => {
    json.peerDependencies = {
      ...json.peerDependencies,
      [PI_CODING_AGENT_PACKAGE]: '*',
    };

    return json;
  });
}

function addPiCodingAgentDevDependency(tree: Tree): GeneratorCallback {
  return addDependenciesToPackageJson(
    tree,
    {},
    { [PI_CODING_AGENT_PACKAGE]: '*' },
    undefined,
    true,
  );
}

function ensureVitestWorkspaceSupport(tree: Tree): GeneratorCallback {
  ensureVitestNxPlugin(tree);

  return addDependenciesToPackageJson(
    tree,
    {},
    {
      '@nx/vitest': getInstalledPackageVersion('@nx/vitest', '23.0.1'),
      '@vitest/coverage-v8': '~4.1.0',
      vitest: '~4.1.0',
    },
    undefined,
    true,
  );
}

function ensureVitestNxPlugin(tree: Tree): void {
  const nxJson = readNxJson(tree) ?? {};
  const plugins = Array.isArray(nxJson.plugins) ? nxJson.plugins : [];
  const hasVitestPlugin = plugins.some((plugin) =>
    typeof plugin === 'string' ? plugin === '@nx/vitest' : plugin.plugin === '@nx/vitest',
  );

  if (hasVitestPlugin) {
    return;
  }

  nxJson.plugins = [
    ...plugins,
    {
      plugin: '@nx/vitest',
      options: {
        testTargetName: 'test',
        ciTargetName: 'test-ci',
        testMode: 'watch',
      },
    },
  ];
  updateNxJson(tree, nxJson);
}

function getInstalledPackageVersion(packageName: string, fallbackVersion: string): string {
  try {
    return (
      (requireFromGenerator(`${packageName}/package.json`) as { version?: string }).version ??
      fallbackVersion
    );
  } catch {
    return fallbackVersion;
  }
}

function assertCanCreateExtension(
  tree: Tree,
  projectRoot: string,
  name: string,
  overwrite: boolean,
): void {
  assertCanCreateFiles(
    tree,
    [
      joinPathFragments(projectRoot, 'extensions', name, 'index.ts'),
      joinPathFragments(projectRoot, 'extensions', name, 'src', `${name}.ts`),
      joinPathFragments(projectRoot, 'extensions', name, 'test', `${name}.spec.ts`),
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
    `Refusing to overwrite existing extension files:\n${existingFiles
      .map((filePath) => `- ${filePath}`)
      .join('\n')}\nPass --overwrite to replace them.`,
  );
}

function addReference(value: unknown, referencePath: string): { path: string }[] {
  const references = Array.isArray(value)
    ? value.filter(
        (entry): entry is { path: string } =>
          !!entry && typeof entry === 'object' && 'path' in entry && typeof entry.path === 'string',
      )
    : [];

  return references.some((entry) => entry.path === referencePath)
    ? references
    : [...references, { path: referencePath }];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
