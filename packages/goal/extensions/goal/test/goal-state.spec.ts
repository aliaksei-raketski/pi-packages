import { describe, expect, it } from 'vitest';
import {
  accountGoalTurn,
  createGoalState,
  formatElapsed,
  formatTokens,
  normalizeTokenBudget,
  parseTokenBudget,
  restoreGoalState,
} from '../src/goal-state.ts';

const create = () => createGoalState('ship it', 100, 42, () => 'goal-1');

describe('goal state', () => {
  it('parses supported token budget forms', () => {
    expect(parseTokenBudget('--tokens=50k finish migration')).toEqual({
      objective: 'finish migration',
      tokenBudget: 50_000,
    });
    expect(parseTokenBudget('finish --tokens 1.5m migration')).toEqual({
      objective: 'finish migration',
      tokenBudget: 1_500_000,
    });
    expect(parseTokenBudget('--tokens 50000 finish')).toEqual({
      objective: 'finish',
      tokenBudget: 50_000,
    });
  });

  it.each(['--tokens 0 finish', '--tokens -1 finish', '--tokens nope finish', '--tokens='])(
    'rejects malformed explicit budget %s',
    (input) => expect(parseTokenBudget(input).error).toMatch(/positive/),
  );

  it('preserves objective words that merely start with the token option name', () => {
    expect(parseTokenBudget('fix the --tokens-parser behavior')).toEqual({
      objective: 'fix the --tokens-parser behavior',
      tokenBudget: null,
    });
  });

  it('normalizes tool budgets', () => {
    expect(normalizeTokenBudget(undefined)).toEqual({ tokenBudget: null });
    expect(normalizeTokenBudget(10.6)).toEqual({ tokenBudget: 11 });
    expect(normalizeTokenBudget(Number.POSITIVE_INFINITY).error).toMatch(/positive/);
  });

  it('formats tokens and elapsed time', () => {
    expect(formatTokens(12_340)).toBe('12.3K');
    expect(formatTokens(1_250_000)).toBe('1.3M');
    expect(formatElapsed(5_460)).toBe('1h 31m');
  });

  it('creates deterministic goals and clamps negative accounting', () => {
    expect(create()).toMatchObject({
      id: 'goal-1',
      status: 'active',
      createdAt: 42,
      updatedAt: 42,
      tokenBudget: 100,
    });
    expect(accountGoalTurn(create(), -5, -2, 50)).toMatchObject({
      tokensUsed: 0,
      timeUsedSeconds: 0,
      status: 'active',
      updatedAt: 50,
    });
  });

  it('limits active goals at budget and preserves completion on final-turn accounting', () => {
    expect(accountGoalTurn(create(), 100, 4, 50).status).toBe('budget_limited');
    const complete = { ...create(), status: 'complete' as const };
    expect(accountGoalTurn(complete, 25, 7, 55)).toMatchObject({
      status: 'complete',
      tokensUsed: 25,
      timeUsedSeconds: 7,
    });
  });

  it('restores only the latest active-branch custom state', () => {
    const first = create();
    const second = { ...first, status: 'paused' as const, updatedAt: 99 };
    expect(
      restoreGoalState([
        { type: 'custom', customType: 'pi-goal', data: { goal: first, statusBarEnabled: true } },
        { type: 'custom', customType: 'other', data: { goal: null } },
        { type: 'custom', customType: 'pi-goal', data: { goal: second, statusBarEnabled: false } },
      ]),
    ).toEqual({ version: 1, goal: second, statusBarEnabled: false });
  });
});
