import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { ContinuationGateController } from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { watch } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { clampPollInterval, clampTimeout } from './config.js';
import {
  createCommandArtifacts,
  createPiSessionEnvironment,
  scheduleRunDirectoryCleanup,
} from './command-artifacts.js';
import { formatOutput, readExitCode, readOutput, type OutputTail } from './output.js';
import type { BashInput } from './schemas.js';
import { sanitizeTerminalText } from './sanitize.js';
import { updateTmuxBashStatus } from './status.js';
import { TmuxClient } from './tmux-client.js';
import { deriveTmuxSession, deriveWindowName, resolveGitRoot, shortHash } from './tmux-scope.js';
import {
  TMUX_BASH_COMPLETION_MESSAGE,
  type CommandRun,
  type Poller,
  type TmuxBashConfig,
  type TmuxBashDetails,
  type TmuxBashRuntimeState,
  type TmuxToolDetails,
} from './types.js';

const BACKGROUND_COMPLETION_SCAN_INTERVAL_MS = 250;

export class TmuxBashRuntime {
  readonly state: TmuxBashRuntimeState;
  private currentGitRoot?: string;

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

  async startSession(ctx: ExtensionContext): Promise<void> {
    if (this.state.runDir) await this.shutdown(ctx);
    this.state.disposed = false;
    this.state.statusContext = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    const parent = this.config.outputDir || tmpdir();
    await mkdir(parent, { recursive: true, mode: 0o700 });
    this.state.runDir = await mkdtemp(join(parent, `pi-tmux-${shortHash(sessionId, 8)}-`));
    this.state.gateController.publishSnapshot(sessionId);
    this.publishStatus();
  }

  async shutdown(ctx?: ExtensionContext): Promise<void> {
    if (this.state.disposed) return;
    this.state.disposed = true;
    this.state.watcher?.close();
    this.state.watcher = null;
    if (this.state.completionMonitor) clearInterval(this.state.completionMonitor);
    this.state.completionMonitor = null;
    for (const poller of this.state.pollers.values()) clearInterval(poller.timer);
    this.state.pollers.clear();
    for (const run of this.state.commands.values()) {
      if (run.completionRetryTimer) clearTimeout(run.completionRetryTimer);
    }

    const sessionId =
      ctx?.sessionManager.getSessionId() ?? this.state.statusContext?.sessionManager.getSessionId();
    if (sessionId) this.state.gateController.clearSession(sessionId, 'abandoned');
    if (ctx) updateTmuxBashStatus(this.pi, ctx, { ...this.config, statusbarEnabled: false }, []);

    const runDir = this.state.runDir;
    const hasLiveCommands = [...this.state.commands.values()].some(
      (run) => run.endedAt === undefined && !run.killed,
    );
    this.state.runDir = null;
    this.state.statusContext = null;
    this.state.commands.clear();
    if (runDir && !this.config.preserveOutputFiles) {
      if (hasLiveCommands) {
        await scheduleRunDirectoryCleanup(runDir);
      } else {
        await rm(runDir, { recursive: true, force: true });
      }
    }
  }

  async executeBash(
    input: BashInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TmuxBashDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TmuxBashDetails>> {
    const command = input.command.trim();
    if (!command) throw new Error('bash command must not be empty.');
    this.assertReady(ctx);
    throwIfCancelled(signal);
    await this.tmux.checkAvailable(signal);
    throwIfCancelled(signal);
    this.ensureWatcher();

    const runDir = this.state.runDir;
    if (!runDir) throw new Error('tmux-bash runtime has no artifact directory.');
    const sessionId = ctx.sessionManager.getSessionId();
    const gitRoot = await resolveGitRoot(ctx.cwd, signal);
    throwIfCancelled(signal);
    const runId = randomUUID().replaceAll('-', '');
    const tmuxSession = deriveTmuxSession(this.config, gitRoot);
    const artifacts = await createCommandArtifacts({
      runDir,
      runId,
      command,
      displayCommand: command,
      config: this.config,
      env: createPiSessionEnvironment(ctx),
    });
    throwIfCancelled(signal);
    const run: CommandRun = {
      ...artifacts,
      runId,
      sessionId,
      gitRoot,
      tmuxSession,
      command,
      displayCommand: command,
      startedAt: Date.now(),
      mode: input.background ? 'background' : 'foreground',
      backgroundReady: false,
      completionDelivered: false,
      completionClaimed: false,
      completionDeliveryFailures: 0,
      completionDeliveryFailed: false,
      killed: false,
    };
    this.state.commands.set(runId, run);
    this.currentGitRoot = gitRoot;

    const shouldGateBackground =
      input.background &&
      (input.waitForCompletion ?? this.config.defaultWaitForBackgroundCompletion);
    if (shouldGateBackground) this.acquireGate(run);

    try {
      run.windowId = await this.tmux.createWindow({
        sessionName: tmuxSession,
        windowName: deriveWindowName(this.config, { name: input.name, runId, command }),
        cwd: ctx.cwd,
        scriptFile: run.scriptFile,
        metadata: {
          version: 'v1',
          gitRoot,
          piSessionId: sessionId,
          runId,
          startedAt: run.startedAt,
          outputFile: run.outputFile,
          displayCommand: run.displayCommand,
        },
        signal,
      });
      throwIfCancelled(signal);
      if (run.gateId) this.acquireGate(run);
    } catch (error) {
      if (run.windowId) await this.tmux.killWindow(run.windowId).catch(() => undefined);
      run.killed = true;
      run.endedAt = Date.now();
      run.completionClaimed = true;
      this.releaseGate(run, signal?.aborted ? 'cancelled' : 'failed', 'current-turn');
      this.state.commands.delete(runId);
      this.publishStatus();
      if (signal?.aborted) throw cancelledError();
      throw error;
    }

    if (input.background) {
      try {
        throwIfCancelled(signal);
        if (input.pollInterval !== undefined) {
          this.startPoll(run, input.pollInterval, input.pollLines);
        }
        this.publishStatus();
        const completed = await this.completeIfReady(run, false);
        if (completed) return completed;
        const running = await this.runningResult(run);
        throwIfCancelled(signal);
        run.backgroundReady = true;
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
    this.stopPoll(run.runId);
    this.releaseGate(run, 'killed', 'current-turn');
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
    return this.tmuxResult(
      'poll',
      [run],
      `Polling ${windowId} every ${poller.intervalSeconds}s (${poller.lines} lines, ${this.config.pollDelivery}).`,
    );
  }

  async unpoll(windowId: string, ctx: ExtensionContext) {
    const run = await this.requireRun(windowId, ctx);
    const removed = this.stopPoll(run.runId);
    return this.tmuxResult(
      'unpoll',
      [run],
      removed ? `Stopped polling ${windowId}.` : `${windowId} was not polled.`,
    );
  }

  async listResult(ctx: ExtensionContext) {
    await this.reconcile(ctx);
    const runs = this.list(ctx);
    if (runs.length === 0) return this.tmuxResult('list', [], 'No managed tmux windows in scope.');
    const text = runs.map((run) => this.describeRun(run)).join('\n');
    return this.tmuxResult('list', runs, text);
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
      const completed = await this.completeIfReady(run, false);
      if (completed) return completed;
      if (input.pollInterval !== undefined)
        this.startPoll(run, input.pollInterval, input.pollLines);
      this.publishStatus();
      const running = await this.runningResult(
        run,
        `Timed out after ${timeoutSeconds}s; continuing in background.`,
      );
      run.backgroundReady = true;
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
    run.completionClaimed = true;
    run.completionDelivered = true;
    const result = await this.completedResult(run);
    await this.closeCompletedWindow(run);
    this.publishStatus();
    if (exitCode !== 0) {
      const output = result.content[0]?.type === 'text' ? result.content[0].text : '';
      throw new Error(`${output}\nCommand exited with code ${exitCode}`.trim());
    }
    return result;
  }

  private async terminateForeground(run: CommandRun, outcome: 'cancelled' | 'failed') {
    if (run.windowId && (await this.isOwnedWindow(run))) await this.tmux.killWindow(run.windowId);
    run.killed = true;
    run.endedAt = Date.now();
    run.completionClaimed = true;
    this.stopPoll(run.runId);
    this.releaseGate(run, outcome, 'current-turn');
    this.publishStatus();
  }

  private waitForExit(
    run: CommandRun,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<'completed' | 'timeout' | 'aborted'> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: 'completed' | 'timeout' | 'aborted') => {
        if (settled) return;
        settled = true;
        clearInterval(interval);
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        resolve(outcome);
      };
      const abort = () => finish('aborted');
      const interval = setInterval(() => {
        void readExitCode(run.exitCodeFile).then((code) => {
          if (code !== undefined) finish('completed');
        });
      }, 100);
      const timeout = setTimeout(() => finish('timeout'), timeoutMs);
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

    let result: AgentToolResult<TmuxBashDetails>;
    try {
      result = await this.completedResult(run);
    } catch (error) {
      const reason = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
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
      let wakeHandoff: ReturnType<typeof this.state.gateController.prepareWake> | undefined;
      try {
        if (run.gateId)
          wakeHandoff = this.state.gateController.prepareWake({
            sessionId: run.sessionId,
            gateId: run.gateId,
          });
        this.pi.sendMessage(
          {
            customType: TMUX_BASH_COMPLETION_MESSAGE,
            content:
              `${run.windowId ?? run.runId} completed with exit code ${exitCode}.\n${output}`.trim(),
            display: true,
            details: result.details,
          },
          { triggerTurn: true, deliverAs: 'followUp' },
        );
        if (wakeHandoff && !this.state.gateController.commitWake(wakeHandoff)) {
          throw new Error('Continuation wake handoff could not be committed.');
        }
      } catch (error) {
        if (wakeHandoff) this.state.gateController.abortWake(wakeHandoff);
        run.completionClaimed = false;
        run.completionDelivered = false;
        run.completionDeliveryFailures += 1;
        this.releaseGate(run, 'failed', 'none');
        result.details = this.details(run, result.details?.truncation);
        const exhausted =
          run.completionDeliveryFailures >= this.config.completionDeliveryMaxAttempts;
        run.completionDeliveryFailed = exhausted;
        if (exhausted) {
          const reason = sanitizeTerminalText(
            error instanceof Error ? error.message : String(error),
          );
          try {
            this.state.statusContext?.ui.notify(
              `Tmux command ${run.windowId ?? run.runId} completed, but its follow-up could not be delivered after ${run.completionDeliveryFailures} attempts${reason ? `: ${reason}` : '.'}`,
              'error',
            );
          } catch {
            // The gate is already released; a broken fallback UI cannot strand the session.
          }
          await this.closeCompletedWindow(run).catch(() => undefined);
        } else if (!this.state.disposed) {
          const delay =
            this.config.completionDeliveryRetryBaseMs * 2 ** (run.completionDeliveryFailures - 1);
          run.completionRetryTimer = setTimeout(() => {
            run.completionRetryTimer = undefined;
            void this.completeIfReady(run, true);
          }, delay);
          run.completionRetryTimer.unref();
        }
        this.publishStatus();
        return result;
      }
      run.completionClaimed = true;
      run.completionDelivered = true;
      if (wakeHandoff)
        this.releaseGate(
          run,
          exitCode === 0 ? 'completed' : 'failed',
          'producer-message',
          wakeHandoff.handoffId,
        );
    } else {
      run.completionClaimed = true;
      run.completionDelivered = true;
      this.releaseGate(run, exitCode === 0 ? 'completed' : 'failed', 'current-turn');
    }
    await this.closeCompletedWindow(run).catch(() => undefined);
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
      `Completion will be reported automatically while this Pi runtime is active.`,
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
    return poller;
  }

  private stopPoll(runId: string): boolean {
    const poller = this.state.pollers.get(runId);
    if (!poller) return false;
    clearInterval(poller.timer);
    this.state.pollers.delete(runId);
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
      reason: `Waiting for tmux command: ${sanitizeTerminalText(run.displayCommand).slice(0, 160)}`,
      resource: { kind: 'tmux-command', id: run.runId, label: run.windowId ?? run.runId },
    });
    run.gateId = gateId;
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
      ...(handoffId ? { handoffId } : {}),
    });
    if (released) run.gateId = undefined;
    return released;
  }

  private details(run: CommandRun, truncation?: TmuxBashDetails['truncation']): TmuxBashDetails {
    const state = run.killed
      ? 'killed'
      : run.endedAt === undefined
        ? 'running'
        : run.exitCode === 0
          ? 'completed'
          : 'failed';
    return {
      runId: run.runId,
      windowId: run.windowId,
      tmuxSession: run.tmuxSession,
      command: sanitizeTerminalText(run.command),
      outputFile: run.outputFile,
      fullOutputPath: truncation?.truncated ? run.outputFile : undefined,
      truncation,
      exitCode: run.exitCode,
      state,
      background: run.mode === 'background',
      awaited: Boolean(run.gateId),
      durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
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
          windowId: run.windowId,
          command: sanitizeTerminalText(run.displayCommand),
          state: this.details(run).state,
          background: run.mode === 'background',
          awaited: Boolean(run.gateId),
          polling: this.state.pollers.has(run.runId),
          ageMs: Date.now() - run.startedAt,
          outputFile: run.outputFile,
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
      version: 'v1',
      gitRoot: run.gitRoot,
      piSessionId: run.sessionId,
      runId: run.runId,
    });
  }

  private async failUnownedRun(run: CommandRun, deliverFollowUp: boolean): Promise<void> {
    if (run.endedAt || run.killed) return;
    run.endedAt = Date.now();
    run.completionClaimed = true;
    this.stopPoll(run.runId);

    if (deliverFollowUp && !this.state.disposed) {
      const formatted = formatOutput(await readOutput(run.outputFile, this.config.maxOutputBytes), {
        maxLines: this.config.completionContextLines,
        maxBytes: this.config.maxOutputBytes,
        fullOutputPath: run.outputFile,
      });
      const output = formatted.text ? `\n${formatted.text}` : '';
      let wakeHandoff: ReturnType<typeof this.state.gateController.prepareWake> | undefined;
      try {
        if (run.gateId)
          wakeHandoff = this.state.gateController.prepareWake({
            sessionId: run.sessionId,
            gateId: run.gateId,
          });
        this.pi.sendMessage(
          {
            customType: TMUX_BASH_COMPLETION_MESSAGE,
            content: `${run.windowId ?? run.runId} failed: the managed tmux window disappeared or is no longer owned by this Pi run.${output}`,
            display: true,
            details: this.details(run, formatted.truncation),
          },
          { triggerTurn: true, deliverAs: 'followUp' },
        );
        if (wakeHandoff && !this.state.gateController.commitWake(wakeHandoff))
          throw new Error('Continuation wake handoff could not be committed.');
        run.completionDelivered = true;
        if (wakeHandoff) this.releaseGate(run, 'failed', 'producer-message', wakeHandoff.handoffId);
      } catch {
        if (wakeHandoff) this.state.gateController.abortWake(wakeHandoff);
        run.completionDelivered = false;
        this.releaseGate(run, 'failed', 'none');
      }
    } else {
      run.completionDelivered = true;
      this.releaseGate(run, 'failed', 'current-turn');
    }
    this.publishStatus();
  }

  private isInScope(run: CommandRun, ctx: ExtensionContext): boolean {
    if (this.config.tmuxWindowScope === 'all') return true;
    if (this.config.tmuxWindowScope === 'pi-session') {
      return run.sessionId === ctx.sessionManager.getSessionId();
    }
    return run.gitRoot === this.currentGitRoot;
  }

  private describeRun(run: CommandRun): string {
    const details = this.details(run);
    const flags = [
      details.state,
      details.awaited ? 'awaited' : '',
      this.state.pollers.has(run.runId) ? 'polling' : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `${run.windowId ?? run.runId} [${flags}] ${run.displayCommand}`;
  }

  private async readRunOutput(run: CommandRun): Promise<string | OutputTail> {
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
