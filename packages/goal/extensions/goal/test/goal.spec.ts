import {
  CONTINUATION_GATE_ACQUIRE_EVENT,
  CONTINUATION_GATE_RELEASE_EVENT,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import {
  STATUSLINE_STATUS_CLEAR_EVENT,
  STATUSLINE_STATUS_SNAPSHOT_EVENT,
  STATUSLINE_STATUS_SNAPSHOT_REQUEST_EVENT,
} from '@aliaksei-raketski/pi-statusline-protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goal } from '../src/goal.ts';
import { createGoalState } from '../src/goal-state.ts';

class EventBus {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  on(eventName: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.handlers.get(eventName) ?? new Set();
    handlers.add(handler);
    this.handlers.set(eventName, handlers);
    return () => handlers.delete(handler);
  }

  emit(eventName: string, payload: unknown): void {
    for (const handler of this.handlers.get(eventName) ?? []) handler(payload);
  }
}

interface Harness {
  pi: Record<string, unknown>;
  ctx: Record<string, unknown>;
  events: EventBus;
  handlers: Map<string, Array<(event: Record<string, unknown>, ctx: never) => unknown>>;
  commands: Map<string, { handler: (args: string, ctx: never) => Promise<void> }>;
  tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
  activeTools: Set<string>;
  branch: unknown[];
  sendMessage: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
  const events = new EventBus();
  const handlers = new Map<
    string,
    Array<(event: Record<string, unknown>, ctx: never) => unknown>
  >();
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const activeTools = new Set(['read']);
  const branch: unknown[] = [];
  const sendMessage = vi.fn();
  const appendEntry = vi.fn((customType: string, data: unknown) => {
    branch.push({ type: 'custom', customType, data });
  });
  const confirm = vi.fn(async () => true);
  const ctx = {
    sessionManager: {
      getSessionId: () => 'session-1',
      getBranch: () => [...branch],
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      confirm,
      theme: { fg: (_color: string, text: string) => text },
    },
    hasUI: true,
    mode: 'tui',
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
  };
  const pi = {
    events,
    on: vi.fn(
      (
        eventName: string,
        handler: (event: Record<string, unknown>, eventCtx: never) => unknown,
      ) => {
        const registered = handlers.get(eventName) ?? [];
        registered.push(handler);
        handlers.set(eventName, registered);
      },
    ),
    registerCommand: vi.fn(
      (name: string, command: Harness['commands'] extends Map<string, infer T> ? T : never) => {
        commands.set(name, command);
      },
    ),
    registerTool: vi.fn(
      (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
        tools.set(tool.name, tool);
        activeTools.add(tool.name);
      },
    ),
    registerMessageRenderer: vi.fn(),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((names: string[]) => {
      activeTools.clear();
      for (const name of names) activeTools.add(name);
    }),
    appendEntry,
    sendMessage,
  };
  return {
    pi,
    ctx,
    events,
    handlers,
    commands,
    tools,
    activeTools,
    branch,
    sendMessage,
    appendEntry,
    confirm,
  };
}

async function emit(
  harness: Harness,
  eventName: string,
  event: Record<string, unknown> = {},
): Promise<void> {
  for (const handler of harness.handlers.get(eventName) ?? []) {
    await handler(event, harness.ctx as never);
  }
}

async function createActiveGoal(harness: Harness): Promise<void> {
  await emit(harness, 'session_start', { reason: 'startup' });
  await harness.commands.get('goal')?.handler('ship with evidence', harness.ctx as never);
  harness.sendMessage.mockClear();
}

function acquireGate(harness: Harness, gateId = 'tests'): void {
  harness.events.emit(CONTINUATION_GATE_ACQUIRE_EVENT, {
    protocolVersion: 1,
    sessionId: 'session-1',
    source: 'producer',
    gateId,
    reason: 'waiting for tests',
    acquiredAt: Date.now(),
  });
}

describe('goal extension', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    goal(harness.pi as never);
  });

  it('registers the required lifecycle, command, renderer, and tools', () => {
    expect(harness.commands.has('goal')).toBe(true);
    expect([...harness.tools]).toEqual([
      ['create_goal', expect.any(Object)],
      ['get_goal', expect.any(Object)],
      ['update_goal', expect.any(Object)],
    ]);
    for (const event of [
      'session_start',
      'session_tree',
      'turn_start',
      'turn_end',
      'agent_settled',
      'session_shutdown',
    ]) {
      expect(harness.handlers.has(event)).toBe(true);
    }
  });

  it('queues at most one continuation after Pi settles', async () => {
    await createActiveGoal(harness);
    await emit(harness, 'agent_settled');
    await emit(harness, 'agent_settled');
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: 'pi-goal-event' }),
      { triggerTurn: true, deliverAs: 'followUp' },
    );
  });

  it('suppresses continuation while gated and invalidates an already queued microtask', async () => {
    await createActiveGoal(harness);
    acquireGate(harness);
    await emit(harness, 'agent_settled');
    await Promise.resolve();
    expect(harness.sendMessage).not.toHaveBeenCalled();

    const second = createHarness();
    goal(second.pi as never);
    await createActiveGoal(second);
    const settled = second.handlers.get('agent_settled')?.[0];
    settled?.({}, second.ctx as never);
    acquireGate(second);
    await Promise.resolve();
    expect(second.sendMessage).not.toHaveBeenCalled();
  });

  it('manual continue confirms a one-turn gate bypass without releasing gates', async () => {
    await createActiveGoal(harness);
    acquireGate(harness);
    await harness.commands.get('goal')?.handler('continue', harness.ctx as never);
    expect(harness.confirm).toHaveBeenCalledOnce();
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.events).toBeDefined();

    harness.sendMessage.mockClear();
    await harness.commands.get('goal')?.handler('waits', harness.ctx as never);
    expect(
      (harness.ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify,
    ).toHaveBeenLastCalledWith(expect.stringContaining('producer/tests'), 'info');
  });

  it('aborts manual gate bypass on decline or a newly acquired gate', async () => {
    await createActiveGoal(harness);
    acquireGate(harness);
    harness.confirm.mockResolvedValueOnce(false);
    await harness.commands.get('goal')?.handler('continue', harness.ctx as never);
    expect(harness.sendMessage).not.toHaveBeenCalled();

    harness.confirm.mockImplementationOnce(async () => {
      acquireGate(harness, 'new-gate');
      return true;
    });
    await harness.commands.get('goal')?.handler('continue', harness.ctx as never);
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('aborts manual gate bypass when the confirmed gate identity is released and reacquired', async () => {
    await createActiveGoal(harness);
    acquireGate(harness);
    harness.confirm.mockImplementationOnce(async () => {
      harness.events.emit(CONTINUATION_GATE_RELEASE_EVENT, {
        protocolVersion: 1,
        sessionId: 'session-1',
        source: 'producer',
        gateId: 'tests',
        outcome: 'abandoned',
        wake: 'none',
        releasedAt: Date.now(),
      });
      harness.events.emit(CONTINUATION_GATE_ACQUIRE_EVENT, {
        protocolVersion: 1,
        sessionId: 'session-1',
        source: 'producer',
        gateId: 'tests',
        reason: 'replacement wait lifecycle',
        acquiredAt: Date.now() + 1_000,
      });
      return true;
    });

    await harness.commands.get('goal')?.handler('continue', harness.ctx as never);
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('suppresses settled continuation while messages are pending', async () => {
    await createActiveGoal(harness);
    (harness.ctx.hasPendingMessages as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await emit(harness, 'agent_settled');
    await Promise.resolve();
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('goal replacement invalidates an old queued continuation', async () => {
    await createActiveGoal(harness);
    const settled = harness.handlers.get('agent_settled')?.[0];
    settled?.({}, harness.ctx as never);
    harness.ctx.hasUI = false;
    await harness.commands.get('goal')?.handler('replacement objective', harness.ctx as never);
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      details: { kind: 'active', goal: { objective: 'replacement objective' } },
    });
  });

  it('publishes snapshots and clears status when disabled or shut down', async () => {
    const snapshots: unknown[] = [];
    const clears: unknown[] = [];
    harness.events.on(STATUSLINE_STATUS_SNAPSHOT_EVENT, (payload) => snapshots.push(payload));
    harness.events.on(STATUSLINE_STATUS_CLEAR_EVENT, (payload) => clears.push(payload));
    await createActiveGoal(harness);

    harness.events.emit(STATUSLINE_STATUS_SNAPSHOT_REQUEST_EVENT, {});
    expect(snapshots.at(-1)).toMatchObject({
      source: 'pi-goal',
      statuses: [{ key: 'goal', state: 'active' }],
    });

    await harness.commands.get('goal')?.handler('statusbar off', harness.ctx as never);
    expect(clears.at(-1)).toEqual({ key: 'goal', source: 'pi-goal' });
    const snapshotCount = snapshots.length;
    harness.events.emit(STATUSLINE_STATUS_SNAPSHOT_REQUEST_EVENT, {});
    expect(snapshots).toHaveLength(snapshotCount);

    await emit(harness, 'session_shutdown', { reason: 'quit' });
    expect(clears.at(-1)).toEqual({ key: 'goal', source: 'pi-goal' });
  });

  it('preserves unrelated active tools and hides active-only tools after completion', async () => {
    await createActiveGoal(harness);
    expect(harness.activeTools).toEqual(
      new Set(['read', 'create_goal', 'get_goal', 'update_goal']),
    );

    const update = harness.tools.get('update_goal');
    await update?.execute('call', { status: 'complete' }, undefined, undefined, harness.ctx);
    expect(harness.activeTools).toEqual(new Set(['read', 'create_goal']));
  });

  it('accounts final-turn usage after update_goal completes the goal', async () => {
    await createActiveGoal(harness);
    await emit(harness, 'turn_start');
    await harness.tools
      .get('update_goal')
      ?.execute('call', { status: 'complete' }, undefined, undefined, harness.ctx);
    await emit(harness, 'turn_end', { message: { usage: { totalTokens: 25 } } });

    const lastData = harness.appendEntry.mock.calls.at(-1)?.[1] as {
      goal: { status: string; tokensUsed: number };
    };
    expect(lastData.goal).toMatchObject({ status: 'complete', tokensUsed: 25 });
  });

  it('transitions to budget_limited and emits one final summary request', async () => {
    await emit(harness, 'session_start', { reason: 'startup' });
    await harness.commands
      .get('goal')
      ?.handler('--tokens 10 budgeted objective', harness.ctx as never);
    harness.sendMessage.mockClear();
    await emit(harness, 'turn_start');
    await emit(harness, 'turn_end', { message: { usage: { totalTokens: 10 } } });

    const lastData = harness.appendEntry.mock.calls.at(-1)?.[1] as {
      goal: { status: string };
    };
    expect(lastData.goal.status).toBe('budget_limited');
    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      details: { kind: 'budget_limited' },
    });
  });

  it('restores branch-local state on session_tree', async () => {
    await emit(harness, 'session_start', { reason: 'startup' });
    const branchGoal = createGoalState('branch goal', null, 1, () => 'branch-goal');
    harness.branch.push({
      type: 'custom',
      customType: 'pi-goal',
      data: { version: 1, goal: branchGoal, statusBarEnabled: true },
    });
    await emit(harness, 'session_tree');
    expect(harness.activeTools).toEqual(
      new Set(['read', 'create_goal', 'get_goal', 'update_goal']),
    );
  });

  it('pauses an active restored goal on reload', async () => {
    const restored = createGoalState('restored', null, 1, () => 'restored-goal');
    harness.branch.push({
      type: 'custom',
      customType: 'pi-goal',
      data: { version: 1, goal: restored, statusBarEnabled: true },
    });
    await emit(harness, 'session_start', { reason: 'reload' });
    const lastData = harness.appendEntry.mock.calls.at(-1)?.[1] as {
      goal: { status: string };
    };
    expect(lastData.goal.status).toBe('paused');
  });
});
