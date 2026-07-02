import {
  formatFiles,
  joinPathFragments,
  names,
  readJson,
  updateJson,
  workspaceRoot,
  type Tree,
} from '@nx/devkit';
import { promptWhenInteractive } from '@nx/devkit/internal';
import { libraryGenerator } from '@nx/js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { PackageGeneratorSchema } from './schema';

interface RepositoryMetadata {
  browserUrl?: string;
  packageJsonUrl: string;
}

interface NormalizedPackageOptions extends PackageGeneratorSchema {
  description: string;
  importPath: string;
  projectRoot: string;
  repository: RepositoryMetadata;
  unprefixedName: string;
}

interface GitRemote {
  name: string;
  url: string;
}

interface GitHubRepository {
  browserUrl: string;
  nameWithOwner: string;
}

interface ParsedRepositoryUrl {
  host: string;
  path: string;
  usesSshConfig: boolean;
}

const PACKAGE_NAME_MAX_LENGTH = 64;
const NPM_PACKAGE_MAX_LENGTH = 214;
const SAFE_PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const NPM_NAME_COMPONENT_PATTERN = /^[a-z0-9](?:[a-z0-9._~-]*[a-z0-9])?$/;

export async function packageGenerator(tree: Tree, options: PackageGeneratorSchema) {
  const normalizedOptions = await normalizeOptions(tree, options);

  const installTask = await libraryGenerator(tree, {
    directory: normalizedOptions.projectRoot,
    importPath: normalizedOptions.importPath,
    bundler: 'none',
    linter: 'none',
    unitTestRunner: 'none',
    useProjectJson: false,
    skipFormat: true,
  });

  tree.delete(joinPathFragments(normalizedOptions.projectRoot, 'src'));
  updateTypeScriptConfigs(tree, normalizedOptions.projectRoot);
  writeEslintConfig(tree, normalizedOptions.projectRoot);
  updatePackageJson(tree, normalizedOptions);
  writeReadme(tree, normalizedOptions);

  if (!options.skipFormat) {
    await formatFiles(tree);
  }

  return installTask;
}

export default packageGenerator;

async function normalizeOptions(
  tree: Tree,
  options: PackageGeneratorSchema,
): Promise<NormalizedPackageOptions> {
  const unprefixedName = normalizePackageName(options.name);
  const packageName = `pi-${unprefixedName}`;
  const npmScope = getWorkspaceNpmScope(tree);
  const projectRoot = normalizeProjectRoot(options.directory, unprefixedName);
  const importPath = validateNpmPackageName(
    options.importPath ?? (npmScope ? `${npmScope}/${packageName}` : packageName),
  );

  return {
    ...options,
    description: options.description ?? `Pi package for ${unprefixedName}.`,
    importPath,
    projectRoot,
    repository: await resolveRepositoryMetadata(options.repositoryUrl),
    unprefixedName,
  };
}

function normalizePackageName(name: string): string {
  const rawName = name.trim();

  if (!rawName) {
    throw new Error('Package name cannot be empty.');
  }

  if (/[/\\\0\r\n]/.test(rawName.replace(/^@[^/]+\//, ''))) {
    throw new Error(
      `Invalid package name "${name}". Package names must not contain path separators or control characters.`,
    );
  }

  const packageName = extractPackageName(rawName, name);
  const unprefixedName = packageName.replace(/^pi-/, '');
  if (!unprefixedName.trim()) {
    throw new Error(
      `Invalid package name "${name}". Package names must contain characters after normalization.`,
    );
  }

  const normalizedName = names(unprefixedName).fileName;
  assertValidPackageSlug(normalizedName, name);

  return normalizedName;
}

function extractPackageName(rawName: string, originalName: string): string {
  if (!rawName.startsWith('@')) {
    if (rawName.includes('/')) {
      throw new Error(
        `Invalid package name "${originalName}". Use an unscoped name or a valid scoped npm name such as @scope/pi-name.`,
      );
    }

    return rawName;
  }

  const parts = rawName.split('/');
  if (parts.length !== 2 || !parts[0].slice(1) || !parts[1]) {
    throw new Error(
      `Invalid package name "${originalName}". Scoped package names must look like @scope/pi-name.`,
    );
  }

  assertValidNpmNameComponent(parts[0].slice(1), originalName, 'scope');

  return parts[1];
}

function assertValidPackageSlug(normalizedName: string, originalName: string): void {
  if (normalizedName.length > PACKAGE_NAME_MAX_LENGTH) {
    throw new Error(
      `Invalid package name "${originalName}". Package names must be at most ${PACKAGE_NAME_MAX_LENGTH} characters after normalization.`,
    );
  }

  if (!SAFE_PACKAGE_NAME_PATTERN.test(normalizedName) || normalizedName.includes('--')) {
    throw new Error(
      `Invalid package name "${originalName}". Use lowercase letters, numbers, and single hyphens; no leading/trailing/consecutive hyphens.`,
    );
  }
}

function normalizeProjectRoot(directory: string | undefined, unprefixedName: string): string {
  if (directory !== undefined && !directory.trim()) {
    throw new Error('Package directory cannot be empty.');
  }

  const projectRoot = directory?.trim() ?? joinPathFragments('packages', unprefixedName);

  if (
    isAbsolute(projectRoot) ||
    /^[A-Za-z]:[\\/]/.test(projectRoot) ||
    projectRoot.includes('\\') ||
    /[\0\r\n]/.test(projectRoot)
  ) {
    throw new Error(
      `Invalid package directory "${directory}". Use a relative workspace path without control characters or backslashes.`,
    );
  }

  const segments = projectRoot.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(
      `Invalid package directory "${directory}". Directory segments must not be empty, ".", or "..".`,
    );
  }

  return joinPathFragments(...segments);
}

function validateNpmPackageName(packageName: string): string {
  const normalizedPackageName = packageName.trim();

  if (!normalizedPackageName) {
    throw new Error('Import path cannot be empty.');
  }

  if (normalizedPackageName.length > NPM_PACKAGE_MAX_LENGTH) {
    throw new Error(
      `Invalid import path "${packageName}". Npm package names must be at most ${NPM_PACKAGE_MAX_LENGTH} characters.`,
    );
  }

  if (/\s|\\|[\0\r\n]/.test(normalizedPackageName)) {
    throw new Error(
      `Invalid import path "${packageName}". Npm package names must not contain whitespace, backslashes, or control characters.`,
    );
  }

  if (normalizedPackageName.startsWith('@')) {
    const parts = normalizedPackageName.split('/');
    if (parts.length !== 2 || !parts[0].slice(1) || !parts[1]) {
      throw new Error(
        `Invalid import path "${packageName}". Scoped npm package names must look like @scope/name.`,
      );
    }

    assertValidNpmNameComponent(parts[0].slice(1), packageName, 'scope');
    assertValidNpmNameComponent(parts[1], packageName, 'package');

    return normalizedPackageName;
  }

  if (normalizedPackageName.includes('/')) {
    throw new Error(
      `Invalid import path "${packageName}". Unscoped npm package names must not contain slashes.`,
    );
  }

  assertValidNpmNameComponent(normalizedPackageName, packageName, 'package');

  return normalizedPackageName;
}

function assertValidNpmNameComponent(
  component: string,
  originalName: string,
  componentType: 'scope' | 'package',
): void {
  if (
    component === '.' ||
    component === '..' ||
    component.includes('..') ||
    !NPM_NAME_COMPONENT_PATTERN.test(component)
  ) {
    throw new Error(
      `Invalid import path "${originalName}". The npm ${componentType} name must be lowercase and contain only URL-safe package name characters.`,
    );
  }
}

function getWorkspaceNpmScope(tree: Tree): string | undefined {
  if (!tree.exists('package.json')) {
    return undefined;
  }

  const packageJson = readJson<{ name?: string }>(tree, 'package.json');
  return packageJson.name?.startsWith('@') ? packageJson.name.split('/')[0] : undefined;
}

async function resolveRepositoryMetadata(
  repositoryUrl: string | undefined,
): Promise<RepositoryMetadata> {
  const explicitRepositoryUrl = repositoryUrl?.trim();
  const gitRemoteUrl = explicitRepositoryUrl || (await resolveGitRemoteUrl());
  const githubRepository = parseGitHubRepository(gitRemoteUrl);

  if (githubRepository) {
    return toGitHubRepositoryMetadata(
      explicitRepositoryUrl
        ? githubRepository
        : (readGitHubCliRepository(githubRepository) ?? githubRepository),
    );
  }

  return {
    browserUrl: toBrowserUrl(gitRemoteUrl),
    packageJsonUrl: toPackageJsonRepositoryUrl(gitRemoteUrl),
  };
}

async function resolveGitRemoteUrl(): Promise<string> {
  const originUrl = readGitRemoteUrl('origin');
  if (originUrl) {
    return originUrl;
  }

  const remotes = readGitRemotes();
  if (remotes.length === 0) {
    throw new Error(
      'Could not find a git remote. Add an origin remote or pass --repositoryUrl=<git-url>.',
    );
  }

  const result = await promptWhenInteractive(
    {
      type: 'select',
      name: 'repositoryUrl',
      message: 'No git remote named "origin" was found. Which remote should package metadata use?',
      choices: remotes.map((remote) => ({
        name: remote.url,
        message: `${remote.name}: ${remote.url}`,
      })),
    },
    { repositoryUrl: undefined },
  );

  if (!result.repositoryUrl) {
    throw new Error(
      `Could not find a git remote named "origin". Available remotes:\n${remotes
        .map((remote) => `- ${remote.name}: ${remote.url}`)
        .join('\n')}\nPass --repositoryUrl=<git-url> to select one in non-interactive mode.`,
    );
  }

  return result.repositoryUrl;
}

function readGitRemoteUrl(remoteName: string): string | undefined {
  try {
    return execFileSync('git', ['remote', 'get-url', remoteName], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function readGitRemotes(): GitRemote[] {
  try {
    return unique(
      execFileSync('git', ['remote'], {
        cwd: workspaceRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\n')
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({ name, url: readGitRemoteUrl(name) }))
        .filter((remote): remote is GitRemote => !!remote.url),
    );
  } catch {
    return [];
  }
}

function parseGitHubRepository(gitRemoteUrl: string): GitHubRepository | undefined {
  const parsedUrl = parseRepositoryUrl(gitRemoteUrl);
  if (!parsedUrl) {
    return undefined;
  }

  const host = parsedUrl.usesSshConfig ? resolveSshHostName(parsedUrl.host) : parsedUrl.host;
  if (host !== 'github.com') {
    return undefined;
  }

  const [owner, repo, ...extraPath] = normalizeRepositoryPath(parsedUrl.path).split('/');
  if (!owner || !repo || extraPath.length > 0) {
    return undefined;
  }

  const nameWithOwner = `${owner}/${repo}`;
  return {
    browserUrl: `https://github.com/${nameWithOwner}`,
    nameWithOwner,
  };
}

function readGitHubCliRepository(repository: GitHubRepository): GitHubRepository | undefined {
  let rawMetadata: string;
  try {
    rawMetadata = execFileSync(
      'gh',
      ['repo', 'view', repository.nameWithOwner, '--json', 'url,sshUrl,nameWithOwner'],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      },
    );
  } catch {
    return undefined;
  }

  let parsedMetadata: unknown;
  try {
    parsedMetadata = JSON.parse(rawMetadata);
  } catch {
    return undefined;
  }

  if (!isPlainObject(parsedMetadata)) {
    return undefined;
  }

  const browserUrl =
    typeof parsedMetadata.url === 'string' ? normalizeBrowserUrl(parsedMetadata.url) : undefined;
  const nameWithOwner =
    typeof parsedMetadata.nameWithOwner === 'string' &&
    isValidGitHubNameWithOwner(parsedMetadata.nameWithOwner)
      ? parsedMetadata.nameWithOwner
      : (extractGitHubNameWithOwner(browserUrl) ?? repository.nameWithOwner);

  return {
    browserUrl: browserUrl ?? `https://github.com/${nameWithOwner}`,
    nameWithOwner,
  };
}

function toGitHubRepositoryMetadata(repository: GitHubRepository): RepositoryMetadata {
  const browserUrl = normalizeBrowserUrl(repository.browserUrl);
  return {
    browserUrl,
    packageJsonUrl: ensureGitSuffix(`git+${browserUrl}`),
  };
}

function parseRepositoryUrl(gitRemoteUrl: string): ParsedRepositoryUrl | undefined {
  const normalizedUrl = gitRemoteUrl.trim().replace(/^git\+/, '');
  if (!normalizedUrl) {
    return undefined;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalizedUrl)) {
    try {
      const url = new URL(normalizedUrl);
      return {
        host: url.hostname,
        path: url.pathname,
        usesSshConfig: url.protocol === 'ssh:' || url.protocol === 'git:',
      };
    } catch {
      return undefined;
    }
  }

  const scpLikeUrl = normalizedUrl.match(/^[^@:/]+@([^:]+):(.+)$/);
  if (scpLikeUrl?.[1] && scpLikeUrl[2]) {
    return {
      host: scpLikeUrl[1],
      path: scpLikeUrl[2],
      usesSshConfig: true,
    };
  }

  return undefined;
}

function toPackageJsonRepositoryUrl(gitRemoteUrl: string): string {
  const normalizedRemoteUrl = gitRemoteUrl.trim();
  if (normalizedRemoteUrl.startsWith('git+')) {
    return ensureGitSuffix(normalizedRemoteUrl);
  }

  const scpLikeUrl = normalizedRemoteUrl.match(/^([^@:/]+)@([^:]+):(.+)$/);
  if (scpLikeUrl?.[1] && scpLikeUrl[2] && scpLikeUrl[3]) {
    return ensureGitSuffix(`git+ssh://${scpLikeUrl[1]}@${scpLikeUrl[2]}/${scpLikeUrl[3]}`);
  }

  if (normalizedRemoteUrl.startsWith('http://') || normalizedRemoteUrl.startsWith('https://')) {
    return ensureGitSuffix(`git+${normalizedRemoteUrl}`);
  }

  if (normalizedRemoteUrl.startsWith('ssh://') || normalizedRemoteUrl.startsWith('git://')) {
    return ensureGitSuffix(`git+${normalizedRemoteUrl}`);
  }

  return normalizedRemoteUrl;
}

function toBrowserUrl(gitRemoteUrl: string): string | undefined {
  const normalizedUrl = gitRemoteUrl.trim().replace(/^git\+/, '');

  if (normalizedUrl.startsWith('http://') || normalizedUrl.startsWith('https://')) {
    return normalizeBrowserUrl(normalizedUrl);
  }

  const scpLikeUrl = normalizedUrl.match(/^[^@:/]+@([^:]+):(.+)$/);
  if (scpLikeUrl?.[1] && scpLikeUrl[2]) {
    return `https://${resolveSshHostName(scpLikeUrl[1])}/${normalizeRepositoryPath(scpLikeUrl[2])}`;
  }

  const sshUrl = normalizedUrl.match(/^(?:ssh|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  if (sshUrl?.[1] && sshUrl[2]) {
    return `https://${resolveSshHostName(sshUrl[1])}/${normalizeRepositoryPath(sshUrl[2])}`;
  }

  return undefined;
}

function resolveSshHostName(host: string): string {
  return readSshHostName(host) ?? host;
}

function readSshHostName(host: string): string | undefined {
  let sshConfig: string;
  try {
    sshConfig = readFileSync(join(homedir(), '.ssh', 'config'), 'utf8');
  } catch {
    return undefined;
  }

  let hostBlockMatches = false;
  for (const rawLine of sshConfig.split('\n')) {
    const line = normalizeSshConfigLine(rawLine);
    if (!line) {
      continue;
    }

    const [keyword = '', ...values] = line.split(/\s+/);
    const normalizedKeyword = keyword.toLowerCase();
    if (normalizedKeyword === 'host') {
      hostBlockMatches = values.some((pattern) => sshHostPatternMatches(pattern, host));
      continue;
    }

    if (hostBlockMatches && normalizedKeyword === 'hostname' && values[0]) {
      return values[0];
    }
  }

  return undefined;
}

function normalizeSshConfigLine(line: string): string {
  const trimmedLine = line.trim();
  if (!trimmedLine || trimmedLine.startsWith('#')) {
    return '';
  }

  return trimmedLine.replace(/\s+#.*$/, '').trim();
}

function sshHostPatternMatches(pattern: string, host: string): boolean {
  if (!pattern || pattern.startsWith('!')) {
    return false;
  }

  const escapedPattern = pattern.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  const regexPattern = escapedPattern.replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
  return new RegExp(`^${regexPattern}$`, 'i').test(host);
}

function normalizeRepositoryPath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

function normalizeBrowserUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

function extractGitHubNameWithOwner(browserUrl: string | undefined): string | undefined {
  if (!browserUrl) {
    return undefined;
  }

  const parsedUrl = parseRepositoryUrl(browserUrl);
  if (!parsedUrl || parsedUrl.host !== 'github.com') {
    return undefined;
  }

  const path = normalizeRepositoryPath(parsedUrl.path);
  return isValidGitHubNameWithOwner(path) ? path : undefined;
}

function isValidGitHubNameWithOwner(value: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(value);
}

function ensureGitSuffix(repositoryUrl: string): string {
  return repositoryUrl.endsWith('.git') ? repositoryUrl : `${repositoryUrl}.git`;
}

function updateTypeScriptConfigs(tree: Tree, projectRoot: string): void {
  updateProjectTypeScriptConfig(tree, projectRoot);
  updateLibraryTypeScriptConfig(tree, projectRoot);
}

function writeEslintConfig(tree: Tree, projectRoot: string): void {
  if (!tree.exists('eslint.config.mjs')) {
    return;
  }

  const rootImportPath = `${projectRoot
    .split('/')
    .map(() => '..')
    .join('/')}/eslint.config.mjs`;
  tree.write(
    joinPathFragments(projectRoot, 'eslint.config.mjs'),
    `import baseConfig from '${rootImportPath}';

export default [
  ...baseConfig,
  {
    ignores: ['**/out-tsc'],
  },
];
`,
  );
}

function updateProjectTypeScriptConfig(tree: Tree, projectRoot: string): void {
  const tsconfigPath = joinPathFragments(projectRoot, 'tsconfig.json');
  if (!tree.exists(tsconfigPath)) {
    return;
  }

  updateJson(tree, tsconfigPath, (json) => {
    json.compilerOptions ??= {};
    json.compilerOptions.module = 'nodenext';
    json.compilerOptions.moduleResolution = 'nodenext';

    return json;
  });
}

function updateLibraryTypeScriptConfig(tree: Tree, projectRoot: string): void {
  const tsconfigPath = joinPathFragments(projectRoot, 'tsconfig.lib.json');
  if (!tree.exists(tsconfigPath)) {
    return;
  }

  updateJson(tree, tsconfigPath, (json) => {
    json.compilerOptions ??= {};
    json.compilerOptions.rootDir = '.';
    json.compilerOptions.module = 'nodenext';
    json.compilerOptions.moduleResolution = 'nodenext';
    json.compilerOptions.emitDeclarationOnly = true;
    json.compilerOptions.allowImportingTsExtensions = true;
    json.compilerOptions.resolveJsonModule = true;
    json.include = unique([
      ...toStringArray(json.include),
      'package.json',
      'extensions/**/*.ts',
      'skills/**/*.ts',
      'prompts/**/*.ts',
      'themes/**/*.ts',
      'scripts/**/*.ts',
      '*.ts',
    ]);
    json.exclude = unique([
      ...toStringArray(json.exclude),
      'dist',
      'out-tsc',
      'vite.config.ts',
      'vite.config.mts',
      'vitest.config.ts',
      'vitest.config.mts',
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/*.test.tsx',
      '**/*.spec.tsx',
      '**/*.test.js',
      '**/*.spec.js',
      '**/*.test.jsx',
      '**/*.spec.jsx',
    ]);

    return json;
  });
}

function updatePackageJson(tree: Tree, options: NormalizedPackageOptions): void {
  updateJson(tree, joinPathFragments(options.projectRoot, 'package.json'), (json) => {
    delete json.private;
    delete json.main;
    delete json.types;
    delete json.exports;

    if (json.dependencies && Object.keys(json.dependencies).length === 0) {
      delete json.dependencies;
    }

    if (isPlainObject(json.nx)) {
      json.nx.sourceRoot = options.projectRoot;
    }

    return {
      ...json,
      name: options.importPath,
      version: json.version ?? '0.0.1',
      type: 'module',
      description: options.description,
      keywords: ['pi-package', 'pi', options.unprefixedName],
      license: 'MIT',
      ...(options.repository.browserUrl
        ? {
            homepage: `${options.repository.browserUrl}/tree/main/${options.projectRoot}`,
            bugs: {
              url: `${options.repository.browserUrl}/issues`,
            },
          }
        : {}),
      repository: {
        type: 'git',
        url: options.repository.packageJsonUrl,
        directory: options.projectRoot,
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
    };
  });
}

function writeReadme(tree: Tree, options: NormalizedPackageOptions): void {
  tree.write(
    joinPathFragments(options.projectRoot, 'README.md'),
    `# ${options.importPath}

${options.description}

## Install

\`\`\`sh
pi install npm:${options.importPath}
\`\`\`
`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
