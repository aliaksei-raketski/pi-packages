import {
  parseManagedRunManifest,
  validateManagedRunManifestPaths,
  type ManagedRunManifest,
} from '@aliaksei-raketski/pi-tmux-bash-core';
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, type FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';

import {
  artifactPaths,
  artifactRunIdFromFileName,
  STRUCTURAL_ARTIFACT_HEADROOM_BYTES,
} from './command-artifacts.js';
import type { TmuxBashConfig } from './types.js';

const MAX_RESOURCE_ENTRIES = 100_000;
const LEASE_STALE_MS = 60_000;
const MAX_LEASE_BYTES = 256;
const MAX_MANIFEST_BYTES = 256 * 1024;

interface OwnedLease {
  handle: FileHandle;
  stats: Stats;
}

export interface ResourceUsage {
  artifactBytes: number;
  activeRuns: number;
  completedRuns: number;
  reservations: number;
  activeArtifactCapacity: number;
}

export interface CleanupCandidate {
  runId: string;
  state: string;
  ageMs: number;
  bytes: number;
  files: string[];
  manifest: ManagedRunManifest;
}

export class ArtifactQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactQuotaError';
  }
}

export class ResourceManager {
  private readonly reservationsDir: string;
  private readonly reservationLock: string;
  private readonly reservationLeases = new Map<string, OwnedLease>();

  constructor(
    readonly root: string,
    private readonly config: TmuxBashConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.reservationsDir = join(root, '.reservations');
    this.reservationLock = join(this.reservationsDir, '.lock');
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.reservationsDir, { recursive: true, mode: 0o700 });
  }

  async reserve(
    runId: string,
    options: {
      isActiveRun?: (manifest: ManagedRunManifest) => Promise<boolean>;
      isCleanupProtectedWindow?: (manifest: ManagedRunManifest) => Promise<boolean>;
      isCleanupProtectedRun?: (manifest: ManagedRunManifest) => Promise<boolean>;
    } = {},
  ): Promise<string> {
    await this.initialize();
    return this.withReservationLock(async () => {
      await this.removeStaleReservations();
      const usage = await this.usage({ isActiveRun: options.isActiveRun });
      if (usage.activeRuns + usage.reservations >= this.config.maxConcurrentRuns) {
        throw new Error(
          `tmux-bash concurrent run limit (${this.config.maxConcurrentRuns}) reached. Wait for a command or run tmux cleanup-preview.`,
        );
      }
      const needsArtifactCapacity =
        this.projectedArtifactBytes(usage) > this.config.maxArtifactBytesTotal;
      const needsCompletedCapacity =
        this.projectedCompletedRuns(usage) > this.config.maxCompletedRuns;
      if (
        this.config.quotaPolicy === 'cleanup-completed' &&
        (needsArtifactCapacity || needsCompletedCapacity)
      ) {
        await this.cleanup({
          automatic: true,
          includeYoung: true,
          additionalRuns: 1,
          isLiveOwnedWindow: options.isCleanupProtectedWindow,
          isActiveRun: options.isActiveRun,
          isCleanupProtectedRun: options.isCleanupProtectedRun,
        });
      }
      const refreshed = await this.usage({ isActiveRun: options.isActiveRun });
      if (this.projectedCompletedRuns(refreshed) > this.config.maxCompletedRuns) {
        throw new Error(
          `tmux-bash completed run limit (${this.config.maxCompletedRuns}) reached. Run tmux cleanup-preview and tmux cleanup.`,
        );
      }
      if (this.projectedArtifactBytes(refreshed) > this.config.maxArtifactBytesTotal) {
        throw new ArtifactQuotaError(
          `tmux-bash artifact quota (${this.config.maxArtifactBytesTotal} bytes) reached. Run tmux cleanup-preview and tmux cleanup.`,
        );
      }
      const path = join(this.reservationsDir, `${assertRunId(runId)}.reserve`);
      try {
        const lease = await createOwnedLease(path, this.now());
        this.reservationLeases.set(path, lease);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`tmux-bash run reservation already exists for ${runId}.`);
        }
        throw error;
      }
      return path;
    });
  }

  async releaseReservation(path: string | undefined): Promise<void> {
    if (!path) return;
    if (!path.startsWith(`${this.reservationsDir}/`)) {
      throw new Error('Refusing to release a reservation outside the durable root.');
    }
    const lease = this.reservationLeases.get(path);
    if (!lease) throw new Error('Refusing to release a reservation not owned by this manager.');
    this.reservationLeases.delete(path);
    await releaseOwnedLease(path, lease);
  }

  async validateReservationCapacity(
    reservationPath: string,
    options: {
      isActiveRun?: (manifest: ManagedRunManifest) => Promise<boolean>;
      isCleanupProtectedWindow?: (manifest: ManagedRunManifest) => Promise<boolean>;
      isCleanupProtectedRun?: (manifest: ManagedRunManifest) => Promise<boolean>;
    } = {},
  ): Promise<void> {
    if (!reservationPath.startsWith(`${this.reservationsDir}/`)) {
      throw new Error('Refusing to validate a reservation outside the durable root.');
    }
    await this.withReservationLock(async () => {
      const reservation = await lstat(reservationPath).catch(() => undefined);
      if (!reservation?.isFile() || reservation.isSymbolicLink()) {
        throw new Error('Tmux-bash run reservation disappeared before launch.');
      }
      let usage = await this.usage({ isActiveRun: options.isActiveRun });
      if (
        this.config.quotaPolicy === 'cleanup-completed' &&
        (this.projectedArtifactBytes(usage, 0) > this.config.maxArtifactBytesTotal ||
          this.projectedCompletedRuns(usage, 0) > this.config.maxCompletedRuns)
      ) {
        await this.cleanup({
          automatic: true,
          includeYoung: true,
          additionalRuns: 0,
          isLiveOwnedWindow: options.isCleanupProtectedWindow,
          isActiveRun: options.isActiveRun,
          isCleanupProtectedRun: options.isCleanupProtectedRun,
        });
        usage = await this.usage({ isActiveRun: options.isActiveRun });
      }
      if (this.projectedCompletedRuns(usage, 0) > this.config.maxCompletedRuns) {
        throw new Error(
          `tmux-bash completed run limit (${this.config.maxCompletedRuns}) reached. Run tmux cleanup-preview and tmux cleanup.`,
        );
      }
      if (this.projectedArtifactBytes(usage, 0) > this.config.maxArtifactBytesTotal) {
        throw new ArtifactQuotaError(
          `tmux-bash artifact quota (${this.config.maxArtifactBytesTotal} bytes) reached after creating launch artifacts.`,
        );
      }
    });
  }

  async usage(
    options: { isActiveRun?: (manifest: ManagedRunManifest) => Promise<boolean> } = {},
  ): Promise<ResourceUsage> {
    await this.initialize();
    const names = await this.readRootNames();
    let artifactBytes = 0;
    let activeRuns = 0;
    let activeArtifactCapacity = 0;
    let completedRuns = 0;
    const bytesByRunId = new Map<string, number>();
    for (const name of names) {
      const path = join(this.root, name);
      const details = await lstat(path).catch(() => undefined);
      if (!details || details.isSymbolicLink() || !details.isFile()) continue;
      artifactBytes += details.size;
      const runId = artifactRunIdFromFileName(name);
      if (runId) bytesByRunId.set(runId, (bytesByRunId.get(runId) ?? 0) + details.size);
    }
    for (const name of names.filter((candidate) => candidate.endsWith('.manifest.json'))) {
      const path = join(this.root, name);
      const manifest = await this.readManifest(path, name).catch(() => undefined);
      if (!manifest) continue;
      if (manifest.state === 'running' || manifest.state === 'starting') {
        if (!options.isActiveRun || (await options.isActiveRun(manifest))) {
          activeRuns += 1;
          activeArtifactCapacity += Math.max(
            0,
            this.config.maxArtifactBytesPerRun +
              STRUCTURAL_ARTIFACT_HEADROOM_BYTES -
              (bytesByRunId.get(manifest.runId) ?? 0),
          );
        }
      } else if (isCleanupState(manifest.state)) completedRuns += 1;
    }
    const reservations = (await this.readReservationNames()).filter((name) =>
      name.endsWith('.reserve'),
    ).length;
    return { artifactBytes, activeRuns, activeArtifactCapacity, completedRuns, reservations };
  }

  async preview(
    options: {
      includeYoung?: boolean;
      isActiveRun?: (manifest: ManagedRunManifest) => Promise<boolean>;
      isCleanupProtectedRun?: (manifest: ManagedRunManifest) => Promise<boolean>;
    } = {},
  ): Promise<CleanupCandidate[]> {
    await this.initialize();
    const names = await this.readRootNames();
    const manifests: ManagedRunManifest[] = [];
    const reservations = new Set(
      (await this.readReservationNames())
        .filter((candidate) => candidate.endsWith('.reserve'))
        .map((candidate) => candidate.slice(0, -'.reserve'.length)),
    );
    for (const name of names.filter((candidate) => candidate.endsWith('.manifest.json'))) {
      const manifest = await this.readManifest(join(this.root, name), name).catch(() => undefined);
      if (
        !manifest ||
        reservations.has(manifest.runId) ||
        (await options.isCleanupProtectedRun?.(manifest))
      ) {
        continue;
      }
      if (isCleanupState(manifest.state)) {
        if (isSettledCleanupDelivery(manifest)) manifests.push(manifest);
        continue;
      }
      const canReconcileCrashLeftover =
        this.config.adoptionPolicy === 'off' &&
        (manifest.state === 'running' || manifest.state === 'starting') &&
        options.isActiveRun;
      if (canReconcileCrashLeftover && !(await options.isActiveRun?.(manifest))) {
        manifests.push(manifest);
      }
    }
    manifests.sort(
      (left, right) => (left.endedAt ?? left.updatedAt) - (right.endedAt ?? right.updatedAt),
    );
    const overflow = Math.max(0, manifests.length - this.config.maxCompletedRuns);
    const filesByRunId = new Map<string, Array<{ path: string; bytes: number }>>();
    for (const name of names) {
      const runId = artifactRunIdFromFileName(name);
      if (!runId) continue;
      const path = join(this.root, name);
      const details = await lstat(path).catch(() => undefined);
      if (!details || details.isSymbolicLink() || (!details.isFile() && !details.isFIFO()))
        continue;
      const files = filesByRunId.get(runId) ?? [];
      files.push({ path, bytes: details.size });
      filesByRunId.set(runId, files);
    }
    const candidates: CleanupCandidate[] = [];
    for (const [index, manifest] of manifests.entries()) {
      const endedAt = manifest.endedAt ?? manifest.updatedAt;
      const ageMs = Math.max(0, this.now() - endedAt);
      const oldEnough = ageMs >= this.config.completedArtifactRetentionSeconds * 1_000;
      if (!options.includeYoung && !oldEnough && index >= overflow) continue;
      const records = filesByRunId.get(manifest.runId) ?? [];
      const files = records.map((record) => record.path);
      const bytes = records.reduce((total, record) => total + record.bytes, 0);
      candidates.push({
        runId: manifest.runId,
        state: manifest.state,
        ageMs,
        bytes,
        files,
        manifest,
      });
    }
    return candidates;
  }

  async cleanup(
    options: {
      automatic?: boolean;
      includeYoung?: boolean;
      isLiveOwnedWindow?: (manifest: ManagedRunManifest) => Promise<boolean>;
      isActiveRun?: (manifest: ManagedRunManifest) => Promise<boolean>;
      isCleanupProtectedRun?: (manifest: ManagedRunManifest) => Promise<boolean>;
      runIds?: ReadonlySet<string>;
      additionalRuns?: number;
    } = {},
  ): Promise<CleanupCandidate[]> {
    const candidates = (
      await this.preview({
        includeYoung: options.includeYoung,
        isActiveRun: options.isActiveRun,
        isCleanupProtectedRun: options.isCleanupProtectedRun,
      })
    ).filter((candidate) => options.runIds === undefined || options.runIds.has(candidate.runId));
    const removed: CleanupCandidate[] = [];
    for (const candidate of candidates) {
      const reservationPath = join(this.reservationsDir, `${candidate.runId}.reserve`);
      if (await isRegularFile(reservationPath)) continue;
      if (options.isLiveOwnedWindow) {
        if (await options.isLiveOwnedWindow(candidate.manifest)) continue;
      } else if (candidate.manifest.windowId) {
        continue;
      }
      for (const path of candidate.files) {
        const details = await lstat(path).catch(() => undefined);
        if (!details || details.isSymbolicLink() || (!details.isFile() && !details.isFIFO()))
          continue;
        if (!path.startsWith(`${this.root}/`)) continue;
        await rm(path, { force: true });
      }
      removed.push(candidate);
      if (options.automatic) {
        const usage = await this.usage({ isActiveRun: options.isActiveRun });
        if (
          this.projectedArtifactBytes(usage, options.additionalRuns ?? 0) <=
            this.config.maxArtifactBytesTotal &&
          this.projectedCompletedRuns(usage, options.additionalRuns ?? 0) <=
            this.config.maxCompletedRuns
        ) {
          break;
        }
      }
    }
    return removed;
  }

  private async readRootNames(): Promise<string[]> {
    const names = await readdir(this.root);
    if (names.length > MAX_RESOURCE_ENTRIES) {
      throw new Error(`Resource scan exceeded its ${MAX_RESOURCE_ENTRIES} entry limit.`);
    }
    return names;
  }

  private async readReservationNames(): Promise<string[]> {
    const names = await readdir(this.reservationsDir);
    if (names.length > MAX_RESOURCE_ENTRIES) {
      throw new Error(`Reservation scan exceeded its ${MAX_RESOURCE_ENTRIES} entry limit.`);
    }
    return names;
  }

  private projectedArtifactBytes(usage: ResourceUsage, additionalRuns = 1): number {
    const reservedCapacity =
      (usage.reservations + Math.max(0, additionalRuns)) *
      (this.config.maxArtifactBytesPerRun + STRUCTURAL_ARTIFACT_HEADROOM_BYTES);
    return usage.artifactBytes + usage.activeArtifactCapacity + reservedCapacity;
  }

  private projectedCompletedRuns(usage: ResourceUsage, additionalRuns = 1): number {
    return usage.completedRuns + usage.activeRuns + usage.reservations + additionalRuns;
  }

  private async withReservationLock<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let lease: OwnedLease;
      try {
        lease = await createOwnedLease(this.reservationLock, this.now());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const lock = await lstat(this.reservationLock).catch(() => undefined);
        if (
          lock?.isFile() &&
          lock.mtimeMs < this.now() - LEASE_STALE_MS &&
          !(await leaseOwnerIsAlive(this.reservationLock, lock))
        ) {
          await removeIfSameFile(this.reservationLock, lock);
          continue;
        }
        await delay(10);
        continue;
      }
      try {
        return await operation();
      } finally {
        await releaseOwnedLease(this.reservationLock, lease);
      }
    }
    throw new Error('Timed out acquiring the tmux-bash resource reservation lock.');
  }

  private async removeStaleReservations(): Promise<void> {
    const staleBefore =
      this.now() - Math.max(LEASE_STALE_MS, this.config.adoptionScanTimeoutMs * 2);
    for (const name of await this.readReservationNames()) {
      if (!name.endsWith('.reserve')) continue;
      const path = join(this.reservationsDir, name);
      if (this.reservationLeases.has(path)) continue;
      const details = await lstat(path).catch(() => undefined);
      if (
        details?.isFile() &&
        details.mtimeMs < staleBefore &&
        !(await leaseOwnerIsAlive(path, details))
      ) {
        await removeIfSameFile(path, details);
      }
    }
  }

  private async readManifest(path: string, name: string): Promise<ManagedRunManifest> {
    let value: unknown;
    try {
      value = JSON.parse(await readPrivateRegularFile(path, MAX_MANIFEST_BYTES)) as unknown;
    } catch (error) {
      throw new Error(`Invalid managed run manifest: ${errorMessage(error)}`);
    }
    const manifest = parseManagedRunManifest(value, {
      artifactRoot: this.root,
      expectedRunId: name.slice(0, -'.manifest.json'.length),
    });
    const canonical = artifactPaths(this.root, manifest.runId);
    for (const key of ['commandFile', 'scriptFile', 'outputFile', 'exitCodeFile'] as const) {
      if (manifest[key] !== canonical[key]) {
        throw new Error(`manifest ${key} does not match its canonical run artifact path`);
      }
    }
    await validateManagedRunManifestPaths(manifest, this.root, { realpath, lstat });
    return manifest;
  }
}

function assertRunId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(runId))
    throw new Error('Invalid tmux-bash run ID.');
  return runId;
}

function isCleanupState(state: ManagedRunManifest['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'killed' || state === 'orphaned';
}

function isSettledCleanupDelivery(manifest: ManagedRunManifest): boolean {
  if (manifest.deliveryState === 'delivered' || manifest.deliveryState === 'persisted') {
    return true;
  }
  if (manifest.deliveryState !== 'failed') return false;
  return manifest.state === 'killed' || manifest.completionDeliveryExhausted === true;
}

async function createOwnedLease(path: string, now: number): Promise<OwnedLease> {
  const handle = await open(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW |
      fsConstants.O_NONBLOCK,
    0o600,
  );
  let stats: Stats | undefined;
  try {
    stats = await handle.stat({ bigint: false });
    await handle.writeFile(`${process.pid} ${now}\n`, 'utf8');
    return { handle, stats };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (stats) await removeIfSameFile(path, stats);
    throw error;
  }
}

async function releaseOwnedLease(path: string, lease: OwnedLease): Promise<void> {
  try {
    await lease.handle.close();
  } finally {
    await removeIfSameFile(path, lease.stats);
  }
}

async function removeIfSameFile(path: string, expected: Pick<Stats, 'dev' | 'ino'>): Promise<void> {
  const current = await lstat(path).catch(() => undefined);
  if (current?.dev === expected.dev && current.ino === expected.ino) {
    await rm(path, { force: true });
  }
}

async function leaseOwnerIsAlive(path: string, expected: Stats): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const actual = await handle.stat({ bigint: false });
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) return true;
    if (actual.size > MAX_LEASE_BYTES) return true;
    const buffer = Buffer.alloc(MAX_LEASE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_LEASE_BYTES) return true;
    const match = /^(\d+)\s/.exec(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!match) return true;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid < 1) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  } catch {
    return true;
  } finally {
    await handle?.close();
  }
}

async function readPrivateRegularFile(path: string, maximumBytes: number): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const stats = await handle.stat({ bigint: false });
    if (!stats.isFile()) throw new Error('file is not a regular file');
    if ((stats.mode & 0o077) !== 0) throw new Error('file permissions are not private');
    if (
      typeof stats.uid === 'number' &&
      typeof process.getuid === 'function' &&
      stats.uid !== process.getuid()
    ) {
      throw new Error('file has unexpected ownership');
    }
    if (stats.size > maximumBytes) throw new Error(`file exceeds ${maximumBytes} bytes`);
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) throw new Error(`file exceeds ${maximumBytes} bytes`);
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle?.close();
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  const details = await lstat(path).catch(() => undefined);
  return Boolean(details?.isFile() && !details.isSymbolicLink());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
