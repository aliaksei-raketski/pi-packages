import {
  CONTINUATION_GATE_ACQUIRE_EVENT,
  CONTINUATION_GATE_RELEASE_EVENT,
  createContinuationGateController,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TMUX_BASH_CONFIG } from '../src/config.js';
import { TmuxBashRuntime } from '../src/runtime.js';
import { TmuxClient, type TmuxExecutor } from '../src/tmux-client.js';

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

afterEach(async () => {
  await Promise.all(
    activeRuntimes.splice(0).map(async (runtime) => {
      for (const run of runtime.state.commands.values()) {
        run.killed = true;
        run.endedAt ??= Date.now();
      }
      await runtime.shutdown();
    }),
  );
});

describe('TmuxBashRuntime', () => {
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

    await writeFile(run.exitCodeFile, '0\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages).toHaveLength(1);
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
    const execute = vi.fn<TmuxExecutor>(async (_binary, args) => ({
      stdout: args[0] === 'new-window' ? '@78\n' : '',
      stderr: '',
      code: 0,
    }));
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
      { command: 'echo done', background: true, waitForCompletion: true },
      undefined,
      undefined,
      context as never,
    );
    const run = runtime.state.commands.get(started.details?.runId ?? '');
    if (!run) throw new Error('Expected registered command run.');
    await writeFile(run.outputFile, '$ echo done\ndone\n');
    await writeFile(run.exitCodeFile, '0\n');

    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(attempts).toBe(2);
    expect(releases[0]).toMatchObject({ wake: 'none' });
    expect(controller.list('session-1')).toHaveLength(0);
    expect(run.completionClaimed).toBe(true);
    expect(run.completionDelivered).toBe(true);
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
    const execute = vi.fn<TmuxExecutor>(async (_binary, args) => ({
      stdout: args[0] === 'new-window' ? '@79\n' : '',
      stderr: '',
      code: 0,
    }));
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        completionDeliveryMaxAttempts: 3,
        completionDeliveryRetryBaseMs: 10,
        statusbarEnabled: false,
      },
      createContinuationGateController(pi, { source: 'pi-tmux-bash' }),
      new TmuxClient('tmux', execute),
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
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(attempts).toBe(3);
    expect(run.completionDeliveryFailed).toBe(true);
    expect(run.completionRetryTimer).toBeUndefined();
    expect(context.ui.notify).toHaveBeenCalledTimes(1);
    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('after 3 attempts'),
      'error',
    );
  });

  it('cancels a pending completion retry during shutdown', async () => {
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
    const execute = vi.fn<TmuxExecutor>(async (_binary, args) => ({
      stdout: args[0] === 'new-window' ? '@80\n' : '',
      stderr: '',
      code: 0,
    }));
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        completionDeliveryRetryBaseMs: 50,
        statusbarEnabled: false,
      },
      createContinuationGateController(pi, { source: 'pi-tmux-bash' }),
      new TmuxClient('tmux', execute),
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
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(attempts).toBe(1);
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
      { command: 'sleep 10', background: true },
      undefined,
      undefined,
      context as never,
    );
    expect(result.terminate).not.toBe(true);
    expect(controller.list('session-1')).toHaveLength(0);
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
