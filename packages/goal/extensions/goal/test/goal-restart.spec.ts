import { describe, expect, it } from 'vitest';
import { activeWallTimeAt } from '../src/goal-clock.ts';
import { applyRestartPolicy, restoreActiveWithoutOfflineGap } from '../src/goal-restart.ts';
import { createGoalState } from '../src/goal-state.ts';

const persistedActive = () => ({
  ...createGoalState('ship', null, 1_000, () => 'goal-1', 60),
  activeWallTimeSeconds: 12,
  activeSince: 5_000,
  updatedAt: 5_000,
});

describe('goal restart policy', () => {
  it('defaults to a reload pause without charging offline time', () => {
    const result = applyRestartPolicy(persistedActive(), 'pause', 100_000);
    expect(result.goal).toMatchObject({
      status: 'paused',
      pauseReason: 'reload',
      activeWallTimeSeconds: 12,
      activeSince: null,
    });
    expect(result.queueContinuation).toBe(false);
  });

  it('restore-idle starts the clock but requests no startup turn', () => {
    const result = applyRestartPolicy(persistedActive(), 'restore-idle', 100_000);
    expect(result.goal).toMatchObject({ status: 'active', activeSince: 100_000 });
    expect(activeWallTimeAt(result.goal, 105_000)).toBe(17);
    expect(result.queueContinuation).toBe(false);
  });

  it('resume requests one guarded continuation and excludes the offline gap', () => {
    const result = applyRestartPolicy(persistedActive(), 'resume', 100_000);
    expect(result.goal.activeWallTimeSeconds).toBe(12);
    expect(result.goal.activeSince).toBe(100_000);
    expect(result.queueContinuation).toBe(true);
  });

  it('tree and explicit session restoration also close stale intervals', () => {
    const restored = restoreActiveWithoutOfflineGap(persistedActive(), 100_000);
    expect(restored.activeWallTimeSeconds).toBe(12);
    expect(restored.activeSince).toBe(100_000);
  });
});
