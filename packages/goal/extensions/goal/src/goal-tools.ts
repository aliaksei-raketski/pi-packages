import { StringEnum } from '@earendil-works/pi-ai';
import type { ContinuationGate } from '@aliaksei-raketski/pi-continuation-gate-protocol';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  createGoalState,
  normalizeTokenBudget,
  remainingTokens,
  type GoalEventKind,
  type GoalState,
} from './goal-state.ts';
import { invalidateContinuation, type GoalRuntime } from './goal-runtime.ts';

export const ACTIVE_GOAL_TOOL_NAMES = ['get_goal', 'update_goal'] as const;

interface GoalToolController {
  runtime: GoalRuntime;
  persist(ctx: ExtensionContext, goal: GoalState | null): void;
  emit(
    kind: GoalEventKind,
    state: GoalState,
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
  ): void;
  gates(): readonly ContinuationGate[];
  now?: () => number;
}

export function syncGoalTools(pi: ExtensionAPI, runtime: GoalRuntime): void {
  const activeTools = new Set(pi.getActiveTools());
  activeTools.add('create_goal');
  for (const toolName of ACTIVE_GOAL_TOOL_NAMES) {
    if (runtime.goal?.status === 'active') activeTools.add(toolName);
    else activeTools.delete(toolName);
  }
  pi.setActiveTools([...activeTools]);
}

export function registerGoalTools(pi: ExtensionAPI, controller: GoalToolController): void {
  const now = () => controller.now?.() ?? Date.now();

  pi.registerTool({
    name: 'create_goal',
    label: 'Create Goal',
    description:
      'Create or replace a persistent thread goal only after explicit user intent. The objective must be an evidence-checkable contract covering outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition.',
    promptSnippet: 'Create a persistent goal only when the user explicitly requests goal mode',
    promptGuidelines: [
      'Use create_goal only when the user explicitly asks to create, set, start, change, or replace a goal.',
      'Do not infer goal-mode intent from ordinary tasks or one-off prompts.',
      'Before calling create_goal, make the objective self-contained and define outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition.',
      'Set create_goal tokenBudget only when the user explicitly requests a token budget.',
    ],
    parameters: Type.Object(
      {
        objective: Type.String({ minLength: 1, description: 'Evidence-checkable objective.' }),
        tokenBudget: Type.Optional(
          Type.Number({ minimum: 1, description: 'Optional positive token budget.' }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(...[, params, , , ctx]) {
      const objective = params.objective.trim();
      if (!objective) throw new Error('objective is required.');
      const budget = normalizeTokenBudget(params.tokenBudget);
      if (budget.error) throw new Error(budget.error);

      const next = createGoalState(objective, budget.tokenBudget, now());
      controller.persist(ctx, next);
      controller.emit('active', next, { triggerTurn: ctx.isIdle() });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ goal: next, remainingTokens: remainingTokens(next) }, null, 2),
          },
        ],
        details: { goal: next },
      };
    },
  });

  pi.registerTool({
    name: 'get_goal',
    label: 'Get Goal',
    description: 'Read the active goal, remaining token budget, and current continuation gates.',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      if (controller.runtime.goal?.status !== 'active') throw new Error('No active goal is set.');
      const payload = {
        goal: controller.runtime.goal,
        remainingTokens: remainingTokens(controller.runtime.goal),
        gates: controller.gates(),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  });

  pi.registerTool({
    name: 'update_goal',
    label: 'Complete Goal',
    description:
      'Mark the active goal complete, and only complete, after every objective requirement has direct evidence.',
    promptSnippet: 'Mark the active goal complete only after a strict evidence audit',
    promptGuidelines: [
      'Use update_goal only after verifying every requirement of the current goal against concrete evidence.',
      'Do not use update_goal to pause, clear, abandon, or budget-limit a goal.',
    ],
    parameters: Type.Object(
      {
        status: StringEnum(['complete'] as const, { description: 'Only complete is accepted.' }),
      },
      { additionalProperties: false },
    ),
    async execute(...[, params, , , ctx]) {
      if (params.status !== 'complete')
        throw new Error('update_goal only accepts status=complete.');
      if (controller.runtime.goal?.status !== 'active') throw new Error('No active goal is set.');

      const next: GoalState = {
        ...controller.runtime.goal,
        status: 'complete',
        updatedAt: now(),
      };
      invalidateContinuation(controller.runtime);
      controller.persist(ctx, next);
      controller.emit('complete', next);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ goal: next, remainingTokens: remainingTokens(next) }, null, 2),
          },
        ],
        details: { goal: next },
      };
    },
  });
}
