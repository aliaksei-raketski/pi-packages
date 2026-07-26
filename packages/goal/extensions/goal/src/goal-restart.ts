import { checkpointActiveClock, startActiveClock, transitionGoal } from './goal-clock.ts';
import type { GoalRestartPolicy, GoalState } from './goal-state.ts';

export interface GoalRestartResult {
  goal: GoalState;
  queueContinuation: boolean;
  notification: string;
}

/**
 * Restores an active interval without charging process downtime. The persisted
 * activeSince is a checkpoint marker only; its unpersisted crash tail is
 * conservatively omitted.
 */
export function applyRestartPolicy(
  goal: GoalState,
  policy: GoalRestartPolicy,
  now: number,
): GoalRestartResult {
  const offlineSafe = {
    ...checkpointActiveClock(goal, goal.activeSince ?? now),
    activeSince: null,
  };
  if (policy === 'pause') {
    return {
      goal: transitionGoal(offlineSafe, 'paused', now, { pauseReason: 'reload' }),
      queueContinuation: false,
      notification: 'Goal paused after restart. Use /goal resume to continue.',
    };
  }
  const active = startActiveClock({ ...offlineSafe, status: 'active', pauseReason: null }, now);
  return {
    goal: active,
    queueContinuation: policy === 'resume',
    notification:
      policy === 'resume'
        ? 'Goal restored and will resume when idle and unblocked.'
        : 'Goal restored active without starting a turn.',
  };
}

export function restoreActiveWithoutOfflineGap(goal: GoalState, now: number): GoalState {
  if (goal.status !== 'active') return { ...goal, activeSince: null };
  const offlineSafe = { ...goal, activeSince: null };
  return startActiveClock(offlineSafe, now);
}
