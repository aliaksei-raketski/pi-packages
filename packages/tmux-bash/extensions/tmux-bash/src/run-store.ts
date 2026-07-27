import {
  manifestFileName,
  parseManagedRunManifest,
  validateManagedRunManifestPaths,
  type ManagedRunManifest,
  type ManagedRunState,
} from '@aliaksei-raketski/pi-tmux-bash-core';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';

import { artifactPaths } from './command-artifacts.js';
import type { CommandRun } from './types.js';

const MAX_MANIFEST_BYTES = 256 * 1024;

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

interface CompletionClaim {
  path: string;
  handle: FileHandle;
  stats: Stats;
}

const COMPLETION_CLAIM_STALE_MS = 60_000;

export class RunStore {
  readonly commands = new Map<string, CommandRun>();
  private readonly completionClaims = new Map<string, CompletionClaim>();

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

  async claimCompletion(runId: string): Promise<boolean> {
    if (this.completionClaims.has(runId)) return true;
    const path = join(this.root, `${runId}.completion.claim`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle: FileHandle | undefined;
      let stats: Stats | undefined;
      try {
        handle = await open(
          path,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_NOFOLLOW |
            fsConstants.O_NONBLOCK,
          0o600,
        );
        stats = await handle.stat();
        await handle.writeFile(`${process.pid} ${this.now()}\\n`, 'utf8');
        this.completionClaims.set(runId, { path, handle, stats });
        return true;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (stats) await removeIfSameFile(path, stats);
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stale = await staleCompletionClaim(path, this.now());
        if (!stale) return false;
        await removeIfSameFile(path, stale);
      }
    }
    return false;
  }

  async releaseCompletionClaim(runId: string): Promise<void> {
    const claim = this.completionClaims.get(runId);
    if (!claim) return;
    this.completionClaims.delete(runId);
    await claim.handle.close().catch(() => undefined);
    await removeIfSameFile(claim.path, claim.stats);
  }

  async releaseAllCompletionClaims(): Promise<void> {
    await Promise.all(
      [...this.completionClaims.keys()].map((runId) => this.releaseCompletionClaim(runId)),
    );
  }

  async persist(run: CommandRun, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const manifest = await this.toManifest(run);
    throwIfAborted(signal);
    const temporary = `${run.manifestPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(temporary, 0o600);
    try {
      throwIfAborted(signal);
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
        const expectedRunId = name.slice(0, -'.manifest.json'.length);
        const value = JSON.parse(await readBoundedManifest(path, options.signal)) as unknown;
        const manifest = parseManagedRunManifest(value, {
          artifactRoot: this.root,
          expectedRunId,
        });
        assertCanonicalArtifactPaths(manifest, artifactPaths(this.root, manifest.runId));
        await validateManagedRunManifestPaths(manifest, this.root, {
          realpath,
          lstat: async (artifactPath) => (await openRegularFile(artifactPath)).closeAndStat(),
        });
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
      commandFile: manifest.commandFile,
      scriptFile: manifest.scriptFile,
      outputFile: manifest.outputFile,
      exitCodeFile: manifest.exitCodeFile,
      runId: manifest.runId,
      origin: manifest.origin,
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
      completionDeliveryFailures: manifest.completionDeliveryAttempts ?? 0,
      completionDeliveryFailed: manifest.completionDeliveryExhausted === true,
      completionDeliveryExhausted: manifest.completionDeliveryExhausted === true,
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
      ...(run.origin ? { origin: run.origin } : {}),
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
      ...(run.completionDeliveryFailures === 0
        ? {}
        : { completionDeliveryAttempts: run.completionDeliveryFailures }),
      ...(run.completionDeliveryExhausted ? { completionDeliveryExhausted: true } : {}),
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

async function staleCompletionClaim(path: string, now: number): Promise<Stats | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const stats = await handle.stat();
    const text = await handle.readFile('utf8');
    const match = /^([0-9]+) ([0-9]+)\\n?$/.exec(text);
    if (!match || now - Number(match[2]) < COMPLETION_CLAIM_STALE_MS) return undefined;
    try {
      process.kill(Number(match[1]), 0);
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return undefined;
      return stats;
    }
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeIfSameFile(path: string, expected: Stats): Promise<void> {
  const actual = await lstat(path).catch(() => undefined);
  if (!actual || actual.dev !== expected.dev || actual.ino !== expected.ino) return;
  await rm(path, { force: true }).catch(() => undefined);
}

async function readBoundedManifest(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const opened = await openRegularFile(path);
  try {
    const stats = await opened.handle.stat();
    if ((stats.mode & 0o077) !== 0) throw new Error('manifest permissions are not private');
    if (typeof stats.uid === 'number' && typeof process.getuid === 'function') {
      if (stats.uid !== process.getuid()) throw new Error('manifest has unexpected ownership');
    }
    if (stats.size > MAX_MANIFEST_BYTES) {
      throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      throwIfAborted(signal);
      const { bytesRead } = await opened.handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    throwIfAborted(signal);
    if (offset > MAX_MANIFEST_BYTES) {
      throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await opened.handle.close();
  }
}

async function openRegularFile(path: string): Promise<{
  handle: FileHandle;
  closeAndStat(): Promise<Stats>;
}> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('file is not a regular file');
    return {
      handle,
      async closeAndStat() {
        try {
          return await handle.stat({ bigint: false });
        } finally {
          await handle.close();
        }
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function assertCanonicalArtifactPaths(
  manifest: ManagedRunManifest,
  canonical: ReturnType<typeof artifactPaths>,
): void {
  for (const key of ['commandFile', 'scriptFile', 'outputFile', 'exitCodeFile'] as const) {
    if (manifest[key] !== canonical[key]) {
      throw new Error(`manifest ${key} does not match its canonical run artifact path`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
