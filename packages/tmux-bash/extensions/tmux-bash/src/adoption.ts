import {
  sameManagedWindowOwner,
  TMUX_BASH_OWNERSHIP_MARKER,
  type ManagedRunManifest,
  type TmuxWorkspaceScope,
} from '@aliaksei-raketski/pi-tmux-bash-core';

import { readExitCode } from './output.js';
import { RunStore } from './run-store.js';
import { sanitizeTerminalText } from './sanitize.js';
import { TmuxClient } from './tmux-client.js';
import type { CommandRun, TmuxBashConfig } from './types.js';

export interface AdoptionResult {
  live: CommandRun[];
  completed: CommandRun[];
  orphaned: CommandRun[];
  diagnostics: string[];
}

export async function discoverAndReconcileRuns(input: {
  config: TmuxBashConfig;
  tmux: TmuxClient;
  store: RunStore;
  sessionId: string;
  scope: TmuxWorkspaceScope;
}): Promise<AdoptionResult> {
  const result: AdoptionResult = { live: [], completed: [], orphaned: [], diagnostics: [] };
  if (input.config.adoptionPolicy === 'off') return result;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.config.adoptionScanTimeoutMs);
  timeout.unref();
  try {
    const loaded = await input.store.loadAll({ signal: controller.signal });
    result.diagnostics.push(
      ...loaded.diagnostics.map((item) => boundedDiagnostic(`${item.path}: ${item.reason}`)),
    );
    let windows = new Map<string, Awaited<ReturnType<TmuxClient['listManaged']>>[number]>();
    try {
      const discovered = await input.tmux.listManaged({
        scope: input.scope,
        piSessionId: input.sessionId,
        signal: controller.signal,
      });
      windows = new Map(discovered.map((window) => [window.metadata.runId, window]));
    } catch (error) {
      result.diagnostics.push(
        boundedDiagnostic(`tmux discovery unavailable: ${errorMessage(error)}`),
      );
    }

    const newest = new Map<string, { manifest: ManagedRunManifest; path: string }>();
    for (const candidate of loaded.manifests) {
      if (candidate.manifest.piSessionId !== input.sessionId) continue;
      if (!matchesScope(candidate.manifest.scope, input.scope)) continue;
      const previous = newest.get(candidate.manifest.runId);
      if (!previous || previous.manifest.updatedAt < candidate.manifest.updatedAt) {
        newest.set(candidate.manifest.runId, candidate);
      }
    }

    for (const candidate of newest.values()) {
      const manifest = candidate.manifest;
      if (isHistorical(manifest)) continue;
      const run = input.store.fromManifest(manifest);
      const exitCode = manifest.exitCode ?? (await readExitCode(run.exitCodeFile));
      if (exitCode !== undefined && manifest.state !== 'killed' && manifest.state !== 'orphaned') {
        run.exitCode = exitCode;
        run.endedAt ??= Date.now();
        run.state = exitCode === 0 ? 'completed' : 'failed';
        run.backgroundReady = false;
        result.completed.push(run);
        continue;
      }

      const window = windows.get(run.runId);
      if (window && ownsManifest(window.windowId, window.metadata, manifest, candidate.path)) {
        run.windowId = window.windowId;
        run.mode = 'background';
        run.state = 'running';
        run.backgroundReady = true;
        result.live.push(run);
        continue;
      }

      run.state = 'orphaned';
      run.endedAt ??= Date.now();
      run.awaited = false;
      run.deliveryState = 'failed';
      await input.store.persist(run);
      result.orphaned.push(run);
      result.diagnostics.push(
        boundedDiagnostic(
          `${run.runId} was orphaned because no validated owned tmux window or exit sentinel exists.`,
        ),
      );
    }
  } catch (error) {
    result.diagnostics.push(boundedDiagnostic(`adoption scan failed: ${errorMessage(error)}`));
  } finally {
    clearTimeout(timeout);
  }
  return result;
}

function ownsManifest(
  windowId: string,
  metadata: Awaited<ReturnType<TmuxClient['getMetadata']>> & {},
  manifest: ManagedRunManifest,
  manifestPath: string,
): boolean {
  if (manifest.windowId !== undefined && manifest.windowId !== windowId) return false;
  return sameManagedWindowOwner(metadata, {
    owner: TMUX_BASH_OWNERSHIP_MARKER,
    scope: manifest.scope,
    piSessionId: manifest.piSessionId,
    runId: manifest.runId,
    manifestPath,
    completionId: manifest.completionId,
    completionDelivery: manifest.completionDelivery,
  });
}

function matchesScope(
  left: Pick<TmuxWorkspaceScope, 'kind' | 'root' | 'hash'>,
  right: Pick<TmuxWorkspaceScope, 'kind' | 'root' | 'hash'>,
): boolean {
  return (['kind', 'root', 'hash'] as const).every((key) => left[key] === right[key]);
}

function isHistorical(manifest: ManagedRunManifest): boolean {
  if (manifest.state === 'killed' || manifest.state === 'orphaned') return true;
  if (manifest.state !== 'completed' && manifest.state !== 'failed') return false;
  return manifest.deliveryState === 'delivered' || manifest.deliveryState === 'persisted';
}

function boundedDiagnostic(value: string): string {
  const sanitized = sanitizeTerminalText(value);
  return sanitized.length <= 2_000 ? sanitized : `${sanitized.slice(0, 1_999)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
