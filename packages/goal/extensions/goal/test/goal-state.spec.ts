import { describe, expect, it } from 'vitest';
import { observeGoalProgress } from '../src/goal-progress.ts';
import {
  accountGoalTurn,
  createGoalState,
  formatElapsed,
  formatTokens,
  MAX_WALL_TIME_BUDGET_SECONDS,
  normalizeTokenBudget,
  normalizeWallTimeBudget,
  parseGoalCommand,
  parseTokenBudget,
  restoreGoalState,
} from '../src/goal-state.ts';

const create = () => createGoalState('ship it', 100, 42, () => 'goal-1');

describe('goal state', () => {
  it('parses token and wall-time budgets in either order', () => {
    expect(parseTokenBudget('--tokens=50k finish migration')).toEqual({
      objective: 'finish migration',
      tokenBudget: 50_000,
      wallTimeBudgetSeconds: null,
    });
    expect(parseGoalCommand('finish --time 30m --tokens 1.5m migration')).toEqual({
      objective: 'finish migration',
      tokenBudget: 1_500_000,
      wallTimeBudgetSeconds: 1_800,
    });
    expect(parseGoalCommand('--time=1.5h --tokens=100000 finish')).toEqual({
      objective: 'finish',
      tokenBudget: 100_000,
      wallTimeBudgetSeconds: 5_400,
    });
    expect(parseGoalCommand('--time 45s finish')).toEqual({
      objective: 'finish',
      tokenBudget: null,
      wallTimeBudgetSeconds: 45,
    });
  });

  it.each([
    '--tokens 0 finish',
    '--tokens -1 finish',
    '--tokens nope finish',
    '--tokens=',
    '--tokens 1 --tokens 2 finish',
  ])('rejects malformed explicit token budget %s', (input) =>
    expect(parseGoalCommand(input).error).toBeTruthy(),
  );

  it.each([
    '--time 0s finish',
    '--time -1s finish',
    '--time 10 finish',
    '--time= finish',
    '--time 1m --time 2m finish',
    '--time 366d finish',
  ])('rejects malformed explicit wall budget %s', (input) =>
    expect(parseGoalCommand(input).error).toBeTruthy(),
  );

  it('preserves objective words that merely start with option names', () => {
    expect(parseGoalCommand('fix the --tokens-parser and --time-series behavior')).toEqual({
      objective: 'fix the --tokens-parser and --time-series behavior',
      tokenBudget: null,
      wallTimeBudgetSeconds: null,
    });
  });

  it('normalizes tool budgets', () => {
    expect(normalizeTokenBudget(undefined)).toEqual({ tokenBudget: null });
    expect(normalizeTokenBudget(10.6)).toEqual({ tokenBudget: 11 });
    expect(normalizeTokenBudget(Number.POSITIVE_INFINITY).error).toMatch(/positive/);
    expect(normalizeWallTimeBudget(10.6)).toEqual({ wallTimeBudgetSeconds: 11 });
    expect(normalizeWallTimeBudget(MAX_WALL_TIME_BUDGET_SECONDS + 1).error).toMatch(/one year/);
  });

  it('formats tokens and elapsed time', () => {
    expect(formatTokens(12_340)).toBe('12.3K');
    expect(formatTokens(1_250_000)).toBe('1.3M');
    expect(formatElapsed(5_460)).toBe('1h 31m');
    expect(formatElapsed(90_000)).toBe('1d 1h');
  });

  it('creates deterministic unversioned goals and clamps negative accounting', () => {
    expect(create()).toMatchObject({
      id: 'goal-1',
      status: 'active',
      createdAt: 42,
      updatedAt: 42,
      tokenBudget: 100,
      wallTimeBudgetSeconds: null,
      activeSince: 42,
      activeWallTimeSeconds: 0,
    });
    expect(create()).not.toHaveProperty('version');
    expect(accountGoalTurn(create(), -5, -2, 50)).toMatchObject({
      tokensUsed: 0,
      timeUsedSeconds: 0,
      status: 'active',
      updatedAt: 50,
    });
  });

  it('limits active goals at budget and preserves completion on final-turn accounting', () => {
    expect(accountGoalTurn(create(), 100, 4, 50)).toMatchObject({
      status: 'budget_limited',
      budgetLimitReason: 'tokens',
    });
    const complete = { ...create(), status: 'complete' as const, activeSince: null };
    expect(accountGoalTurn(complete, 25, 7, 55)).toMatchObject({
      status: 'complete',
      tokensUsed: 25,
      timeUsedSeconds: 7,
    });
  });

  it('restores latest branch state with structural defaults and no version discriminator', () => {
    const historical = {
      version: 1,
      id: 'goal-1',
      objective: 'ship it',
      status: 'paused',
      tokenBudget: 100,
      tokensUsed: 4,
      timeUsedSeconds: 2,
      createdAt: 42,
      updatedAt: 99,
    };
    expect(
      restoreGoalState([
        { type: 'custom', customType: 'pi-goal', data: { goal: create(), statusBarEnabled: true } },
        { type: 'custom', customType: 'other', data: { goal: null } },
        {
          type: 'custom',
          customType: 'pi-goal',
          data: { version: 1, goal: historical, statusBarEnabled: false },
        },
      ]),
    ).toEqual({
      goal: {
        id: 'goal-1',
        objective: 'ship it',
        status: 'paused',
        tokenBudget: 100,
        wallTimeBudgetSeconds: null,
        tokensUsed: 4,
        timeUsedSeconds: 2,
        activeWallTimeSeconds: 0,
        activeSince: null,
        pauseReason: null,
        budgetLimitReason: null,
        createdAt: 42,
        updatedAt: 99,
      },
      ledger: null,
      progress: null,
      statusBarEnabled: false,
      restartPolicy: 'pause',
      noProgressEnabled: false,
      pendingBudgetSummary: false,
    });
  });

  it('restores bounded branch-local detector history', () => {
    const state = create();
    const progress = observeGoalProgress(null, {
      goalId: state.id,
      observedAt: 50,
      assistantText: 'bounded synthetic summary',
      tools: [{ name: 'read', isError: false }],
      evidenceRevision: 0,
    }).state;
    const restored = restoreGoalState([
      {
        type: 'custom',
        customType: 'pi-goal',
        data: { goal: state, progress, noProgressEnabled: true },
      },
    ]);
    expect(restored.progress).toEqual(progress);
    expect(restored.noProgressEnabled).toBe(true);
  });

  it('drops malformed nested state without losing a valid goal', () => {
    const state = create();
    const restored = restoreGoalState([
      {
        type: 'custom',
        customType: 'pi-goal',
        data: {
          goal: state,
          ledger: { goalId: state.id, revision: -1, requirements: [] },
          progress: { observations: [{ rawText: 'secret' }] },
          statusBarEnabled: true,
        },
      },
    ]);
    expect(restored.goal).toEqual(state);
    expect(restored.ledger).toBeNull();
    expect(restored.progress).toBeNull();
  });
});
