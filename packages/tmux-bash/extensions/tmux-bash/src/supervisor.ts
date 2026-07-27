import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  CONTINUATION_GATE_DEFAULT_DOMAIN,
  type ContinuationGateController,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import {
  sameManagedWindowOwner,
  TMUX_BASH_OWNERSHIP_MARKER,
  type CompletionDelivery,
  type ManagedRunManifest,
  type TmuxWorkspaceScope,
} from '@aliaksei-raketski/pi-tmux-bash-core';
import { createReadStream, watch, type ReadStream } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { clampPollInterval, clampTimeout } from './config.js';
import {
  createCommandArtifacts,
  createPiSessionEnvironment,
  createUserBashEnvironment,
  PI_SESSION_ENVIRONMENT_VARIABLES,
  removeUncommittedArtifacts,
  scheduleRunArtifactCleanup,
} from './command-artifacts.js';
import { formatOutput, readExitCode, readOutput, type OutputTail } from './output.js';
import type { BashInput } from './schemas.js';
import { discoverAndReconcileRuns } from './adoption.js';
import { CompletionDeliveryService } from './completion.js';
import { ArtifactQuotaError, ResourceManager } from './resource-manager.js';
import { RunStore } from './run-store.js';
import { validateInteractiveKey, validateLiteralInput } from './interactive-input.js';
import { sanitizeTerminalText } from './sanitize.js';
import { updateTmuxBashStatus } from './status.js';
import { TmuxClient } from './tmux-client.js';
import {
  deriveTmuxSession,
  deriveWindowName,
  resolveWorkspaceScope,
  shortHash,
} from './tmux-scope.js';
import {
  TMUX_BASH_COMPLETION_MESSAGE,
  TMUX_BASH_DISPLAY_COMPLETION,
  type CommandArtifacts,
  type CommandRun,
  type InteractiveKey,
  type Poller,
  type TmuxBashConfig,
  type TmuxBashDetails,
  type TmuxBashRuntimeState,
  type TmuxToolDetails,
} from './types.js';

const BACKGROUND_COMPLETION_SCAN_INTERVAL_MS = 250;
const PANE_HEALTH_CHECK_INTERVAL_MS = 2_000;
const MAX_LIST_RESULT_BYTES = 64 * 1024;
const MAX_TMUX_RESULT_RUNS = 100;

export class TmuxBashSupervisor {
  readonly state: TmuxBashRuntimeState;
  private runStore?: RunStore;
  private resources?: ResourceManager;
  private completion?: CompletionDeliveryService;
  private resourceScanTimer?: ReturnType<typeof setInterval>;
  private readonly sessionArtifacts = new Map<string, string>();
  private readonly reportedDetachedFailures = new Set<string>();

  constructor(
    private readonly pi: ExtensionAPI,
    readonly config: TmuxBashConfig,
    gateController: ContinuationGateController,
    private readonly tmux = new TmuxClient(config.tmuxBinary),
  ) {
    this.state = {
      runDir: null,
      commands: new Map(),
      watcher: null,
      completionMonitor: null,
      pollers: new Map(),
      gateController,
      statusContext: null,
      disposed: false,
    };
  }

  private runDirectory(scope: TmuxWorkspaceScope | undefined, sessionId: string): string {
    const parent =
      this.config.adoptionPolicy === 'same-pi-session'
        ? this.config.durableOutputDir
        : this.config.outputDir || this.config.durableOutputDir;
    return scope ? join(parent, scope.hash) : join(parent, `pi-tmux-${shortHash(sessionId, 12)}`);
  }

  private async activateRunDirectory(
    runDir: string,
    scope: TmuxWorkspaceScope | undefined,
  ): Promise<void> {
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    this.state.runDir = runDir;
    this.state.currentScope = scope;
    const store = new RunStore(runDir);
    const resources = new ResourceManager(runDir, this.config);
    this.runStore = store;
    this.resources = resources;
    this.completion = new CompletionDeliveryService(this.pi, store, this.state.gateController);
    await store.initialize();
    await resources.initialize();
  }

  private async runtimeForScope(
    scope: TmuxWorkspaceScope,
    sessionId: string,
  ): Promise<{ runDir: string; store: RunStore; resources: ResourceManager }> {
    const runDir = this.runDirectory(scope, sessionId);
    if (this.state.runDir === runDir && this.runStore && this.resources) {
      return { runDir, store: this.runStore, resources: this.resources };
    }
    const store = new RunStore(runDir);
    const resources = new ResourceManager(runDir, this.config);
    await store.initialize();
    await resources.initialize();
    return { runDir, store, resources };
  }

  async startSession(ctx: ExtensionContext): Promise<void> {
    if (this.state.runDir) await this.shutdown(ctx);
    this.state.disposed = false;
    this.state.statusContext = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    const scope = await resolveWorkspaceScope(this.config, ctx.cwd);
    const runDir = this.runDirectory(scope, sessionId);
    await this.activateRunDirectory(runDir, scope);
    const store = this.runStore;
    const resources = this.resources;
    if (!store || !resources) throw new Error('tmux-bash artifact store initialization failed.');

    if (scope && this.config.adoptionPolicy === 'same-pi-session') {
      const adopted = await discoverAndReconcileRuns({
        config: this.config,
        tmux: this.tmux,
        store,
        sessionId,
        scope,
      });
      for (const run of [
        ...adopted.live,
        ...adopted.completed,
        ...adopted.orphaned,
        ...adopted.undelivered,
      ]) {
        this.state.commands.set(run.runId, run);
      }
      for (const run of adopted.live) {
        if (run.awaited) this.acquireGate(run);
        if (this.config.adoptPolling && run.polling) {
          this.startPoll(run, run.polling.intervalSeconds, run.polling.lines);
        }
      }
      if (adopted.live.length > 0) this.ensureWatcher();
      for (const run of adopted.completed) {
        await this.finishBackgroundCompletion(run, run.exitCode ?? 1, true);
      }
      for (const run of adopted.undelivered) {
        await this.deliverOrphanCompletion(run);
      }
      if (adopted.diagnostics.length > 0) {
        ctx.ui.notify(adopted.diagnostics.slice(0, 5).join('\n'), 'warning');
      }
    }
    if (this.config.quotaPolicy === 'cleanup-completed') {
      await resources.cleanup({
        automatic: true,
        isLiveOwnedWindow: (manifest) => this.isLiveOwnedManifest(manifest),
        isActiveRun: (manifest) => this.isValidatedActiveManifest(manifest),
        isCleanupProtectedRun: (manifest) => this.isCleanupProtectedManifest(manifest),
      });
      this.resourceScanTimer = setInterval(() => {
        void this.resources
          ?.cleanup({
            automatic: true,
            isLiveOwnedWindow: (manifest) => this.isLiveOwnedManifest(manifest),
            isActiveRun: (manifest) => this.isValidatedActiveManifest(manifest),
            isCleanupProtectedRun: (manifest) => this.isCleanupProtectedManifest(manifest),
          })
          .catch((error: unknown) => this.reportDetachedFailure('resource cleanup', error));
      }, this.config.resourceScanIntervalSeconds * 1_000);
      this.resourceScanTimer.unref();
    }
    this.state.gateController.publishSnapshot(sessionId);
    this.publishStatus();
  }

  async shutdown(ctx?: ExtensionContext): Promise<void> {
    if (this.state.disposed) return;
    this.state.disposed = true;
    this.state.watcher?.close();
    this.state.watcher = null;
    if (this.resourceScanTimer) clearInterval(this.resourceScanTimer);
    this.resourceScanTimer = undefined;
    if (this.state.completionMonitor) clearInterval(this.state.completionMonitor);
    this.state.completionMonitor = null;
    for (const poller of this.state.pollers.values()) clearInterval(poller.timer);
    this.state.pollers.clear();
    for (const run of this.state.commands.values()) {
      if (!run.completionRetryTimer) continue;
      clearTimeout(run.completionRetryTimer);
      run.completionRetryTimer = undefined;
    }
    await Promise.allSettled(
      [...this.state.commands.values()].flatMap((run) => {
        const pending: Promise<unknown>[] = [];
        if (run.completionObserverPromise) pending.push(run.completionObserverPromise);
        if (run.completionPromise) pending.push(run.completionPromise);
        return pending;
      }),
    );
    const preserveForAdoption = new Set<string>();
    for (const run of this.state.commands.values()) {
      if (this.config.adoptionPolicy === 'same-pi-session' && isUnsettledRunCompletion(run)) {
        preserveForAdoption.add(run.runId);
      }
      run.awaited = Boolean(run.gateId) || run.awaited;
      if (run.killed) {
        run.state = 'killed';
        run.endedAt ??= Date.now();
      }
      if (
        isTerminalRunState(run.state) &&
        !run.completionDelivered &&
        !run.completionDeliveryFailed
      ) {
        run.completionClaimed = true;
        run.completionDeliveryFailed = true;
        run.deliveryState = 'failed';
      }
      await this.runStore?.persist(run).catch(() => undefined);
      this.releaseGate(run, 'abandoned', 'none');
    }
    if (!this.config.preserveOutputFiles) {
      for (const [runId, runDir] of this.sessionArtifacts) {
        const run = this.state.commands.get(runId);
        const isLive =
          run !== undefined &&
          !run.killed &&
          !run.endedAt &&
          (run.state === 'running' || run.state === 'starting');
        const needsAdoption =
          this.config.adoptionPolicy === 'same-pi-session' &&
          (isLive || preserveForAdoption.has(runId));
        if (needsAdoption) {
          // Durable manifests and exit sentinels must survive while Pi is offline so
          // same-session adoption can reconcile and deliver the eventual completion.
          continue;
        }
        if (isLive) {
          await scheduleRunArtifactCleanup(runDir, runId, {
            onError: (error) => this.reportDetachedFailure('artifact cleanup process', error, run),
          }).catch((error: unknown) =>
            this.reportDetachedFailure('artifact cleanup launch', error, run),
          );
        } else {
          await removeUncommittedArtifacts(runDir, runId).catch(() => undefined);
        }
      }
    }
    this.sessionArtifacts.clear();
    await this.runStore?.releaseAllCompletionClaims();

    if (ctx) updateTmuxBashStatus(this.pi, ctx, { ...this.config, statusbarEnabled: false }, []);
    this.state.runDir = null;
    this.state.statusContext = null;
    this.state.currentScope = undefined;
    this.state.commands.clear();
    this.runStore = undefined;
    this.resources = undefined;
    this.completion = undefined;
  }

  async executeBash(
    input: BashInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TmuxBashDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TmuxBashDetails>> {
    const command = input.command.trim();
    if (!command) throw new Error('bash command must not be empty.');
    const displayCommand = boundedDisplayCommand(command);
    this.assertReady(ctx);
    throwIfCancelled(signal);
    await this.tmux.checkAvailable(signal);
    throwIfCancelled(signal);

    const sessionId = ctx.sessionManager.getSessionId();
    const scope = await resolveWorkspaceScope(this.config, ctx.cwd, signal);
    if (this.state.currentScope && !matchesScope(this.state.currentScope, scope)) {
      throw new Error('tmux-bash refused a command outside the active workspace scope.');
    }
    const scopedRunDir = this.runDirectory(scope, sessionId);
    if (!this.state.currentScope || this.state.runDir !== scopedRunDir) {
      await this.activateRunDirectory(scopedRunDir, scope);
    }
    const runDir = this.state.runDir;
    const runStore = this.runStore;
    const resources = this.resources;
    if (!runDir || !runStore || !resources) {
      throw new Error('tmux-bash runtime has no artifact store.');
    }
    this.ensureWatcher();
    throwIfCancelled(signal);
    const runId = randomUUID().replaceAll('-', '');
    const completionId = randomUUID().replaceAll('-', '');
    const reservationPath = await this.reserveRunSlot(resources, runStore, runId);
    const tmuxSession = deriveTmuxSession(this.config, scope);
    let run: CommandRun | undefined;
    try {
      const artifacts = await createCommandArtifacts({
        runDir,
        runId,
        command,
        displayCommand,
        config: this.config,
        env: createPiSessionEnvironment(ctx),
      });
      this.sessionArtifacts.set(runId, runDir);
      throwIfCancelled(signal);
      const awaited = Boolean(
        input.background &&
        (input.waitForCompletion ?? this.config.defaultWaitForBackgroundCompletion),
      );
      run = this.createReservedRun({
        artifacts,
        runId,
        completionId,
        sessionId,
        scope,
        cwd: ctx.cwd,
        tmuxSession,
        command,
        displayCommand,
        mode: input.background ? 'background' : 'foreground',
        awaited,
        completionDelivery: input.completionDelivery ?? this.config.defaultCompletionDelivery,
        reservationPath,
      });
      await this.registerStartingRun(run, runStore);
      await this.validateRunSlot(resources, runStore, reservationPath);
      if (awaited) this.acquireGate(run);

      await this.launchStartingRun(run, runStore, resources, reservationPath, signal, input.name);
      throwIfCancelled(signal);
      if (run.gateId) this.acquireGate(run);
    } catch (error) {
      await resources.releaseReservation(reservationPath).catch(() => undefined);
      const killConfirmed =
        run?.windowId === undefined || (await this.tryKillOwnedWindow(run, 'launch failure'));
      if (run && !(error instanceof ArtifactQuotaError) && !killConfirmed) {
        run.reservationPath = undefined;
        if (run.windowId) {
          run.state = 'running';
          run.backgroundReady = true;
          this.ensureWatcher();
          this.observeCompletion(run);
        }
        this.releaseGate(run, 'failed', 'none');
        await runStore.persist(run).catch(() => undefined);
      } else if (run && !(error instanceof ArtifactQuotaError)) {
        run.killed = signal?.aborted ?? false;
        run.endedAt = Date.now();
        run.completionClaimed = true;
        run.deliveryState = 'failed';
        await runStore.transition(run, run.killed ? 'killed' : 'failed').catch(() => undefined);
        this.releaseGate(run, signal?.aborted ? 'cancelled' : 'failed', 'current-turn');
        this.state.commands.delete(runId);
      } else {
        if (run) this.state.commands.delete(runId);
        await removeUncommittedArtifacts(runDir, runId).catch(() => undefined);
        this.sessionArtifacts.delete(runId);
      }
      this.publishStatus();
      if (signal?.aborted) throw cancelledError();
      throw error;
    }

    if (!run) throw new Error('tmux-bash failed to initialize a managed run.');

    if (input.background) {
      try {
        throwIfCancelled(signal);
        if (input.pollInterval !== undefined) {
          this.startPoll(run, input.pollInterval, input.pollLines);
          await this.runStore?.persist(run);
        }
        this.publishStatus();
        const completed = await this.completeIfReady(run, false);
        if (completed) return completed;
        const running = await this.runningResult(run);
        throwIfCancelled(signal);
        run.backgroundReady = true;
        await this.runStore?.persist(run);
        this.observeCompletion(run);
        return running;
      } catch (error) {
        await this.failLaunchedRun(run, signal?.aborted ? 'cancelled' : 'failed', runStore).catch(
          () => false,
        );
        if (run.state !== 'running' && run.state !== 'starting') {
          this.state.commands.delete(runId);
        }
        if (signal?.aborted) throw cancelledError();
        throw error;
      }
    }

    return this.waitInForeground(run, input, signal, onUpdate);
  }

  private reserveRunSlot(
    resources: ResourceManager,
    store: RunStore,
    runId: string,
  ): Promise<string> {
    return resources.reserve(runId, {
      isActiveRun: (manifest) => this.isValidatedActiveManifest(manifest, store),
      isCleanupProtectedWindow: (manifest) => this.isLiveOwnedManifest(manifest),
      isCleanupProtectedRun: (manifest) => this.isCleanupProtectedManifest(manifest),
    });
  }

  private validateRunSlot(
    resources: ResourceManager,
    store: RunStore,
    reservationPath: string,
  ): Promise<void> {
    return resources.validateReservationCapacity(reservationPath, {
      isActiveRun: (manifest) => this.isValidatedActiveManifest(manifest, store),
      isCleanupProtectedWindow: (manifest) => this.isLiveOwnedManifest(manifest),
      isCleanupProtectedRun: (manifest) => this.isCleanupProtectedManifest(manifest),
    });
  }

  private createReservedRun(input: {
    artifacts: CommandArtifacts;
    runId: string;
    completionId: string;
    sessionId: string;
    scope: TmuxWorkspaceScope;
    cwd: string;
    tmuxSession: string;
    command: string;
    displayCommand: string;
    mode: 'foreground' | 'background';
    awaited: boolean;
    completionDelivery: CompletionDelivery;
    reservationPath: string;
    origin?: 'managed' | 'user-bash';
  }): CommandRun {
    return {
      ...input.artifacts,
      runId: input.runId,
      origin: input.origin ?? 'managed',
      completionId: input.completionId,
      sessionId: input.sessionId,
      scope: input.scope,
      cwd: input.cwd,
      tmuxSession: input.tmuxSession,
      command: input.command,
      displayCommand: input.displayCommand,
      startedAt: Date.now(),
      mode: input.mode,
      state: 'reserved',
      backgroundReady: false,
      awaited: input.awaited,
      continuationDomain: CONTINUATION_GATE_DEFAULT_DOMAIN,
      completionDelivery: input.completionDelivery,
      deliveryState: 'pending',
      completionDelivered: false,
      completionClaimed: false,
      completionDeliveryFailures: 0,
      completionDeliveryFailed: false,
      killed: false,
      adopted: false,
      outputWasRotated: false,
      reservationPath: input.reservationPath,
    };
  }

  private async registerStartingRun(run: CommandRun, store: RunStore): Promise<void> {
    this.state.commands.set(run.runId, run);
    await store.persist(run);
    await store.transition(run, 'starting');
  }

  private async launchStartingRun(
    run: CommandRun,
    store: RunStore,
    resources: ResourceManager,
    reservationPath: string,
    signal: AbortSignal | undefined,
    name?: string,
  ): Promise<void> {
    run.windowId = await this.tmux.createWindow({
      sessionName: run.tmuxSession,
      windowName: deriveWindowName(this.config, {
        name,
        runId: run.runId,
        command: run.displayCommand,
      }),
      cwd: run.cwd,
      scriptFile: run.scriptFile,
      metadata: {
        owner: TMUX_BASH_OWNERSHIP_MARKER,
        scope: run.scope,
        piSessionId: run.sessionId,
        runId: run.runId,
        manifestPath: run.manifestPath,
        completionId: run.completionId,
        completionDelivery: run.completionDelivery,
        startedAt: run.startedAt,
        displayCommand: run.displayCommand,
      },
      signal,
    });
    await store.transition(run, 'running');
    await resources.releaseReservation(reservationPath);
    run.reservationPath = undefined;
  }

  async executeUserBash(
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }> {
    const ctx = this.state.statusContext;
    if (!ctx || this.state.disposed) throw new Error('tmux-bash runtime is not active.');
    if (options.signal?.aborted) throw new Error('aborted');
    const timeoutMs = userBashTimeoutMs(options.timeout);
    const scope = await resolveWorkspaceScope(this.config, cwd, options.signal);
    const sessionId = ctx.sessionManager.getSessionId();
    const { runDir, store, resources } = await this.runtimeForScope(scope, sessionId);
    const displayCommand = boundedDisplayCommand(command);
    const runId = randomUUID().replaceAll('-', '');
    const completionId = randomUUID().replaceAll('-', '');
    const reservationPath = await this.reserveRunSlot(resources, store, runId);
    let run: CommandRun | undefined;
    let terminationAttempted = false;
    let uncertainTermination = false;
    let retainStreamDrain = false;
    let outputStream: ReadStream | undefined;
    let streamDone: Promise<void> | undefined;
    try {
      const artifacts = await createCommandArtifacts({
        runDir,
        runId,
        command,
        displayCommand,
        config: this.config,
        env: createUserBashEnvironment(options.env ?? process.env),
        unsetEnvironment: PI_SESSION_ENVIRONMENT_VARIABLES,
        streamOutput: true,
      });
      this.sessionArtifacts.set(runId, runDir);
      if (!artifacts.streamFile) throw new Error('User bash stream FIFO was not created.');
      outputStream = createReadStream(artifacts.streamFile);
      streamDone = new Promise<void>((resolve, reject) => {
        outputStream?.on('data', (chunk: string | Buffer) => {
          try {
            options.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          } catch (error) {
            reject(error);
            outputStream?.destroy();
          }
        });
        outputStream?.once('end', resolve);
        outputStream?.once('close', resolve);
        outputStream?.once('error', reject);
      });
      run = this.createReservedRun({
        artifacts,
        runId,
        completionId,
        sessionId,
        scope,
        cwd,
        tmuxSession: deriveTmuxSession(this.config, scope),
        command,
        displayCommand,
        mode: 'foreground',
        awaited: false,
        completionDelivery: this.config.defaultCompletionDelivery,
        reservationPath,
        origin: 'user-bash',
      });
      await this.registerStartingRun(run, store);
      await this.validateRunSlot(resources, store, reservationPath);
      await this.launchStartingRun(
        run,
        store,
        resources,
        reservationPath,
        options.signal,
        'user-bash',
      );
      const outcome = await this.waitForExit(run, timeoutMs, options.signal);
      if (outcome !== 'completed') {
        terminationAttempted = true;
        const termination = await this.terminateForeground(
          run,
          outcome === 'aborted' ? 'cancelled' : 'failed',
          store,
        );
        uncertainTermination = termination === 'uncertain';
        const continuation = uncertainTermination
          ? ': termination could not be confirmed; the command continues under background monitoring'
          : '';
        throw new Error(
          outcome === 'aborted'
            ? `aborted${continuation}`
            : `timeout:${options.timeout}${continuation}`,
        );
      }
      await streamDone;
      const exitCode = await readExitCode(run.exitCodeFile);
      run.exitCode = exitCode;
      run.endedAt = Date.now();
      run.deliveryState = 'delivered';
      run.completionClaimed = true;
      run.completionDelivered = true;
      await store.transition(run, exitCode === 0 ? 'completed' : 'failed');
      await this.closeCompletedWindow(run);
      return { exitCode: exitCode ?? null };
    } catch (error) {
      if (run?.windowId) {
        if (!terminationAttempted && !run.endedAt && !run.killed) {
          const cleaned = await this.failLaunchedRun(
            run,
            options.signal?.aborted ? 'cancelled' : 'failed',
            store,
          ).catch(() => false);
          uncertainTermination = !cleaned;
        }
      } else if (run) {
        this.state.commands.delete(run.runId);
        await removeUncommittedArtifacts(runDir, runId).catch(() => undefined);
        this.sessionArtifacts.delete(runId);
        run = undefined;
      }
      if (uncertainTermination && outputStream && run?.streamFile) {
        const streamPath = run.streamFile;
        if (outputStream.closed) {
          await rm(streamPath, { force: true }).catch(() => undefined);
        } else {
          retainStreamDrain = true;
          outputStream.removeAllListeners();
          outputStream.on('data', () => undefined);
          const removeStream = () => {
            void rm(streamPath, { force: true }).catch(() => undefined);
          };
          outputStream.once('close', removeStream);
          outputStream.once('error', removeStream);
        }
      }
      if (options.signal?.aborted) {
        throw new Error(
          uncertainTermination
            ? 'aborted: termination could not be confirmed; the command continues under background monitoring'
            : 'aborted',
        );
      }
      throw error;
    } finally {
      if (!retainStreamDrain) outputStream?.destroy();
      if (streamDone && !retainStreamDrain) void streamDone.catch(() => undefined);
      if (run?.streamFile && !retainStreamDrain)
        await rm(run.streamFile, { force: true }).catch(() => undefined);
      if (!run) {
        await removeUncommittedArtifacts(runDir, runId).catch(() => undefined);
        this.sessionArtifacts.delete(runId);
      }
      await resources.releaseReservation(reservationPath).catch(() => undefined);
      if (run && run.state !== 'running' && run.state !== 'starting') {
        this.state.commands.delete(run.runId);
      }
      this.publishStatus();
    }
  }

  list(ctx: ExtensionContext): CommandRun[] {
    return [...this.state.commands.values()]
      .filter((run) => this.isInScope(run, ctx))
      .sort((left, right) => left.startedAt - right.startedAt);
  }

  async peek(windowId: string, ctx: ExtensionContext, lines?: number) {
    const run = await this.requireRun(windowId, ctx);
    const output = await this.readRunOutput(run);
    const formatted = formatOutput(output, {
      maxLines: lines ?? this.config.peekContextLines,
      maxBytes: this.config.maxOutputBytes,
      fullOutputPath: run.outputFile,
    });
    return this.tmuxResult('peek', [run], formatted.text || '(no output yet)');
  }

  async kill(windowId: string, ctx: ExtensionContext) {
    const run = await this.requireRun(windowId, ctx);
    const completed = await this.completeIfReady(run, false);
    if (completed) {
      const output = completed.content[0]?.type === 'text' ? completed.content[0].text : '';
      return this.tmuxResult(
        'kill',
        [run],
        `Command already completed with exit code ${run.exitCode ?? 'unknown'}; it was not killed.\n${output}`.trim(),
      );
    }
    if (run.state === 'orphaned') {
      throw new Error(
        `Tmux window ${windowId} is missing or no longer carries this run's ownership metadata.`,
      );
    }
    if (run.endedAt || run.killed) {
      return this.tmuxResult('kill', [run], `Managed command ${windowId} is already finished.`);
    }
    if (!run.windowId || !(await this.isOwnedWindow(run))) {
      await this.failUnownedRun(run, false);
      throw new Error(`Managed tmux window ${windowId} failed its ownership revalidation.`);
    }
    const lateCompletion = await this.completeIfReady(run, false);
    if (lateCompletion) {
      const output =
        lateCompletion.content[0]?.type === 'text' ? lateCompletion.content[0].text : '';
      return this.tmuxResult(
        'kill',
        [run],
        `Command already completed with exit code ${run.exitCode ?? 'unknown'}; it was not killed.\n${output}`.trim(),
      );
    }
    await this.tmux.killWindow(run.windowId);
    run.killed = true;
    run.endedAt ??= Date.now();
    run.completionClaimed = true;
    run.deliveryState = 'failed';
    this.stopPoll(run.runId);
    this.releaseGate(run, 'killed', 'current-turn');
    await this.runStore?.transition(run, 'killed');
    this.publishStatus();
    return this.tmuxResult('kill', [run], `Killed managed tmux window ${windowId}.`);
  }

  async await(windowId: string, ctx: ExtensionContext) {
    const run = await this.requireRun(windowId, ctx);
    if (run.endedAt && !run.killed) {
      const result = await this.completedResult(run);
      return this.tmuxResult(
        'await',
        [run],
        `Command already completed with exit code ${run.exitCode ?? 'unknown'}.\n${result.content[0]?.type === 'text' ? result.content[0].text : ''}`,
      );
    }
    const completed = await this.completeIfReady(run, false);
    if (completed) {
      return this.tmuxResult(
        'await',
        [run],
        `Command already completed with exit code ${run.exitCode ?? 'unknown'}.\n${completed.content[0]?.type === 'text' ? completed.content[0].text : ''}`,
      );
    }
    if (run.killed || run.endedAt) throw new Error(`Managed command ${windowId} is not running.`);
    this.acquireGate(run);
    await this.runStore?.persist(run);
    this.publishStatus();
    return this.tmuxResult(
      'await',
      [run],
      `Awaiting ${windowId}. Synthetic continuation is suspended until completion or unawait.`,
      true,
    );
  }

  async unawait(windowId: string, ctx: ExtensionContext) {
    const run = await this.requireRun(windowId, ctx);
    const released = this.releaseGate(run, 'abandoned', 'current-turn');
    await this.runStore?.persist(run);
    this.publishStatus();
    return this.tmuxResult(
      'unawait',
      [run],
      released
        ? `Stopped awaiting ${windowId}; the command continues and completion will still be reported.`
        : `${windowId} was not awaited.`,
    );
  }

  async poll(windowId: string, ctx: ExtensionContext, interval?: number, lines?: number) {
    const run = await this.requireRun(windowId, ctx);
    const completed = await this.completeIfReady(run, false);
    if (completed) {
      const output = completed.content[0]?.type === 'text' ? completed.content[0].text : '';
      return this.tmuxResult(
        'poll',
        [run],
        `Command already completed with exit code ${run.exitCode ?? 'unknown'}.\n${output}`.trim(),
      );
    }
    if (run.endedAt || run.killed) throw new Error(`Managed command ${windowId} is not running.`);
    const poller = this.startPoll(run, interval, lines);
    await this.runStore?.persist(run);
    return this.tmuxResult(
      'poll',
      [run],
      `Polling ${windowId} every ${poller.intervalSeconds}s (${poller.lines} lines, ${this.config.pollDelivery}).`,
    );
  }

  async unpoll(windowId: string, ctx: ExtensionContext) {
    const run = await this.requireRun(windowId, ctx);
    const removed = this.stopPoll(run.runId);
    await this.runStore?.persist(run);
    return this.tmuxResult(
      'unpoll',
      [run],
      removed ? `Stopped polling ${windowId}.` : `${windowId} was not polled.`,
    );
  }

  async listResult(ctx: ExtensionContext) {
    await this.reconcile(ctx);
    const runs = this.list(ctx);
    for (const run of runs) {
      run.outputWasRotated ||= await pathExists(run.rotationMarkerFile);
    }
    const displayMarkers = undisplayedCompletionCount(ctx);
    const lines = runs.map((run) => this.describeRun(run));
    if (runs.length === 0) lines.push('No managed tmux windows in scope.');
    if (displayMarkers > 0) {
      lines.push(`${displayMarkers} display-only completion(s) were persisted without a UI.`);
    }
    let usage: ReturnType<TmuxBashSupervisor['resourceUsageDetails']> | undefined;
    if (this.resources) {
      usage = this.resourceUsageDetails(
        await this.resources.usage({
          isActiveRun: (manifest) => this.isValidatedActiveManifest(manifest),
        }),
      );
      lines.push(
        `Usage: ${usage.activeRuns} active, ${usage.reservations} reserved, ${usage.artifactBytes}/${this.config.maxArtifactBytesTotal} artifact bytes, ${usage.completedRuns}/${this.config.maxCompletedRuns} completed runs.`,
      );
    }
    const result = this.tmuxResult('list', runs, boundedLines(lines, MAX_LIST_RESULT_BYTES));
    if (usage) result.details.usage = usage;
    return result;
  }

  async listPollsResult(ctx: ExtensionContext) {
    await this.reconcile(ctx);
    const runs = this.list(ctx).filter((run) => this.state.pollers.has(run.runId));
    if (runs.length === 0)
      return this.tmuxResult('list-polls', [], 'No active tmux polls in scope.');
    const lines = runs.flatMap((run) => {
      const poller = this.state.pollers.get(run.runId);
      return poller
        ? [`${run.windowId}: every ${poller.intervalSeconds}s, ${poller.lines} lines`]
        : [];
    });
    return this.tmuxResult('list-polls', runs, boundedLines(lines, MAX_LIST_RESULT_BYTES));
  }

  async sendInput(windowId: string, text: string, submit: boolean, ctx: ExtensionContext) {
    this.assertActionEnabled('send-input');
    validateLiteralInput(this.config, text);
    const run = await this.requireLiveOwnedRun(windowId, ctx);
    await this.tmux.sendLiteralInput(windowId, text, submit, async () => {
      if (!(await this.isOwnedWindow(run))) {
        await this.failUnownedRun(run, false);
        throw new Error(`Managed tmux window ${windowId} failed its ownership revalidation.`);
      }
    });
    return this.peekAfterInput('send-input', run);
  }

  async sendKey(windowId: string, key: InteractiveKey, ctx: ExtensionContext) {
    this.assertActionEnabled('send-key');
    validateInteractiveKey(this.config, key);
    const run = await this.requireLiveOwnedRun(windowId, ctx);
    await this.tmux.sendKey(windowId, key);
    return this.peekAfterInput('send-key', run);
  }

  async attach(windowId: string, ctx: ExtensionContext) {
    this.assertActionEnabled('attach');
    const run = await this.requireLiveOwnedRun(windowId, ctx);
    const command = this.tmux.attachCommand(run.tmuxSession, windowId);
    const result = this.tmuxResult(
      'attach',
      [run],
      `Managed tmux window ${windowId}.\nAttach command: ${command.display}`,
    );
    result.details.attach = { ...command, insideTmux: Boolean(process.env.TMUX) };
    return result;
  }

  async cleanupPreview(ctx: ExtensionContext, includeYoung = false) {
    this.assertActionEnabled('cleanup-preview');
    this.assertReady(ctx);
    const resources = this.resources;
    if (!resources) throw new Error('tmux-bash resource manager is unavailable.');
    const candidates = await resources.preview({
      includeYoung,
      isActiveRun: (manifest) => this.isValidatedActiveManifest(manifest),
      isCleanupProtectedRun: (manifest) => this.isCleanupProtectedManifest(manifest),
    });
    const listedCandidates = candidates.slice(0, 100);
    const text = candidates.length
      ? [
          ...listedCandidates.map(
            (candidate) => `${candidate.runId} [${candidate.state}] ${candidate.bytes} bytes`,
          ),
          ...(candidates.length > listedCandidates.length
            ? [`… ${candidates.length - listedCandidates.length} additional candidate(s) omitted.`]
            : []),
        ].join('\n')
      : 'No completed, orphaned, or inactive crash-leftover tmux artifacts are eligible for cleanup.';
    const result = this.tmuxResult('cleanup-preview', [], text);
    result.details.cleanup = listedCandidates.map((candidate) => ({
      runId: candidate.runId,
      ageMs: candidate.ageMs,
      bytes: candidate.bytes,
      state: candidate.state,
    }));
    result.details.cleanupSummary = {
      candidateCount: candidates.length,
      reclaimableBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
      truncated: candidates.length > listedCandidates.length,
    };
    result.details.usage = this.resourceUsageDetails(
      await resources.usage({
        isActiveRun: (manifest) => this.isValidatedActiveManifest(manifest),
      }),
    );
    return result;
  }

  async cleanup(ctx: ExtensionContext, includeYoung = false, approvedRunIds?: readonly string[]) {
    this.assertActionEnabled('cleanup');
    this.assertReady(ctx);
    const resources = this.resources;
    if (!resources) throw new Error('tmux-bash resource manager is unavailable.');
    const removed = await resources.cleanup({
      includeYoung,
      isLiveOwnedWindow: (manifest) => this.isLiveOwnedManifest(manifest),
      isActiveRun: (manifest) => this.isValidatedActiveManifest(manifest),
      isCleanupProtectedRun: (manifest) => this.isCleanupProtectedManifest(manifest),
      ...(approvedRunIds === undefined ? {} : { runIds: new Set(approvedRunIds) }),
    });
    for (const candidate of removed) {
      const run = this.state.commands.get(candidate.runId);
      if (run?.completionRetryTimer) clearTimeout(run.completionRetryTimer);
      this.stopPoll(candidate.runId);
      this.state.commands.delete(candidate.runId);
    }
    const result = this.tmuxResult(
      'cleanup',
      [],
      removed.length
        ? `Removed ${removed.length} validated inactive run(s), reclaiming ${removed.reduce((sum, item) => sum + item.bytes, 0)} bytes.`
        : 'No eligible artifacts were removed.',
    );
    const listedRemoved = removed.slice(0, 100);
    result.details.cleanup = listedRemoved.map((candidate) => ({
      runId: candidate.runId,
      ageMs: candidate.ageMs,
      bytes: candidate.bytes,
      state: candidate.state,
    }));
    result.details.cleanupSummary = {
      candidateCount: removed.length,
      reclaimableBytes: removed.reduce((sum, candidate) => sum + candidate.bytes, 0),
      truncated: removed.length > listedRemoved.length,
    };
    result.details.usage = this.resourceUsageDetails(
      await resources.usage({
        isActiveRun: (manifest) => this.isValidatedActiveManifest(manifest),
      }),
    );
    this.publishStatus();
    return result;
  }

  private async waitInForeground(
    run: CommandRun,
    input: BashInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TmuxBashDetails> | undefined,
  ): Promise<AgentToolResult<TmuxBashDetails>> {
    const timeoutSeconds = clampTimeout(this.config, input.timeout);
    const timer = onUpdate
      ? setInterval(() => {
          void this.sendForegroundUpdate(run, onUpdate).catch((error: unknown) =>
            this.reportDetachedFailure('foreground progress update', error, run),
          );
        }, this.config.foregroundUpdateIntervalMs)
      : undefined;
    try {
      let outcome: 'completed' | 'timeout' | 'aborted';
      try {
        outcome = await this.waitForExit(run, timeoutSeconds * 1_000, signal);
      } catch (error) {
        const termination = await this.terminateForeground(run, 'failed');
        const reason = boundedDiagnostic(error instanceof Error ? error.message : String(error));
        const status =
          termination === 'uncertain'
            ? 'could not be confirmed; the command continues under background monitoring'
            : `was terminated${reason ? `: ${reason}` : '.'}`;
        throw new Error(
          `tmux command monitoring failed and termination ${status}${termination === 'uncertain' && reason ? `: ${reason}` : ''}`,
        );
      }
      if (outcome === 'completed') {
        try {
          return await this.finishForeground(run);
        } catch (error) {
          if (run.state === 'reserved' || run.state === 'starting' || run.state === 'running') {
            const termination = await this.terminateForeground(run, 'failed');
            const reason = boundedDiagnostic(
              error instanceof Error ? error.message : String(error),
            );
            const status =
              termination === 'uncertain'
                ? 'could not be confirmed; the command continues under background monitoring'
                : `was terminated${reason ? `: ${reason}` : '.'}`;
            throw new Error(
              `tmux completion reconciliation failed and termination ${status}${termination === 'uncertain' && reason ? `: ${reason}` : ''}`,
            );
          }
          throw error;
        }
      }
      if (outcome === 'aborted') {
        const termination = await this.terminateForeground(run, 'cancelled');
        const suffix =
          termination === 'uncertain'
            ? ' Termination could not be confirmed; the command continues under background monitoring.'
            : '';
        throw new Error(
          `tmux bash command was cancelled.${suffix}\n${await this.errorOutput(run)}`,
        );
      }

      const timeoutAction = input.timeoutAction ?? this.config.defaultTimeoutAction;
      if (timeoutAction === 'kill') {
        const termination = await this.terminateForeground(run, 'failed');
        const result =
          termination === 'uncertain'
            ? 'termination could not be confirmed; the command continues under background monitoring'
            : 'was killed';
        throw new Error(
          `tmux bash command timed out after ${timeoutSeconds}s and ${result}.\n${await this.errorOutput(run)}`,
        );
      }

      run.mode = 'background';
      const waitForCompletion =
        input.waitForCompletion ?? this.config.defaultWaitAfterForegroundTimeout;
      if (waitForCompletion) this.acquireGate(run);
      await this.runStore?.persist(run);
      const completed = await this.completeIfReady(run, false);
      if (completed) return completed;
      if (input.pollInterval !== undefined) {
        this.startPoll(run, input.pollInterval, input.pollLines);
        await this.runStore?.persist(run);
      }
      this.publishStatus();
      const running = await this.runningResult(
        run,
        `Timed out after ${timeoutSeconds}s; continuing in background.`,
      );
      run.backgroundReady = true;
      await this.runStore?.persist(run);
      this.observeCompletion(run);
      return running;
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  private async finishForeground(run: CommandRun): Promise<AgentToolResult<TmuxBashDetails>> {
    const exitCode = await this.readRunExitCode(run);
    if (exitCode === undefined) throw new Error('tmux command exit sentinel was unreadable.');
    run.exitCode = exitCode;
    run.endedAt = Date.now();
    run.deliveryState = 'delivered';
    run.completionClaimed = true;
    run.completionDelivered = true;
    await this.runStore?.transition(run, exitCode === 0 ? 'completed' : 'failed');
    const result = await this.completedResult(run);
    await this.closeCompletedWindow(run);
    this.publishStatus();
    if (exitCode !== 0) {
      const output = result.content[0]?.type === 'text' ? result.content[0].text : '';
      throw new Error(`${output}\nCommand exited with code ${exitCode}`.trim());
    }
    return result;
  }

  private async terminateForeground(
    run: CommandRun,
    outcome: 'cancelled' | 'failed',
    store: RunStore | undefined = this.runStore,
  ): Promise<'terminated' | 'uncertain'> {
    if (run.windowId && !(await this.tryKillOwnedWindow(run, 'foreground termination'))) {
      run.mode = 'background';
      run.backgroundReady = true;
      run.completionClaimed = false;
      run.completionDelivered = false;
      run.completionDeliveryFailed = false;
      run.deliveryState = 'pending';
      await store?.persist(run).catch(() => undefined);
      this.ensureWatcher();
      this.observeCompletion(run);
      this.publishStatus();
      return 'uncertain';
    }
    run.killed = true;
    run.endedAt = Date.now();
    run.deliveryState = 'failed';
    run.completionClaimed = true;
    this.stopPoll(run.runId);
    this.releaseGate(run, outcome, 'current-turn');
    await store?.transition(run, 'killed');
    this.publishStatus();
    return 'terminated';
  }

  private async failLaunchedRun(
    run: CommandRun,
    outcome: 'cancelled' | 'failed',
    store: RunStore,
  ): Promise<boolean> {
    if (!(await this.tryKillOwnedWindow(run, 'foreground failure'))) {
      run.mode = 'background';
      run.backgroundReady = true;
      run.completionClaimed = false;
      run.completionDelivered = false;
      run.completionDeliveryFailed = false;
      run.deliveryState = 'pending';
      await store.persist(run).catch(() => undefined);
      this.ensureWatcher();
      this.observeCompletion(run);
      this.reportDetachedFailure(
        'foreground cleanup',
        new Error(
          'The owned tmux window could not be revalidated or terminated; monitoring continues.',
        ),
        run,
      );
      this.publishStatus();
      return false;
    }
    run.killed = outcome === 'cancelled';
    run.endedAt = Date.now();
    run.state = outcome === 'cancelled' ? 'killed' : 'failed';
    run.backgroundReady = false;
    run.deliveryState = 'failed';
    run.completionClaimed = true;
    this.stopPoll(run.runId);
    await store.persist(run).catch(() => undefined);
    this.releaseGate(run, outcome, 'current-turn');
    this.publishStatus();
    return true;
  }

  private waitForExit(
    run: CommandRun,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<'completed' | 'timeout' | 'aborted'> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let checking = false;
      const cleanup = () => {
        clearInterval(interval);
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      };
      const finish = (outcome: 'completed' | 'timeout' | 'aborted') => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const check = async () => {
        if (settled || checking) return;
        checking = true;
        try {
          if ((await readExitCode(run.exitCodeFile)) !== undefined) finish('completed');
        } catch (error) {
          fail(error);
        } finally {
          checking = false;
        }
      };
      const abort = () => finish('aborted');
      const interval = setInterval(() => void check(), 100);
      const timeout =
        timeoutMs === undefined ? undefined : setTimeout(() => finish('timeout'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) finish('aborted');
      void check();
    });
  }

  private ensureWatcher(): void {
    if (!this.state.runDir) return;
    if (!this.state.watcher) {
      const watcher = watch(this.state.runDir, (_event, filename) => {
        if (!filename?.endsWith('.exit')) return;
        const runId = filename.slice(0, -'.exit'.length);
        const run = this.state.commands.get(runId);
        if (run?.mode === 'background' && run.backgroundReady) {
          this.observeCompletion(run);
        }
      });
      watcher.on('error', (error) => {
        if (this.state.watcher === watcher) this.state.watcher = null;
        try {
          watcher.close();
        } catch (closeError) {
          this.reportDetachedFailure('completion watcher close', closeError);
        }
        this.reportDetachedFailure('completion watcher', error);
      });
      this.state.watcher = watcher;
    }
    if (!this.state.completionMonitor) {
      this.state.completionMonitor = setInterval(() => {
        for (const run of this.state.commands.values()) {
          if (
            run.mode === 'background' &&
            run.backgroundReady &&
            !run.completionDelivered &&
            !run.completionDeliveryFailed &&
            !run.completionRetryTimer
          ) {
            this.observeCompletion(run);
          }
        }
      }, BACKGROUND_COMPLETION_SCAN_INTERVAL_MS);
      this.state.completionMonitor.unref();
    }
  }

  private async completeIfReady(
    run: CommandRun,
    deliver: boolean,
  ): Promise<AgentToolResult<TmuxBashDetails> | undefined> {
    const exitCode = await this.readRunExitCode(run);
    if (exitCode === undefined || run.completionDelivered || run.completionDeliveryFailed) {
      return undefined;
    }
    if (run.completionPromise) return run.completionPromise;
    if (run.completionClaimed || run.completionRetryTimer) return undefined;

    const completion = this.finishBackgroundCompletion(run, exitCode, deliver);
    run.completionPromise = completion;
    try {
      return await completion;
    } finally {
      if (run.completionPromise === completion) run.completionPromise = undefined;
    }
  }

  private async finishBackgroundCompletion(
    run: CommandRun,
    exitCode: number,
    deliver: boolean,
  ): Promise<AgentToolResult<TmuxBashDetails>> {
    run.exitCode = exitCode;
    run.endedAt = Date.now();
    this.stopPoll(run.runId);
    await this.runStore?.transition(run, exitCode === 0 ? 'completed' : 'failed');

    let result: AgentToolResult<TmuxBashDetails>;
    try {
      result = await this.completedResult(run);
    } catch (error) {
      const reason = boundedDiagnostic(error instanceof Error ? error.message : String(error));
      result = {
        content: [
          {
            type: 'text',
            text: `Command completed, but its output could not be read${reason ? `: ${reason}` : '.'}`,
          },
        ],
        details: this.details(run),
      };
    }

    let completionLease = false;
    if (deliver && run.mode === 'background' && !this.state.disposed) {
      completionLease = (await this.runStore?.claimCompletion(run.runId)) ?? true;
      if (!completionLease) {
        run.deliveryState = 'pending';
        run.completionClaimed = false;
        run.completionDelivered = false;
        run.completionDeliveryFailed = false;
        run.completionRetryTimer = setTimeout(() => {
          run.completionRetryTimer = undefined;
          this.observeCompletion(run);
        }, this.config.completionDeliveryRetryBaseMs);
        run.completionRetryTimer.unref();
        await this.runStore?.persist(run).catch(() => undefined);
        this.publishStatus();
        return result;
      }
    }
    if (deliver && run.mode === 'background' && this.state.disposed) {
      // Shutdown must leave a terminal record discoverable for same-session adoption
      // rather than treating an undelivered completion as delivered.
      run.deliveryState = 'failed';
      run.completionClaimed = false;
      run.completionDelivered = false;
      run.completionDeliveryFailed = false;
      run.completionDeliveryExhausted = false;
      await this.runStore?.persist(run).catch(() => undefined);
    } else if (deliver && run.mode === 'background') {
      const output = result.content[0]?.type === 'text' ? result.content[0].text : '';
      const ctx = this.state.statusContext;
      const delivery = this.completion;
      if (!ctx || !delivery) throw new Error('Completion delivery runtime is unavailable.');
      try {
        const outcome = await delivery.deliverCompletion(
          run,
          {
            text: `${run.windowId ?? run.runId} completed with exit code ${exitCode}.\n${output}`.trim(),
            details: result.details,
          },
          ctx,
        );
        run.completionClaimed = true;
        run.completionDelivered = true;
        run.completionDeliveryExhausted = false;
        const wake = outcome.wake;
        this.releaseGate(
          run,
          exitCode === 0 ? 'completed' : 'failed',
          wake,
          outcome.handoff?.handoffId,
        );
        run.awaited = false;
        await this.runStore?.persist(run);
      } catch (error) {
        run.completionClaimed = false;
        run.completionDelivered = false;
        run.completionDeliveryFailures += 1;
        this.releaseGate(run, 'failed', 'none');
        run.awaited = false;
        const exhausted =
          run.completionDeliveryFailures >= this.config.completionDeliveryMaxAttempts;
        run.completionDeliveryFailed = exhausted;
        run.completionDeliveryExhausted = exhausted;
        if (exhausted) {
          const reason = boundedDiagnostic(error instanceof Error ? error.message : String(error));
          let exhaustionPersisted = this.runStore === undefined;
          try {
            await this.runStore?.persist(run);
            exhaustionPersisted = true;
          } catch (persistError) {
            this.reportDetachedFailure('completion exhaustion persistence', persistError, run);
          }
          if (completionLease && exhaustionPersisted) {
            await this.runStore
              ?.releaseCompletionClaim(run.runId)
              .catch((releaseError: unknown) =>
                this.reportDetachedFailure('completion claim release', releaseError, run),
              );
          }
          // A failed persistence must retain the claim; do not let the common
          // terminal cleanup path release it after this branch.
          completionLease = false;
          try {
            ctx.ui.notify(
              `Tmux command ${run.windowId ?? run.runId} completed, but delivery failed after ${run.completionDeliveryFailures} attempts${reason ? `: ${reason}` : '.'}`,
              'error',
            );
          } catch (notifyError) {
            this.reportDetachedFailure('completion delivery notification', notifyError, run);
          }
        } else if (!this.state.disposed) {
          run.completionDeliveryFailed = false;
          run.completionDeliveryExhausted = false;
          run.deliveryState = 'pending';
          const delay =
            this.config.completionDeliveryRetryBaseMs * 2 ** (run.completionDeliveryFailures - 1);
          run.completionRetryTimer = setTimeout(() => {
            run.completionRetryTimer = undefined;
            this.observeCompletion(run);
          }, delay);
          run.completionRetryTimer.unref();
        }
        await this.runStore?.persist(run).catch(() => undefined);
        if (!exhausted) {
          this.publishStatus();
          return result;
        }
      }
    } else {
      run.deliveryState = 'delivered';
      run.completionClaimed = true;
      run.completionDelivered = true;
      this.releaseGate(run, exitCode === 0 ? 'completed' : 'failed', 'current-turn');
      run.awaited = false;
      await this.runStore?.persist(run);
    }
    await this.closeCompletedWindow(run).catch(() => undefined);
    if (this.config.quotaPolicy === 'cleanup-completed') {
      await this.resources?.cleanup({
        automatic: true,
        isLiveOwnedWindow: (manifest) => this.isLiveOwnedManifest(manifest),
        isActiveRun: (manifest) => this.isValidatedActiveManifest(manifest),
        isCleanupProtectedRun: (manifest) => this.isCleanupProtectedManifest(manifest),
      });
    }
    if (completionLease && (run.completionDelivered || run.completionDeliveryFailed)) {
      await this.runStore?.releaseCompletionClaim(run.runId);
    }
    this.publishStatus();
    return result;
  }

  private async completedResult(run: CommandRun): Promise<AgentToolResult<TmuxBashDetails>> {
    const raw = await this.readRunOutput(run);
    const formatted = formatOutput(raw, {
      maxLines:
        run.mode === 'background'
          ? this.config.completionContextLines
          : this.config.foregroundContextLines,
      maxBytes: this.config.maxOutputBytes,
      fullOutputPath: run.outputFile,
    });
    return {
      content: [{ type: 'text', text: formatted.text || '(no output)' }],
      details: this.details(run, formatted.truncation),
    };
  }

  private async runningResult(
    run: CommandRun,
    prefix?: string,
  ): Promise<AgentToolResult<TmuxBashDetails>> {
    const raw = await this.readRunOutput(run);
    const formatted = formatOutput(raw, {
      maxLines: this.config.foregroundContextLines,
      maxBytes: this.config.maxOutputBytes,
      fullOutputPath: run.outputFile,
    });
    const hint = run.windowId ? this.tmux.attachHint(run.tmuxSession, run.windowId) : '';
    const message = [
      prefix,
      formatted.text,
      `Running in managed tmux window ${run.windowId}.`,
      `Attach: ${hint}`,
      completionNotice(run),
    ]
      .filter(Boolean)
      .join('\n');
    return {
      content: [{ type: 'text', text: message }],
      details: this.details(run, formatted.truncation),
      ...(run.gateId ? { terminate: true } : {}),
    };
  }

  private async sendForegroundUpdate(
    run: CommandRun,
    onUpdate: AgentToolUpdateCallback<TmuxBashDetails>,
  ) {
    if (run.endedAt) return;
    const formatted = formatOutput(await this.readRunOutput(run), {
      maxLines: Math.min(20, this.config.foregroundContextLines),
      maxBytes: this.config.maxOutputBytes,
      fullOutputPath: run.outputFile,
    });
    onUpdate({
      content: [{ type: 'text', text: formatted.text || 'Running…' }],
      details: this.details(run, formatted.truncation),
    });
  }

  private startPoll(run: CommandRun, interval?: number, lines?: number): Poller {
    this.stopPoll(run.runId);
    const poller: Poller = {
      key: run.windowId ?? run.runId,
      timer: undefined as unknown as ReturnType<typeof setInterval>,
      runId: run.runId,
      intervalSeconds: clampPollInterval(this.config, interval),
      lines: Math.min(10_000, Math.max(1, Math.floor(lines ?? this.config.pollContextLines))),
      lastOutput: '',
    };
    poller.timer = setInterval(() => {
      void this.pollTick(poller).catch((error: unknown) => {
        this.stopPoll(poller.runId);
        this.reportDetachedFailure('poll update', error, run);
      });
    }, poller.intervalSeconds * 1_000);
    this.state.pollers.set(run.runId, poller);
    run.polling = { intervalSeconds: poller.intervalSeconds, lines: poller.lines };
    return poller;
  }

  private stopPoll(runId: string): boolean {
    const poller = this.state.pollers.get(runId);
    if (!poller) return false;
    clearInterval(poller.timer);
    this.state.pollers.delete(runId);
    const run = this.state.commands.get(runId);
    if (run) run.polling = undefined;
    return true;
  }

  private async pollTick(poller: Poller): Promise<void> {
    const run = this.state.commands.get(poller.runId);
    if (!run || this.state.disposed) {
      this.stopPoll(poller.runId);
      return;
    }
    if (await this.completeIfReady(run, true)) return;
    if (!(await this.isOwnedWindow(run))) {
      await this.failUnownedRun(run, true);
      return;
    }
    const formatted = formatOutput(await this.readRunOutput(run), {
      maxLines: poller.lines,
      maxBytes: this.config.maxOutputBytes,
      fullOutputPath: run.outputFile,
    });
    if (!formatted.text || formatted.text === poller.lastOutput) return;
    poller.lastOutput = formatted.text;
    const content = `${run.windowId ?? run.runId} progress:\n${formatted.text}`;
    if (this.config.pollDelivery === 'model') {
      this.pi.sendMessage(
        { customType: TMUX_BASH_COMPLETION_MESSAGE, content, display: true },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
    } else {
      this.state.statusContext?.ui.notify(content, 'info');
    }
  }

  private acquireGate(run: CommandRun): boolean {
    const wasGated = Boolean(run.gateId);
    const gateId = run.gateId ?? `tmux:${run.runId}`;
    this.state.gateController.acquire({
      sessionId: run.sessionId,
      gateId,
      domain: run.continuationDomain,
      reason: `Waiting for tmux command: ${sanitizeTerminalText(run.displayCommand).slice(0, 160)}`,
      resource: { kind: 'tmux-command', id: run.runId, label: run.windowId ?? run.runId },
    });
    run.gateId = gateId;
    run.awaited = true;
    return !wasGated;
  }

  private releaseGate(
    run: CommandRun,
    outcome: 'completed' | 'failed' | 'cancelled' | 'killed' | 'abandoned',
    wake: 'producer-message' | 'current-turn' | 'none',
    handoffId?: string,
  ): boolean {
    if (!run.gateId) return false;
    const released = this.state.gateController.release({
      sessionId: run.sessionId,
      gateId: run.gateId,
      outcome,
      wake,
      domain: run.continuationDomain,
      ...(handoffId ? { handoffId } : {}),
    });
    if (released) {
      run.gateId = undefined;
      run.awaited = false;
    }
    return released;
  }

  private details(run: CommandRun, truncation?: TmuxBashDetails['truncation']): TmuxBashDetails {
    const state = detailState(run);
    return {
      runId: run.runId,
      completionId: run.completionId,
      windowId: run.windowId,
      tmuxSession: run.tmuxSession,
      command: sanitizeTerminalText(run.displayCommand),
      outputFile: run.outputFile,
      fullOutputPath: truncation?.truncated ? run.outputFile : undefined,
      truncation,
      exitCode: run.exitCode,
      state,
      background: run.mode === 'background',
      awaited: Boolean(run.gateId),
      durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
      completionDelivery: run.completionDelivery,
      adopted: run.adopted,
      outputWasRotated: run.outputWasRotated,
    };
  }

  private tmuxResult(
    action: TmuxToolDetails['action'],
    runs: CommandRun[],
    text: string,
    terminate = false,
  ): AgentToolResult<TmuxToolDetails> {
    return {
      content: [{ type: 'text', text: sanitizeTerminalText(text) }],
      ...(terminate ? { terminate: true } : {}),
      details: {
        action,
        runs: runs.slice(0, MAX_TMUX_RESULT_RUNS).map((run) => ({
          runId: run.runId,
          completionId: run.completionId,
          windowId: run.windowId,
          command: boundedResultValue(sanitizeTerminalText(run.displayCommand), 512),
          state: this.details(run).state,
          background: run.mode === 'background',
          awaited: Boolean(run.gateId),
          polling: this.state.pollers.has(run.runId),
          ageMs: Date.now() - run.startedAt,
          outputFile: run.outputFile,
          completionDelivery: run.completionDelivery,
          adopted: run.adopted,
          outputWasRotated: run.outputWasRotated,
        })),
      },
    };
  }

  private async reconcile(ctx: ExtensionContext): Promise<void> {
    await Promise.all(
      this.list(ctx).map(async (run) => {
        if (run.endedAt || run.killed) return undefined;
        try {
          if ((await this.readRunExitCode(run)) !== undefined) return undefined;
        } catch {
          return undefined;
        }
        if (await this.isOwnedWindow(run)) {
          if (run.windowId && (await this.tmux.isPaneDead(run.windowId))) {
            try {
              if ((await this.readRunExitCode(run)) === undefined) {
                return this.failUnownedRun(run, false);
              }
            } catch {
              return undefined;
            }
          }
          return undefined;
        }
        return this.failUnownedRun(run, false);
      }),
    );
    this.publishStatus();
  }

  private async requireRun(windowId: string, ctx: ExtensionContext): Promise<CommandRun> {
    const run = this.list(ctx).find((candidate) => candidate.windowId === windowId);
    if (!run) throw new Error(`No managed tmux window ${windowId} exists in the configured scope.`);
    if (run.state === 'orphaned') {
      throw new Error(
        `Tmux window ${windowId} is missing or no longer carries this run's ownership metadata.`,
      );
    }
    if (run.endedAt || run.killed || (await this.readRunExitCode(run)) !== undefined) return run;
    if (await this.isOwnedWindow(run)) return run;
    // Completion can publish its sentinel and auto-close the pane while ownership
    // revalidation is in flight. Recheck before declaring the run orphaned.
    if (run.endedAt || run.killed || (await this.readRunExitCode(run)) !== undefined) return run;
    await this.failUnownedRun(run, false);
    if (
      (run.state as string) !== 'orphaned' &&
      (run.endedAt || run.killed || (await this.readRunExitCode(run)) !== undefined)
    ) {
      return run;
    }
    throw new Error(
      `Tmux window ${windowId} is missing or no longer carries this run's ownership metadata.`,
    );
  }

  private async tryKillOwnedWindow(run: CommandRun, operation: string): Promise<boolean> {
    if (!run.windowId) return false;
    try {
      if (!(await this.isOwnedWindow(run))) return false;
      await this.tmux.killWindow(run.windowId);
      return true;
    } catch (error) {
      this.reportDetachedFailure(operation, error, run);
      return false;
    }
  }

  private async deliverOrphanCompletion(
    run: CommandRun,
    text?: string,
    truncation?: TmuxBashDetails['truncation'],
  ): Promise<void> {
    if (run.completionDelivered) return;
    if (!text) {
      let formatted: ReturnType<typeof formatOutput>;
      try {
        formatted = formatOutput(await readOutput(run.outputFile, this.config.maxOutputBytes), {
          maxLines: this.config.completionContextLines,
          maxBytes: this.config.maxOutputBytes,
          fullOutputPath: run.outputFile,
        });
      } catch {
        formatted = { text: '', raw: '' };
      }
      text = `${run.windowId ?? run.runId} failed: the managed tmux window disappeared or is no longer owned by this Pi run.${formatted.text ? `\n${formatted.text}` : ''}`;
      truncation = formatted.truncation;
    }
    const ctx = this.state.statusContext;
    const delivery = this.completion;
    let completionLease = false;
    if (!this.state.disposed) {
      completionLease = (await this.runStore?.claimCompletion(run.runId)) ?? true;
      if (!completionLease) {
        run.deliveryState = 'pending';
        run.completionDelivered = false;
        run.completionDeliveryFailed = false;
        run.completionDeliveryExhausted = false;
        await this.runStore?.persist(run).catch(() => undefined);
        return;
      }
    }
    if (this.state.disposed || !ctx || !delivery) {
      run.deliveryState = 'failed';
      run.completionDelivered = false;
      run.completionDeliveryFailed = false;
      run.completionDeliveryExhausted = false;
      await this.runStore?.persist(run).catch(() => undefined);
      return;
    }
    let terminal = false;
    try {
      const outcome = await delivery.deliverCompletion(
        run,
        { text, details: this.details(run, truncation) },
        ctx,
      );
      run.completionClaimed = true;
      run.completionDelivered = true;
      run.completionDeliveryFailed = false;
      run.completionDeliveryExhausted = false;
      this.releaseGate(run, 'failed', outcome.wake, outcome.handoff?.handoffId);
      run.awaited = false;
      terminal = true;
    } catch (error) {
      run.completionClaimed = false;
      run.completionDelivered = false;
      run.completionDeliveryFailures += 1;
      const exhausted = run.completionDeliveryFailures >= this.config.completionDeliveryMaxAttempts;
      run.completionDeliveryFailed = exhausted;
      run.completionDeliveryExhausted = exhausted;
      run.deliveryState = exhausted ? 'failed' : 'pending';
      this.releaseGate(run, 'failed', 'none');
      run.awaited = false;
      if (exhausted) {
        const reason = boundedDiagnostic(error instanceof Error ? error.message : String(error));
        let exhaustionPersisted = this.runStore === undefined;
        try {
          await this.runStore?.persist(run);
          exhaustionPersisted = true;
        } catch (persistError) {
          this.reportDetachedFailure('orphan completion exhaustion persistence', persistError, run);
        }
        if (completionLease && exhaustionPersisted) {
          await this.runStore
            ?.releaseCompletionClaim(run.runId)
            .catch((releaseError: unknown) =>
              this.reportDetachedFailure('completion claim release', releaseError, run),
            );
        }
        // Keep the claim held when exhaustion was not durably persisted.
        completionLease = false;
        try {
          ctx.ui.notify(
            `Tmux orphaned command ${run.windowId ?? run.runId} could not deliver its failure notification after ${run.completionDeliveryFailures} attempts${reason ? `: ${reason}` : '.'}`,
            'error',
          );
        } catch (notifyError) {
          this.reportDetachedFailure('orphan completion notification', notifyError, run);
        }
        terminal = true;
      } else {
        const delay =
          this.config.completionDeliveryRetryBaseMs * 2 ** (run.completionDeliveryFailures - 1);
        run.completionRetryTimer = setTimeout(() => {
          run.completionRetryTimer = undefined;
          void this.deliverOrphanCompletion(run).catch((retryError) =>
            this.reportDetachedFailure('orphan completion retry', retryError, run),
          );
        }, delay);
        run.completionRetryTimer.unref();
      }
    }
    await this.runStore?.persist(run).catch(() => undefined);
    if (terminal && completionLease) await this.runStore?.releaseCompletionClaim(run.runId);
    this.publishStatus();
  }

  private async readRunExitCode(run: CommandRun): Promise<number | undefined> {
    try {
      return await readExitCode(run.exitCodeFile);
    } catch (error) {
      await this.handleCompletionObserverFailure(run, error);
      throw error;
    }
  }

  private async isOwnedWindow(run: CommandRun): Promise<boolean> {
    if (!run.windowId) return false;
    return this.tmux.isOwnedWindow(run.windowId, {
      owner: TMUX_BASH_OWNERSHIP_MARKER,
      scope: run.scope,
      piSessionId: run.sessionId,
      runId: run.runId,
      manifestPath: run.manifestPath,
      completionId: run.completionId,
      completionDelivery: run.completionDelivery,
    });
  }

  private async failUnownedRun(run: CommandRun, deliverFollowUp: boolean): Promise<void> {
    if (run.endedAt || run.killed) return;
    run.endedAt = Date.now();
    run.completionClaimed = true;
    this.stopPoll(run.runId);
    await this.runStore?.transition(run, 'orphaned');
    const formatted = formatOutput(await readOutput(run.outputFile, this.config.maxOutputBytes), {
      maxLines: this.config.completionContextLines,
      maxBytes: this.config.maxOutputBytes,
      fullOutputPath: run.outputFile,
    });
    const output = formatted.text ? `\n${formatted.text}` : '';
    const text = `${run.windowId ?? run.runId} failed: the managed tmux window disappeared or is no longer owned by this Pi run.${output}`;
    if (deliverFollowUp) {
      await this.deliverOrphanCompletion(run, text, formatted.truncation);
    } else {
      run.deliveryState = 'delivered';
      run.completionDelivered = true;
      this.releaseGate(run, 'failed', 'current-turn');
      await this.runStore?.persist(run).catch(() => undefined);
    }
    await this.runStore?.persist(run).catch(() => undefined);
    this.publishStatus();
  }

  private isInScope(run: CommandRun, ctx: ExtensionContext): boolean {
    if (this.config.tmuxWindowScope === 'all') return true;
    if (this.config.tmuxWindowScope === 'pi-session') {
      return run.sessionId === ctx.sessionManager.getSessionId();
    }
    return (
      this.state.currentScope !== undefined && matchesScope(run.scope, this.state.currentScope)
    );
  }

  private describeRun(run: CommandRun): string {
    const details = this.details(run);
    const flags = [
      details.state,
      details.awaited ? 'awaited' : '',
      this.state.pollers.has(run.runId) ? 'polling' : '',
      `completion=${run.completionDelivery}`,
      run.adopted ? 'adopted' : '',
      run.outputWasRotated ? 'output-rotated' : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `${run.windowId ?? run.runId} [${flags}] ${sanitizeTerminalText(run.displayCommand)}`;
  }

  private async readRunOutput(run: CommandRun): Promise<string | OutputTail> {
    if (!run.outputWasRotated) {
      run.outputWasRotated = await pathExists(run.rotationMarkerFile);
    }
    const artifact = await readOutput(run.outputFile, this.config.maxOutputBytes);
    if (artifact.content) {
      const header = `$ ${run.displayCommand}\n`;
      if (!artifact.truncated && artifact.content.startsWith(header)) {
        const headerBytes = Buffer.byteLength(header);
        return {
          ...artifact,
          content: artifact.content.slice(header.length),
          totalBytes: Math.max(0, artifact.totalBytes - headerBytes),
          readBytes: Math.max(0, artifact.readBytes - headerBytes),
        };
      }
      return artifact;
    }
    if (!run.windowId || !(await this.isOwnedWindow(run))) return artifact;
    try {
      return await this.tmux.capturePane(run.windowId, this.config.peekContextLines);
    } catch {
      return artifact;
    }
  }

  private async errorOutput(run: CommandRun): Promise<string> {
    return formatOutput(await this.readRunOutput(run), {
      maxLines: this.config.foregroundContextLines,
      maxBytes: this.config.maxOutputBytes,
      fullOutputPath: run.outputFile,
    }).text;
  }

  private async closeCompletedWindow(run: CommandRun): Promise<void> {
    if (!this.config.autoCloseWindowsOnCompletion || !run.windowId) return;
    if (await this.isOwnedWindow(run)) {
      await this.tmux.killWindow(run.windowId).catch(() => undefined);
    }
  }

  consumePendingCompletions(ctx: ExtensionContext): string | undefined {
    return this.completion?.consumePending(ctx);
  }

  private async requireLiveOwnedRun(windowId: string, ctx: ExtensionContext): Promise<CommandRun> {
    const run = await this.requireRun(windowId, ctx);
    if ((await this.readRunExitCode(run)) !== undefined) {
      throw new Error(`Managed command ${windowId} has already completed.`);
    }
    if (run.endedAt || run.killed || run.state !== 'running') {
      throw new Error(`Managed command ${windowId} is not running.`);
    }
    if (!(await this.isOwnedWindow(run))) {
      await this.failUnownedRun(run, false);
      throw new Error(`Managed tmux window ${windowId} failed its ownership revalidation.`);
    }
    if (run.windowId && (await this.tmux.isPaneDead(run.windowId))) {
      if ((await this.readRunExitCode(run)) === undefined) {
        await this.failUnownedRun(run, false);
        throw new Error(`Managed tmux window ${windowId} has exited without an exit sentinel.`);
      }
      throw new Error(`Managed command ${windowId} has already completed.`);
    }
    return run;
  }

  private async peekAfterInput(action: 'send-input' | 'send-key', run: CommandRun) {
    const formatted = formatOutput(await this.readRunOutput(run), {
      maxLines: this.config.peekContextLines,
      maxBytes: this.config.maxOutputBytes,
      fullOutputPath: run.outputFile,
    });
    return this.tmuxResult(
      action,
      [run],
      `Input sent to ${run.windowId}.\n${formatted.text || '(no output yet)'}`,
    );
  }

  private assertActionEnabled(action: TmuxToolDetails['action']): void {
    const enabled = this.config.enabledTmuxActions.includes(action);
    const cleanupUsesPreview =
      action === 'cleanup-preview' && this.config.enabledTmuxActions.includes('cleanup');
    if (!enabled && !cleanupUsesPreview) {
      throw new Error(`tmux action ${action} is disabled by configuration.`);
    }
  }

  private async isValidatedActiveManifest(
    manifest: ManagedRunManifest,
    store: RunStore | undefined = this.runStore,
  ): Promise<boolean> {
    try {
      if ((await readExitCode(manifest.exitCodeFile)) !== undefined) return false;
      const windowId = await this.ownedWindowForManifest(manifest, store);
      return windowId !== undefined && !(await this.tmux.isPaneDead(windowId));
    } catch {
      // Ambiguous filesystem/tmux failures must preserve quota headroom; never
      // classify a possibly-live run as inactive for destructive cleanup.
      return true;
    }
  }

  private async isLiveOwnedManifest(manifest: ManagedRunManifest): Promise<boolean> {
    try {
      if (!manifest.windowId) {
        const discovered = await this.ownedWindowForManifest(manifest, this.runStore);
        return discovered !== undefined && !(await this.tmux.isPaneDead(discovered));
      }
      if (!(await this.tmux.hasWindow(manifest.windowId))) return false;
      if (!(await this.tmux.isPaneDead(manifest.windowId))) return true;
      const manifestPath =
        this.runStore?.manifestPath(manifest.runId) ??
        join(dirname(manifest.outputFile), `${manifest.runId}.manifest.json`);
      // An exited pane owned by this exact manifest is no longer live and can be
      // cleaned. A reused/unowned stable ID remains protected as collateral.
      return !(await this.tmux.isOwnedWindow(manifest.windowId, {
        owner: TMUX_BASH_OWNERSHIP_MARKER,
        scope: manifest.scope,
        piSessionId: manifest.piSessionId,
        runId: manifest.runId,
        manifestPath,
        completionId: manifest.completionId,
        completionDelivery: manifest.completionDelivery,
      }));
    } catch {
      return true;
    }
  }

  private async ownedWindowForManifest(
    manifest: ManagedRunManifest,
    store: RunStore | undefined,
  ): Promise<string | undefined> {
    const manifestPath =
      store?.manifestPath(manifest.runId) ??
      join(dirname(manifest.outputFile), `${manifest.runId}.manifest.json`);
    const expected = {
      owner: TMUX_BASH_OWNERSHIP_MARKER,
      scope: manifest.scope,
      piSessionId: manifest.piSessionId,
      runId: manifest.runId,
      manifestPath,
      completionId: manifest.completionId,
      completionDelivery: manifest.completionDelivery,
    } as const;
    if (manifest.windowId) {
      return (await this.tmux.isOwnedWindow(manifest.windowId, expected))
        ? manifest.windowId
        : undefined;
    }
    const windows = await this.tmux.listManaged({
      scope: manifest.scope,
      piSessionId: manifest.piSessionId,
    });
    return windows.find((window) => sameManagedWindowOwner(window.metadata, expected))?.windowId;
  }

  private observeCompletion(run: CommandRun): void {
    if (run.completionObserverPromise) return;
    const observation = this.observeCompletionTask(run);
    run.completionObserverPromise = observation;
  }

  private async observeCompletionTask(run: CommandRun): Promise<void> {
    try {
      const completed = await this.completeIfReady(run, run.origin !== 'user-bash');
      if (completed || run.endedAt || run.killed) return;
      const now = Date.now();
      if (
        run.windowId &&
        (run.lastPaneHealthCheckAt === undefined ||
          now - run.lastPaneHealthCheckAt >= PANE_HEALTH_CHECK_INTERVAL_MS)
      ) {
        run.lastPaneHealthCheckAt = now;
        let paneDead: boolean;
        try {
          paneDead = await this.tmux.isPaneDead(run.windowId);
        } catch (error) {
          this.reportDetachedFailure('completion pane health check', error, run);
          return;
        }
        if (!paneDead) return;
        let owned: boolean;
        try {
          owned = await this.isOwnedWindow(run);
        } catch (error) {
          this.reportDetachedFailure('completion ownership check', error, run);
          return;
        }
        if (!owned) {
          await this.failUnownedRun(run, true);
          return;
        }
        if ((await this.readRunExitCode(run)) === undefined) {
          await this.failUnownedRun(run, true);
        }
      }
    } catch (error) {
      if (!run.completionDeliveryFailed) {
        await this.handleCompletionObserverFailure(run, error);
      }
    } finally {
      run.completionObserverPromise = undefined;
    }
  }

  private async handleCompletionObserverFailure(run: CommandRun, error: unknown): Promise<void> {
    if (this.state.disposed) return;
    this.stopPoll(run.runId);
    const wasActive =
      run.state === 'reserved' || run.state === 'starting' || run.state === 'running';
    if (wasActive) {
      const terminated = await this.tryKillOwnedWindow(run, 'failed-run termination');
      if (!terminated) {
        run.completionClaimed = false;
        run.completionDelivered = false;
        run.completionDeliveryFailed = false;
        run.deliveryState = 'pending';
        run.backgroundReady = Boolean(run.windowId);
        await this.runStore
          ?.persist(run)
          .catch((persistError: unknown) =>
            this.reportDetachedFailure('completion failure persistence', persistError, run),
          );
        this.reportDetachedFailure('completion observer retry', error, run);
        this.publishStatus();
        return;
      }
    }
    run.completionClaimed = true;
    run.completionDelivered = false;
    run.completionDeliveryFailed = true;
    run.deliveryState = 'failed';
    run.awaited = false;
    run.backgroundReady = false;
    this.releaseGate(run, 'failed', 'none');
    if (wasActive) {
      run.endedAt ??= Date.now();
      await this.runStore
        ?.transition(run, 'failed')
        .catch((persistError: unknown) =>
          this.reportDetachedFailure('completion failure persistence', persistError, run),
        );
    } else {
      await this.runStore
        ?.persist(run)
        .catch((persistError: unknown) =>
          this.reportDetachedFailure('completion failure persistence', persistError, run),
        );
    }
    this.reportDetachedFailure('completion observer', error, run);
    this.publishStatus();
  }

  private reportDetachedFailure(operation: string, error: unknown, run?: CommandRun): void {
    const key = `${operation}:${run?.runId ?? 'global'}`;
    if (this.reportedDetachedFailures.has(key)) return;
    this.reportedDetachedFailures.add(key);
    const reason = boundedDiagnostic(error instanceof Error ? error.message : String(error));
    try {
      this.state.statusContext?.ui.notify(
        `Tmux ${operation} failed${run ? ` for ${run.windowId ?? run.runId}` : ''}${reason ? `: ${reason}` : '.'}`,
        'error',
      );
    } catch {
      // Detached diagnostics must never turn a durable cleanup or delivery failure
      // into an unhandled exception.
    }
  }

  private async isCleanupProtectedManifest(manifest: ManagedRunManifest): Promise<boolean> {
    const run = this.state.commands.get(manifest.runId);
    if (!run) return false;
    return Boolean(
      run.completionPromise ||
      run.completionRetryTimer ||
      (run.state !== 'completed' &&
        run.state !== 'failed' &&
        run.state !== 'killed' &&
        run.state !== 'orphaned') ||
      (isTerminalRunState(run.state) && !run.completionDelivered && !run.completionDeliveryFailed),
    );
  }

  private resourceUsageDetails(usage: {
    artifactBytes: number;
    activeRuns: number;
    reservations: number;
    completedRuns: number;
  }) {
    return {
      artifactBytes: usage.artifactBytes,
      artifactLimitBytes: this.config.maxArtifactBytesTotal,
      activeRuns: usage.activeRuns,
      reservations: usage.reservations,
      concurrentRunLimit: this.config.maxConcurrentRuns,
      completedRuns: usage.completedRuns,
      completedRunLimit: this.config.maxCompletedRuns,
    };
  }

  private assertReady(ctx: ExtensionContext): void {
    if (this.state.disposed || !this.state.runDir) {
      throw new Error('tmux-bash runtime is not active; start a Pi session first.');
    }
    if (
      this.state.statusContext?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()
    ) {
      throw new Error('tmux-bash refused a tool call from a stale Pi session.');
    }
  }

  private publishStatus(): void {
    const ctx = this.state.statusContext;
    if (ctx) updateTmuxBashStatus(this.pi, ctx, this.config, this.state.commands.values());
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError(): Error {
  const error = new Error('tmux bash command was cancelled.');
  error.name = 'AbortError';
  return error;
}

function matchesScope(left: TmuxWorkspaceScope, right: TmuxWorkspaceScope): boolean {
  return (['kind', 'root', 'hash'] as const).every((key) => left[key] === right[key]);
}

function boundedLines(lines: string[], maximumBytes: number): string {
  const selected: string[] = [];
  let usedBytes = 0;
  let omitted = 0;
  for (const line of lines) {
    const separatorBytes = selected.length === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(line);
    if (usedBytes + separatorBytes + lineBytes <= maximumBytes) {
      selected.push(line);
      usedBytes += separatorBytes + lineBytes;
    } else {
      omitted += 1;
    }
  }
  if (omitted === 0) return selected.join('\n');
  const notice = `… ${omitted} additional line(s) omitted from bounded output.`;
  while (
    selected.length > 0 &&
    Buffer.byteLength([...selected, notice].join('\n')) > maximumBytes
  ) {
    selected.pop();
    omitted += 1;
  }
  return [...selected, notice].join('\n');
}

function boundedResultValue(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  const suffix = '…';
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character + suffix) > maximumBytes) break;
    result += character;
  }
  return result + suffix;
}

function isTerminalRunState(state: CommandRun['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'killed' || state === 'orphaned';
}

function isUnsettledRunCompletion(run: CommandRun): boolean {
  return Boolean(
    run.completionObserverPromise ||
    run.completionPromise ||
    run.completionRetryTimer ||
    (isTerminalRunState(run.state) && !run.completionDelivered && !run.completionDeliveryFailed),
  );
}

function detailState(run: CommandRun): TmuxBashDetails['state'] {
  if (run.killed || run.state === 'killed') return 'killed';
  if (run.state === 'orphaned') return 'orphaned';
  if (run.state === 'reserved' || run.state === 'starting' || run.state === 'running') {
    return 'running';
  }
  return run.state === 'completed' || run.exitCode === 0 ? 'completed' : 'failed';
}

function completionNotice(run: CommandRun): string {
  if (run.completionDelivery === 'display') {
    return run.awaited
      ? 'Completion will be displayed without entering model context. Gate release uses wake=none and only an opted-in autonomous consumer may auto-resume.'
      : 'Completion will be displayed without entering model context.';
  }
  if (run.completionDelivery === 'next-turn') {
    return 'Completion will be persisted for the next natural model turn without waking it.';
  }
  return 'Completion will be reported automatically with one model follow-up.';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function boundedDiagnostic(value: string): string {
  const sanitized = sanitizeTerminalText(value);
  return sanitized.length <= 2_000 ? sanitized : `${sanitized.slice(0, 1_999)}…`;
}

function userBashTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('Invalid timeout: must be a finite number of seconds');
  }
  const timeoutMs = timeout * 1_000;
  if (timeoutMs > 2_147_483_647) {
    throw new Error('Invalid timeout: exceeds the platform timer limit');
  }
  return timeoutMs;
}

function boundedDisplayCommand(command: string): string {
  const maximumBytes = 4_096;
  if (Buffer.byteLength(command) <= maximumBytes) return command;
  const suffix = '… [command truncated]';
  const budget = maximumBytes - Buffer.byteLength(suffix);
  let result = '';
  for (const character of command) {
    if (Buffer.byteLength(result + character) > budget) break;
    result += character;
  }
  return result + suffix;
}

function undisplayedCompletionCount(ctx: ExtensionContext): number {
  const getBranch = ctx.sessionManager.getBranch;
  if (typeof getBranch !== 'function') return 0;
  return getBranch
    .call(ctx.sessionManager)
    .filter(
      (entry) =>
        entry.type === 'custom' &&
        entry.customType === TMUX_BASH_DISPLAY_COMPLETION &&
        (entry.data as { displayed?: unknown } | undefined)?.displayed === false,
    ).length;
}
