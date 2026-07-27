import type { GoalEvidenceLedger } from './goal-evidence.ts';
import type { GoalProgressState } from './goal-progress.ts';

export type GoalStatus = 'active' | 'paused' | 'budget_limited' | 'complete';
export type GoalPauseReason = 'user' | 'reload' | 'no_progress' | 'delivery_failure' | null;
export type GoalBudgetLimitReason = 'tokens' | 'wall_time' | 'tokens_and_wall_time' | null;
export type GoalRestartPolicy = 'pause' | 'restore-idle' | 'resume';

export interface GoalState {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  wallTimeBudgetSeconds: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  activeWallTimeSeconds: number;
  activeSince: number | null;
  pauseReason: GoalPauseReason;
  budgetLimitReason: GoalBudgetLimitReason;
  createdAt: number;
  updatedAt: number;
}

export interface GoalPersistedState {
  goal: GoalState | null;
  ledger: GoalEvidenceLedger | null;
  progress: GoalProgressState | null;
  statusBarEnabled: boolean;
  restartPolicy: GoalRestartPolicy;
  noProgressEnabled: boolean;
  pendingBudgetSummary: boolean;
}

export type GoalEventKind =
  | 'active'
  | 'continuation'
  | 'paused'
  | 'resumed'
  | 'cleared'
  | 'budget_limited'
  | 'complete';
