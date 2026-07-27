import type { ContinuationGate } from '@aliaksei-raketski/pi-continuation-gate-protocol';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { formatGoalEvidenceSummaryValue, type GoalEvidenceSummary } from './goal-evidence.ts';
import {
  formatGoalUsage,
  goalEventLabel,
  GOAL_EVENT_CUSTOM_TYPE,
  type GoalEventKind,
  type GoalState,
} from './goal-state.ts';

export interface GoalEventDetails {
  kind: GoalEventKind;
  goal: GoalState;
  gates: readonly ContinuationGate[];
  evidenceSummary: GoalEvidenceSummary;
  noProgressStreak: number;
  timestamp: number;
  deliveryId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function countValue(value: unknown): number {
  return Math.floor(finiteNonNegative(value));
}

function normalizeEvidenceSummary(value: unknown, legacyLedger: unknown): GoalEvidenceSummary {
  const source = isRecord(value) ? value : undefined;
  if (source) {
    return {
      revision: countValue(source.revision),
      total: countValue(source.total),
      pending: countValue(source.pending),
      inProgress: countValue(source.inProgress),
      verified: countValue(source.verified),
      blocked: countValue(source.blocked),
    };
  }
  const ledger = isRecord(legacyLedger) ? legacyLedger : undefined;
  const requirements = ledger && Array.isArray(ledger.requirements) ? ledger.requirements : [];
  const summary = {
    revision: countValue(ledger?.revision),
    total: requirements.length,
    pending: 0,
    inProgress: 0,
    verified: 0,
    blocked: 0,
  };
  for (const requirement of requirements) {
    if (!isRecord(requirement)) continue;
    if (requirement.status === 'pending') summary.pending += 1;
    else if (requirement.status === 'in_progress') summary.inProgress += 1;
    else if (requirement.status === 'verified') summary.verified += 1;
    else if (requirement.status === 'blocked') summary.blocked += 1;
  }
  return summary;
}

function normalizeEventKind(value: unknown): GoalEventKind {
  return value === 'active' ||
    value === 'continuation' ||
    value === 'paused' ||
    value === 'resumed' ||
    value === 'cleared' ||
    value === 'budget_limited' ||
    value === 'complete'
    ? value
    : 'continuation';
}

function normalizeGateLabels(value: unknown): Array<{ source: string; gateId: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.source !== 'string' ||
      candidate.source.length === 0 ||
      typeof candidate.gateId !== 'string' ||
      candidate.gateId.length === 0
    )
      return [];
    return [{ source: candidate.source, gateId: candidate.gateId }];
  });
}

function normalizeLegacyGoal(goal: GoalState): GoalState {
  const value = goal as unknown as Record<string, unknown>;
  const updatedAt = finiteNonNegative(value.updatedAt);
  const status =
    value.status === 'active' ||
    value.status === 'paused' ||
    value.status === 'budget_limited' ||
    value.status === 'complete'
      ? value.status
      : 'active';
  const tokenBudget =
    value.tokenBudget === null ? null : finiteNonNegative(value.tokenBudget, 0) || null;
  const wallTimeBudgetSeconds =
    value.wallTimeBudgetSeconds === null
      ? null
      : finiteNonNegative(value.wallTimeBudgetSeconds, 0) || null;
  return {
    id: typeof value.id === 'string' ? value.id : 'legacy-goal',
    objective: typeof value.objective === 'string' ? value.objective : '',
    status,
    tokenBudget,
    wallTimeBudgetSeconds,
    tokensUsed: finiteNonNegative(value.tokensUsed),
    timeUsedSeconds: finiteNonNegative(value.timeUsedSeconds),
    activeWallTimeSeconds: finiteNonNegative(value.activeWallTimeSeconds),
    activeSince:
      typeof value.activeSince === 'number' && Number.isFinite(value.activeSince)
        ? Math.max(0, value.activeSince)
        : null,
    pauseReason:
      value.pauseReason === 'user' ||
      value.pauseReason === 'reload' ||
      value.pauseReason === 'no_progress' ||
      value.pauseReason === 'delivery_failure'
        ? value.pauseReason
        : null,
    budgetLimitReason:
      value.budgetLimitReason === 'tokens' ||
      value.budgetLimitReason === 'wall_time' ||
      value.budgetLimitReason === 'tokens_and_wall_time'
        ? value.budgetLimitReason
        : null,
    createdAt: finiteNonNegative(value.createdAt, updatedAt),
    updatedAt,
  };
}

export function registerGoalRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(GOAL_EVENT_CUSTOM_TYPE, (message, { expanded }, theme) => {
    const details = (isRecord(message.details) ? message.details : undefined) as
      | GoalEventDetails
      | undefined;
    const legacyLedger = isRecord(message.details) ? message.details.ledger : undefined;
    const evidenceSummary = normalizeEvidenceSummary(details?.evidenceSummary, legacyLedger);
    const label = goalEventLabel(normalizeEventKind(details?.kind));
    const goal = details?.goal ? normalizeLegacyGoal(details.goal) : undefined;
    const timestamp =
      typeof details?.timestamp === 'number' && Number.isFinite(details.timestamp)
        ? details.timestamp
        : (goal?.updatedAt ?? 0);
    const noProgressStreak =
      typeof details?.noProgressStreak === 'number' && Number.isFinite(details.noProgressStreak)
        ? Math.max(0, details.noProgressStreak)
        : 0;
    const gates = normalizeGateLabels(details?.gates);
    if (!expanded) {
      return new Text(
        `${theme.fg('customMessageLabel', theme.bold('Goal'))}  ${theme.fg('customMessageText', label)} ${theme.fg('dim', '(expand for details)')}`,
        0,
        0,
      );
    }

    const lines = [`Status: ${label}`];
    if (goal) {
      lines.push(`Objective: ${goal.objective}`);
      lines.push(`Usage: ${formatGoalUsage(goal, timestamp)}`);
      lines.push(
        `Budgets: tokens=${goal.tokenBudget ?? 'none'}, wall=${goal.wallTimeBudgetSeconds === null ? 'none' : `${goal.wallTimeBudgetSeconds}s`}`,
      );
      lines.push(`Evidence: ${formatGoalEvidenceSummaryValue(evidenceSummary)}`);
      lines.push(`No-progress streak: ${noProgressStreak}`);
    }
    if (gates.length) {
      lines.push(`Gates: ${gates.map((gate) => `${gate.source}/${gate.gateId}`).join(', ')}`);
    }
    return new Text(theme.fg('customMessageText', lines.join('\n')), 0, 0);
  });
}
