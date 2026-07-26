import type { ContinuationGate } from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { remainingWallTime } from './goal-clock.ts';
import {
  completionEvidenceErrors,
  createGoalEvidenceLedger,
  formatGoalEvidenceSummary,
  MAX_BLOCKER_LENGTH,
  MAX_EVIDENCE_CLAIM_LENGTH,
  MAX_EVIDENCE_REFERENCE_LENGTH,
  MAX_GOAL_REQUIREMENTS,
  MAX_REQUIREMENT_ID_LENGTH,
  MAX_REQUIREMENT_LENGTH,
  mutateGoalEvidence,
  summarizeGoalEvidence,
  type GoalEvidenceKind,
  type GoalEvidenceMutation,
  type GoalRequirementStatus,
} from './goal-evidence.ts';
import type { GoalRuntime } from './goal-runtime-core.ts';
import {
  createGoalState,
  MAX_GOAL_OBJECTIVE_LENGTH,
  MAX_WALL_TIME_BUDGET_SECONDS,
  normalizeTokenBudget,
  normalizeWallTimeBudget,
  remainingTokens,
  type GoalEventKind,
  type GoalState,
  type GoalStatus,
} from './goal-state.ts';

export const ACTIVE_GOAL_TOOL_NAMES = ['get_goal', 'update_goal', 'update_goal_evidence'] as const;

interface GoalToolController {
  runtime: GoalRuntime;
  replace(ctx: ExtensionContext, goal: GoalState): void;
  persist(ctx: ExtensionContext): void;
  transition(ctx: ExtensionContext, status: GoalStatus): GoalState;
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
      'Create or replace a persistent thread goal only after explicit user intent. The objective must be an evidence-checkable contract. Optional token and active wall-clock budgets may be combined.',
    promptSnippet: 'Create a persistent goal only when the user explicitly requests goal mode',
    promptGuidelines: [
      'Use create_goal only when the user explicitly asks to create, set, start, change, or replace a goal.',
      'Do not infer goal-mode intent from ordinary tasks or one-off prompts.',
      'Before calling create_goal, make the objective self-contained and define outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition.',
      'Set create_goal tokenBudget or timeBudgetSeconds only when the user explicitly requests that budget.',
    ],
    parameters: Type.Object(
      {
        objective: Type.String({
          minLength: 1,
          maxLength: MAX_GOAL_OBJECTIVE_LENGTH,
          description: 'Evidence-checkable objective.',
        }),
        tokenBudget: Type.Optional(
          Type.Number({ minimum: 1, description: 'Optional positive token budget.' }),
        ),
        timeBudgetSeconds: Type.Optional(
          Type.Number({
            minimum: 1,
            maximum: MAX_WALL_TIME_BUDGET_SECONDS,
            description: 'Optional positive active wall-clock budget.',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(...[, params, , , ctx]) {
      const objective = params.objective.trim();
      if (!objective) throw new Error('objective is required.');
      const tokens = normalizeTokenBudget(params.tokenBudget);
      if (tokens.error) throw new Error(tokens.error);
      const wall = normalizeWallTimeBudget(params.timeBudgetSeconds);
      if (wall.error) throw new Error(wall.error);
      const timestamp = now();
      const next = createGoalState(
        objective,
        tokens.tokenBudget,
        timestamp,
        undefined,
        wall.wallTimeBudgetSeconds,
      );
      controller.runtime.ledger = createGoalEvidenceLedger(next.id, timestamp);
      controller.runtime.progress = null;
      controller.replace(ctx, next);
      controller.emit('active', next, { triggerTurn: ctx.isIdle() });
      const payload = goalPayload(controller.runtime, controller.gates(), timestamp);
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  });

  pi.registerTool({
    name: 'get_goal',
    label: 'Get Goal',
    description:
      'Read the active goal, evidence ledger, progress diagnostics, remaining budgets, restart policy, and continuation gates.',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      if (controller.runtime.goal?.status !== 'active') throw new Error('No active goal is set.');
      const payload = goalPayload(controller.runtime, controller.gates(), now());
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  });

  pi.registerTool({
    name: 'update_goal_evidence',
    label: 'Update Goal Evidence',
    description:
      'Revision-checked mutations for the active goal evidence ledger. Stores concise references and claims, never command output.',
    promptSnippet: 'Record concise, inspected evidence against active goal requirements',
    promptGuidelines: [
      'Initialize update_goal_evidence requirements before attempting to complete an active goal.',
      'Read the current ledger revision before each update_goal_evidence mutation and record only concise evidence references and claims.',
      'Do not store raw prompts, command output, file contents, or logs in update_goal_evidence.',
    ],
    parameters: Type.Object(
      {
        action: StringEnum([
          'initialize_requirements',
          'upsert_requirement',
          'add_evidence',
          'set_requirement_status',
          'remove_evidence',
        ] as const),
        expectedRevision: Type.Integer({ minimum: 0 }),
        requirements: Type.Optional(
          Type.Array(
            Type.Object(
              {
                id: Type.String({ minLength: 1, maxLength: MAX_REQUIREMENT_ID_LENGTH }),
                requirement: Type.String({ minLength: 1, maxLength: MAX_REQUIREMENT_LENGTH }),
              },
              { additionalProperties: false },
            ),
            { maxItems: MAX_GOAL_REQUIREMENTS },
          ),
        ),
        replace: Type.Optional(Type.Boolean()),
        requirementId: Type.Optional(
          Type.String({ minLength: 1, maxLength: MAX_REQUIREMENT_ID_LENGTH }),
        ),
        requirement: Type.Optional(
          Type.String({ minLength: 1, maxLength: MAX_REQUIREMENT_LENGTH }),
        ),
        status: Type.Optional(
          StringEnum(['pending', 'in_progress', 'verified', 'blocked'] as const),
        ),
        blocker: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_BLOCKER_LENGTH })),
        evidence: Type.Optional(
          Type.Object(
            {
              id: Type.String({ minLength: 1, maxLength: MAX_REQUIREMENT_ID_LENGTH }),
              kind: StringEnum([
                'file',
                'command',
                'test',
                'log',
                'url',
                'user_confirmation',
                'other',
              ] as const),
              reference: Type.String({
                minLength: 1,
                maxLength: MAX_EVIDENCE_REFERENCE_LENGTH,
              }),
              claim: Type.String({ minLength: 1, maxLength: MAX_EVIDENCE_CLAIM_LENGTH }),
            },
            { additionalProperties: false },
          ),
        ),
        evidenceId: Type.Optional(
          Type.String({ minLength: 1, maxLength: MAX_REQUIREMENT_ID_LENGTH }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(...[, params, , , ctx]) {
      const goal = controller.runtime.goal;
      if (goal?.status !== 'active') throw new Error('No active goal is set.');
      const mutation = evidenceMutationFromParams(params);
      controller.runtime.ledger = mutateGoalEvidence(
        controller.runtime.ledger,
        goal.id,
        mutation,
        now(),
      );
      controller.persist(ctx);
      const summary = summarizeGoalEvidence(controller.runtime.ledger);
      return {
        content: [
          {
            type: 'text',
            text: `Evidence updated: ${formatGoalEvidenceSummary(controller.runtime.ledger)}.`,
          },
        ],
        details: summary,
      };
    },
  });

  pi.registerTool({
    name: 'update_goal',
    label: 'Complete Goal',
    description:
      'Mark the active goal complete, and only complete, after every ledger requirement has inspected evidence.',
    promptSnippet: 'Mark the active goal complete only after a strict evidence audit',
    promptGuidelines: [
      'Use update_goal only after verifying every requirement of the current goal against concrete evidence and marking the entire evidence ledger verified.',
      'Do not use update_goal to pause, clear, abandon, or budget-limit a goal.',
    ],
    parameters: Type.Object(
      { status: StringEnum(['complete'] as const, { description: 'Only complete is accepted.' }) },
      { additionalProperties: false },
    ),
    async execute(...[, params, , , ctx]) {
      if (params.status !== 'complete')
        throw new Error('update_goal only accepts status=complete.');
      const goal = controller.runtime.goal;
      if (goal?.status !== 'active') throw new Error('No active goal is set.');
      const errors = completionEvidenceErrors(controller.runtime.ledger, goal.id);
      if (errors.length > 0) throw new Error(`Goal cannot be completed:\n- ${errors.join('\n- ')}`);
      const next = controller.transition(ctx, 'complete');
      controller.emit('complete', next);
      const payload = goalPayload(controller.runtime, controller.gates(), now());
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  });
}

function goalPayload(runtime: GoalRuntime, gates: readonly ContinuationGate[], now: number) {
  if (!runtime.goal) return { goal: null };
  return {
    goal: runtime.goal,
    remainingTokens: remainingTokens(runtime.goal),
    remainingWallTimeSeconds: remainingWallTime(runtime.goal, now),
    ledger: runtime.ledger,
    evidenceSummary: summarizeGoalEvidence(runtime.ledger),
    progress: runtime.progress,
    noProgressEnabled: runtime.noProgressEnabled,
    restartPolicy: runtime.restartPolicy,
    pendingBudgetSummary: runtime.pendingBudgetSummary,
    gates,
  };
}

type EvidenceToolParams = {
  action:
    | 'initialize_requirements'
    | 'upsert_requirement'
    | 'add_evidence'
    | 'set_requirement_status'
    | 'remove_evidence';
  expectedRevision: number;
  requirements?: Array<{ id: string; requirement: string }>;
  replace?: boolean;
  requirementId?: string;
  requirement?: string;
  status?: GoalRequirementStatus;
  blocker?: string;
  evidence?: { id: string; kind: GoalEvidenceKind; reference: string; claim: string };
  evidenceId?: string;
};

function evidenceMutationFromParams(params: EvidenceToolParams): GoalEvidenceMutation {
  if (params.action === 'initialize_requirements') {
    if (!params.requirements)
      throw new Error('requirements is required for initialize_requirements.');
    return {
      action: params.action,
      expectedRevision: params.expectedRevision,
      requirements: params.requirements,
      ...(params.replace === undefined ? {} : { replace: params.replace }),
    };
  }
  if (!params.requirementId) throw new Error(`requirementId is required for ${params.action}.`);
  if (params.action === 'upsert_requirement') {
    if (!params.requirement) throw new Error('requirement is required for upsert_requirement.');
    return {
      action: params.action,
      expectedRevision: params.expectedRevision,
      requirementId: params.requirementId,
      requirement: params.requirement,
    };
  }
  if (params.action === 'add_evidence') {
    if (!params.evidence) throw new Error('evidence is required for add_evidence.');
    return {
      action: params.action,
      expectedRevision: params.expectedRevision,
      requirementId: params.requirementId,
      evidence: params.evidence,
    };
  }
  if (params.action === 'set_requirement_status') {
    if (!params.status) throw new Error('status is required for set_requirement_status.');
    return {
      action: params.action,
      expectedRevision: params.expectedRevision,
      requirementId: params.requirementId,
      status: params.status,
      ...(params.blocker === undefined ? {} : { blocker: params.blocker }),
    };
  }
  if (!params.evidenceId) throw new Error('evidenceId is required for remove_evidence.');
  return {
    action: params.action,
    expectedRevision: params.expectedRevision,
    requirementId: params.requirementId,
    evidenceId: params.evidenceId,
  };
}
