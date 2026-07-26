import type { StatuslineStatus } from '@aliaksei-raketski/pi-statusline-protocol';
import { activeWallTimeAt, remainingWallTime } from './goal-clock.ts';
import { formatElapsed, formatTokens, type GoalState } from './goal-state.ts';

export const GOAL_STATUS_KEY = 'goal';
export const GOAL_STATUS_SOURCE = 'pi-goal';

export function collectGoalStatus(
  goal: GoalState | null,
  activeGateCount: number,
  now = Date.now(),
): StatuslineStatus | undefined {
  if (!goal) return undefined;
  const usage = compactUsage(goal, now);

  if (goal.status === 'active' && activeGateCount > 0) {
    return {
      key: GOAL_STATUS_KEY,
      text: `goal waiting (${activeGateCount}) ${usage}`,
      state: 'waiting',
      fallbackColor: 'warning',
    };
  }

  switch (goal.status) {
    case 'active':
      return {
        key: GOAL_STATUS_KEY,
        text: `goal ${usage}`,
        state: 'active',
        fallbackColor: 'accent',
      };
    case 'paused':
      return {
        key: GOAL_STATUS_KEY,
        text: goal.pauseReason === 'no_progress' ? 'goal paused (no progress)' : 'goal paused',
        state: 'paused',
        fallbackColor: 'muted',
      };
    case 'complete':
      return {
        key: GOAL_STATUS_KEY,
        text: 'goal achieved',
        state: 'complete',
        fallbackColor: 'success',
      };
    case 'budget_limited':
      return {
        key: GOAL_STATUS_KEY,
        text: `goal unmet ${usage}`,
        state: 'budget_limited',
        fallbackColor: 'error',
      };
    default:
      return assertNever(goal.status);
  }
}

function compactUsage(goal: GoalState, now: number): string {
  const tokens =
    goal.tokenBudget === null
      ? formatTokens(goal.tokensUsed)
      : `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`;
  const wallRemaining = remainingWallTime(goal, now);
  const wall =
    goal.wallTimeBudgetSeconds === null
      ? formatElapsed(activeWallTimeAt(goal, now))
      : `${formatElapsed(wallRemaining ?? 0)} left`;
  return `${tokens} · ${wall}`;
}

function assertNever(value: never): never {
  throw new Error(`Unknown goal status: ${String(value)}`);
}
