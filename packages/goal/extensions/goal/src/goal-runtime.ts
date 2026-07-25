import type {
  ContinuationGate,
  ContinuationGateRegistry,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { GoalState } from './goal-state.ts';

export interface GoalRuntime {
  goal: GoalState | null;
  statusBarEnabled: boolean;
  activeTurnStartedAt: number | null;
  activeGoalThisTurnId: string | null;
  continuationGeneration: number;
  continuationQueued: boolean;
  sessionId: string | null;
  gateRegistry: ContinuationGateRegistry;
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

export function createGoalRuntime(gateRegistry: ContinuationGateRegistry): GoalRuntime {
  return {
    goal: null,
    statusBarEnabled: true,
    activeTurnStartedAt: null,
    activeGoalThisTurnId: null,
    continuationGeneration: 0,
    continuationQueued: false,
    sessionId: null,
    gateRegistry,
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

export function gateIdentity(gate: ContinuationGate): string {
  return `${gate.sessionId}\u0000${gate.source}\u0000${gate.gateId}`;
}

export function allGatesWereConfirmed(
  liveGates: readonly ContinuationGate[],
  confirmedGates: readonly ContinuationGate[],
): boolean {
  const confirmed = new Set(confirmedGates.map(gateIdentity));
  return liveGates.every((gate) => confirmed.has(gateIdentity(gate)));
}
