import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { GoalRuntime } from './goal-runtime-core.ts';
import {
  createPersistedState,
  GOAL_STATE_CUSTOM_TYPE,
  restoreGoalState,
  type GoalPersistedState,
} from './goal-state.ts';

export function persistedStateFromRuntime(runtime: GoalRuntime): GoalPersistedState {
  return createPersistedState(
    runtime.goal,
    runtime.ledger,
    runtime.progress,
    runtime.statusBarEnabled,
    runtime.restartPolicy,
    runtime.noProgressEnabled,
    runtime.pendingBudgetSummary,
  );
}

export function appendGoalRuntimeState(pi: ExtensionAPI, runtime: GoalRuntime): void {
  pi.appendEntry(GOAL_STATE_CUSTOM_TYPE, persistedStateFromRuntime(runtime));
}

export function restoreGoalRuntimeState(
  runtime: GoalRuntime,
  entries: Iterable<unknown>,
): GoalPersistedState {
  const restored = restoreGoalState(entries);
  runtime.goal = restored.goal;
  runtime.ledger = restored.ledger;
  runtime.progress = restored.progress;
  runtime.statusBarEnabled = restored.statusBarEnabled;
  runtime.restartPolicy = restored.restartPolicy;
  runtime.noProgressEnabled = restored.noProgressEnabled;
  runtime.pendingBudgetSummary = restored.pendingBudgetSummary;
  return restored;
}
