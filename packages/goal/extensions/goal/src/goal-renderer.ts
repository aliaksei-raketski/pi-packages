import type { ContinuationGate } from '@aliaksei-raketski/pi-continuation-gate-protocol';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import {
  formatGoalEvidenceSummaryValue,
  summarizeGoalEvidence,
  type GoalEvidenceLedger,
  type GoalEvidenceSummary,
} from './goal-evidence.ts';
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
}

export function registerGoalRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(GOAL_EVENT_CUSTOM_TYPE, (message, { expanded }, theme) => {
    const details = message.details as GoalEventDetails | undefined;
    const legacyLedger = (message.details as { ledger?: GoalEvidenceLedger | null } | undefined)
      ?.ledger;
    const evidenceSummary = details?.evidenceSummary ?? summarizeGoalEvidence(legacyLedger ?? null);
    const label = goalEventLabel(details?.kind ?? 'continuation');
    if (!expanded) {
      return new Text(
        `${theme.fg('customMessageLabel', theme.bold('Goal'))}  ${theme.fg('customMessageText', label)} ${theme.fg('dim', '(expand for details)')}`,
        0,
        0,
      );
    }

    const lines = [`Status: ${label}`];
    if (details?.goal) {
      lines.push(`Objective: ${details.goal.objective}`);
      lines.push(`Usage: ${formatGoalUsage(details.goal, details.timestamp)}`);
      lines.push(
        `Budgets: tokens=${details.goal.tokenBudget ?? 'none'}, wall=${details.goal.wallTimeBudgetSeconds ?? 'none'}s`,
      );
      lines.push(`Evidence: ${formatGoalEvidenceSummaryValue(evidenceSummary)}`);
      lines.push(`No-progress streak: ${details.noProgressStreak}`);
    }
    if (details?.gates.length) {
      lines.push(
        `Gates: ${details.gates.map((gate) => `${gate.source}/${gate.gateId}`).join(', ')}`,
      );
    }
    return new Text(theme.fg('customMessageText', lines.join('\n')), 0, 0);
  });
}
