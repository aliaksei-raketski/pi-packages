import {
  parseManagedRunManifest,
  validateManagedRunManifestPaths,
  type ManagedRunManifest,
} from '@aliaksei-raketski/pi-tmux-bash-core';
import { lstat, mkdir, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';

import type { TmuxBashConfig } from './types.js';

const MAX_RESOURCE_ENTRIES = 100_000;

export interface ResourceUsage {
  artifactBytes: number;
  activeRuns: number;
  completedRuns: number;
  reservations: number;
}

export interface CleanupCandidate {
  runId: string;
  state: string;
  ageMs: number;
  bytes: number;
  files: string[];
  manifest: ManagedRunManifest;
}

export class ResourceManager {
  private readonly reservationsDir: string;
  private readonly reservationLock: string;

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
      if (this.projectedArtifactBytes(usage) > this.config.maxArtifactBytesTotal) {
        await this.cleanup({
          automatic: true,
          isLiveOwnedWindow: options.isCleanupProtectedWindow,
          isActiveRun: options.isActiveRun,
        });
        const refreshed = await this.usage({ isActiveRun: options.isActiveRun });
        if (this.projectedArtifactBytes(refreshed) > this.config.maxArtifactBytesTotal) {
          throw new Error(
            `tmux-bash artifact quota (${this.config.maxArtifactBytesTotal} bytes) reached. Run tmux cleanup-preview and tmux cleanup.`,
          );
        }
      }
      const path = join(this.reservationsDir, `${assertRunId(runId)}.reserve`);
      try {
        await writeFile(path, `${process.pid} ${this.now()}\n`, { mode: 0o600, flag: 'wx' });
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
    await rm(path, { force: true });
  }

  async usage(
    options: { isActiveRun?: (manifest: ManagedRunManifest) => Promise<boolean> } = {},
  ): Promise<ResourceUsage> {
    await this.initialize();
    const names = await this.readRootNames();
    let artifactBytes = 0;
    let activeRuns = 0;
    let completedRuns = 0;
    for (const name of names) {
      const path = join(this.root, name);
      const details = await lstat(path).catch(() => undefined);
      if (!details || details.isSymbolicLink() || !details.isFile()) continue;
      artifactBytes += details.size;
      if (!name.endsWith('.manifest.json')) continue;
      const manifest = await this.readManifest(path, name).catch(() => undefined);
      if (!manifest) continue;
      if (manifest.state === 'running' || manifest.state === 'starting') {
        if (!options.isActiveRun || (await options.isActiveRun(manifest))) activeRuns += 1;
      } else if (isCleanupState(manifest.state)) completedRuns += 1;
    }
    const reservations = (await this.readReservationNames()).filter((name) =>
      name.endsWith('.reserve'),
    ).length;
    return { artifactBytes, activeRuns, completedRuns, reservations };
  }

  async preview(options: { includeYoung?: boolean } = {}): Promise<CleanupCandidate[]> {
    await this.initialize();
    const names = await this.readRootNames();
    const manifests: ManagedRunManifest[] = [];
    for (const name of names.filter((candidate) => candidate.endsWith('.manifest.json'))) {
      const manifest = await this.readManifest(join(this.root, name), name).catch(() => undefined);
      if (manifest && isCleanupState(manifest.state)) manifests.push(manifest);
    }
    manifests.sort(
      (left, right) => (left.endedAt ?? left.updatedAt) - (right.endedAt ?? right.updatedAt),
    );
    const overflow = Math.max(0, manifests.length - this.config.maxCompletedRuns);
    const filesByRunId = new Map<string, Array<{ path: string; bytes: number }>>();
    for (const name of names) {
      const runId = name.split('.', 1)[0] ?? '';
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(runId)) continue;
      const path = join(this.root, name);
      const details = await lstat(path).catch(() => undefined);
      if (!details?.isFile() || details.isSymbolicLink()) continue;
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
    } = {},
  ): Promise<CleanupCandidate[]> {
    const candidates = await this.preview({ includeYoung: options.includeYoung });
    const removed: CleanupCandidate[] = [];
    for (const candidate of candidates) {
      if (
        candidate.manifest.windowId &&
        (!options.isLiveOwnedWindow || (await options.isLiveOwnedWindow(candidate.manifest)))
      ) {
        continue;
      }
      for (const path of candidate.files) {
        const details = await lstat(path).catch(() => undefined);
        if (!details || details.isSymbolicLink() || !details.isFile()) continue;
        if (!path.startsWith(`${this.root}/`)) continue;
        await rm(path, { force: true });
      }
      removed.push(candidate);
      if (options.automatic) {
        const usage = await this.usage({ isActiveRun: options.isActiveRun });
        if (
          this.projectedArtifactBytes(usage) <= this.config.maxArtifactBytesTotal &&
          usage.completedRuns <= this.config.maxCompletedRuns
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

  private projectedArtifactBytes(usage: ResourceUsage): number {
    const liveCapacity =
      (usage.activeRuns + usage.reservations + 1) * this.config.maxArtifactBytesPerRun;
    return usage.artifactBytes + liveCapacity;
  }

  private async withReservationLock<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await writeFile(this.reservationLock, `${process.pid} ${this.now()}\n`, {
          mode: 0o600,
          flag: 'wx',
        });
        const heartbeat = setInterval(() => {
          const now = new Date();
          void utimes(this.reservationLock, now, now).catch(() => undefined);
        }, 10_000);
        heartbeat.unref();
        try {
          return await operation();
        } finally {
          clearInterval(heartbeat);
          await rm(this.reservationLock, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const lock = await lstat(this.reservationLock).catch(() => undefined);
        if (lock && lock.mtimeMs < this.now() - 60_000) {
          await rm(this.reservationLock, { force: true });
          continue;
        }
        await delay(10);
      }
    }
    throw new Error('Timed out acquiring the tmux-bash resource reservation lock.');
  }

  private async removeStaleReservations(): Promise<void> {
    const staleBefore = this.now() - Math.max(60_000, this.config.adoptionScanTimeoutMs * 2);
    for (const name of await this.readReservationNames()) {
      if (!name.endsWith('.reserve')) continue;
      const path = join(this.reservationsDir, name);
      const details = await lstat(path).catch(() => undefined);
      if (details?.isFile() && details.mtimeMs < staleBefore) await rm(path, { force: true });
    }
  }

  private async readManifest(path: string, name: string): Promise<ManagedRunManifest> {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error('unsafe manifest file');
    if ((details.mode & 0o077) !== 0) throw new Error('manifest permissions are not private');
    if (
      typeof details.uid === 'number' &&
      typeof process.getuid === 'function' &&
      details.uid !== process.getuid()
    ) {
      throw new Error('manifest has unexpected ownership');
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Invalid managed run manifest JSON: ${errorMessage(error)}`);
    }
    const manifest = parseManagedRunManifest(value, {
      artifactRoot: this.root,
      expectedRunId: name.slice(0, -'.manifest.json'.length),
    });
    await validateManagedRunManifestPaths(manifest, this.root, { realpath, lstat });
    return manifest;
  }
}

function assertRunId(runId: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(runId)) throw new Error('Invalid tmux-bash run ID.');
  return runId;
}

function isCleanupState(state: ManagedRunManifest['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'killed' || state === 'orphaned';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
