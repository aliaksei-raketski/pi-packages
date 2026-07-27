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
  undelivered: CommandRun[];
  diagnostics: string[];
}

export async function discoverAndReconcileRuns(input: {
  config: TmuxBashConfig;
  tmux: TmuxClient;
  store: RunStore;
  sessionId: string;
  scope: TmuxWorkspaceScope;
}): Promise<AdoptionResult> {
  const result: AdoptionResult = {
    live: [],
    completed: [],
    orphaned: [],
    undelivered: [],
    diagnostics: [],
  };
  if (input.config.adoptionPolicy === 'off') return result;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.config.adoptionScanTimeoutMs);
  timeout.unref();
  const killOwnedWindow = async (
    windowId: string,
    manifest: ManagedRunManifest,
    manifestPath: string,
  ): Promise<boolean> => {
    const owned = await input.tmux.isOwnedWindow(
      windowId,
      {
        owner: TMUX_BASH_OWNERSHIP_MARKER,
        scope: manifest.scope,
        piSessionId: manifest.piSessionId,
        runId: manifest.runId,
        manifestPath,
        completionId: manifest.completionId,
        completionDelivery: manifest.completionDelivery,
      },
      controller.signal,
    );
    if (!owned) return false;
    await input.tmux.killWindow(windowId, controller.signal);
    return true;
  };
  const preserveLiveRun = async (run: CommandRun) => {
    run.mode = 'background';
    run.state = 'running';
    run.endedAt = undefined;
    run.exitCode = undefined;
    run.killed = false;
    run.backgroundReady = true;
    run.completionClaimed = false;
    run.completionDelivered = false;
    run.completionDeliveryFailed = false;
    run.completionDeliveryExhausted = false;
    run.deliveryState = 'pending';
    await input.store.persist(run, controller.signal);
    result.live.push(run);
  };
  try {
    const loaded = await input.store.loadAll({ signal: controller.signal });
    result.diagnostics.push(
      ...loaded.diagnostics.map((item) => boundedDiagnostic(`${item.path}: ${item.reason}`)),
    );
    let windows: Map<string, Awaited<ReturnType<TmuxClient['listManaged']>>>;
    try {
      const discovered = await input.tmux.listManaged({
        scope: input.scope,
        piSessionId: input.sessionId,
        signal: controller.signal,
      });
      windows = new Map();
      for (const window of discovered) {
        const candidates = windows.get(window.metadata.runId) ?? [];
        candidates.push(window);
        windows.set(window.metadata.runId, candidates);
      }
    } catch (error) {
      result.diagnostics.push(
        boundedDiagnostic(`tmux discovery unavailable: ${errorMessage(error)}`),
      );
      return result;
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
      throwIfAborted(controller.signal);
      const manifest = candidate.manifest;
      const run = input.store.fromManifest(manifest);
      const windowsForRun = windows.get(run.runId) ?? [];
      const window =
        windowsForRun.find((candidateWindow) =>
          ownsManifest(
            candidateWindow.windowId,
            candidateWindow.metadata,
            manifest,
            candidate.path,
          ),
        ) ?? windowsForRun[0];
      if (isHistorical(manifest)) {
        for (const historicalWindow of windowsForRun) {
          if (
            !ownsManifest(
              historicalWindow.windowId,
              historicalWindow.metadata,
              manifest,
              candidate.path,
              { ignoreWindowId: true },
            )
          ) {
            continue;
          }
          try {
            if (!(await killOwnedWindow(historicalWindow.windowId, manifest, candidate.path))) {
              result.diagnostics.push(
                boundedDiagnostic(`${run.runId} historical window closure was not confirmed.`),
              );
            }
          } catch (error) {
            result.diagnostics.push(
              boundedDiagnostic(
                `${run.runId} historical window could not be closed: ${errorMessage(error)}`,
              ),
            );
          }
        }
        continue;
      }
      if (manifest.state === 'orphaned' && !isHistorical(manifest)) {
        if (await input.store.claimCompletion(run.runId)) {
          result.undelivered.push(run);
        }
        continue;
      }
      let exitCode: number | undefined;
      try {
        exitCode = manifest.exitCode ?? (await readExitCode(run.exitCodeFile));
      } catch (error) {
        let killFailed = false;
        if (window && ownsManifest(window.windowId, window.metadata, manifest, candidate.path)) {
          try {
            if (!(await killOwnedWindow(window.windowId, manifest, candidate.path))) {
              killFailed = true;
              result.diagnostics.push(
                boundedDiagnostic(
                  `${run.runId} termination could not be confirmed after an invalid exit sentinel.`,
                ),
              );
            }
          } catch (killError) {
            killFailed = true;
            result.diagnostics.push(
              boundedDiagnostic(
                `${run.runId} could not terminate after an invalid exit sentinel: ${errorMessage(killError)}`,
              ),
            );
          }
        }
        if (killFailed) {
          await preserveLiveRun(run);
          continue;
        }
        run.state = 'orphaned';
        run.endedAt ??= Date.now();
        run.awaited = false;
        run.deliveryState = 'failed';
        run.completionDeliveryFailed = true;
        await input.store.persist(run, controller.signal);
        result.orphaned.push(run);
        result.diagnostics.push(
          boundedDiagnostic(
            `${run.runId} was orphaned after an invalid exit sentinel: ${errorMessage(error)}`,
          ),
        );
        continue;
      }
      const ownedWindow =
        window !== undefined &&
        ownsManifest(window.windowId, window.metadata, manifest, candidate.path);
      if (ownedWindow && exitCode === undefined) {
        const dead = await input.tmux.isPaneDead(window.windowId, controller.signal);
        if (dead) {
          // The wrapper may have published the sentinel immediately after this
          // check, so read it again before classifying the pane as orphaned.
          try {
            exitCode = await readExitCode(run.exitCodeFile);
          } catch (error) {
            let killFailed = false;
            try {
              if (!(await killOwnedWindow(window.windowId, manifest, candidate.path))) {
                killFailed = true;
                result.diagnostics.push(
                  boundedDiagnostic(
                    `${run.runId} termination could not be confirmed after an invalid exit sentinel.`,
                  ),
                );
              }
            } catch (killError) {
              killFailed = true;
              result.diagnostics.push(
                boundedDiagnostic(
                  `${run.runId} could not terminate after an invalid exit sentinel: ${errorMessage(killError)}`,
                ),
              );
            }
            if (killFailed) {
              await preserveLiveRun(run);
              continue;
            }
            run.state = 'orphaned';
            run.endedAt ??= Date.now();
            run.awaited = false;
            run.deliveryState = 'failed';
            run.completionDeliveryFailed = true;
            await input.store.persist(run, controller.signal);
            result.orphaned.push(run);
            result.diagnostics.push(
              boundedDiagnostic(
                `${run.runId} was orphaned after an invalid exit sentinel: ${errorMessage(error)}`,
              ),
            );
            continue;
          }
          if (exitCode === undefined) {
            run.state = 'orphaned';
            run.endedAt ??= Date.now();
            run.awaited = false;
            run.deliveryState = 'failed';
            run.completionDeliveryFailed = true;
            await input.store.persist(run, controller.signal);
            result.orphaned.push(run);
            result.diagnostics.push(
              boundedDiagnostic(
                `${run.runId} was orphaned because its owned tmux pane died without an exit sentinel.`,
              ),
            );
            continue;
          }
        }
      }

      if (manifest.origin === 'user-bash') {
        let closeFailed = false;
        if (ownedWindow && window) {
          try {
            if (!(await killOwnedWindow(window.windowId, manifest, candidate.path))) {
              closeFailed = true;
              result.diagnostics.push(
                boundedDiagnostic(`${run.runId} user-bash termination could not be confirmed.`),
              );
            }
          } catch (error) {
            closeFailed = true;
            result.diagnostics.push(
              boundedDiagnostic(
                `${run.runId} could not close its user-bash window: ${errorMessage(error)}`,
              ),
            );
          }
        }
        if (closeFailed && exitCode === undefined) {
          await preserveLiveRun(run);
          continue;
        }
        run.backgroundReady = false;
        run.awaited = false;
        run.endedAt ??= Date.now();
        if (exitCode === undefined) {
          run.state = 'orphaned';
          run.deliveryState = 'failed';
          run.completionDeliveryFailed = true;
        } else if (manifest.state !== 'killed' && manifest.state !== 'orphaned') {
          run.exitCode = exitCode;
          run.state = exitCode === 0 ? 'completed' : 'failed';
          run.deliveryState = 'delivered';
          run.completionClaimed = true;
          run.completionDelivered = true;
        }
        await input.store.persist(run, controller.signal);
        result.orphaned.push(run);
        result.diagnostics.push(
          boundedDiagnostic(`${run.runId} was not adopted because it originated from user-bash.`),
        );
        continue;
      }

      if (exitCode !== undefined && manifest.state !== 'killed' && manifest.state !== 'orphaned') {
        run.exitCode = exitCode;
        run.endedAt ??= Date.now();
        run.state = exitCode === 0 ? 'completed' : 'failed';
        run.backgroundReady = false;
        // Keep a completed run in the active runtime even when another scanner
        // temporarily owns its delivery claim. The supervisor will retry the
        // claim instead of silently dropping an undelivered completion.
        await input.store.claimCompletion(run.runId);
        result.completed.push(run);
        continue;
      }

      if (ownedWindow) {
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
      await input.store.persist(run, controller.signal);
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
  options: { ignoreWindowId?: boolean } = {},
): boolean {
  if (
    !options.ignoreWindowId &&
    manifest.windowId !== undefined &&
    manifest.windowId !== windowId
  ) {
    return false;
  }
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
  if (manifest.state === 'killed') return true;
  if (manifest.state === 'orphaned') {
    return (
      manifest.deliveryState === 'delivered' ||
      manifest.deliveryState === 'persisted' ||
      (manifest.deliveryState === 'failed' && manifest.completionDeliveryExhausted === true)
    );
  }
  if (manifest.state !== 'completed' && manifest.state !== 'failed') return false;
  return (
    manifest.deliveryState === 'delivered' ||
    manifest.deliveryState === 'persisted' ||
    (manifest.deliveryState === 'failed' && manifest.completionDeliveryExhausted === true)
  );
}

function boundedDiagnostic(value: string): string {
  const sanitized = sanitizeTerminalText(value);
  return sanitized.length <= 2_000 ? sanitized : `${sanitized.slice(0, 1_999)}…`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Adoption scan aborted.');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
