import {
  createContinuationGateController,
  createContinuationGateRegistry,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { describe, expect, it } from 'vitest';

class EventBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();

  on(name: string, handler: (payload: unknown) => void) {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }

  emit(name: string, payload: unknown) {
    for (const handler of this.handlers.get(name) ?? []) handler(payload);
  }
}

describe('goal coexistence contract', () => {
  it('suppresses synthetic continuation until every tmux completion result settles', () => {
    const events = new EventBus();
    const controller = createContinuationGateController({ events }, { source: 'pi-tmux-bash' });
    const registry = createContinuationGateRegistry({ events });
    const sent: string[] = [];
    const settleGoal = () => {
      if (!registry.isBlocked('session')) sent.push('goal-continuation');
    };

    for (const gateId of ['tmux:first', 'tmux:second']) {
      controller.acquire({
        sessionId: 'session',
        gateId,
        reason: `Waiting for ${gateId}`,
        resource: { kind: 'tmux-command', id: gateId },
      });
    }
    settleGoal();
    expect(sent).toEqual([]);

    sent.push('first-completion');
    controller.release({
      sessionId: 'session',
      gateId: 'tmux:first',
      outcome: 'completed',
      wake: 'producer-message',
    });
    settleGoal();
    expect(sent).toEqual(['first-completion']);

    sent.push('second-completion');
    controller.release({
      sessionId: 'session',
      gateId: 'tmux:second',
      outcome: 'completed',
      wake: 'producer-message',
    });
    settleGoal();
    expect(sent).toEqual(['first-completion', 'second-completion', 'goal-continuation']);

    registry.dispose();
    controller.dispose();
  });
});
