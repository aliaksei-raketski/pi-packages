import type { ContinuationGate } from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { formatElapsed, formatGoalUsage, remainingTokens, type GoalState } from './goal-state.ts';

export const GOAL_COMMAND_COMPLETIONS = [
  'status',
  'waits',
  'pause',
  'resume',
  'continue',
  'clear',
  'statusbar on',
  'statusbar off',
] as const;

export function formatGate(gate: ContinuationGate, now = Date.now()): string {
  const ageSeconds = Math.max(0, Math.floor((now - gate.acquiredAt) / 1000));
  let resource = '';
  if (gate.resource) {
    const label = gate.resource.label ? ` (${gate.resource.label})` : '';
    resource = `; resource=${gate.resource.kind}:${gate.resource.id}${label}`;
  }
  return `${gate.source}/${gate.gateId}: ${gate.reason}; age=${formatElapsed(ageSeconds)}${resource}`;
}

export function formatGates(gates: readonly ContinuationGate[], now = Date.now()): string {
  if (gates.length === 0) return 'No active continuation gates.';
  return [
    `Active continuation gates (${gates.length}):`,
    ...gates.map((gate) => `- ${formatGate(gate, now)}`),
  ].join('\n');
}

export function formatGoalStatus(
  goal: GoalState | null,
  statusBarEnabled: boolean,
  gates: readonly ContinuationGate[],
): string {
  if (!goal) {
    return `No goal is set.\nStatus bar: ${statusBarEnabled ? 'on' : 'off'}\n${formatGates(gates)}`;
  }

  const budget = remainingTokens(goal);
  return [
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Usage: ${formatGoalUsage(goal)}`,
    `Remaining tokens: ${budget === null ? 'n/a' : budget}`,
    `Status bar: ${statusBarEnabled ? 'on' : 'off'}`,
    formatGates(gates),
  ].join('\n');
}
