import {
  joinPathFragments,
  names,
  readJson,
  readProjectConfiguration,
  updateJson,
  type Tree,
} from '@nx/devkit';

export type PiResourceType = 'extensions' | 'skills' | 'prompts' | 'themes';

export interface PiResourceNames {
  name: string;
  className: string;
  propertyName: string;
}

const BASE_KEYWORDS = ['pi-package', 'pi'];
const RESOURCE_KEYWORDS: Record<PiResourceType, string[]> = {
  extensions: ['pi-extension'],
  skills: ['pi-skill', 'agent-skills'],
  prompts: ['pi-prompt'],
  themes: ['pi-theme'],
};

const RESOURCE_NAME_MAX_LENGTH = 64;
const SAFE_RESOURCE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const RESERVED_IDENTIFIER_WORDS = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
]);

export function getPiPackageRoot(tree: Tree, project: string): string {
  let projectRoot: string;

  try {
    projectRoot = readProjectConfiguration(tree, project).root;
  } catch (error) {
    throw new Error(
      `Could not find project "${project}". Pass an existing Pi package project with --project=<project>.`,
      { cause: error },
    );
  }

  const packageJsonPath = joinPathFragments(projectRoot, 'package.json');
  if (!tree.exists(packageJsonPath)) {
    throw new Error(`Project "${project}" must contain a package.json at ${packageJsonPath}.`);
  }

  const packageJson = readJson<{ pi?: unknown }>(tree, packageJsonPath);
  if (!isPlainObject(packageJson.pi)) {
    throw new Error(
      `Project "${project}" is not a Pi package. Expected ${packageJsonPath} to contain a "pi" object. Use the @org/nx-pi:package generator to create Pi packages.`,
    );
  }

  return projectRoot;
}

export function getPiResourceNames(name: string, identifierPrefix = 'resource'): PiResourceNames {
  const normalizedName = normalizeResourceName(name);
  const normalizedNames = names(normalizedName);
  const fallbackPropertyName = `${identifierPrefix}${normalizedNames.className}`;

  return {
    name: normalizedName,
    className: normalizedNames.className,
    propertyName: toSafeIdentifier(normalizedNames.propertyName, fallbackPropertyName),
  };
}

export function normalizeResourceName(name: string): string {
  const trimmedName = name.trim();

  if (!trimmedName) {
    throw new Error('Resource name cannot be empty.');
  }

  if (
    trimmedName.includes('..') ||
    trimmedName.includes('/') ||
    trimmedName.includes('\\') ||
    /[\0\r\n]/.test(trimmedName)
  ) {
    throw new Error(
      `Invalid resource name "${name}". Resource names must not contain path separators, control characters, or "..".`,
    );
  }

  const normalizedName = names(trimmedName).fileName;
  assertValidResourceName(normalizedName, name);

  return normalizedName;
}

export function addPiPackageResource(
  tree: Tree,
  projectRoot: string,
  resourceType: PiResourceType,
  resourcePath: `./${string}`,
): void {
  updateJson(tree, joinPathFragments(projectRoot, 'package.json'), (json) => {
    json.pi ??= {};
    json.pi[resourceType] = unique([...toStringArray(json.pi[resourceType]), resourcePath]);

    if (Array.isArray(json.files)) {
      json.files = unique([...toStringArray(json.files), toPackageFilesEntry(resourcePath)]);
    }

    json.keywords = unique([
      ...toStringArray(json.keywords),
      ...BASE_KEYWORDS,
      ...RESOURCE_KEYWORDS[resourceType],
    ]);

    return json;
  });
}

export function toYamlString(value: string): string {
  return JSON.stringify(value);
}

function assertValidResourceName(normalizedName: string, originalName: string): void {
  if (normalizedName.length > RESOURCE_NAME_MAX_LENGTH) {
    throw new Error(
      `Invalid resource name "${originalName}". Resource names must be at most ${RESOURCE_NAME_MAX_LENGTH} characters after normalization.`,
    );
  }

  if (!SAFE_RESOURCE_NAME_PATTERN.test(normalizedName) || normalizedName.includes('--')) {
    throw new Error(
      `Invalid resource name "${originalName}". Use lowercase letters, numbers, and single hyphens; no leading/trailing/consecutive hyphens.`,
    );
  }
}

function toSafeIdentifier(identifier: string, fallbackIdentifier: string): string {
  if (isSafeIdentifier(identifier)) {
    return identifier;
  }

  return isSafeIdentifier(fallbackIdentifier) ? fallbackIdentifier : 'resource';
}

function isSafeIdentifier(identifier: string): boolean {
  return (
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(identifier) && !RESERVED_IDENTIFIER_WORDS.has(identifier)
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

function toPackageFilesEntry(resourcePath: `./${string}`): string {
  return resourcePath.replace(/^\.\//, '').split('/')[0];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
