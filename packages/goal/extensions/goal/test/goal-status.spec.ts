import type { ContinuationGate } from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { describe, expect, it } from 'vitest';
import { formatGates } from '../src/goal-command.ts';
import { createGoalState } from '../src/goal-state.ts';
import { collectGoalStatus } from '../src/goal-status.ts';

const active = {
  ...createGoalState('ship', 50_000, 1, () => 'goal-1'),
  tokensUsed: 12_300,
};

const gate: ContinuationGate = {
  sessionId: 'session-1',
  source: 'tmux',
  gateId: 'tests',
  domain: 'autonomous-continuation',
  reason: 'test process is running',
  acquiredAt: 1_000,
  updatedAt: 1_000,
  resource: { kind: 'process', id: 'pane-1', label: 'unit tests' },
};

describe('goal status and diagnostics', () => {
  it('maps lifecycle and waiting states to stable payloads', () => {
    expect(collectGoalStatus(active, 0)).toEqual({
      key: 'goal',
      text: 'goal 12.3K/50K',
      state: 'active',
      fallbackColor: 'accent',
    });
    expect(collectGoalStatus(active, 2)).toMatchObject({
      text: 'goal waiting (2)',
      state: 'waiting',
      fallbackColor: 'warning',
    });
    expect(collectGoalStatus({ ...active, status: 'paused' }, 0)).toMatchObject({
      text: 'goal paused',
      state: 'paused',
    });
    expect(collectGoalStatus({ ...active, status: 'complete' }, 0)).toMatchObject({
      text: 'goal achieved',
      state: 'complete',
    });
    expect(collectGoalStatus({ ...active, status: 'budget_limited' }, 0)).toMatchObject({
      text: 'goal unmet 12.3K/50K',
      state: 'budget_limited',
    });
  });

  it('reports an empty gate state and full gate diagnostics', () => {
    expect(formatGates([])).toBe('No active continuation gates.');
    expect(formatGates([gate], 31_000)).toContain(
      'tmux/tests: test process is running; age=30s; resource=process:pane-1 (unit tests)',
    );
  });
});
