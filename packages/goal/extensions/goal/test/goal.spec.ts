import {
  CONTINUATION_GATE_ACQUIRE_EVENT,
  CONTINUATION_GATE_RELEASE_EVENT,
  CONTINUATION_GATE_RESUME_COMMIT_EVENT,
  CONTINUATION_GATE_WAKE_COMMITTED_EVENT,
  CONTINUATION_GATE_WAKE_PENDING_EVENT,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import {
  STATUSLINE_STATUS_CLEAR_EVENT,
  STATUSLINE_STATUS_SNAPSHOT_EVENT,
  STATUSLINE_STATUS_SNAPSHOT_REQUEST_EVENT,
} from '@aliaksei-raketski/pi-statusline-protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGoalEvidenceLedger,
  goalEvidenceLedgerByteLength,
  mutateGoalEvidence,
  type GoalEvidenceLedger,
} from '../src/goal-evidence.ts';
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

async function acknowledgeBudgetSummary(
  harness: Harness,
  message: unknown = harness.sendMessage.mock.calls.at(-1)?.[0],
): Promise<void> {
  await emit(harness, 'message_start', { message });
}

async function acknowledgeContinuation(harness: Harness): Promise<void> {
  await emit(harness, 'message_start', {
    message: harness.sendMessage.mock.calls.at(-1)?.[0] as Record<string, unknown>,
  });
}

async function activeGoalId(harness: Harness): Promise<string> {
  const result = (await harness.tools
    .get('get_goal')
    ?.execute('get-active-goal', {}, undefined, undefined, harness.ctx)) as {
    details: { goal: { id: string } };
  };
  return result.details.goal.id;
}

async function verifySingleRequirement(harness: Harness): Promise<void> {
  const updateEvidence = harness.tools.get('update_goal_evidence');
  const goalId = await activeGoalId(harness);
  await updateEvidence?.execute(
    'call-1',
    {
      action: 'initialize_requirements',
      goalId,
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
      goalId,
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
      goalId,
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
    expect(harness.pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'get_goal',
        label: 'Get Goal',
        renderCall: expect.any(Function),
        renderResult: expect.any(Function),
      }),
    );
    for (const event of [
      'session_start',
      'session_before_tree',
      'session_tree',
      'before_agent_start',
      'message_start',
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
          evidenceSummary: {
            revision: 0,
            total: 0,
            pending: 0,
            inProgress: 0,
            verified: 0,
            blocked: 0,
          },
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

  it('renders legacy goal-event details with safe structural defaults', () => {
    const registerRenderer = harness.pi.registerMessageRenderer as ReturnType<typeof vi.fn>;
    const renderer = registerRenderer.mock.calls[0]?.[1] as
      | ((
          message: unknown,
          options: { expanded: boolean },
          theme: unknown,
        ) => { render(width: number): string[] })
      | undefined;
    const component = renderer?.(
      {
        details: {
          kind: 'active',
          goal: {
            id: 'legacy-goal',
            objective: 'legacy objective',
            status: 'active',
            tokenBudget: 100,
            tokensUsed: 10,
            timeUsedSeconds: 2,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
      { expanded: true },
      (harness.ctx.ui as { theme: unknown }).theme,
    );
    const rendered = component?.render(200).join('\n') ?? '';

    expect(rendered).toContain('Usage: 10/100 tokens; 0s active wall; 2s turn time');
    expect(rendered).toContain('Budgets: tokens=100, wall=none');
    expect(rendered).toContain('No-progress streak: 0');
    expect(rendered).not.toMatch(/NaN|undefined/);
  });

  it('does not throw on malformed nested historical event details', () => {
    const registerRenderer = harness.pi.registerMessageRenderer as ReturnType<typeof vi.fn>;
    const renderer = registerRenderer.mock.calls[0]?.[1] as
      | ((
          message: unknown,
          options: { expanded: boolean },
          theme: unknown,
        ) => { render(width: number): string[] })
      | undefined;
    const component = renderer?.(
      {
        details: {
          kind: 'unknown',
          goal: { objective: 'malformed', status: 'active' },
          gates: [null, { source: 'valid', gateId: 'gate-1' }],
          evidenceSummary: { revision: 'bad', verified: undefined },
          ledger: { requirements: null },
        },
      },
      { expanded: true },
      (harness.ctx.ui as { theme: unknown }).theme,
    );
    const rendered = component?.render(200).join('\n') ?? '';

    expect(rendered).toContain('Status: continuing');
    expect(rendered).toContain('Gates: valid/gate-1');
    expect(rendered).toContain('Evidence: revision 0; 0/0 verified');
    expect(rendered).not.toMatch(/NaN|undefined/);
  });

  it('bounds aggregate goal tool results and reports omitted data', async () => {
    await emit(harness, 'session_start', { reason: 'startup' });
    const objective = '界'.repeat(20_000);
    const createResult = (await harness.tools
      .get('create_goal')
      ?.execute('create-large', { objective }, undefined, undefined, harness.ctx)) as {
      details: { goal: { id: string }; truncation: { truncated: boolean } | null };
    };
    expect(new TextEncoder().encode(JSON.stringify(createResult)).byteLength).toBeLessThanOrEqual(
      50 * 1_024,
    );
    expect(createResult.details.truncation).toMatchObject({ truncated: true });

    await harness.tools.get('update_goal_evidence')?.execute(
      'initialize-large-ledger',
      {
        action: 'initialize_requirements',
        goalId: createResult.details.goal.id,
        expectedRevision: 0,
        requirements: Array.from({ length: 8 }, (_, index) => ({
          id: `large-requirement-${index}`,
          requirement: 'direct evidence requirement '.padEnd(1_800, String(index)),
        })),
      },
      undefined,
      undefined,
      harness.ctx,
    );

    for (let index = 0; index < 32; index += 1) {
      harness.events.emit(CONTINUATION_GATE_ACQUIRE_EVENT, {
        sessionId: 'session-1',
        source: 'producer',
        gateId: `large-${index}`,
        domain: 'autonomous-continuation',
        reason: 'x'.repeat(2_048),
        acquiredAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    const getResult = (await harness.tools
      .get('get_goal')
      ?.execute('get-large', {}, undefined, undefined, harness.ctx)) as {
      details: {
        ledger: { requirements: Array<{ id: string }> };
        truncation: {
          truncated: boolean;
          ledgerRequirements: { total: number; included: number };
          gates: { total: number; included: number };
        } | null;
      };
    };
    expect(new TextEncoder().encode(JSON.stringify(getResult)).byteLength).toBeLessThanOrEqual(
      50 * 1_024,
    );
    expect(getResult.details.ledger.requirements).toHaveLength(8);
    expect(getResult.details.truncation).toMatchObject({
      truncated: true,
      ledgerRequirements: { total: 8, included: 8 },
      gates: { total: 32 },
    });
  });

  it('keeps escape-heavy recovery payloads within 50 KiB without omitting the ledger', async () => {
    const goalId = '\\'.repeat(128);
    const state = createGoalState('\\'.repeat(20_000), null, 1, () => goalId);
    let ledger: GoalEvidenceLedger | null = null;
    for (let length = 2_000; length >= 1_000 && ledger === null; length -= 10) {
      try {
        ledger = mutateGoalEvidence(
          createGoalEvidenceLedger(goalId, 1),
          goalId,
          {
            action: 'initialize_requirements',
            expectedRevision: 0,
            requirements: Array.from({ length: 4 }, (_, index) => ({
              id: `escaped-${index}`,
              requirement: '\\'.repeat(length),
            })),
          },
          2,
        );
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('serialized bytes')) throw error;
      }
    }
    expect(ledger).not.toBeNull();
    expect(goalEvidenceLedgerByteLength(ledger as GoalEvidenceLedger)).toBeGreaterThan(15_000);
    harness.branch.push({
      type: 'custom',
      customType: 'pi-goal',
      data: { goal: state, ledger, statusBarEnabled: true },
    });
    await emit(harness, 'session_start', { reason: 'resume' });

    const result = (await harness.tools
      .get('get_goal')
      ?.execute('get-escaped', {}, undefined, undefined, harness.ctx)) as {
      content: Array<{ type: 'text'; text: string }>;
      details?: unknown;
    };
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      50 * 1_024,
    );
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      ledger: { requirements: unknown[] };
      truncation: { ledgerRequirements: { total: number; included: number } };
    };
    expect(payload.ledger.requirements).toHaveLength(4);
    expect(payload.truncation.ledgerRequirements).toEqual({ total: 4, included: 4 });
  });

  it('queues one continuation after Pi settles', async () => {
    await createActiveGoal(harness);
    await emit(harness, 'agent_settled');
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: 'pi-goal-event' }),
      { triggerTurn: true, deliverAs: 'followUp' },
    );
  });

  it('does not consume an unacknowledged continuation for an unrelated turn', async () => {
    await createActiveGoal(harness);
    await harness.commands.get('goal')?.handler('no-progress on', harness.ctx as never);
    await emit(harness, 'agent_settled');
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledOnce();

    await emit(harness, 'turn_start');
    await emit(harness, 'turn_end', {
      message: {
        content: [{ type: 'text', text: 'Unrelated user turn.' }],
        usage: { totalTokens: 1 },
      },
      toolResults: [],
    });
    expect(harness.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({ progress: null });

    await emit(harness, 'agent_settled');
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    await acknowledgeContinuation(harness);
  });

  it('keeps /goal resume retryable when continuation delivery throws', async () => {
    await createActiveGoal(harness);
    await harness.commands.get('goal')?.handler('pause', harness.ctx as never);
    harness.sendMessage.mockClear();
    harness.sendMessage.mockImplementation(() => {
      throw new Error('resume provider unavailable');
    });

    await harness.commands.get('goal')?.handler('resume', harness.ctx as never);

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      goal: { status: 'paused', pauseReason: 'delivery_failure' },
    });
    expect((harness.ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify).toHaveBeenCalledWith(
      expect.stringContaining('Goal resume delivery failed: resume provider unavailable'),
      'error',
    );
  });

  it('retries an unacknowledged synthetic continuation on the final settle', async () => {
    await createActiveGoal(harness);
    await emit(harness, 'agent_settled');
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledOnce();

    await emit(harness, 'agent_settled');
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    await emit(harness, 'message_start', {
      message: harness.sendMessage.mock.calls.at(-1)?.[0] as Record<string, unknown>,
    });
  });

  it('bounds continuation turns that settle without completing', async () => {
    await createActiveGoal(harness);
    await emit(harness, 'agent_settled');
    await Promise.resolve();
    await emit(harness, 'message_start', {
      message: harness.sendMessage.mock.calls.at(-1)?.[0] as Record<string, unknown>,
    });
    await emit(harness, 'turn_start');

    await emit(harness, 'agent_settled');
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    await emit(harness, 'message_start', {
      message: harness.sendMessage.mock.calls.at(-1)?.[0] as Record<string, unknown>,
    });
    await emit(harness, 'turn_start');
    await emit(harness, 'agent_settled');

    expect(harness.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      goal: { status: 'paused', pauseReason: 'delivery_failure' },
    });
  });

  it('bounds continuation delivery after terminal provider failures', async () => {
    await createActiveGoal(harness);
    await emit(harness, 'agent_settled');
    await Promise.resolve();
    await emit(harness, 'message_start', {
      message: harness.sendMessage.mock.calls.at(-1)?.[0] as Record<string, unknown>,
    });
    await emit(harness, 'turn_start');
    await emit(harness, 'turn_end', {
      message: { stopReason: 'error', usage: { totalTokens: 1 } },
      toolResults: [],
    });
    await emit(harness, 'agent_settled');
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledTimes(2);

    await emit(harness, 'message_start', {
      message: harness.sendMessage.mock.calls.at(-1)?.[0] as Record<string, unknown>,
    });
    await emit(harness, 'turn_start');
    await emit(harness, 'turn_end', {
      message: { stopReason: 'aborted', usage: { totalTokens: 1 } },
      toolResults: [],
    });
    await emit(harness, 'agent_settled');

    expect(harness.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      goal: { status: 'paused', pauseReason: 'delivery_failure' },
    });
  });

  it('contains synthetic continuation queue failures and permits a later retry', async () => {
    await createActiveGoal(harness);
    harness.sendMessage.mockImplementationOnce(() => {
      throw {
        toString: () => {
          throw new Error('unsafe coercion');
        },
      };
    });

    await emit(harness, 'agent_settled');
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    expect((harness.ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify).toHaveBeenCalledWith(
      'Failed to deliver goal continuation: Unknown delivery error',
      'error',
    );
  });

  it('pauses safely after bounded continuation delivery failures', async () => {
    await createActiveGoal(harness);
    harness.sendMessage.mockImplementation(() => {
      throw new Error('provider unavailable');
    });

    await emit(harness, 'agent_settled');
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    expect(harness.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      goal: { status: 'paused', pauseReason: 'delivery_failure' },
    });
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

  it('cancels stale goal replacement confirmation after a concurrent replacement', async () => {
    await createActiveGoal(harness);
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined;
    harness.confirm.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (resolveConfirmation = resolve)),
    );
    const pendingReplacement = harness.commands
      .get('goal')
      ?.handler('stale replacement', harness.ctx as never);
    await Promise.resolve();

    await harness.tools
      .get('create_goal')
      ?.execute(
        'concurrent-replacement',
        { objective: 'concurrent goal' },
        undefined,
        undefined,
        harness.ctx,
      );
    resolveConfirmation?.(true);
    await pendingReplacement;

    const current = (await harness.tools
      .get('get_goal')
      ?.execute('current-goal', {}, undefined, undefined, harness.ctx)) as {
      details: { goal: { objective: string } };
    };
    expect(current.details.goal.objective).toBe('concurrent goal');
    expect((harness.ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify).toHaveBeenCalledWith(
      'Goal changed while replacement confirmation was open; replacement was cancelled.',
      'warning',
    );
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

  it('keeps an unacknowledged queued summary durable and retries on a natural turn', async () => {
    await emit(harness, 'session_start', { reason: 'startup' });
    await harness.commands
      .get('goal')
      ?.handler('--tokens 10 budgeted objective', harness.ctx as never);
    harness.sendMessage.mockClear();
    await emit(harness, 'turn_start');
    await emit(harness, 'turn_end', { message: { usage: { totalTokens: 10 } } });

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      pendingBudgetSummary: true,
    });
    await emit(harness, 'agent_settled');
    expect(harness.sendMessage).toHaveBeenCalledOnce();

    const beforeStart = harness.handlers.get('before_agent_start')?.[0];
    const injected = beforeStart?.({}, harness.ctx as never) as
      | { message: Record<string, unknown> }
      | undefined;
    expect(injected?.message).toMatchObject({
      customType: 'pi-goal-event',
      details: { kind: 'budget_limited' },
    });
    expect(harness.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      pendingBudgetSummary: true,
    });
    const forgedMessage = {
      ...injected?.message,
      details: {
        ...((injected?.message.details as Record<string, unknown> | undefined) ?? {}),
        deliveryId: 'forged-delivery-id',
      },
    };
    await acknowledgeBudgetSummary(harness, forgedMessage);
    expect(harness.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      pendingBudgetSummary: true,
    });

    await acknowledgeBudgetSummary(harness, injected?.message);
    expect(harness.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      pendingBudgetSummary: false,
    });
  });

  it('keeps a budget summary pending without escaping queue failures', async () => {
    await emit(harness, 'session_start', { reason: 'startup' });
    await harness.commands
      .get('goal')
      ?.handler('--tokens 10 budgeted objective', harness.ctx as never);
    harness.sendMessage.mockClear();
    harness.sendMessage.mockImplementationOnce(() => {
      throw {
        toString: () => {
          throw new Error('unsafe coercion');
        },
      };
    });
    await emit(harness, 'turn_start');
    await expect(
      emit(harness, 'turn_end', { message: { usage: { totalTokens: 10 } } }),
    ).resolves.toBeUndefined();

    expect(harness.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      pendingBudgetSummary: true,
    });
    expect((harness.ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify).toHaveBeenCalledWith(
      'Failed to deliver goal budget summary: Unknown delivery error',
      'error',
    );

    await emit(harness, 'agent_settled');
    expect(harness.sendMessage).toHaveBeenCalledOnce();
    const beforeStart = harness.handlers.get('before_agent_start')?.[0];
    const injected = beforeStart?.({}, harness.ctx as never) as
      | { message: Record<string, unknown> }
      | undefined;
    expect(injected?.message).toMatchObject({ details: { kind: 'budget_limited' } });
    await acknowledgeBudgetSummary(harness, injected?.message);
    expect(harness.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      pendingBudgetSummary: false,
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
    const goalId = await activeGoalId(harness);
    await updateEvidence?.execute(
      'call',
      {
        action: 'initialize_requirements',
        goalId,
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

  it('binds public evidence mutations to the active goal and cannot replace the ledger', async () => {
    await createActiveGoal(harness);
    const originalGoalId = await activeGoalId(harness);
    const evidenceTool = harness.tools.get('update_goal_evidence') as unknown as {
      parameters: {
        properties: Record<string, { maximum?: number }>;
      };
      execute: (...args: unknown[]) => Promise<unknown>;
    };
    expect(evidenceTool.parameters.properties).toHaveProperty('goalId');
    expect(evidenceTool.parameters.properties).not.toHaveProperty('replace');
    expect(evidenceTool.parameters.properties.expectedRevision?.maximum).toBe(
      Number.MAX_SAFE_INTEGER,
    );

    await evidenceTool.execute(
      'initialize-original',
      {
        action: 'initialize_requirements',
        goalId: originalGoalId,
        expectedRevision: 0,
        requirements: [{ id: 'one', requirement: 'Keep the original requirement' }],
      },
      undefined,
      undefined,
      harness.ctx,
    );
    await expect(
      evidenceTool.execute(
        'replace-original',
        {
          action: 'initialize_requirements',
          goalId: originalGoalId,
          expectedRevision: 1,
          requirements: [{ id: 'two', requirement: 'Erase the original requirement' }],
          replace: true,
        },
        undefined,
        undefined,
        harness.ctx,
      ),
    ).rejects.toThrow(/user-confirmed evidence reset/);

    await harness.tools
      .get('create_goal')
      ?.execute(
        'replace-goal',
        { objective: 'replacement goal' },
        undefined,
        undefined,
        harness.ctx,
      );
    const replacementGoalId = await activeGoalId(harness);
    expect(replacementGoalId).not.toBe(originalGoalId);
    await expect(
      evidenceTool.execute(
        'stale-goal-update',
        {
          action: 'initialize_requirements',
          goalId: originalGoalId,
          expectedRevision: 0,
          requirements: [{ id: 'stale', requirement: 'Mutate the replacement goal' }],
        },
        undefined,
        undefined,
        harness.ctx,
      ),
    ).rejects.toThrow(/different goal/);
  });

  it('cancels evidence reset when the confirmed ledger changes concurrently', async () => {
    await createActiveGoal(harness);
    const goalId = await activeGoalId(harness);
    const evidenceTool = harness.tools.get('update_goal_evidence');
    await evidenceTool?.execute(
      'initialize-before-reset',
      {
        action: 'initialize_requirements',
        goalId,
        expectedRevision: 0,
        requirements: [{ id: 'one', requirement: 'Preserve concurrent evidence' }],
      },
      undefined,
      undefined,
      harness.ctx,
    );
    harness.confirm.mockImplementationOnce(async () => {
      await evidenceTool?.execute(
        'concurrent-update',
        {
          action: 'upsert_requirement',
          goalId,
          expectedRevision: 1,
          requirementId: 'two',
          requirement: 'Added while confirmation was open',
        },
        undefined,
        undefined,
        harness.ctx,
      );
      return true;
    });

    await harness.commands.get('goal')?.handler('evidence reset', harness.ctx as never);
    const result = (await harness.tools
      .get('get_goal')
      ?.execute('after-cancelled-reset', {}, undefined, undefined, harness.ctx)) as {
      details: { ledger: { revision: number; requirements: unknown[] } };
    };
    expect(result.details.ledger).toMatchObject({ revision: 2 });
    expect(result.details.ledger.requirements).toHaveLength(2);
    expect((harness.ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify).toHaveBeenCalledWith(
      'Goal evidence changed while confirmation was open; reset was cancelled.',
      'warning',
    );
  });

  it('rejects evidence reset for completed goals to preserve the audit record', async () => {
    await createActiveGoal(harness);
    await verifySingleRequirement(harness);
    await harness.tools
      .get('update_goal')
      ?.execute('complete-before-reset', { status: 'complete' }, undefined, undefined, harness.ctx);
    harness.confirm.mockClear();
    const persistedEntries = harness.appendEntry.mock.calls.length;

    await harness.commands.get('goal')?.handler('evidence reset', harness.ctx as never);

    expect(harness.confirm).not.toHaveBeenCalled();
    expect(harness.appendEntry.mock.calls).toHaveLength(persistedEntries);
    expect((harness.ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify).toHaveBeenCalledWith(
      'Evidence can only be reset for an active or paused goal.',
      'warning',
    );
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

  it('combines wall and token limits when the wall timer fires mid-turn', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await emit(harness, 'session_start', { reason: 'startup' });
      await harness.commands
        .get('goal')
        ?.handler('--time 10s --tokens 10 combined limit', harness.ctx as never);
      harness.sendMessage.mockClear();
      (harness.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
      await emit(harness, 'turn_start');
      await vi.advanceTimersByTimeAsync(10_000);
      await emit(harness, 'turn_end', { message: { usage: { totalTokens: 10 } } });

      const limited = harness.appendEntry.mock.calls.at(-1)?.[1] as {
        goal: { status: string; budgetLimitReason: string };
        pendingBudgetSummary: boolean;
      };
      expect(limited.goal).toMatchObject({
        status: 'budget_limited',
        budgetLimitReason: 'tokens_and_wall_time',
      });
      expect(limited.pendingBudgetSummary).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.sendMessage).toHaveBeenCalledOnce();
      const queued = harness.appendEntry.mock.calls.at(-1)?.[1] as {
        pendingBudgetSummary: boolean;
      };
      expect(queued.pendingBudgetSummary).toBe(true);
      await acknowledgeBudgetSummary(harness);
      const delivered = harness.appendEntry.mock.calls.at(-1)?.[1] as {
        pendingBudgetSummary: boolean;
      };
      expect(delivered.pendingBudgetSummary).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-resume an invalid producer-message handoff normalized to wake none', async () => {
    await createActiveGoal(harness);
    acquireGate(harness);

    harness.events.emit(CONTINUATION_GATE_RELEASE_EVENT, {
      releaseId: 'release-invalid-handoff',
      sessionId: 'session-1',
      source: 'producer',
      gateId: 'tests',
      domain: 'autonomous-continuation',
      outcome: 'completed',
      wake: 'producer-message',
      handoffId: 'not-committed',
      releasedAt: Date.now(),
    });
    await Promise.resolve();

    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('queues auto-resume delivery before committing the winning claim', async () => {
    await createActiveGoal(harness);
    acquireGate(harness);
    const order: string[] = [];
    harness.sendMessage.mockImplementation(() => order.push('queue'));
    harness.events.on(CONTINUATION_GATE_RESUME_COMMIT_EVENT, () => order.push('commit'));

    harness.events.emit(CONTINUATION_GATE_RELEASE_EVENT, {
      releaseId: 'release-ordered-auto-resume',
      sessionId: 'session-1',
      source: 'producer',
      gateId: 'tests',
      domain: 'autonomous-continuation',
      outcome: 'completed',
      wake: 'none',
      releasedAt: Date.now(),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(['queue', 'commit']);
  });

  it('aborts a failed auto-resume claim and pauses instead of burning the transition', async () => {
    await createActiveGoal(harness);
    acquireGate(harness);
    harness.sendMessage.mockImplementationOnce(() => {
      throw new Error('auto-resume queue failed');
    });

    harness.events.emit(CONTINUATION_GATE_RELEASE_EVENT, {
      releaseId: 'release-failed-auto-resume',
      sessionId: 'session-1',
      source: 'producer',
      gateId: 'tests',
      domain: 'autonomous-continuation',
      outcome: 'completed',
      wake: 'none',
      releasedAt: Date.now(),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect((harness.ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify).toHaveBeenCalledWith(
      expect.stringContaining('auto-resume queue failed'),
      'error',
    );

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      goal: { status: 'paused', pauseReason: 'delivery_failure' },
    });
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

  it('defers an exhausted restore-idle budget summary until a natural turn', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const restored = {
        ...createGoalState('exhausted idle restore', null, 1_000, () => 'restored-goal', 10),
        activeWallTimeSeconds: 10,
      };
      harness.branch.push({
        type: 'custom',
        customType: 'pi-goal',
        data: { goal: restored, statusBarEnabled: true, restartPolicy: 'restore-idle' },
      });

      await emit(harness, 'session_start', { reason: 'startup' });
      await Promise.resolve();

      expect(harness.sendMessage).not.toHaveBeenCalled();
      expect(harness.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
        goal: { status: 'budget_limited' },
        pendingBudgetSummary: true,
      });

      const beforeStart = harness.handlers.get('before_agent_start')?.[0];
      const injection = beforeStart?.({}, harness.ctx as never);
      expect(injection).toMatchObject({
        message: {
          details: {
            kind: 'budget_limited',
            evidenceSummary: expect.any(Object),
          },
        },
      });
      expect(
        (injection as { message?: { details?: unknown } })?.message?.details,
      ).not.toHaveProperty('ledger');
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers a later restore-idle deadline summary after startup deferral ends', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const restored = createGoalState(
        'idle restore with time remaining',
        null,
        Date.now(),
        () => 'restored-goal',
        10,
      );
      harness.branch.push({
        type: 'custom',
        customType: 'pi-goal',
        data: { goal: restored, statusBarEnabled: true, restartPolicy: 'restore-idle' },
      });

      await emit(harness, 'session_start', { reason: 'startup' });
      await Promise.resolve();
      expect(harness.sendMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.sendMessage).toHaveBeenCalledOnce();
      expect(harness.sendMessage.mock.calls[0]?.[0]).toMatchObject({
        details: { kind: 'budget_limited', goal: { status: 'budget_limited' } },
      });
    } finally {
      vi.useRealTimers();
    }
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
    await Promise.resolve();
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
      await acknowledgeContinuation(harness);
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

  it('clears prior observations on explicit no-progress reset', async () => {
    await createActiveGoal(harness);
    await harness.commands.get('goal')?.handler('no-progress on', harness.ctx as never);
    await emit(harness, 'agent_settled');
    await Promise.resolve();
    await acknowledgeContinuation(harness);
    await emit(harness, 'turn_start');
    await emit(harness, 'turn_end', {
      message: {
        content: [{ type: 'text', text: 'Initial synthetic observation.' }],
        usage: { totalTokens: 1 },
      },
      toolResults: [],
    });
    const observed = harness.appendEntry.mock.calls.at(-1)?.[1] as {
      progress: { observations: unknown[] };
    };
    expect(observed.progress.observations).toHaveLength(1);

    await harness.commands.get('goal')?.handler('no-progress reset', harness.ctx as never);
    const reset = harness.appendEntry.mock.calls.at(-1)?.[1] as {
      progress: { observations: unknown[]; stagnationStreak: number };
    };
    expect(reset.progress).toMatchObject({ observations: [], stagnationStreak: 0 });
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
      await acknowledgeContinuation(harness);
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
      const injected = beforeStart?.({}, harness.ctx as never);
      const pendingAtInjection = harness.appendEntry.mock.calls.at(-1)?.[1] as {
        pendingBudgetSummary: boolean;
      };
      expect(pendingAtInjection.pendingBudgetSummary).toBe(true);
      expect(injected).toMatchObject({
        message: {
          customType: 'pi-goal-event',
          content: expect.stringContaining('budget_limited'),
        },
      });
      await Promise.resolve();
      const stillPending = harness.appendEntry.mock.calls.at(-1)?.[1] as {
        pendingBudgetSummary: boolean;
      };
      expect(stillPending.pendingBudgetSummary).toBe(true);
      await acknowledgeBudgetSummary(
        harness,
        (injected as { message: unknown } | undefined)?.message,
      );
      const delivered = harness.appendEntry.mock.calls.at(-1)?.[1] as {
        pendingBudgetSummary: boolean;
      };
      expect(delivered.pendingBudgetSummary).toBe(false);
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
