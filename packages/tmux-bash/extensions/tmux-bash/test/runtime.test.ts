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
  it('queues completion before gate release and delivers it exactly once', async () => {
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
    expect(ordering).toContain('acquire');
    expect(controller.list('session-1')).toHaveLength(1);

    const details = started.details;
    if (!details) throw new Error('Expected tmux-bash details.');
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
    await runtime.executeBash(
      { command: 'sleep 10', background: true },
      undefined,
      undefined,
      context as never,
    );
    expect(controller.list('session-1')).toHaveLength(0);
  });
});

function fakeContext() {
  return {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => 'session-1' },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
    },
  };
}
