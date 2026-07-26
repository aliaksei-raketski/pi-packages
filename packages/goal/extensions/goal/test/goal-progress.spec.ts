import { describe, expect, it } from 'vitest';
import {
  fingerprintSimilarity,
  GOAL_PROGRESS_WINDOW,
  GOAL_STAGNATION_THRESHOLD,
  normalizeSummary,
  observeGoalProgress,
  parseGoalProgressState,
  resetGoalProgress,
  simHash64,
  type GoalProgressState,
} from '../src/goal-progress.ts';

const input = (overrides: Partial<Parameters<typeof observeGoalProgress>[1]> = {}) => ({
  goalId: 'goal-1',
  observedAt: 1,
  assistantText: 'Inspected the same files and found no new direct evidence.',
  tools: [{ name: 'read', isError: false }],
  evidenceRevision: 1,
  ...overrides,
});

describe('goal no-progress observations', () => {
  it('pauses only after the conservative consecutive threshold', () => {
    let state: GoalProgressState | null = null;
    for (let index = 0; index < GOAL_STAGNATION_THRESHOLD; index += 1) {
      const result = observeGoalProgress(state, input({ observedAt: index + 1 }));
      state = result.state;
      expect(result.shouldPause).toBe(false);
    }
    const repeated = observeGoalProgress(state, input({ observedAt: 10 }));
    expect(repeated.shouldPause).toBe(true);
    expect(repeated.state.stagnationStreak).toBe(GOAL_STAGNATION_THRESHOLD);
  });

  it('recognizes near duplicates but resets for changed tools or evidence revision', () => {
    const first = observeGoalProgress(
      null,
      input({
        assistantText:
          'Inspected the same files and found no new direct evidence at 2025-01-01T00:00:00Z.',
      }),
    );
    const near = observeGoalProgress(
      first.state,
      input({
        observedAt: 2,
        assistantText:
          'Inspected the same files and found no new direct evidence at 2026-07-26T10:30:00Z.',
      }),
    );
    const firstFingerprint = first.state.observations.at(0)?.summaryFingerprint ?? '';
    const nearFingerprint = near.state.observations.at(1)?.summaryFingerprint ?? '';
    expect(fingerprintSimilarity(firstFingerprint, nearFingerprint)).toBeGreaterThanOrEqual(0.9);
    expect(near.state.stagnationStreak).toBe(1);

    const changedTool = observeGoalProgress(
      near.state,
      input({ observedAt: 3, tools: [{ name: 'bash', isError: false }] }),
    );
    expect(changedTool.state.stagnationStreak).toBe(0);
    const changedLedger = observeGoalProgress(
      near.state,
      input({ observedAt: 3, evidenceRevision: 2 }),
    );
    expect(changedLedger.state.stagnationStreak).toBe(0);
  });

  it('normalizes volatile IDs without retaining source text and bounds storage', () => {
    expect(normalizeSummary('Run 123 at 2026-07-26T10:30:00Z ID deadbeefcafebabe').tokens).toEqual([
      'run',
      '<n>',
      'at',
      '<time>',
      'id',
      '<id>',
    ]);
    let state: GoalProgressState | null = null;
    for (let index = 0; index < 20; index += 1)
      state = observeGoalProgress(state, input({ observedAt: index })).state;
    expect(state?.observations).toHaveLength(GOAL_PROGRESS_WINDOW);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('Inspected the same files');
    expect(serialized).not.toContain('read:success');
    expect(serialized).toMatch(/summaryFingerprint/);
  });

  it('parses only bounded fingerprints and resume reset keeps diagnostic history', () => {
    const state = observeGoalProgress(null, input()).state;
    expect(parseGoalProgressState(state, 'goal-1')).toEqual(state);
    expect(parseGoalProgressState({ ...state, rawAssistantText: 'secret' }, 'goal-1')).toEqual(
      state,
    );
    expect(
      parseGoalProgressState(
        { ...state, observations: [{ ...state.observations[0], summaryFingerprint: 'raw text' }] },
        'goal-1',
      ),
    ).toBeNull();
    const reset = resetGoalProgress({ ...state, stagnationStreak: 2, pausedAt: 5 }, 10);
    expect(reset.stagnationStreak).toBe(0);
    expect(reset.observations).toEqual(state.observations);
    expect(reset.pausedAt).toBeUndefined();
  });

  it('produces deterministic similarity-friendly fingerprints', () => {
    const tokens = normalizeSummary('repeat this summary').tokens;
    expect(simHash64(tokens)).toBe(simHash64(tokens));
    expect(simHash64(tokens)).toMatch(/^[0-9a-f]{16}$/);
  });
});
