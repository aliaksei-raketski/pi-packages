import {
  CONTINUATION_GATE_ACQUIRE_EVENT,
  CONTINUATION_GATE_RELEASE_EVENT,
  CONTINUATION_GATE_WAKE_COMMITTED_EVENT,
  CONTINUATION_GATE_WAKE_PENDING_EVENT,
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

async function verifySingleRequirement(harness: Harness): Promise<void> {
  const updateEvidence = harness.tools.get('update_goal_evidence');
  await updateEvidence?.execute(
    'call-1',
    {
      action: 'initialize_requirements',
      expectedRevision: 0,
      requirements: [{ id: 'ship', requirement: 'Ship with direct evidence' }],
    },
    undefined,
    undefined,
    harness.ctx,
  );
  await updateEvidence?.execute(
    'call-2',
    {
      action: 'add_evidence',
      expectedRevision: 1,
      requirementId: 'ship',
      evidence: {
        id: 'test',
        kind: 'test',
        reference: 'goal.spec.ts',
        claim: 'integration behavior was inspected',
      },
    },
    undefined,
    undefined,
    harness.ctx,
  );
  await updateEvidence?.execute(
    'call-3',
    {
      action: 'set_requirement_status',
      expectedRevision: 2,
      requirementId: 'ship',
      status: 'verified',
    },
    undefined,
    undefined,
    harness.ctx,
  );
}

function acquireGate(harness: Harness, gateId = 'tests'): void {
  harness.events.emit(CONTINUATION_GATE_ACQUIRE_EVENT, {
    sessionId: 'session-1',
    source: 'producer',
    gateId,
    domain: 'autonomous-continuation',
    reason: 'waiting for tests',
    acquiredAt: Date.now(),
    updatedAt: Date.now(),
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
      ['update_goal_evidence', expect.any(Object)],
      ['update_goal', expect.any(Object)],
    ]);
    for (const event of [
      'session_start',
      'session_before_tree',
      'session_tree',
      'before_agent_start',
      'turn_start',
      'turn_end',
      'agent_settled',
      'session_shutdown',
    ]) {
      expect(harness.handlers.has(event)).toBe(true);
    }
  });

  it('renders wall budgets, evidence summary, and progress diagnostics in details', () => {
    const registerRenderer = harness.pi.registerMessageRenderer as ReturnType<typeof vi.fn>;
    const renderer = registerRenderer.mock.calls[0]?.[1] as
      | ((
          message: unknown,
          options: { expanded: boolean },
          theme: unknown,
        ) => {
          render(width: number): string[];
        })
      | undefined;
    const state = createGoalState('render details', 100, 1, () => 'render-goal', 60);
    const component = renderer?.(
      {
        details: {
          kind: 'active',
          goal: state,
          gates: [],
          ledger: null,
          noProgressStreak: 2,
          timestamp: 1_001,
        },
      },
      { expanded: true },
      (harness.ctx.ui as { theme: unknown }).theme,
    );
    const rendered = component?.render(200).join('\n') ?? '';
    expect(rendered).toContain('Usage: 0/100 tokens; 1s/1m active wall; 0s turn time');
    expect(rendered).toContain('Budgets: tokens=100, wall=60s');
    expect(rendered).toContain('Evidence: revision 0');
    expect(rendered).toContain('No-progress streak: 2');
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
        releaseId: 'release-tests',
        sessionId: 'session-1',
        source: 'producer',
        gateId: 'tests',
        domain: 'autonomous-continuation',
        outcome: 'abandoned',
        wake: 'none',
        releasedAt: Date.now(),
      });
      harness.events.emit(CONTINUATION_GATE_ACQUIRE_EVENT, {
        sessionId: 'session-1',
        source: 'producer',
        gateId: 'tests',
        domain: 'autonomous-continuation',
        reason: 'replacement wait lifecycle',
        acquiredAt: Date.now() + 1_000,
        updatedAt: Date.now() + 1_000,
      });
      return true;
    });

    await harness.commands.get('goal')?.handler('continue', harness.ctx as never);
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('does not duplicate a committed producer-message wake handoff', async () => {
    await createActiveGoal(harness);
    acquireGate(harness);
    const handoff = {
      handoffId: 'handoff-tests',
      sessionId: 'session-1',
      source: 'producer',
      gateId: 'tests',
      domain: 'autonomous-continuation',
      createdAt: Date.now(),
    };
    harness.events.emit(CONTINUATION_GATE_WAKE_PENDING_EVENT, handoff);
    harness.events.emit(CONTINUATION_GATE_WAKE_COMMITTED_EVENT, handoff);
    harness.events.emit(CONTINUATION_GATE_RELEASE_EVENT, {
      releaseId: 'release-producer',
      sessionId: 'session-1',
      source: 'producer',
      gateId: 'tests',
      domain: 'autonomous-continuation',
      outcome: 'completed',
      wake: 'producer-message',
      handoffId: handoff.handoffId,
      releasedAt: Date.now(),
    });
    await Promise.resolve();
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
      new Set(['read', 'create_goal', 'get_goal', 'update_goal', 'update_goal_evidence']),
    );

    await verifySingleRequirement(harness);
    const update = harness.tools.get('update_goal');
    await update?.execute('call', { status: 'complete' }, undefined, undefined, harness.ctx);
    expect(harness.activeTools).toEqual(new Set(['read', 'create_goal']));
  });

  it('accounts final-turn usage after update_goal completes the goal', async () => {
    await createActiveGoal(harness);
    await verifySingleRequirement(harness);
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
      new Set(['read', 'create_goal', 'get_goal', 'update_goal', 'update_goal_evidence']),
    );
  });

  it('restores branch-local evidence and settings on session_tree', async () => {
    await createActiveGoal(harness);
    const updateEvidence = harness.tools.get('update_goal_evidence');
    await updateEvidence?.execute(
      'call',
      {
        action: 'initialize_requirements',
        expectedRevision: 0,
        requirements: [{ id: 'branch', requirement: 'Branch-local requirement' }],
      },
      undefined,
      undefined,
      harness.ctx,
    );
    await harness.commands.get('goal')?.handler('restart restore-idle', harness.ctx as never);
    const branchState = harness.appendEntry.mock.calls.at(-1)?.[1];
    await harness.commands.get('goal')?.handler('evidence reset', harness.ctx as never);
    harness.branch.splice(0, harness.branch.length, {
      type: 'custom',
      customType: 'pi-goal',
      data: branchState,
    });
    await emit(harness, 'session_tree');
    const result = (await harness.tools
      .get('get_goal')
      ?.execute('call', {}, undefined, undefined, harness.ctx)) as {
      details: { ledger: { requirements: Array<{ id: string }> }; restartPolicy: string };
    };
    expect(result.details.ledger.requirements).toEqual([expect.objectContaining({ id: 'branch' })]);
    expect(result.details.restartPolicy).toBe('restore-idle');
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
      goal: { status: string; pauseReason: string };
    };
    expect(lastData.goal).toMatchObject({ status: 'paused', pauseReason: 'reload' });
  });

  it('rejects completion until the ledger is fully verified', async () => {
    await createActiveGoal(harness);
    await expect(
      harness.tools
        .get('update_goal')
        ?.execute('call', { status: 'complete' }, undefined, undefined, harness.ctx),
    ).rejects.toThrow(/no requirements/);
    await verifySingleRequirement(harness);
    await expect(
      harness.tools
        .get('update_goal')
        ?.execute('call', { status: 'complete' }, undefined, undefined, harness.ctx),
    ).resolves.toBeDefined();
  });

  it('supports combined command budgets and exposes them through get_goal', async () => {
    await emit(harness, 'session_start', { reason: 'startup' });
    await harness.commands
      .get('goal')
      ?.handler('--time 30m --tokens 50k combined objective', harness.ctx as never);
    const result = (await harness.tools
      .get('get_goal')
      ?.execute('call', {}, undefined, undefined, harness.ctx)) as {
      details: { goal: { tokenBudget: number; wallTimeBudgetSeconds: number } };
    };
    expect(result.details.goal).toMatchObject({
      tokenBudget: 50_000,
      wallTimeBudgetSeconds: 1_800,
    });
  });

  it('keeps a gated wall-budget summary pending until the gate clears', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await emit(harness, 'session_start', { reason: 'startup' });
      await harness.commands.get('goal')?.handler('--time 10s timed goal', harness.ctx as never);
      harness.sendMessage.mockClear();
      acquireGate(harness);
      await vi.advanceTimersByTimeAsync(10_000);
      const limited = harness.appendEntry.mock.calls.at(-1)?.[1] as {
        goal: { status: string; budgetLimitReason: string };
        pendingBudgetSummary: boolean;
      };
      expect(limited.goal).toMatchObject({
        status: 'budget_limited',
        budgetLimitReason: 'wall_time',
      });
      expect(limited.pendingBudgetSummary).toBe(true);
      expect(harness.sendMessage).not.toHaveBeenCalled();

      harness.events.emit(CONTINUATION_GATE_RELEASE_EVENT, {
        releaseId: 'release-timer',
        sessionId: 'session-1',
        source: 'producer',
        gateId: 'tests',
        domain: 'autonomous-continuation',
        outcome: 'completed',
        wake: 'none',
        releasedAt: Date.now(),
      });
      expect(harness.sendMessage).toHaveBeenCalledOnce();
      const delivered = harness.appendEntry.mock.calls.at(-1)?.[1] as {
        pendingBudgetSummary: boolean;
      };
      expect(delivered.pendingBudgetSummary).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the wall deadline active when tree navigation is canceled', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await emit(harness, 'session_start', { reason: 'startup' });
      await harness.commands.get('goal')?.handler('--time 10s timed goal', harness.ctx as never);
      harness.sendMessage.mockClear();

      await vi.advanceTimersByTimeAsync(4_000);
      await emit(harness, 'session_before_tree');
      const checkpoint = harness.appendEntry.mock.calls.at(-1)?.[1] as {
        goal: { status: string; activeSince: number | null };
      };
      expect(checkpoint.goal).toMatchObject({ status: 'active', activeSince: Date.now() });

      await vi.advanceTimersByTimeAsync(6_000);
      const limited = harness.appendEntry.mock.calls.at(-1)?.[1] as {
        goal: { status: string; budgetLimitReason: string };
      };
      expect(limited.goal).toMatchObject({
        status: 'budget_limited',
        budgetLimitReason: 'wall_time',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['restore-idle', 0],
    ['resume', 1],
  ] as const)('applies restart policy %s with guarded startup turns', async (policy, turns) => {
    const restored = createGoalState('restored', null, 1, () => 'restored-goal');
    harness.branch.push({
      type: 'custom',
      customType: 'pi-goal',
      data: { goal: restored, statusBarEnabled: true, restartPolicy: policy },
    });
    await emit(harness, 'session_start', { reason: 'startup' });
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledTimes(turns);
  });

  it('enforces an exhausted wall budget before restart continuation', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const restored = {
        ...createGoalState('exhausted restart', null, 1_000, () => 'restored-goal', 10),
        activeWallTimeSeconds: 10,
      };
      harness.branch.push({
        type: 'custom',
        customType: 'pi-goal',
        data: { goal: restored, statusBarEnabled: true, restartPolicy: 'resume' },
      });

      await emit(harness, 'session_start', { reason: 'startup' });
      await Promise.resolve();

      expect(harness.sendMessage).toHaveBeenCalledOnce();
      expect(harness.sendMessage.mock.calls[0]?.[0]).toMatchObject({
        details: { kind: 'budget_limited', goal: { status: 'budget_limited' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces an exhausted wall budget before /goal resume delivery', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const paused = {
        ...createGoalState('exhausted resume', null, 1_000, () => 'paused-goal', 10),
        status: 'paused' as const,
        activeWallTimeSeconds: 10,
        activeSince: null,
        pauseReason: 'user' as const,
      };
      harness.branch.push({
        type: 'custom',
        customType: 'pi-goal',
        data: { goal: paused, statusBarEnabled: true },
      });
      await emit(harness, 'session_start', { reason: 'resume' });
      harness.sendMessage.mockClear();

      await harness.commands.get('goal')?.handler('resume', harness.ctx as never);

      expect(harness.sendMessage).toHaveBeenCalledOnce();
      expect(harness.sendMessage.mock.calls[0]?.[0]).toMatchObject({
        details: { kind: 'budget_limited', goal: { status: 'budget_limited' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a gated restart and wins one auto-resume claim after wake none', async () => {
    acquireGate(harness);
    const restored = createGoalState('restored', null, 1, () => 'restored-goal');
    harness.branch.push({
      type: 'custom',
      customType: 'pi-goal',
      data: { goal: restored, statusBarEnabled: true, restartPolicy: 'resume' },
    });
    await emit(harness, 'session_start', { reason: 'startup' });
    await Promise.resolve();
    expect(harness.sendMessage).not.toHaveBeenCalled();

    harness.events.emit(CONTINUATION_GATE_RELEASE_EVENT, {
      releaseId: 'release-restart',
      sessionId: 'session-1',
      source: 'producer',
      gateId: 'tests',
      domain: 'autonomous-continuation',
      outcome: 'completed',
      wake: 'none',
      releasedAt: Date.now(),
    });
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledOnce();
  });

  it('does not run restart resume while pending messages exist', async () => {
    const restored = createGoalState('restored', null, 1, () => 'restored-goal');
    harness.branch.push({
      type: 'custom',
      customType: 'pi-goal',
      data: { goal: restored, statusBarEnabled: true, restartPolicy: 'resume' },
    });
    (harness.ctx.hasPendingMessages as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await emit(harness, 'session_start', { reason: 'startup' });
    await Promise.resolve();
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('does not observe repeated synthetic turns while no-progress is disabled', async () => {
    await createActiveGoal(harness);
    for (let index = 0; index < 4; index += 1) {
      await emit(harness, 'agent_settled');
      await Promise.resolve();
      await emit(harness, 'turn_start');
      await emit(harness, 'turn_end', {
        message: {
          content: [{ type: 'text', text: 'Repeated disabled-mode result.' }],
          usage: { totalTokens: 1 },
        },
        toolResults: [],
      });
    }
    const lastData = harness.appendEntry.mock.calls.at(-1)?.[1] as {
      goal: { status: string };
      progress: unknown;
    };
    expect(lastData.goal.status).toBe('active');
    expect(lastData.progress).toBeNull();
  });

  it('does not count explicit manual continuation toward no-progress', async () => {
    await createActiveGoal(harness);
    await harness.commands.get('goal')?.handler('no-progress on', harness.ctx as never);
    for (let index = 0; index < 4; index += 1) {
      await harness.commands.get('goal')?.handler('continue', harness.ctx as never);
      await emit(harness, 'turn_start');
      await emit(harness, 'turn_end', {
        message: {
          content: [{ type: 'text', text: 'Repeated manual result.' }],
          usage: { totalTokens: 1 },
        },
        toolResults: [],
      });
    }
    const lastData = harness.appendEntry.mock.calls.at(-1)?.[1] as {
      goal: { status: string };
      progress: unknown;
    };
    expect(lastData.goal.status).toBe('active');
    expect(lastData.progress).toBeNull();
  });

  it('pauses only repeated synthetic continuations when no-progress is enabled', async () => {
    await createActiveGoal(harness);
    await harness.commands.get('goal')?.handler('no-progress on', harness.ctx as never);
    for (let index = 0; index < 4; index += 1) {
      await emit(harness, 'agent_settled');
      await Promise.resolve();
      await emit(harness, 'turn_start');
      await emit(harness, 'turn_end', {
        message: {
          content: [{ type: 'text', text: 'Repeated the same inspection with no new evidence.' }],
          usage: { totalTokens: 1 },
        },
        toolResults: [],
      });
    }
    const lastData = harness.appendEntry.mock.calls.at(-1)?.[1] as {
      goal: { status: string; pauseReason: string };
      progress: { stagnationStreak: number };
    };
    expect(lastData.goal).toMatchObject({ status: 'paused', pauseReason: 'no_progress' });
    expect(lastData.progress.stagnationStreak).toBe(3);
    expect(
      (harness.ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify,
    ).toHaveBeenLastCalledWith(expect.stringContaining('repeated synthetic'), 'warning');
  });

  it('delivers a busy budget limit as a model-visible next-turn instruction once', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await emit(harness, 'session_start', { reason: 'startup' });
      await harness.commands.get('goal')?.handler('--time 1s timed goal', harness.ctx as never);
      harness.sendMessage.mockClear();
      (harness.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.sendMessage).not.toHaveBeenCalled();
      const beforeStart = harness.handlers.get('before_agent_start')?.[0];
      const injected = await beforeStart?.({}, harness.ctx as never);
      expect(injected).toMatchObject({
        message: {
          customType: 'pi-goal-event',
          content: expect.stringContaining('budget_limited'),
        },
      });
      const lastData = harness.appendEntry.mock.calls.at(-1)?.[1] as {
        pendingBudgetSummary: boolean;
      };
      expect(lastData.pendingBudgetSummary).toBe(false);
      expect(await beforeStart?.({}, harness.ctx as never)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkpoints the active wall clock on shutdown without sending a turn', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await createActiveGoal(harness);
      harness.sendMessage.mockClear();
      await vi.advanceTimersByTimeAsync(5_000);
      await emit(harness, 'session_shutdown', { reason: 'quit' });
      const lastData = harness.appendEntry.mock.calls.at(-1)?.[1] as {
        goal: { activeWallTimeSeconds: number; activeSince: number | null };
      };
      expect(lastData.goal.activeWallTimeSeconds).toBe(5);
      expect(lastData.goal.activeSince).toBeNull();
      expect(harness.sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
