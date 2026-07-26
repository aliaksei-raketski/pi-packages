import type { ContinuationGateRegistry } from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  activeWallTimeAt,
  checkpointAndRestartActiveClock,
  checkpointActiveClock,
  evaluateBudgetLimit,
  remainingWallTime,
  transitionGoal,
} from '../src/goal-clock.ts';
import {
  cancelGoalDeadline,
  createGoalRuntime,
  scheduleGoalDeadline,
  type GoalTimer,
} from '../src/goal-runtime.ts';
import { createGoalState } from '../src/goal-state.ts';

const registry = {
  list: () => [],
  listStale: () => [],
  leaseState: () => 'none' as const,
  isBlocked: () => false,
  requestSnapshot: () => 'request',
  claimAutoResume: () => undefined,
  commitAutoResume: () => false,
  abortAutoResume: () => false,
  diagnostics: () => [],
  clear: () => undefined,
  dispose: () => undefined,
} satisfies ContinuationGateRegistry;

describe('goal active wall clock', () => {
  it('accrues while active, including gate waits, but not while paused', () => {
    const active = createGoalState('ship', null, 0, () => 'goal-1', 60);
    expect(activeWallTimeAt(active, 10_000)).toBe(10);
    expect(remainingWallTime(active, 10_000)).toBe(50);
    const paused = transitionGoal(active, 'paused', 10_000, { pauseReason: 'user' });
    expect(activeWallTimeAt(paused, 20_000)).toBe(10);
    const resumed = transitionGoal(paused, 'active', 20_000);
    expect(activeWallTimeAt(resumed, 25_000)).toBe(15);
  });

  it('checkpoints normal persistence and clamps clock rollback', () => {
    const active = createGoalState('ship', null, 10_000, () => 'goal-1', 60);
    const rolledBack = checkpointActiveClock(active, 5_000);
    expect(rolledBack.activeWallTimeSeconds).toBe(0);
    const checkpointed = checkpointAndRestartActiveClock(active, 15_000);
    expect(checkpointed).toMatchObject({ activeWallTimeSeconds: 5, activeSince: 15_000 });
  });

  it('reports token, wall-time, and simultaneous budget limits', () => {
    const active = createGoalState('ship', 10, 0, () => 'goal-1', 10);
    expect(evaluateBudgetLimit({ ...active, tokensUsed: 10 }, 5_000)).toBe('tokens');
    expect(evaluateBudgetLimit(active, 10_000)).toBe('wall_time');
    expect(evaluateBudgetLimit({ ...active, tokensUsed: 10 }, 10_000)).toBe('tokens_and_wall_time');
  });

  it('schedules one guarded deadline and cancels it', () => {
    let now = 0;
    let callback: (() => void) | undefined;
    const delays: number[] = [];
    const clear = vi.fn();
    const timer: GoalTimer = { unref: vi.fn() };
    const runtime = createGoalRuntime(registry, {
      now: () => now,
      scheduler: {
        setTimeout: (next, delay) => {
          callback = next;
          delays.push(delay);
          return timer;
        },
        clearTimeout: clear,
      },
    });
    runtime.sessionId = 'session-1';
    runtime.goal = createGoalState('ship', null, 0, () => 'goal-1', 10);
    const due = vi.fn();
    scheduleGoalDeadline(runtime, due);
    expect(delays).toEqual([10_000]);
    expect(timer.unref).toHaveBeenCalledOnce();
    cancelGoalDeadline(runtime);
    callback?.();
    expect(clear).toHaveBeenCalledWith(timer);
    expect(due).not.toHaveBeenCalled();

    now = 1;
    scheduleGoalDeadline(runtime, due);
    expect(delays).toEqual([10_000, 9_999]);
    runtime.goal = createGoalState('replacement', null, 1, () => 'goal-2', 10);
    callback?.();
    expect(due).not.toHaveBeenCalled();
  });
});
