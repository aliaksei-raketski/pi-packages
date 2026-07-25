import type {
  ContinuationGate,
  ContinuationGateRegistry,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { describe, expect, it } from 'vitest';
import {
  allGatesWereConfirmed,
  captureContinuation,
  continuationCaptureIsCurrent,
  createGoalRuntime,
  invalidateContinuation,
  isContinuationEligible,
} from '../src/goal-runtime.ts';
import { createGoalState } from '../src/goal-state.ts';

const gate = (gateId: string): ContinuationGate => ({
  protocolVersion: 1,
  sessionId: 'session-1',
  source: 'producer',
  gateId,
  reason: 'waiting for tests',
  acquiredAt: 10,
});

const registry = {
  list: () => [],
  isBlocked: () => false,
  requestSnapshot: () => 'request',
  clear: () => undefined,
  dispose: () => undefined,
} satisfies ContinuationGateRegistry;

describe('goal runtime', () => {
  it('requires an active idle unblocked goal with no pending or queued work', () => {
    const active = createGoalState('ship', null, 1, () => 'goal-1');
    expect(
      isContinuationEligible({
        goal: active,
        sessionId: 'session-1',
        isIdle: true,
        hasPendingMessages: false,
        continuationQueued: false,
        activeGates: [],
      }),
    ).toBe(true);
    expect(
      isContinuationEligible({
        goal: active,
        sessionId: 'session-1',
        isIdle: true,
        hasPendingMessages: false,
        continuationQueued: false,
        activeGates: [gate('one')],
      }),
    ).toBe(false);
  });

  it('invalidates captures when goal, session, or generation changes', () => {
    const runtime = createGoalRuntime(registry);
    runtime.goal = createGoalState('ship', null, 1, () => 'goal-1');
    runtime.sessionId = 'session-1';
    const capture = captureContinuation(runtime);
    expect(capture && continuationCaptureIsCurrent(runtime, capture)).toBe(true);
    invalidateContinuation(runtime);
    expect(capture && continuationCaptureIsCurrent(runtime, capture)).toBe(false);
  });

  it('requires every live gate acquisition to have been explicitly confirmed', () => {
    expect(allGatesWereConfirmed([gate('one')], [gate('one')])).toBe(true);
    expect(allGatesWereConfirmed([gate('one'), gate('two')], [gate('one')])).toBe(false);
    expect(allGatesWereConfirmed([{ ...gate('one'), acquiredAt: 11 }], [gate('one')])).toBe(false);
  });
});
