import {
  manifestFileName,
  parseManagedRunManifest,
  validateManagedRunManifestPaths,
  type ManagedRunManifest,
  type ManagedRunState,
} from '@aliaksei-raketski/pi-tmux-bash-core';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { artifactPaths } from './command-artifacts.js';
import type { CommandRun } from './types.js';

const TRANSITIONS: Readonly<Record<ManagedRunState, readonly ManagedRunState[]>> = {
  reserved: ['starting', 'failed', 'killed'],
  starting: ['running', 'failed', 'killed', 'orphaned'],
  running: ['completed', 'failed', 'killed', 'orphaned'],
  completed: [],
  failed: [],
  killed: [],
  orphaned: [],
};

export interface LoadedManifest {
  manifest: ManagedRunManifest;
  path: string;
}

export interface ManifestDiagnostic {
  path: string;
  reason: string;
}

export class RunStore {
  readonly commands = new Map<string, CommandRun>();

  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }

  manifestPath(runId: string): string {
    return join(this.root, manifestFileName(runId));
  }

  async persist(run: CommandRun): Promise<void> {
    const manifest = await this.toManifest(run);
    const temporary = `${run.manifestPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(temporary, 0o600);
    try {
      await rename(temporary, run.manifestPath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async transition(
    run: CommandRun,
    next: ManagedRunState,
    patch: Partial<CommandRun> = {},
  ): Promise<void> {
    if (run.state !== next && !TRANSITIONS[run.state].includes(next)) {
      throw new Error(`Invalid tmux-bash run transition: ${run.state} -> ${next}.`);
    }
    Object.assign(run, patch, { state: next });
    if (isTerminalState(next)) run.endedAt ??= this.now();
    await this.persist(run);
  }

  async loadAll(
    options: { signal?: AbortSignal; maximumManifests?: number } = {},
  ): Promise<{ manifests: LoadedManifest[]; diagnostics: ManifestDiagnostic[] }> {
    throwIfAborted(options.signal);
    await this.initialize();
    const names = await readdir(this.root);
    throwIfAborted(options.signal);
    const manifestNames = names.filter((candidate) => candidate.endsWith('.manifest.json')).sort();
    const maximumManifests = options.maximumManifests ?? 10_000;
    if (!Number.isInteger(maximumManifests) || maximumManifests < 1) {
      throw new Error('Manifest scan limit must be a positive integer.');
    }
    if (manifestNames.length > maximumManifests) {
      throw new Error(`Manifest scan exceeded its ${maximumManifests} record limit.`);
    }
    const manifests: LoadedManifest[] = [];
    const diagnostics: ManifestDiagnostic[] = [];
    for (const name of manifestNames) {
      throwIfAborted(options.signal);
      const path = join(this.root, name);
      try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) throw new Error('manifest is a symlink');
        if ((stats.mode & 0o077) !== 0) throw new Error('manifest permissions are not private');
        if (typeof stats.uid === 'number' && typeof process.getuid === 'function') {
          if (stats.uid !== process.getuid()) throw new Error('manifest has unexpected ownership');
        }
        const expectedRunId = name.slice(0, -'.manifest.json'.length);
        const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
        const manifest = parseManagedRunManifest(value, {
          artifactRoot: this.root,
          expectedRunId,
        });
        await validateManagedRunManifestPaths(manifest, this.root, { realpath, lstat });
        manifests.push({ manifest, path });
      } catch (error) {
        throwIfAborted(options.signal);
        diagnostics.push({ path, reason: errorMessage(error) });
      }
    }
    return { manifests, diagnostics };
  }

  fromManifest(manifest: ManagedRunManifest): CommandRun {
    const artifacts = artifactPaths(this.root, manifest.runId);
    return {
      ...artifacts,
      runId: manifest.runId,
      completionId: manifest.completionId,
      sessionId: manifest.piSessionId,
      scope: {
        ...manifest.scope,
        displayName: manifest.scope.root.split('/').at(-1) ?? 'workspace',
      },
      cwd: manifest.cwd,
      tmuxSession: manifest.tmuxSession,
      ...(manifest.windowId ? { windowId: manifest.windowId } : {}),
      command: manifest.displayCommand,
      displayCommand: manifest.displayCommand,
      startedAt: manifest.startedAt,
      ...(manifest.endedAt === undefined ? {} : { endedAt: manifest.endedAt }),
      ...(manifest.exitCode === undefined ? {} : { exitCode: manifest.exitCode }),
      mode: manifest.mode,
      state: manifest.state,
      backgroundReady: manifest.state === 'running',
      awaited: manifest.awaited,
      continuationDomain: manifest.continuationDomain,
      completionDelivery: manifest.completionDelivery,
      deliveryState: manifest.deliveryState,
      completionDelivered: manifest.deliveryState === 'delivered',
      completionClaimed: manifest.deliveryState !== 'pending',
      completionDeliveryFailures: 0,
      completionDeliveryFailed: manifest.deliveryState === 'failed',
      killed: manifest.state === 'killed',
      adopted: true,
      outputWasRotated: manifest.outputWasRotated,
      ...(manifest.polling ? { polling: manifest.polling } : {}),
    };
  }

  private async toManifest(run: CommandRun): Promise<ManagedRunManifest> {
    const outputWasRotated = run.outputWasRotated || (await exists(run.rotationMarkerFile));
    run.outputWasRotated = outputWasRotated;
    return {
      runId: run.runId,
      completionId: run.completionId,
      piSessionId: run.sessionId,
      scope: { kind: run.scope.kind, root: run.scope.root, hash: run.scope.hash },
      cwd: run.cwd,
      tmuxSession: run.tmuxSession,
      ...(run.windowId ? { windowId: run.windowId } : {}),
      commandFile: run.commandFile,
      scriptFile: run.scriptFile,
      outputFile: run.outputFile,
      exitCodeFile: run.exitCodeFile,
      displayCommand: run.displayCommand,
      startedAt: run.startedAt,
      ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
      mode: run.mode,
      state: run.state,
      awaited: run.awaited,
      continuationDomain: run.continuationDomain,
      completionDelivery: run.completionDelivery,
      deliveryState: run.deliveryState,
      ...(run.polling ? { polling: run.polling } : {}),
      outputWasRotated,
      updatedAt: this.now(),
    };
  }
}

function isTerminalState(state: ManagedRunState): boolean {
  return state === 'completed' || state === 'failed' || state === 'killed' || state === 'orphaned';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Manifest scan aborted.');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
