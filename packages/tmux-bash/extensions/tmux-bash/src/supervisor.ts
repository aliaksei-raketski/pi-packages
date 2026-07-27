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

export class TmuxBashSupervisor {
  readonly state: TmuxBashRuntimeState;
  private runStore?: RunStore;
  private resources?: ResourceManager;
  private completion?: CompletionDeliveryService;
  private resourceScanTimer?: ReturnType<typeof setInterval>;
  private readonly sessionArtifacts = new Map<string, string>();

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
    let scope: TmuxWorkspaceScope | undefined;
    try {
      scope = await resolveWorkspaceScope(this.config, ctx.cwd);
    } catch (error) {
      if (this.config.nonGitScope === 'cwd') throw error;
    }
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
      for (const run of [...adopted.live, ...adopted.completed, ...adopted.orphaned]) {
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
      if (adopted.diagnostics.length > 0) {
        ctx.ui.notify(adopted.diagnostics.slice(0, 5).join('\n'), 'warning');
      }
    }
    if (this.config.quotaPolicy === 'cleanup-completed') {
      await resources.cleanup({
        automatic: true,
        isLiveOwnedWindow: (manifest) => this.isLiveOwnedManifest(manifest),
        isActiveRun: (manifest) => this.isValidatedActiveManifest(manifest),
      });
      this.resourceScanTimer = setInterval(() => {
        void this.resources?.cleanup({
          automatic: true,
          isLiveOwnedWindow: (manifest) => this.isLiveOwnedManifest(manifest),
          isActiveRun: (manifest) => this.isValidatedActiveManifest(manifest),
        });
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
      if (run.completionRetryTimer) clearTimeout(run.completionRetryTimer);
      run.awaited = Boolean(run.gateId) || run.awaited;
      if (run.killed) {
        run.state = 'killed';
        run.endedAt ??= Date.now();
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
        if (isLive) {
          await scheduleRunArtifactCleanup(runDir, runId).catch(() => undefined);
        } else {
          await removeUncommittedArtifacts(runDir, runId).catch(() => undefined);
        }
      }
    }
    this.sessionArtifacts.clear();

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
      if (run?.windowId) await this.tmux.killWindow(run.windowId).catch(() => undefined);
      if (run && !(error instanceof ArtifactQuotaError)) {
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
        void this.completeIfReady(run, true);
        return running;
      } catch (error) {
        if (!signal?.aborted) throw error;
        await this.terminateForeground(run, 'cancelled');
        this.state.commands.delete(runId);
        throw cancelledError();
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
  }): CommandRun {
    return {
      ...input.artifacts,
      runId: input.runId,
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
        await this.terminateForeground(run, outcome === 'aborted' ? 'cancelled' : 'failed', store);
        throw new Error(outcome === 'aborted' ? 'aborted' : `timeout:${options.timeout}`);
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
      if (run && !run.windowId) {
        this.state.commands.delete(run.runId);
        await removeUncommittedArtifacts(runDir, runId).catch(() => undefined);
        this.sessionArtifacts.delete(runId);
        run = undefined;
      }
      throw error;
    } finally {
      outputStream?.destroy();
      await streamDone?.catch(() => undefined);
      if (run?.streamFile) await rm(run.streamFile, { force: true }).catch(() => undefined);
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
    if (run.endedAt || run.killed) {
      return this.tmuxResult('kill', [run], `Managed command ${windowId} is already finished.`);
    }
    if (run.windowId) await this.tmux.killWindow(run.windowId);
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
    const result = this.tmuxResult('list', runs, lines.join('\n'));
    if (this.resources) {
      const usage = await this.resources.usage({
        isActiveRun: (manifest) => this.isValidatedActiveManifest(manifest),
      });
      result.details.usage = this.resourceUsageDetails(usage);
      lines.push(
        `Usage: ${usage.activeRuns} active, ${usage.reservations} reserved, ${usage.artifactBytes}/${this.config.maxArtifactBytesTotal} artifact bytes, ${usage.completedRuns}/${this.config.maxCompletedRuns} completed runs.`,
      );
      result.content = [{ type: 'text', text: lines.join('\n') }];
    }
    return result;
  }

  async listPollsResult(ctx: ExtensionContext) {
    await this.reconcile(ctx);
    const runs = this.list(ctx).filter((run) => this.state.pollers.has(run.runId));
    if (runs.length === 0)
      return this.tmuxResult('list-polls', [], 'No active tmux polls in scope.');
    const text = runs
      .flatMap((run) => {
        const poller = this.state.pollers.get(run.runId);
        return poller
          ? [`${run.windowId}: every ${poller.intervalSeconds}s, ${poller.lines} lines`]
          : [];
      })
      .join('\n');
    return this.tmuxResult('list-polls', runs, text);
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
    const candidates = await resources.preview({ includeYoung });
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
      : 'No completed or orphaned tmux artifacts are eligible for cleanup.';
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

  async cleanup(ctx: ExtensionContext, includeYoung = false) {
    this.assertActionEnabled('cleanup');
    this.assertReady(ctx);
    const resources = this.resources;
    if (!resources) throw new Error('tmux-bash resource manager is unavailable.');
    const removed = await resources.cleanup({
      includeYoung,
      isLiveOwnedWindow: (manifest) => this.isLiveOwnedManifest(manifest),
    });
    for (const candidate of removed) this.state.commands.delete(candidate.runId);
    const result = this.tmuxResult(
      'cleanup',
      [],
      removed.length
        ? `Removed ${removed.length} validated completed run(s), reclaiming ${removed.reduce((sum, item) => sum + item.bytes, 0)} bytes.`
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
      ? setInterval(
          () => void this.sendForegroundUpdate(run, onUpdate),
          this.config.foregroundUpdateIntervalMs,
        )
      : undefined;
    try {
      const outcome = await this.waitForExit(run, timeoutSeconds * 1_000, signal);
      if (outcome === 'completed') return await this.finishForeground(run);
      if (outcome === 'aborted') {
        await this.terminateForeground(run, 'cancelled');
        throw new Error(`tmux bash command was cancelled.\n${await this.errorOutput(run)}`);
      }

      const timeoutAction = input.timeoutAction ?? this.config.defaultTimeoutAction;
      if (timeoutAction === 'kill') {
        await this.terminateForeground(run, 'failed');
        throw new Error(
          `tmux bash command timed out after ${timeoutSeconds}s and was killed.\n${await this.errorOutput(run)}`,
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
      void this.completeIfReady(run, true);
      return running;
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  private async finishForeground(run: CommandRun): Promise<AgentToolResult<TmuxBashDetails>> {
    const exitCode = await readExitCode(run.exitCodeFile);
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
  ) {
    if (run.windowId && (await this.isOwnedWindow(run))) await this.tmux.killWindow(run.windowId);
    run.killed = true;
    run.endedAt = Date.now();
    run.deliveryState = 'failed';
    run.completionClaimed = true;
    this.stopPoll(run.runId);
    this.releaseGate(run, outcome, 'current-turn');
    await store?.transition(run, 'killed');
    this.publishStatus();
  }

  private waitForExit(
    run: CommandRun,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<'completed' | 'timeout' | 'aborted'> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: 'completed' | 'timeout' | 'aborted') => {
        if (settled) return;
        settled = true;
        clearInterval(interval);
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        resolve(outcome);
      };
      const abort = () => finish('aborted');
      const interval = setInterval(() => {
        void readExitCode(run.exitCodeFile).then((code) => {
          if (code !== undefined) finish('completed');
        });
      }, 100);
      const timeout =
        timeoutMs === undefined ? undefined : setTimeout(() => finish('timeout'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) finish('aborted');
      void readExitCode(run.exitCodeFile).then((code) => {
        if (code !== undefined) finish('completed');
      });
    });
  }

  private ensureWatcher(): void {
    if (!this.state.runDir) return;
    if (!this.state.watcher) {
      this.state.watcher = watch(this.state.runDir, (_event, filename) => {
        if (!filename?.endsWith('.exit')) return;
        const runId = filename.slice(0, -'.exit'.length);
        const run = this.state.commands.get(runId);
        if (run?.mode === 'background' && run.backgroundReady) {
          void this.completeIfReady(run, true);
        }
      });
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
            void this.completeIfReady(run, true);
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
    const exitCode = await readExitCode(run.exitCodeFile);
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

    if (deliver && run.mode === 'background' && !this.state.disposed) {
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
        if (exhausted) {
          const reason = boundedDiagnostic(error instanceof Error ? error.message : String(error));
          ctx.ui.notify(
            `Tmux command ${run.windowId ?? run.runId} completed, but delivery failed after ${run.completionDeliveryFailures} attempts${reason ? `: ${reason}` : '.'}`,
            'error',
          );
        } else if (!this.state.disposed) {
          run.completionDeliveryFailed = false;
          run.deliveryState = 'pending';
          const delay =
            this.config.completionDeliveryRetryBaseMs * 2 ** (run.completionDeliveryFailures - 1);
          run.completionRetryTimer = setTimeout(() => {
            run.completionRetryTimer = undefined;
            void this.completeIfReady(run, true);
          }, delay);
          run.completionRetryTimer.unref();
        }
        await this.runStore?.persist(run).catch(() => undefined);
        this.publishStatus();
        return result;
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
      });
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
    poller.timer = setInterval(() => void this.pollTick(poller), poller.intervalSeconds * 1_000);
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
    if (!run || this.state.disposed) return void this.stopPoll(poller.runId);
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
  ): AgentToolResult<TmuxToolDetails> {
    return {
      content: [{ type: 'text', text: sanitizeTerminalText(text) }],
      details: {
        action,
        runs: runs.map((run) => ({
          runId: run.runId,
          completionId: run.completionId,
          windowId: run.windowId,
          command: sanitizeTerminalText(run.displayCommand),
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
        if (await this.completeIfReady(run, false)) return undefined;
        if (await this.isOwnedWindow(run)) return undefined;
        return this.failUnownedRun(run, false);
      }),
    );
    this.publishStatus();
  }

  private async requireRun(windowId: string, ctx: ExtensionContext): Promise<CommandRun> {
    const run = this.list(ctx).find((candidate) => candidate.windowId === windowId);
    if (!run) throw new Error(`No managed tmux window ${windowId} exists in the configured scope.`);
    if (!run.endedAt && !run.killed && (await this.completeIfReady(run, false))) return run;
    if (!run.endedAt && !run.killed && !(await this.isOwnedWindow(run))) {
      await this.failUnownedRun(run, false);
      throw new Error(
        `Tmux window ${windowId} is missing or no longer carries this run's ownership metadata.`,
      );
    }
    return run;
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
    if (deliverFollowUp && !this.state.disposed && this.completion && this.state.statusContext) {
      try {
        const outcome = await this.completion.deliverCompletion(
          run,
          { text, details: this.details(run, formatted.truncation) },
          this.state.statusContext,
        );
        this.releaseGate(run, 'failed', outcome.wake, outcome.handoff?.handoffId);
      } catch {
        run.deliveryState = 'failed';
        run.completionDelivered = false;
        this.releaseGate(run, 'failed', 'none');
      }
    } else {
      run.deliveryState = 'delivered';
      run.completionDelivered = true;
      this.releaseGate(run, 'failed', 'current-turn');
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
    if (run.endedAt || run.killed || run.state !== 'running') {
      throw new Error(`Managed command ${windowId} is not running.`);
    }
    if (!(await this.isOwnedWindow(run))) {
      await this.failUnownedRun(run, false);
      throw new Error(`Managed tmux window ${windowId} failed its ownership revalidation.`);
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
    if (!this.config.enabledTmuxActions.includes(action)) {
      throw new Error(`tmux action ${action} is disabled by configuration.`);
    }
  }

  private async isValidatedActiveManifest(
    manifest: ManagedRunManifest,
    store: RunStore | undefined = this.runStore,
  ): Promise<boolean> {
    if (!manifest.windowId) return false;
    try {
      if ((await readExitCode(manifest.exitCodeFile)) !== undefined) return false;
      if (await this.tmux.isPaneDead(manifest.windowId)) return false;
      const manifestPath =
        store?.manifestPath(manifest.runId) ??
        join(dirname(manifest.outputFile), `${manifest.runId}.manifest.json`);
      return await this.tmux.isOwnedWindow(manifest.windowId, {
        owner: TMUX_BASH_OWNERSHIP_MARKER,
        scope: manifest.scope,
        piSessionId: manifest.piSessionId,
        runId: manifest.runId,
        manifestPath,
        completionId: manifest.completionId,
        completionDelivery: manifest.completionDelivery,
      });
    } catch {
      return false;
    }
  }

  private async isLiveOwnedManifest(manifest: ManagedRunManifest): Promise<boolean> {
    if (!manifest.windowId) return false;
    try {
      // Cleanup fails closed for both an owned preserved pane and a stable ID that
      // has been reused by an unowned pane. Neither may be deleted as collateral.
      return await this.tmux.hasWindow(manifest.windowId);
    } catch {
      return true;
    }
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
