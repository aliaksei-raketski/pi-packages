import {
  CONTINUATION_GATE_ACQUIRE_EVENT,
  CONTINUATION_GATE_RELEASE_EVENT,
  CONTINUATION_GATE_SNAPSHOT_EVENT,
  createContinuationGateController,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TMUX_BASH_CONFIG } from '../src/config.js';
import { TmuxBashRuntime } from '../src/runtime.js';
import { TmuxClient, type TmuxExecutor } from '../src/tmux-client.js';
import { TMUX_BASH_DISPLAY_COMPLETION, TMUX_BASH_PENDING_COMPLETION } from '../src/types.js';

class EventBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();

  on(name: string, handler: (payload: unknown) => void) {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }

  emit(name: string, payload: unknown) {
    for (const handler of this.handlers.get(name) ?? []) handler(payload);
  }
}

const activeRuntimes: TmuxBashRuntime[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  try {
    await Promise.all(
      activeRuntimes.splice(0).map(async (runtime) => {
        for (const run of runtime.state.commands.values()) {
          run.killed = true;
          run.endedAt ??= Date.now();
        }
        await runtime.shutdown();
      }),
    );
  } finally {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

describe('TmuxBashRuntime', () => {
  it('surfaces durable no-UI display markers and resource usage through tmux list', async () => {
    const root = await temporaryDirectory('tmux-list-diagnostics-');
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn(), appendEntry: vi.fn() };
    const controller = createContinuationGateController(pi as never, {
      source: 'pi-tmux-bash',
    });
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: root,
        durableOutputDir: root,
        statusbarEnabled: false,
      },
      controller,
      new TmuxClient(
        'tmux',
        vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      ),
    );
    activeRuntimes.push(runtime);
    const base = fakeContext();
    const context = {
      ...base,
      sessionManager: {
        ...base.sessionManager,
        getBranch: () => [
          {
            type: 'custom',
            customType: TMUX_BASH_DISPLAY_COMPLETION,
            data: { displayed: false },
          },
        ],
      },
    };
    await runtime.startSession(context as never);
    const result = await runtime.listResult(context as never);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('display-only completion(s) were persisted without a UI'),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('Usage: 0 active'),
    });
    expect(result.details.usage).toMatchObject({ activeRuns: 0, reservations: 0 });
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('bounds list and list-polls model-visible output and run details', async () => {
    const root = await temporaryDirectory('tmux-list-bounded-');
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn(), appendEntry: vi.fn() };
    const controller = createContinuationGateController(pi as never, { source: 'pi-tmux-bash' });
    const fakeTmux = managedTmux('@99');
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: root,
        durableOutputDir: root,
        statusbarEnabled: false,
      },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    const context = fakeContext();
    await runtime.startSession(context as never);
    const started = await runtime.executeBash(
      { command: 'sleep 10', background: true },
      undefined,
      undefined,
      context as never,
    );
    const base = runtime.state.commands.get(started.details?.runId ?? '');
    if (!base) throw new Error('Expected base run.');
    const sharedTimer = setInterval(() => undefined, 60_000);
    for (let index = 0; index < 2_500; index += 1) {
      const runId = `bounded-${String(index).padStart(4, '0')}`;
      const clone = {
        ...base,
        runId,
        completionId: `completion-${runId}`,
        windowId: `@${index + 100}`,
        state: 'completed' as const,
        endedAt: Date.now(),
        exitCode: 0,
        killed: false,
        completionDelivered: true,
        completionClaimed: true,
        completionDeliveryFailed: false,
        deliveryState: 'delivered' as const,
        displayCommand: 'x'.repeat(4_096),
        command: 'x'.repeat(4_096),
      };
      runtime.state.commands.set(runId, clone);
      runtime.state.pollers.set(runId, {
        key: clone.windowId,
        timer: sharedTimer,
        runId,
        intervalSeconds: 30,
        lines: 80,
        lastOutput: '',
      });
    }

    const listed = await runtime.listResult(context as never);
    const listText = listed.content[0]?.type === 'text' ? listed.content[0].text : '';
    expect(Buffer.byteLength(listText)).toBeLessThanOrEqual(64 * 1024);
    expect(listText).toContain('additional line(s) omitted');
    expect(listed.details.runs.length).toBeLessThanOrEqual(100);
    expect(listed.details.runs[0]?.command.length).toBeLessThanOrEqual(512);

    const polls = await runtime.listPollsResult(context as never);
    const pollText = polls.content[0]?.type === 'text' ? polls.content[0].text : '';
    expect(Buffer.byteLength(pollText)).toBeLessThanOrEqual(64 * 1024);
    expect(pollText).toContain('additional line(s) omitted');

    clearInterval(sharedTimer);
    runtime.state.pollers.clear();
    for (const runId of [...runtime.state.commands.keys()]) {
      if (runId.startsWith('bounded-')) runtime.state.commands.delete(runId);
    }
    base.killed = true;
    base.endedAt = Date.now();
    await runtime.shutdown(context as never);
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('removes this session artifacts on shutdown when preservation is disabled', async () => {
    const root = await temporaryDirectory('tmux-shutdown-cleanup-');
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn(), appendEntry: vi.fn() };
    const controller = createContinuationGateController(pi as never, {
      source: 'pi-tmux-bash',
    });
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: root,
        durableOutputDir: root,
        preserveOutputFiles: false,
        statusbarEnabled: false,
      },
      controller,
      new TmuxClient('tmux', managedTmux('@98').execute),
    );
    activeRuntimes.push(runtime);
    const context = fakeContext();
    await runtime.startSession(context as never);
    const result = await runtime.executeBash(
      { command: 'sleep 10', background: true },
      undefined,
      undefined,
      context as never,
    );
    const run = runtime.state.commands.get(result.details?.runId ?? '');
    if (!run) throw new Error('Expected a managed run.');
    run.killed = true;
    run.endedAt = Date.now();
    await runtime.shutdown(context as never);

    await expect(readFile(run.outputFile)).rejects.toMatchObject({ code: 'ENOENT' });
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('retains live artifacts needed for same-session adoption when preservation is disabled', async () => {
    const root = await temporaryDirectory('tmux-shutdown-adoption-');
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn(), appendEntry: vi.fn() };
    const controller = createContinuationGateController(pi as never, {
      source: 'pi-tmux-bash',
    });
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: root,
        durableOutputDir: root,
        adoptionPolicy: 'same-pi-session',
        preserveOutputFiles: false,
        statusbarEnabled: false,
      },
      controller,
      new TmuxClient('tmux', managedTmux('@99').execute),
    );
    activeRuntimes.push(runtime);
    const context = fakeContext();
    await runtime.startSession(context as never);
    const result = await runtime.executeBash(
      { command: 'sleep 10', background: true },
      undefined,
      undefined,
      context as never,
    );
    const run = runtime.state.commands.get(result.details?.runId ?? '');
    if (!run) throw new Error('Expected a managed run.');

    await runtime.shutdown(context as never);

    await expect(readFile(run.manifestPath, 'utf8')).resolves.toContain('"state":"running"');
    await expect(readFile(run.outputFile, 'utf8')).resolves.toBeDefined();
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a launch whose structural artifacts exceed the bounded quota headroom', async () => {
    const root = await temporaryDirectory('tmux-launch-quota-');
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn(), appendEntry: vi.fn() };
    const controller = createContinuationGateController(pi as never, {
      source: 'pi-tmux-bash',
    });
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: root,
        durableOutputDir: root,
        maxArtifactBytesPerRun: 1_024,
        maxArtifactBytesTotal: 38_000,
        statusbarEnabled: false,
      },
      controller,
      new TmuxClient('tmux', managedTmux('@96').execute),
    );
    activeRuntimes.push(runtime);
    const context = fakeContext();
    await runtime.startSession(context as never);

    await expect(
      runtime.executeBash(
        { command: `printf %s ${'x'.repeat(40_000)}`, background: true },
        undefined,
        undefined,
        context as never,
      ),
    ).rejects.toThrow(/structural limit/);
    const runDir = runtime.state.runDir;
    if (!runDir) throw new Error('Expected an active run directory.');
    expect((await readdir(runDir)).filter((name) => name !== '.reservations')).toEqual([]);
    expect(runtime.state.commands.size).toBe(0);
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('does not let a completed-while-offline pane exhaust concurrency', async () => {
    const root = await temporaryDirectory('tmux-offline-capacity-');
    const events = new EventBus();
    const context = fakeContext();
    const fakeTmux = managedTmux('@97');
    const config = {
      ...DEFAULT_TMUX_BASH_CONFIG,
      outputDir: root,
      durableOutputDir: root,
      maxConcurrentRuns: 1,
      preserveOutputFiles: true,
      statusbarEnabled: false,
    };
    const firstController = createContinuationGateController({ events } as never, {
      source: 'pi-tmux-bash',
    });
    const first = new TmuxBashRuntime(
      { events, sendMessage: vi.fn(), appendEntry: vi.fn() } as never,
      config,
      firstController,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(first);
    await first.startSession(context as never);
    const started = await first.executeBash(
      { command: 'sleep 10', background: true },
      undefined,
      undefined,
      context as never,
    );
    const offlineRun = first.state.commands.get(started.details?.runId ?? '');
    if (!offlineRun) throw new Error('Expected an offline run.');
    await first.shutdown(context as never);
    firstController.dispose();
    await writeFile(offlineRun.exitCodeFile, '0\n');

    const secondController = createContinuationGateController({ events } as never, {
      source: 'pi-tmux-bash',
    });
    const second = new TmuxBashRuntime(
      { events, sendMessage: vi.fn(), appendEntry: vi.fn() } as never,
      config,
      secondController,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(second);
    await second.startSession(context as never);
    await expect(
      second.executeBash(
        { command: 'sleep 10', background: true },
        undefined,
        undefined,
        context as never,
      ),
    ).resolves.toMatchObject({ details: { state: 'running' } });
    secondController.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('queues completion before gate release when the file watcher misses the exit event', async () => {
    const events = new EventBus();
    const ordering: string[] = [];
    const messages: unknown[] = [];
    events.on(CONTINUATION_GATE_ACQUIRE_EVENT, () => ordering.push('acquire'));
    events.on(CONTINUATION_GATE_RELEASE_EVENT, () => ordering.push('release'));

    const pi = {
      events,
      sendMessage: (message: unknown) => {
        ordering.push('message');
        messages.push(message);
      },
    };
    const context = fakeContext();
    const execute = vi.fn<TmuxExecutor>(async (_binary, args) => {
      if (args[0] === 'new-window') return { stdout: '@77\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      { ...DEFAULT_TMUX_BASH_CONFIG, statusbarEnabled: false },
      controller,
      new TmuxClient('tmux', execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);

    const started = await runtime.executeBash(
      { command: 'sleep 1; echo done', background: true, waitForCompletion: true },
      undefined,
      undefined,
      context as never,
    );
    expect(started.details?.windowId).toBe('@77');
    expect(started.terminate).toBe(true);
    expect(ordering).toContain('acquire');
    expect(controller.list('session-1')).toHaveLength(1);

    const details = started.details;
    if (!details) throw new Error('Expected tmux-bash details.');
    runtime.state.watcher?.close();
    runtime.state.watcher = null;
    await writeFile(details.outputFile, '$ sleep 1; echo done\ndone\n');
    const run = runtime.state.commands.get(details.runId);
    if (!run) throw new Error('Expected registered command run.');
    await writeFile(run.exitCodeFile, '0\n');

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(ordering.slice(-2)).toEqual(['message', 'release']);
    expect(controller.list('session-1')).toHaveLength(0);

    const internals = runtime as unknown as {
      completeIfReady(value: typeof run, deliver: boolean): Promise<unknown>;
    };
    await internals.completeIfReady(run, true);
    expect(messages).toHaveLength(1);
  });

  it('does not let passive list reconciliation consume a next-turn completion', async () => {
    const root = await temporaryDirectory('tmux-passive-completion-');
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn(), appendEntry: vi.fn() };
    const context = fakeContext();
    const controller = createContinuationGateController(pi as never, { source: 'pi-tmux-bash' });
    const fakeTmux = managedTmux('@77');
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: root,
        durableOutputDir: root,
        statusbarEnabled: false,
      },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);
    const started = await runtime.executeBash(
      {
        command: 'sleep 1',
        background: true,
        waitForCompletion: true,
        completionDelivery: 'next-turn',
      },
      undefined,
      undefined,
      context as never,
    );
    const run = runtime.state.commands.get(started.details?.runId ?? '');
    if (!run) throw new Error('Expected registered command run.');
    runtime.state.watcher?.close();
    runtime.state.watcher = null;
    if (runtime.state.completionMonitor) clearInterval(runtime.state.completionMonitor);
    runtime.state.completionMonitor = null;
    const manifestWithoutWindow = JSON.parse(await readFile(run.manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    delete manifestWithoutWindow.windowId;
    const internals = runtime as unknown as {
      completeIfReady(value: typeof run, deliver: boolean): Promise<unknown>;
      isLiveOwnedManifest(value: typeof manifestWithoutWindow): Promise<boolean>;
    };
    await expect(internals.isLiveOwnedManifest(manifestWithoutWindow)).resolves.toBe(true);
    await writeFile(run.outputFile, '$ sleep 1\ndone\n');
    await writeFile(run.exitCodeFile, '0\n');

    await runtime.listResult(context as never);

    expect(run.completionDelivered).toBe(false);
    expect(run.deliveryState).toBe('pending');
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(controller.list('session-1')).toHaveLength(1);

    await internals.completeIfReady(run, true);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      TMUX_BASH_PENDING_COMPLETION,
      expect.objectContaining({ runId: run.runId }),
    );
    expect(controller.list('session-1')).toHaveLength(0);
    controller.dispose();
  });

  it('reconciles a sentinel before kill without transitioning the completed run to killed', async () => {
    const root = await temporaryDirectory('tmux-kill-completion-race-');
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn(), appendEntry: vi.fn() };
    const context = fakeContext();
    const controller = createContinuationGateController(pi as never, { source: 'pi-tmux-bash' });
    const fakeTmux = managedTmux('@78');
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: root,
        durableOutputDir: root,
        autoCloseWindowsOnCompletion: false,
        statusbarEnabled: false,
      },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);
    const started = await runtime.executeBash(
      { command: 'sleep 1', background: true, waitForCompletion: true },
      undefined,
      undefined,
      context as never,
    );
    const run = runtime.state.commands.get(started.details?.runId ?? '');
    if (!run?.windowId) throw new Error('Expected registered command run.');
    runtime.state.watcher?.close();
    runtime.state.watcher = null;
    if (runtime.state.completionMonitor) clearInterval(runtime.state.completionMonitor);
    runtime.state.completionMonitor = null;
    await writeFile(run.outputFile, '$ sleep 1\ndone\n');
    await writeFile(run.exitCodeFile, '0\n');
    await runtime.listResult(context as never);

    const result = await runtime.kill(run.windowId, context as never);

    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('it was not killed'),
    });
    expect(run.state).toBe('completed');
    expect(run.killed).toBe(false);
    expect(fakeTmux.execute.mock.calls.some(([, args]) => args[0] === 'kill-window')).toBe(false);
    expect(controller.list('session-1')).toHaveLength(0);
    controller.dispose();
  });

  it('contains an actual watcher error event and keeps monitor fallback active', async () => {
    const root = await temporaryDirectory('tmux-watcher-emitter-error-');
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn(), appendEntry: vi.fn() };
    const context = fakeContext();
    const controller = createContinuationGateController(pi as never, { source: 'pi-tmux-bash' });
    const fakeTmux = managedTmux('@79');
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: root,
        durableOutputDir: root,
        statusbarEnabled: false,
      },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);
    await runtime.executeBash(
      { command: 'sleep 1', background: true },
      undefined,
      undefined,
      context as never,
    );
    const watcher = runtime.state.watcher;
    if (!watcher) throw new Error('Expected completion watcher.');

    expect(() => watcher.emit('error', new Error('watch backend failed'))).not.toThrow();

    expect(runtime.state.watcher).toBeNull();
    expect(runtime.state.completionMonitor).not.toBeNull();
    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('completion watcher failed'),
      'error',
    );
    controller.dispose();
  });

  it('contains invalid-sentinel observer failures, terminates the run, and releases its gate', async () => {
    const root = await temporaryDirectory('tmux-observer-failure-');
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn(), appendEntry: vi.fn() };
    const context = fakeContext();
    const controller = createContinuationGateController(pi as never, { source: 'pi-tmux-bash' });
    const fakeTmux = managedTmux('@78');
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: root,
        durableOutputDir: root,
        statusbarEnabled: false,
      },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);
    const started = await runtime.executeBash(
      { command: 'sleep 1', background: true, waitForCompletion: true },
      undefined,
      undefined,
      context as never,
    );
    const run = runtime.state.commands.get(started.details?.runId ?? '');
    if (!run) throw new Error('Expected registered command run.');
    await mkdir(run.exitCodeFile);

    await vi.waitFor(() => {
      expect(run.completionDeliveryFailed).toBe(true);
      expect(context.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('completion observer failed'),
        'error',
      );
    });
    expect(controller.list('session-1')).toHaveLength(0);
    expect(run.state).toBe('failed');
    expect(run.endedAt).toBeTypeOf('number');
    expect(fakeTmux.execute.mock.calls.some(([, args]) => args[0] === 'kill-window')).toBe(true);
    expect(context.ui.notify).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('terminates a foreground run when an existing exit sentinel is malformed', async () => {
    const root = await temporaryDirectory('tmux-foreground-invalid-sentinel-');
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn(), appendEntry: vi.fn() };
    const context = fakeContext();
    const controller = createContinuationGateController(pi as never, { source: 'pi-tmux-bash' });
    const fakeTmux = managedTmux('@80');
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: root,
        durableOutputDir: root,
        statusbarEnabled: false,
      },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);
    const executing = runtime.executeBash(
      { command: 'sleep 10' },
      undefined,
      undefined,
      context as never,
    );
    await vi.waitFor(() => expect(runtime.state.commands.size).toBe(1));
    const run = [...runtime.state.commands.values()][0];
    if (!run) throw new Error('Expected foreground run.');
    await writeFile(run.exitCodeFile, 'invalid\n');

    await expect(executing).rejects.toThrow('monitoring failed');
    expect(run.state).toBe('killed');
    expect(run.endedAt).toBeTypeOf('number');
    expect(fakeTmux.execute.mock.calls.some(([, args]) => args[0] === 'kill-window')).toBe(true);
    expect(controller.list('session-1')).toHaveLength(0);
    controller.dispose();
  });

  it('releases the gate and retries after completion follow-up delivery fails', async () => {
    const events = new EventBus();
    const releases: Array<{ wake?: string }> = [];
    events.on(CONTINUATION_GATE_RELEASE_EVENT, (payload) =>
      releases.push(payload as { wake?: string }),
    );
    const delivered: unknown[] = [];
    let attempts = 0;
    const pi = {
      events,
      sendMessage: (message: unknown) => {
        attempts += 1;
        if (attempts === 1) throw new Error('delivery unavailable');
        delivered.push(message);
      },
    };
    const context = fakeContext();
    const fakeTmux = managedTmux('@78');
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      { ...DEFAULT_TMUX_BASH_CONFIG, statusbarEnabled: false },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);

    const started = await runtime.executeBash(
      { command: 'echo done', background: true, waitForCompletion: true },
      undefined,
      undefined,
      context as never,
    );
    const run = runtime.state.commands.get(started.details?.runId ?? '');
    if (!run) throw new Error('Expected registered command run.');
    await writeFile(run.outputFile, '$ echo done\ndone\n');
    await writeFile(run.exitCodeFile, '0\n');

    await vi.waitFor(() => {
      expect(delivered).toHaveLength(1);
      expect(run.completionClaimed).toBe(true);
      expect(run.completionDelivered).toBe(true);
    });
    expect(attempts).toBe(2);
    expect(releases[0]).toMatchObject({ wake: 'none' });
    expect(controller.list('session-1')).toHaveLength(0);
  });

  it('protects terminal artifacts while completion delivery is pending retry', async () => {
    const root = await temporaryDirectory('tmux-retry-cleanup-');
    const events = new EventBus();
    let attempts = 0;
    const pi = {
      events,
      sendMessage: () => {
        attempts += 1;
        throw new Error('delivery unavailable');
      },
      appendEntry: vi.fn(),
    };
    const context = fakeContext();
    const fakeTmux = managedTmux('@81');
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: root,
        durableOutputDir: root,
        completionDeliveryRetryBaseMs: 5_000,
        completedArtifactRetentionSeconds: 0,
        statusbarEnabled: false,
      },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);
    const started = await runtime.executeBash(
      { command: 'echo done', background: true },
      undefined,
      undefined,
      context as never,
    );
    const run = runtime.state.commands.get(started.details?.runId ?? '');
    if (!run) throw new Error('Expected registered command run.');
    await writeFile(run.outputFile, '$ echo done\ndone\n');
    await writeFile(run.exitCodeFile, '0\n');
    await vi.waitFor(() => {
      expect(attempts).toBe(1);
      expect(run.deliveryState).toBe('pending');
      expect(run.completionRetryTimer).toBeDefined();
    });

    const cleanup = await runtime.cleanup(context as never, true);

    expect(cleanup.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('No eligible artifacts'),
    });
    await expect(readFile(run.manifestPath, 'utf8')).resolves.toContain(
      '"deliveryState":"pending"',
    );
    expect(runtime.state.commands.has(run.runId)).toBe(true);
    controller.dispose();
  });

  it('stops retrying and reports one terminal notification after permanent delivery failure', async () => {
    const events = new EventBus();
    let attempts = 0;
    const pi = {
      events,
      sendMessage: () => {
        attempts += 1;
        throw new Error('delivery permanently unavailable');
      },
    };
    const context = fakeContext();
    const fakeTmux = managedTmux('@79');
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        completionDeliveryMaxAttempts: 3,
        completionDeliveryRetryBaseMs: 10,
        statusbarEnabled: false,
      },
      createContinuationGateController(pi, { source: 'pi-tmux-bash' }),
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);

    const started = await runtime.executeBash(
      { command: 'echo done', background: true },
      undefined,
      undefined,
      context as never,
    );
    const run = runtime.state.commands.get(started.details?.runId ?? '');
    if (!run) throw new Error('Expected registered command run.');
    await writeFile(run.outputFile, '$ echo done\ndone\n');
    await writeFile(run.exitCodeFile, '0\n');

    await vi.waitFor(() => expect(attempts).toBe(3));

    expect(attempts).toBe(3);
    expect(run.completionDeliveryFailed).toBe(true);
    expect(run.completionRetryTimer).toBeUndefined();
    expect(context.ui.notify).toHaveBeenCalledTimes(1);
    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('after 3 attempts'),
      'error',
    );
    expect(fakeTmux.execute.mock.calls.some(([, args]) => args[0] === 'kill-window')).toBe(true);
  });

  it('preserves pending completion artifacts for same-session adoption during shutdown', async () => {
    const root = await temporaryDirectory('tmux-shutdown-pending-');
    const events = new EventBus();
    let attempts = 0;
    const pi = {
      events,
      sendMessage: () => {
        attempts += 1;
        throw new Error('delivery unavailable');
      },
    };
    const context = fakeContext();
    const fakeTmux = managedTmux('@80');
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: root,
        durableOutputDir: root,
        adoptionPolicy: 'same-pi-session',
        preserveOutputFiles: false,
        completionDeliveryRetryBaseMs: 50,
        statusbarEnabled: false,
      },
      createContinuationGateController(pi, { source: 'pi-tmux-bash' }),
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);

    const started = await runtime.executeBash(
      { command: 'echo done', background: true },
      undefined,
      undefined,
      context as never,
    );
    const run = runtime.state.commands.get(started.details?.runId ?? '');
    if (!run) throw new Error('Expected registered command run.');
    await writeFile(run.outputFile, '$ echo done\ndone\n');
    await writeFile(run.exitCodeFile, '0\n');
    await vi.waitFor(() => expect(attempts).toBe(1));

    await runtime.shutdown(context as never);

    expect(attempts).toBe(1);
    expect(run.completionRetryTimer).toBeUndefined();
    await expect(readFile(run.manifestPath, 'utf8')).resolves.toContain('"deliveryState":"failed"');
    await rm(root, { recursive: true, force: true });
  });

  it('bounds poll updates and reports an unowned awaited window before releasing its gate', async () => {
    const events = new EventBus();
    const ordering: string[] = [];
    const releases: unknown[] = [];
    const messages: Array<{ content?: string }> = [];
    events.on(CONTINUATION_GATE_RELEASE_EVENT, (payload) => {
      ordering.push('release');
      releases.push(payload);
    });
    const pi = {
      events,
      sendMessage: (message: { content?: string }) => {
        ordering.push('message');
        messages.push(message);
      },
    };
    const context = fakeContext();
    const fakeTmux = managedTmux('@91');
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        autoCloseWindowsOnCompletion: false,
        maxOutputBytes: 128,
        pollDelivery: 'model',
        statusbarEnabled: false,
      },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);
    const started = await runtime.executeBash(
      {
        command: 'printf huge',
        background: true,
        waitForCompletion: true,
        pollInterval: 60,
        pollLines: 20,
      },
      undefined,
      undefined,
      context as never,
    );
    const run = runtime.state.commands.get(started.details?.runId ?? '');
    if (!run) throw new Error('Expected registered command run.');
    await writeFile(run.outputFile, `$ ${run.displayCommand}\n${'x'.repeat(10_000)}`);
    const poller = runtime.state.pollers.get(run.runId);
    if (!poller) throw new Error('Expected active poller.');

    await (runtime as unknown as { pollTick(value: typeof poller): Promise<void> }).pollTick(
      poller,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain('Output truncated');
    expect(Buffer.byteLength(messages[0]?.content ?? '')).toBeLessThan(1_000);

    fakeTmux.metadata.set('@pi_tmux_bash_run_id', 'reused-by-another-run');
    await (runtime as unknown as { pollTick(value: typeof poller): Promise<void> }).pollTick(
      poller,
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toMatch(/failed:.*no longer owned/s);
    expect(Buffer.byteLength(messages[1]?.content ?? '')).toBeLessThan(1_000);
    expect(ordering.slice(-2)).toEqual(['message', 'release']);
    expect(releases.at(-1)).toMatchObject({ outcome: 'failed', wake: 'producer-message' });
    expect(controller.list('session-1')).toHaveLength(0);
  });

  it('refuses to kill a reused window whose ownership metadata no longer matches', async () => {
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn() };
    const context = fakeContext();
    const fakeTmux = managedTmux('@92');
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      { ...DEFAULT_TMUX_BASH_CONFIG, statusbarEnabled: false },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);
    await runtime.executeBash(
      { command: 'sleep 10', background: true },
      undefined,
      undefined,
      context as never,
    );
    fakeTmux.metadata.set('@pi_tmux_bash_session_id', 'another-session');

    await expect(runtime.kill('@92', context as never)).rejects.toThrow(/ownership metadata/);
    expect(fakeTmux.execute).not.toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['kill-window']),
    );
  });

  it('does not gate an explicit background command by default', async () => {
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn() };
    const context = fakeContext();
    const execute: TmuxExecutor = async (_binary, args) => ({
      stdout: args[0] === 'new-window' ? '@88\n' : '',
      stderr: '',
      code: 0,
    });
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      { ...DEFAULT_TMUX_BASH_CONFIG, statusbarEnabled: false },
      controller,
      new TmuxClient('tmux', execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);
    const result = await runtime.executeBash(
      { command: 'sleep 10', background: true, completionDelivery: 'next-turn' },
      undefined,
      undefined,
      context as never,
    );
    expect(controller.list('session-1')).toHaveLength(0);
    expect(result.details?.completionDelivery).toBe('next-turn');
    expect(result.terminate).not.toBe(true);
  });

  it('transitions a foreground timeout to an awaited background run', async () => {
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn() };
    const context = fakeContext();
    const fakeTmux = managedTmux('@93');
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      { ...DEFAULT_TMUX_BASH_CONFIG, defaultTimeoutSeconds: 1, statusbarEnabled: false },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);

    const result = await runtime.executeBash(
      { command: 'sleep 10', timeout: 1, timeoutAction: 'background' },
      undefined,
      undefined,
      context as never,
    );

    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('continuing in background'),
    });
    expect(result.details).toMatchObject({ background: true, awaited: true, state: 'running' });
    expect(result.terminate).toBe(true);
    expect(controller.list('session-1')).toHaveLength(1);
  });

  it('kills a foreground command when its timeout action is kill', async () => {
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn() };
    const context = fakeContext();
    const fakeTmux = managedTmux('@94');
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      { ...DEFAULT_TMUX_BASH_CONFIG, defaultTimeoutSeconds: 1, statusbarEnabled: false },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);

    await expect(
      runtime.executeBash(
        { command: 'sleep 10', timeout: 1, timeoutAction: 'kill', waitForCompletion: true },
        undefined,
        undefined,
        context as never,
      ),
    ).rejects.toThrow(/timed out after 1s and was killed/);
    expect(fakeTmux.execute).toHaveBeenCalledWith('tmux', ['kill-window', '-t', '@94']);
    expect(controller.list('session-1')).toHaveLength(0);
  });

  it('rejects interactive input for a completed managed window before invoking tmux input', async () => {
    const root = await temporaryDirectory('tmux-completed-input-');
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn() };
    const execute = vi.fn<TmuxExecutor>(async (_binary, args) => ({
      stdout: args[0] === 'new-window' ? '@96\n' : '',
      stderr: '',
      code: 0,
    }));
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: root,
        durableOutputDir: root,
        interactiveInputEnabled: true,
        enabledTmuxActions: [...DEFAULT_TMUX_BASH_CONFIG.enabledTmuxActions, 'send-input'],
        statusbarEnabled: false,
      },
      controller,
      new TmuxClient('tmux', execute),
    );
    activeRuntimes.push(runtime);
    const context = fakeContext();
    await runtime.startSession(context as never);
    const started = await runtime.executeBash(
      { command: 'sleep 10', background: true },
      undefined,
      undefined,
      context as never,
    );
    const run = runtime.state.commands.get(started.details?.runId ?? '');
    if (!run?.windowId) throw new Error('Expected a managed window.');
    run.state = 'completed';
    run.endedAt = Date.now();
    execute.mockClear();
    await expect(runtime.sendInput(run.windowId, 'value', true, context as never)).rejects.toThrow(
      'not running',
    );
    expect(execute).not.toHaveBeenCalled();
    await rm(root, { recursive: true, force: true });
  });

  it('does not launch an already-cancelled background call', async () => {
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn() };
    const execute = vi.fn<TmuxExecutor>();
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      { ...DEFAULT_TMUX_BASH_CONFIG, statusbarEnabled: false },
      controller,
      new TmuxClient('tmux', execute),
    );
    activeRuntimes.push(runtime);
    const context = fakeContext();
    await runtime.startSession(context as never);
    const abort = new AbortController();
    abort.abort();

    await expect(
      runtime.executeBash(
        { command: 'sleep 10', background: true, waitForCompletion: true },
        abort.signal,
        undefined,
        context as never,
      ),
    ).rejects.toThrow(/cancelled/);
    expect(execute).not.toHaveBeenCalled();
    expect(controller.list('session-1')).toHaveLength(0);
  });

  it('kills a window and releases its provisional gate when setup is cancelled', async () => {
    const events = new EventBus();
    const releases: Array<{ outcome?: string }> = [];
    events.on(CONTINUATION_GATE_RELEASE_EVENT, (payload) =>
      releases.push(payload as { outcome?: string }),
    );
    const pi = { events, sendMessage: vi.fn() };
    const abort = new AbortController();
    const execute = vi.fn<TmuxExecutor>(async (_binary, args) => {
      if (args[0] === 'new-window') return { stdout: '@95\n', stderr: '', code: 0 };
      if (args[0] === 'set-option') abort.abort();
      return { stdout: '', stderr: '', code: 0 };
    });
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      { ...DEFAULT_TMUX_BASH_CONFIG, statusbarEnabled: false },
      controller,
      new TmuxClient('tmux', execute),
    );
    activeRuntimes.push(runtime);
    const context = fakeContext();
    await runtime.startSession(context as never);

    await expect(
      runtime.executeBash(
        { command: 'sleep 10', background: true, waitForCompletion: true },
        abort.signal,
        undefined,
        context as never,
      ),
    ).rejects.toThrow(/cancelled/);
    expect(execute).toHaveBeenCalledWith('tmux', ['kill-window', '-t', '@95']);
    expect(releases.at(-1)).toMatchObject({ outcome: 'cancelled' });
    expect(controller.list('session-1')).toHaveLength(0);
    expect(runtime.state.commands).toHaveLength(0);
  });

  it('releases a provisional gate and command state after spawn failure', async () => {
    const events = new EventBus();
    const releases: Array<{ outcome?: string }> = [];
    events.on(CONTINUATION_GATE_RELEASE_EVENT, (payload) =>
      releases.push(payload as { outcome?: string }),
    );
    const pi = { events, sendMessage: vi.fn() };
    const execute = vi.fn<TmuxExecutor>(async (_binary, args) =>
      args[0] === 'new-window'
        ? { stdout: '', stderr: 'spawn failed', code: 1 }
        : { stdout: '', stderr: '', code: 0 },
    );
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      { ...DEFAULT_TMUX_BASH_CONFIG, statusbarEnabled: false },
      controller,
      new TmuxClient('tmux', execute),
    );
    activeRuntimes.push(runtime);
    const context = fakeContext();
    await runtime.startSession(context as never);

    await expect(
      runtime.executeBash(
        { command: 'sleep 10', background: true, waitForCompletion: true },
        undefined,
        undefined,
        context as never,
      ),
    ).rejects.toThrow(/spawn failed/);
    expect(releases.at(-1)).toMatchObject({ outcome: 'failed' });
    expect(controller.list('session-1')).toHaveLength(0);
    expect(runtime.state.commands).toHaveLength(0);
  });

  it('fails and releases an awaited run when post-launch output handling fails', async () => {
    const events = new EventBus();
    const releases: Array<{ outcome?: string }> = [];
    events.on(CONTINUATION_GATE_RELEASE_EVENT, (payload) =>
      releases.push(payload as { outcome?: string }),
    );
    const pi = { events, sendMessage: vi.fn() };
    const context = fakeContext();
    const fakeTmux = managedTmux('@97');
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      { ...DEFAULT_TMUX_BASH_CONFIG, statusbarEnabled: false },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);
    const internals = runtime as unknown as {
      runningResult: () => Promise<never>;
    };
    internals.runningResult = vi.fn(async () => {
      throw new Error('output persistence failed');
    });

    await expect(
      runtime.executeBash(
        { command: 'sleep 10', background: true, waitForCompletion: true },
        undefined,
        undefined,
        context as never,
      ),
    ).rejects.toThrow('output persistence failed');

    expect(fakeTmux.execute).toHaveBeenCalledWith('tmux', ['kill-window', '-t', '@97']);
    expect(releases.at(-1)).toMatchObject({ outcome: 'failed' });
    expect(controller.list('session-1')).toHaveLength(0);
    expect(runtime.state.commands).toHaveLength(0);
    const runDir = runtime.state.runDir;
    if (!runDir) throw new Error('Expected an active run directory.');
    const manifestName = (await readdir(runDir)).find((name) => name.endsWith('.manifest.json'));
    if (!manifestName) throw new Error('Expected a failed manifest.');
    expect(JSON.parse(await readFile(join(runDir, manifestName), 'utf8'))).toMatchObject({
      state: 'failed',
    });
  });

  it('makes await and unawait idempotent', async () => {
    const events = new EventBus();
    const releases: unknown[] = [];
    events.on(CONTINUATION_GATE_RELEASE_EVENT, (payload) => releases.push(payload));
    const pi = { events, sendMessage: vi.fn() };
    const context = fakeContext();
    const fakeTmux = managedTmux('@96');
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      { ...DEFAULT_TMUX_BASH_CONFIG, statusbarEnabled: false },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);
    await runtime.executeBash(
      { command: 'sleep 10', background: true },
      undefined,
      undefined,
      context as never,
    );

    const firstAwait = await runtime.await('@96', context as never);
    const secondAwait = await runtime.await('@96', context as never);
    expect(firstAwait.terminate).toBe(true);
    expect(secondAwait.terminate).toBe(true);
    expect(controller.list('session-1')).toHaveLength(1);
    await runtime.unawait('@96', context as never);
    await runtime.unawait('@96', context as never);
    expect(controller.list('session-1')).toHaveLength(0);
    expect(releases).toHaveLength(1);
  });

  it('reacquires adopted live gates before publishing the authoritative snapshot', async () => {
    const root = await temporaryDirectory('tmux-adoption-runtime-');
    const events = new EventBus();
    const context = fakeContext();
    const fakeTmux = managedTmux('@98');
    const config = {
      ...DEFAULT_TMUX_BASH_CONFIG,
      outputDir: root,
      durableOutputDir: root,
      adoptionPolicy: 'same-pi-session' as const,
      autoCloseWindowsOnCompletion: false,
      statusbarEnabled: false,
    };
    const firstController = createContinuationGateController({ events } as never, {
      source: 'pi-tmux-bash',
    });
    const first = new TmuxBashRuntime(
      { events, sendMessage: vi.fn(), appendEntry: vi.fn() } as never,
      config,
      firstController,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(first);
    await first.startSession(context as never);
    await first.executeBash(
      {
        command: 'sleep 10',
        background: true,
        waitForCompletion: true,
        pollInterval: 60,
      },
      undefined,
      undefined,
      context as never,
    );
    await first.shutdown(context as never);
    firstController.dispose();

    const ordering: string[] = [];
    events.on(CONTINUATION_GATE_ACQUIRE_EVENT, () => ordering.push('acquire'));
    events.on(CONTINUATION_GATE_SNAPSHOT_EVENT, () => ordering.push('snapshot'));
    const secondController = createContinuationGateController({ events } as never, {
      source: 'pi-tmux-bash',
    });
    const second = new TmuxBashRuntime(
      { events, sendMessage: vi.fn(), appendEntry: vi.fn() } as never,
      config,
      secondController,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(second);
    await second.startSession(context as never);
    expect(ordering.indexOf('acquire')).toBeGreaterThanOrEqual(0);
    expect(ordering.indexOf('snapshot')).toBeGreaterThan(ordering.indexOf('acquire'));
    expect(secondController.list('session-1')).toHaveLength(1);
    expect(second.state.pollers.size).toBe(1);
    const adopted = [...second.state.commands.values()];
    expect(adopted).toHaveLength(1);
    const adoptedRun = adopted[0];
    if (!adoptedRun) throw new Error('Expected one adopted run.');
    expect(adoptedRun).toMatchObject({ adopted: true, awaited: true, state: 'running' });
    adoptedRun.killed = true;
    await second.shutdown(context as never);
    secondController.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('delivers a completed-while-offline run once without reconstructing its gate', async () => {
    const root = await temporaryDirectory('tmux-offline-runtime-');
    const events = new EventBus();
    const context = fakeContext();
    const fakeTmux = managedTmux('@99');
    const config = {
      ...DEFAULT_TMUX_BASH_CONFIG,
      outputDir: root,
      durableOutputDir: root,
      adoptionPolicy: 'same-pi-session' as const,
      autoCloseWindowsOnCompletion: false,
      completionDeliveryRetryBaseMs: 25,
      preserveOutputFiles: true,
      statusbarEnabled: false,
    };
    const firstController = createContinuationGateController({ events } as never, {
      source: 'pi-tmux-bash',
    });
    const first = new TmuxBashRuntime(
      { events, sendMessage: vi.fn(), appendEntry: vi.fn() } as never,
      config,
      firstController,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(first);
    await first.startSession(context as never);
    const started = await first.executeBash(
      { command: 'sleep 10', background: true, waitForCompletion: true },
      undefined,
      undefined,
      context as never,
    );
    const offlineRun = first.state.commands.get(started.details?.runId ?? '');
    if (!offlineRun) throw new Error('Expected offline run.');
    await first.shutdown(context as never);
    firstController.dispose();
    await writeFile(offlineRun.outputFile, '$ sleep 10\noffline done\n');
    await writeFile(offlineRun.exitCodeFile, '0\n');
    const claimPath = offlineRun.manifestPath.replace(/\.manifest\.json$/, '.completion.claim');
    await writeFile(claimPath, `${process.pid} ${Date.now()}\n`);

    const messages: unknown[] = [];
    const secondController = createContinuationGateController({ events } as never, {
      source: 'pi-tmux-bash',
    });
    const unavailableDiscovery = vi.fn<TmuxExecutor>(async (binary, args, signal) => {
      if (args[0] === 'list-windows') {
        return { stdout: '', stderr: 'permission denied', code: 1 };
      }
      return fakeTmux.execute(binary, args, signal);
    });
    const second = new TmuxBashRuntime(
      {
        events,
        appendEntry: vi.fn(),
        sendMessage: vi.fn((message) => messages.push(message)),
      } as never,
      config,
      secondController,
      new TmuxClient('tmux', unavailableDiscovery),
    );
    activeRuntimes.push(second);
    vi.useFakeTimers({ toFake: ['clearTimeout', 'setTimeout'] });
    try {
      await second.startSession(context as never);
      expect(messages).toHaveLength(0);
      const adoptedRun = second.state.commands.get(offlineRun.runId);
      if (!adoptedRun) throw new Error('Expected the contended completion to remain retryable.');
      await rm(claimPath, { force: true });
      await vi.advanceTimersByTimeAsync(config.completionDeliveryRetryBaseMs);
      await adoptedRun.completionObserverPromise;
      expect(messages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    expect(messages[0]).toMatchObject({ content: expect.stringContaining('offline done') });
    expect(secondController.list('session-1')).toHaveLength(0);
    expect(JSON.parse(await readFile(offlineRun.manifestPath, 'utf8'))).toMatchObject({
      awaited: false,
      deliveryState: 'delivered',
    });
    await second.shutdown(context as never);
    secondController.dispose();

    const thirdController = createContinuationGateController({ events } as never, {
      source: 'pi-tmux-bash',
    });
    const third = new TmuxBashRuntime(
      {
        events,
        appendEntry: vi.fn(),
        sendMessage: vi.fn((message) => messages.push(message)),
      } as never,
      config,
      thirdController,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(third);
    await third.startSession(context as never);
    expect(messages).toHaveLength(1);
    await third.shutdown(context as never);
    thirdController.dispose();
    await rm(root, { recursive: true, force: true });
  }, 10_000);

  it('delivers completion once when a poller and completion observer race', async () => {
    const events = new EventBus();
    const pi = { events, sendMessage: vi.fn() };
    const context = fakeContext();
    const fakeTmux = managedTmux('@97');
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      { ...DEFAULT_TMUX_BASH_CONFIG, pollDelivery: 'model', statusbarEnabled: false },
      controller,
      new TmuxClient('tmux', fakeTmux.execute),
    );
    activeRuntimes.push(runtime);
    await runtime.startSession(context as never);
    const started = await runtime.executeBash(
      { command: 'sleep 1', background: true, waitForCompletion: true, pollInterval: 60 },
      undefined,
      undefined,
      context as never,
    );
    const run = runtime.state.commands.get(started.details?.runId ?? '');
    if (!run) throw new Error('Expected registered command run.');
    const poller = runtime.state.pollers.get(run.runId);
    if (!poller) throw new Error('Expected active poller.');
    await writeFile(run.outputFile, '$ sleep 1\ndone\n');
    await writeFile(run.exitCodeFile, '0\n');

    const internals = runtime as unknown as {
      pollTick(value: typeof poller): Promise<void>;
      completeIfReady(value: typeof run, deliver: boolean): Promise<unknown>;
    };
    await Promise.all([internals.pollTick(poller), internals.completeIfReady(run, true)]);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    expect(controller.list('session-1')).toHaveLength(0);
  });
});

function fakeContext() {
  return {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => 'session-1',
      getSessionFile: () => '/tmp/session-1.jsonl',
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
    },
  };
}

function managedTmux(windowId: string) {
  const metadata = new Map<string, string>();
  const execute = vi.fn<TmuxExecutor>(async (_binary, args) => {
    switch (args[0]) {
      case 'new-window':
        return { stdout: `${windowId}\n`, stderr: '', code: 0 };
      case 'set-option':
        metadata.set(args[4] ?? '', args[5] ?? '');
        return { stdout: '', stderr: '', code: 0 };
      case 'display-message':
        return { stdout: `${windowId}\n`, stderr: '', code: 0 };
      case 'list-windows':
        return { stdout: `${windowId}\n`, stderr: '', code: 0 };
      case 'show-options':
        return metadata.has(args.at(-1) ?? '')
          ? { stdout: `${metadata.get(args.at(-1) ?? '')}\n`, stderr: '', code: 0 }
          : { stdout: '', stderr: 'missing option', code: 1 };
      default:
        return { stdout: '', stderr: '', code: 0 };
    }
  });
  return { execute, metadata };
}
