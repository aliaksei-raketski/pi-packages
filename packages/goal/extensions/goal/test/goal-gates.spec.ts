import {
  CONTINUATION_GATE_ACQUIRE_EVENT,
  CONTINUATION_GATE_RELEASE_EVENT,
  createContinuationGateRegistry,
  type ContinuationGate,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { describe, expect, it } from 'vitest';
import { isContinuationEligible } from '../src/goal-runtime.ts';
import { createGoalState } from '../src/goal-state.ts';

class EventBus {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  on(eventName: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.handlers.get(eventName) ?? new Set();
    handlers.add(handler);
    this.handlers.set(eventName, handlers);
    return () => handlers.delete(handler);
  }

  emit(eventName: string, payload: unknown): void {
    for (const handler of this.handlers.get(eventName) ?? []) handler(payload);
  }
}

const active = createGoalState('ship', null, 1, () => 'goal-1');
const gate = (gateId: string, sessionId = 'session-1'): ContinuationGate => ({
  protocolVersion: 1,
  sessionId,
  source: 'producer',
  gateId,
  reason: 'background work',
  acquiredAt: 10,
});

function eligible(activeGates: readonly ContinuationGate[], hasPendingMessages = false): boolean {
  return isContinuationEligible({
    goal: active,
    sessionId: 'session-1',
    hasPendingMessages,
    isIdle: true,
    continuationQueued: false,
    activeGates,
  });
}

describe('goal and continuation-gate coexistence', () => {
  it('waits through producer completion and resumes only after its result turn settles', () => {
    const events = new EventBus();
    const registry = createContinuationGateRegistry({ events });
    events.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate('tests'));
    expect(eligible(registry.list('session-1'))).toBe(false);

    // The producer queues its completion follow-up before release.
    events.emit(CONTINUATION_GATE_RELEASE_EVENT, {
      protocolVersion: 1,
      sessionId: 'session-1',
      source: 'producer',
      gateId: 'tests',
      outcome: 'completed',
      wake: 'producer-message',
      releasedAt: 20,
    });
    expect(eligible(registry.list('session-1'), true)).toBe(false);

    // After the producer message runs and Pi settles, goal continuation is eligible.
    expect(eligible(registry.list('session-1'))).toBe(true);
    registry.dispose();
  });

  it('requires all same-session gates to clear and ignores gates from other sessions', () => {
    const events = new EventBus();
    const registry = createContinuationGateRegistry({ events });
    events.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate('one'));
    events.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate('two'));
    events.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate('other', 'session-2'));
    expect(registry.list('session-1')).toHaveLength(2);
    expect(eligible(registry.list('session-1'))).toBe(false);

    events.emit(CONTINUATION_GATE_RELEASE_EVENT, {
      protocolVersion: 1,
      sessionId: 'session-1',
      source: 'producer',
      gateId: 'one',
      outcome: 'completed',
      wake: 'producer-message',
      releasedAt: 20,
    });
    expect(eligible(registry.list('session-1'))).toBe(false);
    expect(registry.list('session-2')).toHaveLength(1);
    registry.dispose();
  });
});
