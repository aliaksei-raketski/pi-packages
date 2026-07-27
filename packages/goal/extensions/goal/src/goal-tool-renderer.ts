import { Text, truncateToWidth } from '@earendil-works/pi-tui';

const MAX_EXPANDED_LINES = 20;
const MAX_DISPLAY_VALUE_CHARACTERS = 160;
const MAX_DISPLAYED_REQUIREMENTS = 4;
const MAX_DISPLAYED_GATES = 2;

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface GoalToolResultLike {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

interface GoalToolRenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

export function renderGetGoalCall(theme: ThemeLike) {
  return new Text(theme.fg('toolTitle', theme.bold('Get Goal')), 0, 0);
}

export const getGoalToolRenderers = {
  renderCall: (_args: unknown, theme: ThemeLike) => renderGetGoalCall(theme),
  renderResult: (result: GoalToolResultLike, options: GoalToolRenderOptions, theme: ThemeLike) =>
    renderGetGoalResult(result, options, theme),
};

export function renderGetGoalResult(
  result: GoalToolResultLike,
  options: GoalToolRenderOptions,
  theme: ThemeLike,
) {
  const payload = payloadFromResult(result);
  if (!payload) {
    return renderBoundedLines(
      [options.isPartial ? 'Loading goal…' : 'Goal details unavailable.'],
      options.isPartial ? 'warning' : 'dim',
      theme,
    );
  }

  const goal = asRecord(payload.goal);
  const evidence = evidenceSummary(payload.evidenceSummary);
  const gates = Array.isArray(payload.gates) ? payload.gates : [];
  const status = displayValue(goal?.status, 'unknown');
  const truncated = asRecord(payload.truncation)?.truncated === true;
  const summary = [
    status,
    `evidence ${evidence.verified}/${evidence.total} verified`,
    `${gates.length} ${gates.length === 1 ? 'gate' : 'gates'}`,
    truncated ? 'payload truncated' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  if (!options.expanded) {
    return renderBoundedLines([summary], options.isPartial ? 'warning' : 'dim', theme);
  }

  const lines = limitLines(expandedLines(payload, goal, evidence, gates), MAX_EXPANDED_LINES);
  return renderBoundedLines(lines, options.isPartial ? 'warning' : 'dim', theme);
}

function expandedLines(
  payload: Record<string, unknown>,
  goal: Record<string, unknown> | undefined,
  evidence: EvidenceCounts,
  gates: unknown[],
): string[] {
  const lines = [
    `Status: ${displayValue(goal?.status, 'unknown')}`,
    `Goal: ${displayValue(goal?.id, 'unknown')}`,
    `Objective: ${displayValue(goal?.objective, 'none')}`,
    `Tokens: ${numberLabel(goal?.tokensUsed)}/${numberLabel(goal?.tokenBudget)} used; ${numberLabel(payload.remainingTokens)} remaining`,
    `Active wall: ${secondsLabel(goal?.activeWallTimeSeconds)}/${secondsLabel(goal?.wallTimeBudgetSeconds)}; ${secondsLabel(payload.remainingWallTimeSeconds)} remaining`,
    `Evidence: revision ${evidence.revision}; ${evidence.verified}/${evidence.total} verified; ${evidence.pending} pending; ${evidence.inProgress} in progress; ${evidence.blocked} blocked`,
    `No-progress detection: ${payload.noProgressEnabled === true ? 'enabled' : 'disabled'}`,
    `Restart policy: ${displayValue(payload.restartPolicy, 'unknown')}`,
    `Pending budget summary: ${payload.pendingBudgetSummary === true ? 'yes' : 'no'}`,
  ];

  const ledger = asRecord(payload.ledger);
  const requirements = Array.isArray(ledger?.requirements) ? ledger.requirements : [];
  if (requirements.length > 0) {
    lines.push(`Requirements (${requirements.length}):`);
    for (const requirement of requirements.slice(0, MAX_DISPLAYED_REQUIREMENTS)) {
      const value = asRecord(requirement);
      lines.push(
        `- [${displayValue(value?.status, 'unknown')}] ${displayValue(value?.id, 'unknown')}: ${displayValue(value?.requirement, 'none')}`,
      );
    }
    if (requirements.length > MAX_DISPLAYED_REQUIREMENTS) {
      lines.push(`… ${requirements.length - MAX_DISPLAYED_REQUIREMENTS} more requirements`);
    }
  }

  if (gates.length > 0) {
    lines.push(`Gates (${gates.length}):`);
    for (const gate of gates.slice(0, MAX_DISPLAYED_GATES)) {
      const value = asRecord(gate);
      lines.push(
        `- ${displayValue(value?.source, 'unknown')}/${displayValue(value?.gateId, 'unknown')}: ${displayValue(value?.reason, 'no reason')}`,
      );
    }
    if (gates.length > MAX_DISPLAYED_GATES) {
      lines.push(`… ${gates.length - MAX_DISPLAYED_GATES} more gates`);
    }
  }

  const truncation = asRecord(payload.truncation);
  if (truncation?.truncated === true) {
    lines.push(`Payload: ${displayValue(truncation.notice, 'truncated')}`);
  }
  return lines;
}

interface EvidenceCounts {
  revision: number;
  total: number;
  pending: number;
  inProgress: number;
  verified: number;
  blocked: number;
}

function evidenceSummary(value: unknown): EvidenceCounts {
  const source = asRecord(value);
  return {
    revision: count(source?.revision),
    total: count(source?.total),
    pending: count(source?.pending),
    inProgress: count(source?.inProgress),
    verified: count(source?.verified),
    blocked: count(source?.blocked),
  };
}

function payloadFromResult(result: GoalToolResultLike): Record<string, unknown> | undefined {
  const details = asRecord(result.details);
  if (details) return details;
  const text = result.content.find((item) => item.type === 'text')?.text;
  if (!text) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function numberLabel(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  return typeof value === 'number' && Number.isFinite(value)
    ? String(Math.max(0, Math.floor(value)))
    : 'unknown';
}

function secondsLabel(value: unknown): string {
  const label = numberLabel(value);
  return label === 'none' || label === 'unknown' ? label : `${label}s`;
}

function displayValue(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const safe = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!safe) return fallback;
  const characters = [...safe];
  return characters.length <= MAX_DISPLAY_VALUE_CHARACTERS
    ? safe
    : `${characters.slice(0, MAX_DISPLAY_VALUE_CHARACTERS - 1).join('')}…`;
}

function limitLines(lines: string[], maximum: number): string[] {
  if (lines.length <= maximum) return lines;
  const included = lines.slice(0, maximum - 1);
  included.push(`… ${lines.length - included.length} more detail lines`);
  return included;
}

function renderBoundedLines(lines: string[], color: string, theme: ThemeLike) {
  const themedLines = lines.map((line) => theme.fg(color, line));
  return {
    render: (width: number) => themedLines.map((line) => truncateToWidth(line, Math.max(1, width))),
    invalidate: () => {
      // Static content has no render cache to invalidate.
    },
  };
}
