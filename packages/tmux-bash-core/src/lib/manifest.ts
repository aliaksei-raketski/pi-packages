import { isAbsolute, relative, resolve, sep } from 'node:path';

import { MANAGED_RUN_MANIFEST_FIELDS, MAX_MANIFEST_DISPLAY_COMMAND_BYTES } from './constants.js';
import type { TmuxWorkspaceScope } from './scope.js';

export type CompletionDelivery = 'model' | 'display' | 'next-turn';
export type ManagedRunState =
  | 'reserved'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'orphaned';
export type CompletionDeliveryState = 'pending' | 'queued' | 'delivered' | 'persisted' | 'failed';

export interface ManagedRunManifest {
  runId: string;
  completionId: string;
  piSessionId: string;
  scope: Pick<TmuxWorkspaceScope, 'kind' | 'root' | 'hash'>;
  cwd: string;
  tmuxSession: string;
  windowId?: string;
  commandFile: string;
  scriptFile: string;
  outputFile: string;
  exitCodeFile: string;
  displayCommand: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  mode: 'foreground' | 'background';
  state: ManagedRunState;
  awaited: boolean;
  continuationDomain: string;
  completionDelivery: CompletionDelivery;
  deliveryState: CompletionDeliveryState;
  polling?: { intervalSeconds: number; lines: number };
  outputWasRotated: boolean;
  updatedAt: number;
}

export interface ParseManagedRunManifestOptions {
  artifactRoot: string;
  expectedRunId?: string;
}

export function isManagedRunManifest(value: unknown): value is ManagedRunManifest {
  try {
    parseManagedRunManifest(value, { artifactRoot: '/' });
    return true;
  } catch {
    return false;
  }
}

export function parseManagedRunManifest(
  value: unknown,
  options: ParseManagedRunManifestOptions,
): ManagedRunManifest {
  if (!isRecord(value)) throw new Error('Managed run manifest must be an object.');
  rejectUnexpectedFields(value);
  assertAbsoluteSafePath(options.artifactRoot, 'artifact root');

  const runId = requireIdentifier(value.runId, 'runId');
  if (options.expectedRunId !== undefined && runId !== options.expectedRunId) {
    throw new Error('Managed run manifest runId does not match its record identity.');
  }
  const completionId = requireIdentifier(value.completionId, 'completionId');
  const piSessionId = requireNonEmptyString(value.piSessionId, 'piSessionId', 1024);
  const scope = parseScope(value.scope);
  const cwd = requireAbsolutePath(value.cwd, 'cwd');
  const tmuxSession = requireNonEmptyString(value.tmuxSession, 'tmuxSession', 200);
  const windowId = optionalWindowId(value.windowId);
  const commandFile = requireArtifactPath(value.commandFile, 'commandFile', options.artifactRoot);
  const scriptFile = requireArtifactPath(value.scriptFile, 'scriptFile', options.artifactRoot);
  const outputFile = requireArtifactPath(value.outputFile, 'outputFile', options.artifactRoot);
  const exitCodeFile = requireArtifactPath(
    value.exitCodeFile,
    'exitCodeFile',
    options.artifactRoot,
  );
  const displayCommand = requireNonEmptyString(
    value.displayCommand,
    'displayCommand',
    MAX_MANIFEST_DISPLAY_COMMAND_BYTES,
  );
  const startedAt = requireTimestamp(value.startedAt, 'startedAt');
  const endedAt = optionalTimestamp(value.endedAt, 'endedAt');
  const exitCode = optionalInteger(value.exitCode, 'exitCode', -1, 255);
  const mode = requireEnum(value.mode, 'mode', ['foreground', 'background'] as const);
  const state = requireEnum(value.state, 'state', [
    'reserved',
    'starting',
    'running',
    'completed',
    'failed',
    'killed',
    'orphaned',
  ] as const);
  const awaited = requireBoolean(value.awaited, 'awaited');
  const continuationDomain = requireNonEmptyString(
    value.continuationDomain,
    'continuationDomain',
    200,
  );
  const completionDelivery = requireEnum(value.completionDelivery, 'completionDelivery', [
    'model',
    'display',
    'next-turn',
  ] as const);
  const deliveryState = requireEnum(value.deliveryState, 'deliveryState', [
    'pending',
    'queued',
    'delivered',
    'persisted',
    'failed',
  ] as const);
  const polling = parsePolling(value.polling);
  const outputWasRotated = requireBoolean(value.outputWasRotated, 'outputWasRotated');
  const updatedAt = requireTimestamp(value.updatedAt, 'updatedAt');

  if (endedAt !== undefined && endedAt < startedAt) {
    throw new Error('Managed run manifest endedAt cannot precede startedAt.');
  }
  if (updatedAt < startedAt) {
    throw new Error('Managed run manifest updatedAt cannot precede startedAt.');
  }
  if (
    (state === 'reserved' || state === 'starting' || state === 'running') &&
    (endedAt !== undefined || exitCode !== undefined)
  ) {
    throw new Error('A non-terminal managed run cannot have completion fields.');
  }
  if (
    (state === 'completed' || state === 'failed' || state === 'killed' || state === 'orphaned') &&
    endedAt === undefined
  ) {
    throw new Error('A terminal managed run must have endedAt.');
  }
  if (state === 'completed' && exitCode !== 0) {
    throw new Error('A completed managed run must have exitCode 0.');
  }
  if (state === 'failed' && exitCode === 0) {
    throw new Error('A failed managed run cannot have exitCode 0.');
  }

  return {
    runId,
    completionId,
    piSessionId,
    scope,
    cwd,
    tmuxSession,
    ...(windowId ? { windowId } : {}),
    commandFile,
    scriptFile,
    outputFile,
    exitCodeFile,
    displayCommand,
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(exitCode === undefined ? {} : { exitCode }),
    mode,
    state,
    awaited,
    continuationDomain,
    completionDelivery,
    deliveryState,
    ...(polling ? { polling } : {}),
    outputWasRotated,
    updatedAt,
  };
}

export interface ManifestPathHost {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{
    isSymbolicLink(): boolean;
    isFile(): boolean;
    mode: number;
    uid?: number;
  }>;
}

export async function validateManagedRunManifestPaths(
  manifest: ManagedRunManifest,
  artifactRoot: string,
  host: ManifestPathHost,
): Promise<void> {
  const canonicalRoot = await host.realpath(artifactRoot);
  const paths = [
    { path: manifest.commandFile, required: true },
    { path: manifest.scriptFile, required: true },
    { path: manifest.outputFile, required: true },
    { path: manifest.exitCodeFile, required: false },
  ];
  for (const { path, required } of paths) {
    let stats: Awaited<ReturnType<ManifestPathHost['lstat']>>;
    try {
      stats = await host.lstat(path);
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`Managed run artifact is a symlink: ${path}.`);
    if (!stats.isFile()) throw new Error(`Managed run artifact is not a regular file: ${path}.`);
    const canonical = await host.realpath(path);
    assertWithinRoot(canonical, canonicalRoot, 'artifact path');
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Managed run artifact permissions are not private: ${path}.`);
    }
    if (
      typeof stats.uid === 'number' &&
      typeof process.getuid === 'function' &&
      stats.uid !== process.getuid()
    ) {
      throw new Error(`Managed run artifact has unexpected ownership: ${path}.`);
    }
  }
}

export function manifestFileName(runId: string): string {
  return `${requireIdentifier(runId, 'runId')}.manifest.json`;
}

function parseScope(value: unknown): ManagedRunManifest['scope'] {
  if (!isRecord(value)) throw new Error('Managed run manifest scope must be an object.');
  const allowed = new Set(['kind', 'root', 'hash']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Managed run manifest scope has unexpected fields.');
  }
  return {
    kind: requireEnum(value.kind, 'scope.kind', ['git-root', 'cwd'] as const),
    root: requireAbsolutePath(value.root, 'scope.root'),
    hash: requireHash(value.hash, 'scope.hash'),
  };
}

function parsePolling(value: unknown): ManagedRunManifest['polling'] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Managed run manifest polling must be an object.');
  if (Object.keys(value).some((key) => key !== 'intervalSeconds' && key !== 'lines')) {
    throw new Error('Managed run manifest polling has unexpected fields.');
  }
  return {
    intervalSeconds: requireInteger(value.intervalSeconds, 'polling.intervalSeconds', 1),
    lines: requireInteger(value.lines, 'polling.lines', 1, 10_000),
  };
}

function rejectUnexpectedFields(value: Record<string, unknown>): void {
  const allowed = new Set<string>(MANAGED_RUN_MANIFEST_FIELDS);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`Managed run manifest has unexpected field: ${unexpected}.`);
}

function requireArtifactPath(value: unknown, key: string, artifactRoot: string): string {
  const path = requireAbsolutePath(value, key);
  assertWithinRoot(path, artifactRoot, key);
  return path;
}

function assertWithinRoot(path: string, root: string, key: string): void {
  const canonicalRoot = resolve(root);
  const candidate = resolve(path);
  const rel = relative(canonicalRoot, candidate);
  if (rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) return;
  throw new Error(`Managed run manifest ${key} escapes or aliases the artifact root.`);
}

function requireAbsolutePath(value: unknown, key: string): string {
  const path = requireNonEmptyString(value, key, 32 * 1024);
  assertAbsoluteSafePath(path, key);
  return path;
}

function assertAbsoluteSafePath(value: string, key: string): void {
  if (!isAbsolute(value) || value.includes('\0')) {
    throw new Error(`Managed run manifest ${key} must be an absolute path without NUL bytes.`);
  }
}

function requireIdentifier(value: unknown, key: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new Error(`Managed run manifest ${key} is invalid.`);
  }
  return value;
}

function requireHash(value: unknown, key: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8,64}$/.test(value)) {
    throw new Error(`Managed run manifest ${key} is invalid.`);
  }
  return value;
}

function optionalWindowId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^@\d+$/.test(value)) {
    throw new Error('Managed run manifest windowId is invalid.');
  }
  return value;
}

function requireTimestamp(value: unknown, key: string): number {
  return requireInteger(value, key, 0);
}

function optionalTimestamp(value: unknown, key: string): number | undefined {
  return value === undefined ? undefined : requireTimestamp(value, key);
}

function optionalInteger(
  value: unknown,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  return value === undefined ? undefined : requireInteger(value, key, minimum, maximum);
}

function requireInteger(
  value: unknown,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(
      `Managed run manifest ${key} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value as number;
}

function requireBoolean(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Managed run manifest ${key} must be boolean.`);
  return value;
}

function requireNonEmptyString(value: unknown, key: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    Buffer.byteLength(value) > maximumBytes
  ) {
    throw new Error(`Managed run manifest ${key} is invalid or too large.`);
  }
  return value;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  key: string,
  allowed: T,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`Managed run manifest ${key} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
