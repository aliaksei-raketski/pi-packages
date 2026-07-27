import { isAbsolute } from 'node:path';

import {
  MAX_MANIFEST_DISPLAY_COMMAND_BYTES,
  TMUX_BASH_METADATA_KEYS,
  TMUX_BASH_OWNERSHIP_MARKER,
} from './constants.js';
import type { CompletionDelivery } from './manifest.js';
import type { TmuxWorkspaceScope } from './scope.js';

export interface ManagedWindowIdentity {
  owner: typeof TMUX_BASH_OWNERSHIP_MARKER;
  scope: Pick<TmuxWorkspaceScope, 'kind' | 'root' | 'hash'>;
  piSessionId: string;
  runId: string;
  manifestPath: string;
  completionId: string;
  completionDelivery: CompletionDelivery;
}

export interface ManagedWindowMetadata extends ManagedWindowIdentity {
  startedAt: number;
  displayCommand?: string;
}

export function managedWindowMetadataEntries(
  metadata: ManagedWindowMetadata,
): ReadonlyArray<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [
    [TMUX_BASH_METADATA_KEYS.owner, metadata.owner],
    [TMUX_BASH_METADATA_KEYS.scopeKind, metadata.scope.kind],
    [TMUX_BASH_METADATA_KEYS.scopeRoot, metadata.scope.root],
    [TMUX_BASH_METADATA_KEYS.scopeHash, metadata.scope.hash],
    [TMUX_BASH_METADATA_KEYS.piSessionId, metadata.piSessionId],
    [TMUX_BASH_METADATA_KEYS.runId, metadata.runId],
    [TMUX_BASH_METADATA_KEYS.manifestPath, metadata.manifestPath],
    [TMUX_BASH_METADATA_KEYS.completionId, metadata.completionId],
    [TMUX_BASH_METADATA_KEYS.completionDelivery, metadata.completionDelivery],
    [TMUX_BASH_METADATA_KEYS.startedAt, String(metadata.startedAt)],
  ];
  if (metadata.displayCommand !== undefined) {
    entries.push([TMUX_BASH_METADATA_KEYS.displayCommand, metadata.displayCommand]);
  }
  return entries;
}

export function parseManagedWindowMetadata(
  options: Readonly<Record<string, string | undefined>>,
): ManagedWindowMetadata {
  const owner = requireValue(options, TMUX_BASH_METADATA_KEYS.owner);
  if (owner !== TMUX_BASH_OWNERSHIP_MARKER) throw new Error('Unrecognized tmux ownership marker.');
  const kind = requireValue(options, TMUX_BASH_METADATA_KEYS.scopeKind);
  if (kind !== 'git-root' && kind !== 'cwd') throw new Error('Invalid tmux scope kind.');
  const root = requireAbsolutePath(options, TMUX_BASH_METADATA_KEYS.scopeRoot);
  const hash = requireValue(options, TMUX_BASH_METADATA_KEYS.scopeHash);
  if (!/^[a-f0-9]{8,64}$/.test(hash)) throw new Error('Invalid tmux scope hash.');
  const piSessionId = requireBoundedValue(options, TMUX_BASH_METADATA_KEYS.piSessionId, 1024);
  const runId = requireIdentifier(options, TMUX_BASH_METADATA_KEYS.runId);
  const manifestPath = requireAbsolutePath(options, TMUX_BASH_METADATA_KEYS.manifestPath);
  const completionId = requireIdentifier(options, TMUX_BASH_METADATA_KEYS.completionId);
  const completionDelivery = requireValue(options, TMUX_BASH_METADATA_KEYS.completionDelivery);
  if (!isCompletionDelivery(completionDelivery)) {
    throw new Error('Invalid tmux completion delivery policy.');
  }
  const startedAtText = requireValue(options, TMUX_BASH_METADATA_KEYS.startedAt);
  const startedAt = Number(startedAtText);
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error('Invalid tmux startedAt.');
  const displayCommand = options[TMUX_BASH_METADATA_KEYS.displayCommand];
  if (
    displayCommand !== undefined &&
    (displayCommand.includes('\0') ||
      Buffer.byteLength(displayCommand) > MAX_MANIFEST_DISPLAY_COMMAND_BYTES)
  ) {
    throw new Error('Invalid or oversized tmux display command.');
  }

  return {
    owner,
    scope: { kind, root, hash },
    piSessionId,
    runId,
    manifestPath,
    completionId,
    completionDelivery,
    startedAt,
    ...(displayCommand === undefined ? {} : { displayCommand }),
  };
}

export function isManagedWindowMetadata(value: unknown): value is ManagedWindowMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    parseManagedWindowMetadata(value as Record<string, string | undefined>);
    return true;
  } catch {
    return false;
  }
}

export function sameManagedWindowOwner(
  actual: ManagedWindowIdentity,
  expected: ManagedWindowIdentity,
): boolean {
  return (
    actual.owner === expected.owner &&
    actual.scope.kind === expected.scope.kind &&
    actual.scope.root === expected.scope.root &&
    actual.scope.hash === expected.scope.hash &&
    actual.piSessionId === expected.piSessionId &&
    actual.runId === expected.runId &&
    actual.manifestPath === expected.manifestPath &&
    actual.completionId === expected.completionId &&
    actual.completionDelivery === expected.completionDelivery
  );
}

function requireIdentifier(
  options: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = requireValue(options, key);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new Error(`Invalid tmux option ${key}.`);
  return value;
}

function requireAbsolutePath(
  options: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = requireBoundedValue(options, key, 32 * 1024);
  if (!isAbsolute(value)) throw new Error(`Tmux option ${key} must be an absolute path.`);
  return value;
}

function requireBoundedValue(
  options: Readonly<Record<string, string | undefined>>,
  key: string,
  maximumBytes: number,
): string {
  const value = requireValue(options, key);
  if (Buffer.byteLength(value) > maximumBytes) throw new Error(`Tmux option ${key} is too large.`);
  return value;
}

function requireValue(options: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = options[key];
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error(`Missing or invalid tmux option ${key}.`);
  }
  return value;
}

function isCompletionDelivery(value: string): value is CompletionDelivery {
  return value === 'model' || value === 'display' || value === 'next-turn';
}
