import { describe, expect, it } from 'vitest';
import { budgetLimitPrompt, continuationPrompt } from '../src/goal-prompt.ts';
import { createGoalState } from '../src/goal-state.ts';

const state = {
  ...createGoalState('finish migration and verify tests', 50_000, 10, () => 'goal-1'),
  tokensUsed: 12_000,
  timeUsedSeconds: 90,
};

describe('goal prompts', () => {
  it('keeps the deterministic completion contract', () => {
    const prompt = continuationPrompt(state, { now: 10 });
    for (const phrase of [
      '<untrusted_objective>',
      'Tokens remaining: 38000',
      'strict evidence-based completion audit',
      'prompt-to-artifact checklist',
      'proxy evidence',
      "update_goal({ status: 'complete' })",
      'Do not repeat completed work',
      'Do not claim completion because a budget is nearly exhausted',
      'Active wall time:',
      'Evidence ledger for goal goal-1:',
      'every ledger requirement is verified with evidence',
    ]) {
      expect(prompt).toContain(phrase);
    }
  });

  it('asks for a concise non-substantive budget summary', () => {
    const prompt = budgetLimitPrompt(state);
    expect(prompt).toContain('Do not begin new substantive work');
    expect(prompt).toContain('remaining requirements or blockers');
    expect(prompt).toContain('Evidence ledger for goal goal-1:');
    expect(prompt).toContain('<untrusted_objective>');
  });
});
