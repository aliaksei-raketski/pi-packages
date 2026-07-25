export const GOAL_STATE_CUSTOM_TYPE = 'pi-goal';
export const GOAL_EVENT_CUSTOM_TYPE = 'pi-goal-event';

export type GoalStatus = 'active' | 'paused' | 'budget_limited' | 'complete';

export interface GoalState {
  version: 1;
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalPersistedState {
  version: 1;
  goal: GoalState | null;
  statusBarEnabled: boolean;
}

export type GoalEventKind =
  | 'active'
  | 'continuation'
  | 'paused'
  | 'resumed'
  | 'cleared'
  | 'budget_limited'
  | 'complete';

export interface ParsedGoalCommand {
  objective: string;
  tokenBudget: number | null;
  error?: string;
}

const GOAL_STATUSES = new Set<GoalStatus>(['active', 'paused', 'budget_limited', 'complete']);
const TOKEN_FLAG_PATTERN = /(?:^|\s)--tokens(?:=|\s+)(\S+)(?=\s|$)/;
const TOKEN_OPTION_PATTERN = /(?:^|\s)--tokens(?=$|[=\s])/;
const TOKEN_VALUE_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;

export function parseTokenBudget(input: string): ParsedGoalCommand {
  const match = TOKEN_FLAG_PATTERN.exec(input);
  if (!match) {
    return TOKEN_OPTION_PATTERN.test(input)
      ? {
          objective: input.trim(),
          tokenBudget: null,
          error: 'Token budget must be a positive number.',
        }
      : { objective: input.trim(), tokenBudget: null };
  }

  const rawValue = match[1] ?? '';
  const parsedValue = TOKEN_VALUE_PATTERN.exec(rawValue);
  if (!parsedValue) {
    return {
      objective: input.trim(),
      tokenBudget: null,
      error: 'Token budget must be a positive number.',
    };
  }

  const numeric = Number(parsedValue[1]);
  const multiplier = tokenMultiplier(parsedValue[2]);
  const tokenBudget = Math.round(numeric * multiplier);
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    return {
      objective: input.trim(),
      tokenBudget: null,
      error: 'Token budget must be a positive number.',
    };
  }

  const objective = `${input.slice(0, match.index)} ${input.slice(match.index + match[0].length)}`
    .replace(/\s+/g, ' ')
    .trim();
  return { objective, tokenBudget };
}

export function normalizeTokenBudget(value: unknown): {
  tokenBudget: number | null;
  error?: string;
} {
  if (value === undefined || value === null) return { tokenBudget: null };

  const tokenBudget = Math.round(Number(value));
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    return {
      tokenBudget: null,
      error: 'tokenBudget must be a positive number when provided.',
    };
  }
  return { tokenBudget };
}

export function createGoalState(
  objective: string,
  tokenBudget: number | null,
  now = Date.now(),
  createId: (now: number) => string = (timestamp) =>
    `${timestamp.toString(36)}-${Math.random().toString(36).slice(2)}`,
): GoalState {
  return {
    version: 1,
    id: createId(now),
    objective: objective.trim(),
    status: 'active',
    tokenBudget,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function accountGoalTurn(
  state: GoalState,
  tokenDelta: number,
  elapsedSeconds: number,
  now = Date.now(),
): GoalState {
  const tokensUsed = state.tokensUsed + Math.max(0, tokenDelta);
  const timeUsedSeconds = state.timeUsedSeconds + Math.max(0, elapsedSeconds);
  const status =
    state.status === 'active' && state.tokenBudget !== null && tokensUsed >= state.tokenBudget
      ? 'budget_limited'
      : state.status;

  return { ...state, tokensUsed, timeUsedSeconds, status, updatedAt: now };
}

export function remainingTokens(state: GoalState): number | null {
  return state.tokenBudget === null ? null : Math.max(0, state.tokenBudget - state.tokensUsed);
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(Math.max(0, Math.round(value)));
}

export function formatElapsed(seconds: number): string {
  const normalized = Math.max(0, Math.round(seconds));
  if (normalized < 60) return `${normalized}s`;
  const minutes = Math.floor(normalized / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function formatGoalUsage(state: GoalState): string {
  if (state.tokenBudget !== null) {
    return `${formatTokens(state.tokensUsed)}/${formatTokens(state.tokenBudget)} tokens`;
  }
  return `${formatTokens(state.tokensUsed)} tokens, ${formatElapsed(state.timeUsedSeconds)}`;
}

export function truncateObjective(objective: string, maxLength = 96): string {
  const normalized = objective.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

export function goalEventLabel(kind: GoalEventKind): string {
  const labels: Record<GoalEventKind, string> = {
    active: 'active',
    continuation: 'continuing',
    paused: 'paused',
    resumed: 'resumed',
    cleared: 'cleared',
    budget_limited: 'budget reached',
    complete: 'achieved',
  };
  return labels[kind];
}

export function isGoalState(value: unknown): value is GoalState {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.objective === 'string' &&
    value.objective.trim().length > 0 &&
    typeof value.status === 'string' &&
    GOAL_STATUSES.has(value.status as GoalStatus) &&
    (value.tokenBudget === null || isPositiveFiniteNumber(value.tokenBudget)) &&
    isNonNegativeFiniteNumber(value.tokensUsed) &&
    isNonNegativeFiniteNumber(value.timeUsedSeconds) &&
    isNonNegativeFiniteNumber(value.createdAt) &&
    isNonNegativeFiniteNumber(value.updatedAt)
  );
}

export function restoreGoalState(
  entries: Iterable<unknown>,
  defaultStatusBarEnabled = true,
): GoalPersistedState {
  const branch = [...entries];
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (
      !isRecord(entry) ||
      entry.type !== 'custom' ||
      entry.customType !== GOAL_STATE_CUSTOM_TYPE
    ) {
      continue;
    }
    const data = entry.data;
    if (!isRecord(data)) continue;
    return {
      version: 1,
      goal: isGoalState(data.goal) ? { ...data.goal } : null,
      statusBarEnabled:
        typeof data.statusBarEnabled === 'boolean'
          ? data.statusBarEnabled
          : defaultStatusBarEnabled,
    };
  }
  return { version: 1, goal: null, statusBarEnabled: defaultStatusBarEnabled };
}

export function createPersistedState(
  goal: GoalState | null,
  statusBarEnabled: boolean,
): GoalPersistedState {
  return { version: 1, goal, statusBarEnabled };
}

function tokenMultiplier(suffix: string | undefined): number {
  switch (suffix?.toLowerCase()) {
    case 'm':
      return 1_000_000;
    case 'k':
      return 1_000;
    default:
      return 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
