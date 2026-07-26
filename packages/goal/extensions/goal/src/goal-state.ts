import {
  activeWallTimeAt,
  checkpointAndRestartActiveClock,
  evaluateBudgetLimit,
  transitionGoal,
} from './goal-clock.ts';
import { parseGoalEvidenceLedger, type GoalEvidenceLedger } from './goal-evidence.ts';
import { parseGoalProgressState, type GoalProgressState } from './goal-progress.ts';
import type {
  GoalBudgetLimitReason,
  GoalEventKind,
  GoalPauseReason,
  GoalPersistedState,
  GoalRestartPolicy,
  GoalState,
  GoalStatus,
} from './goal-types.ts';

export type {
  GoalBudgetLimitReason,
  GoalEventKind,
  GoalPauseReason,
  GoalPersistedState,
  GoalRestartPolicy,
  GoalState,
  GoalStatus,
} from './goal-types.ts';

export const GOAL_STATE_CUSTOM_TYPE = 'pi-goal';
export const GOAL_EVENT_CUSTOM_TYPE = 'pi-goal-event';
export const MAX_WALL_TIME_BUDGET_SECONDS = 365 * 24 * 60 * 60;
export const MAX_GOAL_OBJECTIVE_LENGTH = 20_000;

export interface ParsedGoalCommand {
  objective: string;
  tokenBudget: number | null;
  wallTimeBudgetSeconds: number | null;
  error?: string;
}

const GOAL_STATUSES = new Set<GoalStatus>(['active', 'paused', 'budget_limited', 'complete']);
const PAUSE_REASONS = new Set<GoalPauseReason>(['user', 'reload', 'no_progress', null]);
const BUDGET_REASONS = new Set<GoalBudgetLimitReason>([
  'tokens',
  'wall_time',
  'tokens_and_wall_time',
  null,
]);
const RESTART_POLICIES = new Set<GoalRestartPolicy>(['pause', 'restore-idle', 'resume']);
const TOKEN_VALUE_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
const TIME_VALUE_PATTERN = /^(\d+(?:\.\d+)?)([smhd])$/i;

export function parseGoalCommand(input: string): ParsedGoalCommand {
  const tokens = input.trim() ? input.trim().split(/\s+/) : [];
  const objective: string[] = [];
  let tokenBudget: number | null = null;
  let wallTimeBudgetSeconds: number | null = null;
  let sawTokens = false;
  let sawTime = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    const tokenOption = optionValue(token, '--tokens', tokens[index + 1]);
    if (tokenOption.recognized) {
      if (sawTokens) return parseError(input, 'Duplicate --tokens option.');
      sawTokens = true;
      if (tokenOption.consumedNext) index += 1;
      const parsed = parseTokenValue(tokenOption.value);
      if (parsed === null) return parseError(input, 'Token budget must be a positive number.');
      tokenBudget = parsed;
      continue;
    }
    const timeOption = optionValue(token, '--time', tokens[index + 1]);
    if (timeOption.recognized) {
      if (sawTime) return parseError(input, 'Duplicate --time option.');
      sawTime = true;
      if (timeOption.consumedNext) index += 1;
      const parsed = parseTimeValue(timeOption.value);
      if (parsed.error) return parseError(input, parsed.error);
      wallTimeBudgetSeconds = parsed.seconds;
      continue;
    }
    objective.push(token);
  }
  const normalizedObjective = objective.join(' ').trim();
  if (normalizedObjective.length > MAX_GOAL_OBJECTIVE_LENGTH)
    return parseError(input, `Objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters.`);
  return { objective: normalizedObjective, tokenBudget, wallTimeBudgetSeconds };
}

/** Backward-compatible name retained for callers while parsing both budget kinds. */
export const parseTokenBudget = parseGoalCommand;

export function normalizeTokenBudget(value: unknown): {
  tokenBudget: number | null;
  error?: string;
} {
  if (value === undefined || value === null) return { tokenBudget: null };
  const tokenBudget = Math.round(Number(value));
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0)
    return { tokenBudget: null, error: 'tokenBudget must be a positive number when provided.' };
  return { tokenBudget };
}

export function normalizeWallTimeBudget(value: unknown): {
  wallTimeBudgetSeconds: number | null;
  error?: string;
} {
  if (value === undefined || value === null) return { wallTimeBudgetSeconds: null };
  const wallTimeBudgetSeconds = Math.round(Number(value));
  if (!Number.isFinite(wallTimeBudgetSeconds) || wallTimeBudgetSeconds <= 0)
    return {
      wallTimeBudgetSeconds: null,
      error: 'timeBudgetSeconds must be a positive number when provided.',
    };
  if (wallTimeBudgetSeconds > MAX_WALL_TIME_BUDGET_SECONDS)
    return {
      wallTimeBudgetSeconds: null,
      error: `timeBudgetSeconds cannot exceed ${MAX_WALL_TIME_BUDGET_SECONDS} seconds (one year).`,
    };
  return { wallTimeBudgetSeconds };
}

export function createGoalState(
  objective: string,
  tokenBudget: number | null,
  now = Date.now(),
  createId: (now: number) => string = (timestamp) =>
    `${timestamp.toString(36)}-${Math.random().toString(36).slice(2)}`,
  wallTimeBudgetSeconds: number | null = null,
): GoalState {
  return {
    id: createId(now),
    objective: objective.trim().slice(0, MAX_GOAL_OBJECTIVE_LENGTH),
    status: 'active',
    tokenBudget,
    wallTimeBudgetSeconds,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    activeWallTimeSeconds: 0,
    activeSince: Math.max(0, now),
    pauseReason: null,
    budgetLimitReason: null,
    createdAt: Math.max(0, now),
    updatedAt: Math.max(0, now),
  };
}

export function accountGoalTurn(
  state: GoalState,
  tokenDelta: number,
  elapsedSeconds: number,
  now = Date.now(),
): GoalState {
  let next: GoalState = {
    ...state,
    tokensUsed: state.tokensUsed + Math.max(0, tokenDelta),
    timeUsedSeconds: state.timeUsedSeconds + Math.max(0, elapsedSeconds),
    updatedAt: Math.max(0, now),
  };
  const reason = evaluateBudgetLimit(next, now);
  if (reason) return transitionGoal(next, 'budget_limited', now, { budgetLimitReason: reason });
  if (next.status === 'active') next = checkpointAndRestartActiveClock(next, now);
  return next;
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
  if (hours < 24) return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

export function formatGoalUsage(state: GoalState, now = Date.now()): string {
  const tokens =
    state.tokenBudget === null
      ? `${formatTokens(state.tokensUsed)} tokens`
      : `${formatTokens(state.tokensUsed)}/${formatTokens(state.tokenBudget)} tokens`;
  const wall =
    state.wallTimeBudgetSeconds === null
      ? `${formatElapsed(activeWallTimeAt(state, now))} active wall`
      : `${formatElapsed(activeWallTimeAt(state, now))}/${formatElapsed(state.wallTimeBudgetSeconds)} active wall`;
  return `${tokens}; ${wall}; ${formatElapsed(state.timeUsedSeconds)} turn time`;
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
  return (
    isRecord(value) &&
    'wallTimeBudgetSeconds' in value &&
    'activeWallTimeSeconds' in value &&
    'activeSince' in value &&
    'pauseReason' in value &&
    'budgetLimitReason' in value &&
    normalizeGoalState(value) !== null
  );
}

export function normalizeGoalState(value: unknown): GoalState | null {
  if (!isRecord(value)) return null;
  const id = boundedString(value.id, 128);
  const objective = boundedString(value.objective, MAX_GOAL_OBJECTIVE_LENGTH);
  if (!id || !objective || !GOAL_STATUSES.has(value.status as GoalStatus)) return null;
  if (value.tokenBudget !== null && !positiveNumber(value.tokenBudget)) return null;
  const wallBudget = value.wallTimeBudgetSeconds ?? null;
  if (
    wallBudget !== null &&
    (!positiveNumber(wallBudget) || wallBudget > MAX_WALL_TIME_BUDGET_SECONDS)
  )
    return null;
  for (const counter of [value.tokensUsed, value.timeUsedSeconds, value.createdAt, value.updatedAt])
    if (!nonNegativeNumber(counter)) return null;
  const activeWallTimeSeconds = value.activeWallTimeSeconds ?? 0;
  const activeSince = value.activeSince ?? null;
  const pauseReason = value.pauseReason ?? null;
  const budgetLimitReason = value.budgetLimitReason ?? null;
  if (!nonNegativeNumber(activeWallTimeSeconds)) return null;
  if (activeSince !== null && !nonNegativeNumber(activeSince)) return null;
  if (!PAUSE_REASONS.has(pauseReason as GoalPauseReason)) return null;
  if (!BUDGET_REASONS.has(budgetLimitReason as GoalBudgetLimitReason)) return null;
  return {
    id,
    objective,
    status: value.status as GoalStatus,
    tokenBudget: value.tokenBudget as number | null,
    wallTimeBudgetSeconds: wallBudget as number | null,
    tokensUsed: value.tokensUsed as number,
    timeUsedSeconds: value.timeUsedSeconds as number,
    activeWallTimeSeconds,
    activeSince,
    pauseReason: pauseReason as GoalPauseReason,
    budgetLimitReason: budgetLimitReason as GoalBudgetLimitReason,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
  };
}

export function restoreGoalState(
  entries: Iterable<unknown>,
  defaultStatusBarEnabled = true,
): GoalPersistedState {
  const branch = [...entries];
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!isRecord(entry) || entry.type !== 'custom' || entry.customType !== GOAL_STATE_CUSTOM_TYPE)
      continue;
    const data = entry.data;
    if (!isRecord(data)) continue;
    const goal = normalizeGoalState(data.goal);
    return {
      goal,
      ledger: goal ? parseGoalEvidenceLedger(data.ledger, goal.id) : null,
      progress: goal ? parseGoalProgressState(data.progress, goal.id) : null,
      statusBarEnabled:
        typeof data.statusBarEnabled === 'boolean'
          ? data.statusBarEnabled
          : defaultStatusBarEnabled,
      restartPolicy: RESTART_POLICIES.has(data.restartPolicy as GoalRestartPolicy)
        ? (data.restartPolicy as GoalRestartPolicy)
        : 'pause',
      noProgressEnabled: typeof data.noProgressEnabled === 'boolean' && data.noProgressEnabled,
      pendingBudgetSummary:
        typeof data.pendingBudgetSummary === 'boolean' && data.pendingBudgetSummary,
    };
  }
  return {
    goal: null,
    ledger: null,
    progress: null,
    statusBarEnabled: defaultStatusBarEnabled,
    restartPolicy: 'pause',
    noProgressEnabled: false,
    pendingBudgetSummary: false,
  };
}

export function createPersistedState(
  goal: GoalState | null,
  ledger: GoalEvidenceLedger | null,
  progress: GoalProgressState | null,
  statusBarEnabled: boolean,
  restartPolicy: GoalRestartPolicy,
  noProgressEnabled: boolean,
  pendingBudgetSummary: boolean,
): GoalPersistedState {
  return {
    goal,
    ledger,
    progress,
    statusBarEnabled,
    restartPolicy,
    noProgressEnabled,
    pendingBudgetSummary,
  };
}

function optionValue(
  token: string,
  name: '--tokens' | '--time',
  next: string | undefined,
): { recognized: boolean; value?: string; consumedNext: boolean } {
  if (token === name)
    return {
      recognized: true,
      value: next && !next.startsWith('--') ? next : undefined,
      consumedNext: Boolean(next) && !next?.startsWith('--'),
    };
  if (token.startsWith(`${name}=`))
    return { recognized: true, value: token.slice(name.length + 1), consumedNext: false };
  return { recognized: false, consumedNext: false };
}

function parseTokenValue(value: string | undefined): number | null {
  const match = value ? TOKEN_VALUE_PATTERN.exec(value) : null;
  if (!match) return null;
  const budget = Math.round(Number(match[1]) * tokenMultiplier(match[2]));
  return Number.isFinite(budget) && budget > 0 ? budget : null;
}

function parseTimeValue(value: string | undefined): { seconds: number | null; error?: string } {
  const match = value ? TIME_VALUE_PATTERN.exec(value) : null;
  if (!match)
    return {
      seconds: null,
      error: 'Time budget must be a positive number with s, m, h, or d suffix.',
    };
  const multiplier = timeMultiplier(match[2] ?? 's');
  const seconds = Math.round(Number(match[1]) * multiplier);
  if (!Number.isFinite(seconds) || seconds <= 0)
    return { seconds: null, error: 'Time budget must round to at least one second.' };
  if (seconds > MAX_WALL_TIME_BUDGET_SECONDS)
    return { seconds: null, error: 'Time budget cannot exceed one year.' };
  return { seconds };
}

function parseError(input: string, error: string): ParsedGoalCommand {
  return { objective: input.trim(), tokenBudget: null, wallTimeBudgetSeconds: null, error };
}
function tokenMultiplier(suffix: string | undefined): number {
  if (suffix?.toLowerCase() === 'm') return 1_000_000;
  if (suffix?.toLowerCase() === 'k') return 1_000;
  return 1;
}
function timeMultiplier(suffix: string): number {
  switch (suffix.toLowerCase()) {
    case 'd':
      return 86_400;
    case 'h':
      return 3_600;
    case 'm':
      return 60;
    default:
      return 1;
  }
}
function boundedString(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
