import type { StatuslineStatus } from '@aliaksei-raketski/pi-statusline-protocol';
import { formatElapsed, formatTokens, type GoalState } from './goal-state.ts';

export const GOAL_STATUS_KEY = 'goal';
export const GOAL_STATUS_SOURCE = 'pi-goal';

export function collectGoalStatus(
  goal: GoalState | null,
  activeGateCount: number,
): StatuslineStatus | undefined {
  if (!goal) return undefined;

  if (goal.status === 'active' && activeGateCount > 0) {
    return {
      key: GOAL_STATUS_KEY,
      text: `goal waiting (${activeGateCount})`,
      state: 'waiting',
      fallbackColor: 'warning',
    };
  }

  const usage =
    goal.tokenBudget === null
      ? formatElapsed(goal.timeUsedSeconds)
      : `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`;

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
        text: 'goal paused',
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

function assertNever(value: never): never {
  throw new Error(`Unknown goal status: ${String(value)}`);
}
