import type {
  GoalBudgetLimitReason,
  GoalPauseReason,
  GoalState,
  GoalStatus,
} from './goal-types.ts';

const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

export function activeWallTimeAt(goal: GoalState, now: number): number {
  if (goal.status !== 'active' || goal.activeSince === null) return goal.activeWallTimeSeconds;
  return Math.min(
    MAX_COUNTER,
    goal.activeWallTimeSeconds + Math.max(0, boundedCounter(now) - goal.activeSince) / 1_000,
  );
}

export function startActiveClock(goal: GoalState, now: number): GoalState {
  if (goal.status !== 'active' || goal.activeSince !== null) return goal;
  const timestamp = boundedCounter(now);
  return { ...goal, activeSince: timestamp, updatedAt: timestamp };
}

export function checkpointActiveClock(goal: GoalState, now: number): GoalState {
  if (goal.activeSince === null) return goal;
  return {
    ...goal,
    activeWallTimeSeconds: activeWallTimeAt(goal, now),
    activeSince: null,
    updatedAt: boundedCounter(now),
  };
}

export function remainingWallTime(goal: GoalState, now: number): number | null {
  return goal.wallTimeBudgetSeconds === null
    ? null
    : Math.max(0, goal.wallTimeBudgetSeconds - activeWallTimeAt(goal, now));
}

export function evaluateBudgetLimit(goal: GoalState, now: number): GoalBudgetLimitReason {
  if (goal.status !== 'active' && goal.status !== 'budget_limited') return null;
  const tokens = goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget;
  const wallTime =
    goal.wallTimeBudgetSeconds !== null &&
    activeWallTimeAt(goal, now) >= goal.wallTimeBudgetSeconds;
  if (tokens && wallTime) return 'tokens_and_wall_time';
  if (tokens) return 'tokens';
  if (wallTime) return 'wall_time';
  return null;
}

export interface GoalTransitionOptions {
  pauseReason?: GoalPauseReason;
  budgetLimitReason?: GoalBudgetLimitReason;
}

/** Applies every lifecycle clock transition in one place. */
export function transitionGoal(
  goal: GoalState,
  status: GoalStatus,
  now: number,
  options: GoalTransitionOptions = {},
): GoalState {
  let next =
    goal.status === 'active' && status !== 'active' ? checkpointActiveClock(goal, now) : goal;
  next = {
    ...next,
    status,
    pauseReason: status === 'paused' ? (options.pauseReason ?? next.pauseReason ?? 'user') : null,
    budgetLimitReason:
      status === 'budget_limited' ? (options.budgetLimitReason ?? next.budgetLimitReason) : null,
    updatedAt: boundedCounter(now),
  };
  return status === 'active' ? startActiveClock({ ...next, activeSince: null }, now) : next;
}

/** Checkpoints and immediately restarts an active interval at the same instant. */
export function checkpointAndRestartActiveClock(goal: GoalState, now: number): GoalState {
  if (goal.status !== 'active') return goal;
  return startActiveClock(checkpointActiveClock(goal, now), now);
}

function boundedCounter(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_COUNTER, value);
}
