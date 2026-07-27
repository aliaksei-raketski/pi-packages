import { MAX_TMUX_DISCOVERY_BYTES, TMUX_BASH_METADATA_KEYS } from './constants.js';
import { parseManagedWindowMetadata, type ManagedWindowMetadata } from './metadata.js';
import { sameTmuxWorkspaceScope, type TmuxWorkspaceScope } from './scope.js';
import { assertWindowId } from './attach.js';

const MISSING_TMUX_VALUE_PATTERN =
  /^(?:missing|unknown option|invalid option(?::|$)|no such option|option .* (?:does not exist|not found)|can't find (?:window|session)|no server running)/i;

export interface TmuxCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface TmuxCommandExecutor {
  (args: readonly string[], signal?: AbortSignal): Promise<TmuxCommandResult>;
}

export interface ListedManagedTmuxWindow {
  windowId: string;
  metadata: ManagedWindowMetadata;
}

export interface ListManagedTmuxWindowsOptions {
  scope?: Pick<TmuxWorkspaceScope, 'kind' | 'root' | 'hash'>;
  piSessionId?: string;
  includeLocalDiagnostics?: boolean;
  signal?: AbortSignal;
  maximumOutputBytes?: number;
  maximumWindows?: number;
}

export async function listManagedTmuxWindows(
  execute: TmuxCommandExecutor,
  options: ListManagedTmuxWindowsOptions = {},
): Promise<ListedManagedTmuxWindow[]> {
  const maximum = options.maximumOutputBytes ?? MAX_TMUX_DISCOVERY_BYTES;
  const listed = await execute(['list-windows', '-a', '-F', '#{window_id}'], options.signal);
  assertBoundedResult(listed, maximum);
  if (listed.code !== 0) {
    if (/no server running|failed to connect/i.test(listed.stderr)) return [];
    throw new Error(`Failed to list tmux windows: ${boundedMessage(listed.stderr, maximum)}`);
  }

  const ids = [...new Set(listed.stdout.split(/\r?\n/).filter(Boolean))];
  const maximumWindows = options.maximumWindows ?? 1000;
  if (!Number.isInteger(maximumWindows) || maximumWindows < 1) {
    throw new Error('Tmux discovery window limit must be a positive integer.');
  }
  if (ids.length > maximumWindows) {
    throw new Error(`Tmux discovery exceeded its ${maximumWindows} window record limit.`);
  }
  const windows: ListedManagedTmuxWindow[] = [];
  for (const windowId of ids) {
    assertWindowId(windowId);
    const values: Record<string, string | undefined> = {};
    for (const key of metadataKeys(options.includeLocalDiagnostics ?? false)) {
      const result = await execute(
        ['show-options', '-w', '-v', '-t', windowId, key],
        options.signal,
      );
      assertBoundedResult(result, maximum);
      if (result.code === 0) {
        values[key] = stripOneNewline(result.stdout);
      } else if (!MISSING_TMUX_VALUE_PATTERN.test(result.stderr)) {
        throw new Error(
          `Failed to read tmux window option ${key}: ${boundedMessage(result.stderr, maximum)}`,
        );
      }
    }
    let metadata: ManagedWindowMetadata;
    try {
      metadata = parseManagedWindowMetadata(values);
    } catch {
      continue;
    }
    if (options.piSessionId !== undefined && metadata.piSessionId !== options.piSessionId) continue;
    if (options.scope !== undefined && !sameTmuxWorkspaceScope(metadata.scope, options.scope)) {
      continue;
    }
    if (options.includeLocalDiagnostics) {
      windows.push({ windowId, metadata });
    } else {
      windows.push({ windowId, metadata: { ...metadata, displayCommand: undefined } });
    }
  }
  return windows.sort((left, right) => left.metadata.startedAt - right.metadata.startedAt);
}

function metadataKeys(includeLocalDiagnostics: boolean): string[] {
  const keys: string[] = [
    TMUX_BASH_METADATA_KEYS.owner,
    TMUX_BASH_METADATA_KEYS.scopeKind,
    TMUX_BASH_METADATA_KEYS.scopeRoot,
    TMUX_BASH_METADATA_KEYS.scopeHash,
    TMUX_BASH_METADATA_KEYS.piSessionId,
    TMUX_BASH_METADATA_KEYS.runId,
    TMUX_BASH_METADATA_KEYS.manifestPath,
    TMUX_BASH_METADATA_KEYS.completionId,
    TMUX_BASH_METADATA_KEYS.completionDelivery,
    TMUX_BASH_METADATA_KEYS.startedAt,
  ];
  if (includeLocalDiagnostics) keys.push(TMUX_BASH_METADATA_KEYS.displayCommand);
  return keys;
}

function assertBoundedResult(result: TmuxCommandResult, maximum: number): void {
  if (!Number.isInteger(maximum) || maximum < 1024) {
    throw new Error('Tmux discovery output limit must be an integer of at least 1024 bytes.');
  }
  if (Buffer.byteLength(result.stdout) > maximum || Buffer.byteLength(result.stderr) > maximum) {
    throw new Error('Tmux discovery output exceeded its configured bound.');
  }
}

function boundedMessage(value: string, maximum: number): string {
  const bytes = Buffer.from(value);
  return bytes.subarray(0, maximum).toString('utf8').trim() || 'unknown tmux error';
}

function stripOneNewline(value: string): string {
  return value.replace(/\r?\n$/, '');
}
