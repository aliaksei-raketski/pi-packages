import {
  CONTINUATION_GATE_RELEASE_EVENT,
  createContinuationGateController,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TMUX_BASH_CONFIG } from '../src/config.js';
import { TmuxBashRuntime } from '../src/runtime.js';
import { TmuxClient, type TmuxExecutor } from '../src/tmux-client.js';
import { TMUX_BASH_COMPLETION_MESSAGE } from '../src/types.js';

interface QueuedMessage {
  customType: string;
  details?: { kind?: string };
}

type Handler = (event: Record<string, unknown>, ctx: never) => unknown;

class EventBus {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  on(name: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }

  emit(name: string, payload: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(payload);
  }
}

class FakePiLifecycle {
  readonly events = new EventBus();
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  readonly followUps: QueuedMessage[] = [];
  readonly deliveryOrder: string[] = [];
  readonly branch: unknown[] = [];
  private readonly activeTools = new Set(['read']);
  private idle = true;

  readonly ctx = {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => 'session-1',
      getSessionFile: () => '/tmp/session-1.jsonl',
      getBranch: () => [...this.branch],
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      confirm: vi.fn(async () => true),
      theme: { fg: (_color: string, text: string) => text },
    },
    hasUI: true,
    mode: 'tui',
    model: undefined,
    thinkingLevel: undefined,
    isIdle: () => this.idle,
    hasPendingMessages: () => this.followUps.length > 0,
  };

  readonly pi = {
    events: this.events,
    on: (name: string, handler: Handler) => {
      const handlers = this.handlers.get(name) ?? [];
      handlers.push(handler);
      this.handlers.set(name, handlers);
    },
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: never) => Promise<void> },
    ) => this.commands.set(name, command),
    registerTool: (tool: { name: string }) => this.activeTools.add(tool.name),
    registerMessageRenderer: vi.fn(),
    getActiveTools: () => [...this.activeTools],
    setActiveTools: (names: string[]) => {
      this.activeTools.clear();
      for (const name of names) this.activeTools.add(name);
    },
    appendEntry: (customType: string, data: unknown) => {
      this.branch.push({ type: 'custom', customType, data });
    },
    sendMessage: (
      message: QueuedMessage,
      options?: { triggerTurn?: boolean; deliverAs?: string },
    ) => {
      this.deliveryOrder.push(`message:${message.customType}:${message.details?.kind ?? ''}`);
      if (options?.triggerTurn && options.deliverAs === 'followUp') this.followUps.push(message);
    },
  };

  async emit(name: string, event: Record<string, unknown> = {}): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) {
      await handler(event, this.ctx as never);
    }
  }

  async beginFollowUp(): Promise<QueuedMessage> {
    const message = this.followUps.shift();
    if (!message) throw new Error('Expected a queued follow-up.');
    this.idle = false;
    await this.emit('turn_start', { turnIndex: 0, timestamp: Date.now() });
    return message;
  }

  async settleTurn(): Promise<void> {
    await this.emit('turn_end', { turnIndex: 0, message: { usage: { totalTokens: 1 } } });
    this.idle = true;
    await this.emit('agent_settled');
    await Promise.resolve();
  }
}

const activeScenarios: Array<{
  lifecycle: FakePiLifecycle;
  runtime: TmuxBashRuntime;
  controller: ReturnType<typeof createContinuationGateController>;
}> = [];

afterEach(async () => {
  for (const { lifecycle, runtime, controller } of activeScenarios.splice(0)) {
    for (const run of runtime.state.commands.values()) {
      run.killed = true;
      run.endedAt ??= Date.now();
    }
    await lifecycle.emit('session_shutdown', { reason: 'quit' });
    await runtime.shutdown(lifecycle.ctx as never);
    controller.dispose();
  }
});

describe('actual Goal and tmux-bash lifecycle coexistence', () => {
  it('runs a tmux completion follow-up before queuing exactly one Goal continuation', async () => {
    const scenario = await startScenario(1);
    const [run] = [...scenario.runtime.state.commands.values()];
    if (!run) throw new Error('Expected one managed run.');

    await complete(run, 0);
    await vi.waitFor(() =>
      expect(scenario.lifecycle.followUps[0]?.customType).toBe(TMUX_BASH_COMPLETION_MESSAGE),
    );
    expect(scenario.lifecycle.deliveryOrder.slice(-2)).toEqual([
      `message:${TMUX_BASH_COMPLETION_MESSAGE}:`,
      'release:producer-message',
    ]);

    const completion = await scenario.lifecycle.beginFollowUp();
    expect(completion.customType).toBe(TMUX_BASH_COMPLETION_MESSAGE);
    await scenario.lifecycle.settleTurn();

    expect(scenario.lifecycle.followUps).toHaveLength(1);
    expect(scenario.lifecycle.followUps[0]).toMatchObject({
      customType: 'pi-goal-event',
      details: { kind: 'continuation' },
    });
  });

  it('cannot resume Goal after the first completion while a second tmux gate remains', async () => {
    const scenario = await startScenario(2);
    const [first, second] = [...scenario.runtime.state.commands.values()];
    if (!first || !second) throw new Error('Expected two managed runs.');

    await complete(first, 0);
    await vi.waitFor(() => expect(scenario.lifecycle.followUps).toHaveLength(1));
    await scenario.lifecycle.beginFollowUp();
    await scenario.lifecycle.settleTurn();
    expect(scenario.controller.list('session-1')).toHaveLength(1);
    expect(scenario.lifecycle.followUps).toHaveLength(0);

    await complete(second, 0);
    await vi.waitFor(() => expect(scenario.lifecycle.followUps).toHaveLength(1));
    await scenario.lifecycle.beginFollowUp();
    await scenario.lifecycle.settleTurn();

    expect(scenario.controller.list('session-1')).toHaveLength(0);
    expect(scenario.lifecycle.followUps).toHaveLength(1);
    expect(scenario.lifecycle.followUps[0]).toMatchObject({
      customType: 'pi-goal-event',
      details: { kind: 'continuation' },
    });
  });
});

async function startScenario(commandCount: number) {
  const lifecycle = new FakePiLifecycle();
  const goalSourcePath = ['../../../../goal/extensions/goal/src', 'goal.ts'].join('/');
  const goalModuleUrl = new URL(goalSourcePath, import.meta.url).href;
  const { goal } = (await import(goalModuleUrl)) as { goal: (pi: never) => void };
  goal(lifecycle.pi as never);
  const controller = createContinuationGateController(lifecycle.pi, { source: 'pi-tmux-bash' });
  let nextWindowId = 70;
  const metadata = new Map<string, string>();
  const windows: string[] = [];
  const execute = vi.fn<TmuxExecutor>(async (_binary, args) => {
    if (args[0] === 'new-window') {
      const windowId = `@${nextWindowId++}`;
      windows.push(windowId);
      return { stdout: `${windowId}\n`, stderr: '', code: 0 };
    }
    if (args[0] === 'set-option') {
      metadata.set(`${args[3]}:${args[4]}`, args[5] ?? '');
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args[0] === 'list-windows') {
      return { stdout: `${windows.join('\n')}\n`, stderr: '', code: 0 };
    }
    if (args[0] === 'show-options') {
      const value = metadata.get(`${args[4]}:${args[5]}`);
      return value === undefined
        ? { stdout: '', stderr: 'missing option', code: 1 }
        : { stdout: `${value}\n`, stderr: '', code: 0 };
    }
    if (args[0] === 'display-message') {
      return args.at(-1) === '#{window_id}'
        ? { stdout: `${args[3]}\n`, stderr: '', code: 0 }
        : { stdout: '0\n', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
  const runtime = new TmuxBashRuntime(
    lifecycle.pi as never,
    {
      ...DEFAULT_TMUX_BASH_CONFIG,
      autoCloseWindowsOnCompletion: false,
      statusbarEnabled: false,
    },
    controller,
    new TmuxClient('tmux', execute),
  );
  activeScenarios.push({ lifecycle, runtime, controller });

  await runtime.startSession(lifecycle.ctx as never);
  await lifecycle.emit('session_start', { reason: 'startup' });
  await lifecycle.commands.get('goal')?.handler('ship with evidence', lifecycle.ctx as never);
  const activation = await lifecycle.beginFollowUp();
  expect(activation).toMatchObject({ customType: 'pi-goal-event', details: { kind: 'active' } });

  for (let index = 0; index < commandCount; index += 1) {
    await runtime.executeBash(
      {
        command: `sleep ${index + 1}; echo done-${index + 1}`,
        background: true,
        waitForCompletion: true,
      },
      undefined,
      undefined,
      lifecycle.ctx as never,
    );
  }
  await lifecycle.settleTurn();

  expect(controller.list('session-1')).toHaveLength(commandCount);
  expect(lifecycle.followUps).toHaveLength(0);
  lifecycle.events.on(CONTINUATION_GATE_RELEASE_EVENT, (payload) => {
    const wake = (payload as { wake?: string }).wake ?? '';
    lifecycle.deliveryOrder.push(`release:${wake}`);
  });
  return { lifecycle, runtime, controller };
}

async function complete(
  run: TmuxBashRuntime['state']['commands'] extends Map<string, infer T> ? T : never,
  exitCode: number,
): Promise<void> {
  await writeFile(run.outputFile, `$ ${run.displayCommand}\ndone\n`);
  await writeFile(run.exitCodeFile, `${exitCode}\n`);
}
