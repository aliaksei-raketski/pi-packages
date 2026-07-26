import type {
  ContinuationGate,
  ContinuationGateRegistry,
  ContinuationGateResumeClaim,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { remainingWallTime } from './goal-clock.ts';
import type { GoalEvidenceLedger } from './goal-evidence.ts';
import type { GoalProgressState } from './goal-progress.ts';
import type { GoalRestartPolicy, GoalState } from './goal-state.ts';

export type GoalTurnOrigin = 'synthetic' | 'manual' | 'resume' | 'restart' | 'other';
export interface GoalTimer {
  unref?: () => void;
}
export interface GoalScheduler {
  setTimeout(callback: () => void, delayMs: number): GoalTimer;
  clearTimeout(timer: GoalTimer): void;
}

export interface GoalRuntime {
  goal: GoalState | null;
  ledger: GoalEvidenceLedger | null;
  progress: GoalProgressState | null;
  statusBarEnabled: boolean;
  restartPolicy: GoalRestartPolicy;
  noProgressEnabled: boolean;
  pendingBudgetSummary: boolean;
  restartContinuationPending: boolean;
  activeTurnStartedAt: number | null;
  activeGoalThisTurnId: string | null;
  activeTurnOrigin: GoalTurnOrigin;
  pendingTurnOrigin: GoalTurnOrigin;
  continuationGeneration: number;
  continuationQueued: boolean;
  sessionId: string | null;
  gateRegistry: ContinuationGateRegistry;
  activeResumeClaim?: ContinuationGateResumeClaim;
  deadlineTimer?: GoalTimer;
  deadlineGeneration: number;
  now: () => number;
  scheduler: GoalScheduler;
  clearStatusProvider?: () => void;
  statusContext: ExtensionContext | null;
  disposed: boolean;
}

export interface ContinuationDecisionInput {
  goal: GoalState | null;
  sessionId: string;
  hasPendingMessages: boolean;
  isIdle: boolean;
  continuationQueued: boolean;
  activeGates: readonly ContinuationGate[];
}

export interface ContinuationCapture {
  goalId: string;
  sessionId: string;
  generation: number;
}

export interface GoalRuntimeOptions {
  now?: () => number;
  scheduler?: GoalScheduler;
}

const defaultScheduler: GoalScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as GoalTimer,
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function createGoalRuntime(
  gateRegistry: ContinuationGateRegistry,
  options: GoalRuntimeOptions = {},
): GoalRuntime {
  return {
    goal: null,
    ledger: null,
    progress: null,
    statusBarEnabled: true,
    restartPolicy: 'pause',
    noProgressEnabled: false,
    pendingBudgetSummary: false,
    restartContinuationPending: false,
    activeTurnStartedAt: null,
    activeGoalThisTurnId: null,
    activeTurnOrigin: 'other',
    pendingTurnOrigin: 'other',
    continuationGeneration: 0,
    continuationQueued: false,
    sessionId: null,
    gateRegistry,
    deadlineGeneration: 0,
    now: options.now ?? (() => Date.now()),
    scheduler: options.scheduler ?? defaultScheduler,
    statusContext: null,
    disposed: false,
  };
}

export function isContinuationEligible(input: ContinuationDecisionInput): boolean {
  return (
    input.goal?.status === 'active' &&
    input.sessionId.length > 0 &&
    input.isIdle &&
    !input.hasPendingMessages &&
    !input.continuationQueued &&
    input.activeGates.length === 0
  );
}

export function invalidateContinuation(runtime: GoalRuntime): void {
  runtime.continuationGeneration += 1;
  runtime.continuationQueued = false;
  runtime.pendingTurnOrigin = 'other';
  if (runtime.activeResumeClaim) {
    runtime.gateRegistry.abortAutoResume(runtime.activeResumeClaim);
    runtime.activeResumeClaim = undefined;
  }
}

export function captureContinuation(runtime: GoalRuntime): ContinuationCapture | undefined {
  if (!runtime.goal || !runtime.sessionId) return undefined;
  return {
    goalId: runtime.goal.id,
    sessionId: runtime.sessionId,
    generation: runtime.continuationGeneration,
  };
}

export function continuationCaptureIsCurrent(
  runtime: GoalRuntime,
  capture: ContinuationCapture,
): boolean {
  return (
    !runtime.disposed &&
    runtime.goal?.id === capture.goalId &&
    runtime.goal.status === 'active' &&
    runtime.sessionId === capture.sessionId &&
    runtime.continuationGeneration === capture.generation
  );
}

export function cancelGoalDeadline(runtime: GoalRuntime): void {
  runtime.deadlineGeneration += 1;
  if (runtime.deadlineTimer) runtime.scheduler.clearTimeout(runtime.deadlineTimer);
  runtime.deadlineTimer = undefined;
}

export function scheduleGoalDeadline(runtime: GoalRuntime, onDue: () => void): void {
  cancelGoalDeadline(runtime);
  const goal = runtime.goal;
  const sessionId = runtime.sessionId;
  if (!goal || goal.status !== 'active' || !sessionId || goal.wallTimeBudgetSeconds === null)
    return;
  const remaining = remainingWallTime(goal, runtime.now());
  if (remaining === null) return;
  const goalId = goal.id;
  const generation = runtime.deadlineGeneration;
  runtime.deadlineTimer = runtime.scheduler.setTimeout(
    () => {
      runtime.deadlineTimer = undefined;
      if (
        runtime.disposed ||
        runtime.deadlineGeneration !== generation ||
        runtime.goal?.id !== goalId ||
        runtime.goal.status !== 'active' ||
        runtime.sessionId !== sessionId
      )
        return;
      onDue();
    },
    Math.min(2_147_483_647, Math.max(0, remaining * 1_000)),
  );
  runtime.deadlineTimer.unref?.();
}

export function gateIdentity(gate: ContinuationGate): string {
  return `${gate.sessionId}\u0000${gate.source}\u0000${gate.gateId}\u0000${gate.domain}\u0000${gate.acquiredAt}\u0000${gate.updatedAt}`;
}

export function allGatesWereConfirmed(
  liveGates: readonly ContinuationGate[],
  confirmedGates: readonly ContinuationGate[],
): boolean {
  const confirmed = new Set(confirmedGates.map(gateIdentity));
  return liveGates.every((gate) => confirmed.has(gateIdentity(gate)));
}
