import type { GoalEvidenceLedger } from './goal-evidence.ts';

export interface GoalProgressObservation {
  goalId: string;
  observedAt: number;
  summaryFingerprint: string;
  summaryTokenCount: number;
  toolPattern: string;
  evidenceRevision: number;
}

export interface GoalProgressState {
  observations: GoalProgressObservation[];
  stagnationStreak: number;
  lastProgressAt: number;
  pausedAt?: number;
}

export const GOAL_PROGRESS_WINDOW = 4;
export const GOAL_PROGRESS_SIMILARITY = 0.9;
export const GOAL_STAGNATION_THRESHOLD = 3;
const MAX_SUMMARY_TOKENS = 512;
const MIN_STAGNATION_SUMMARY_TOKENS = 3;
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;

export interface GoalProgressInput {
  goalId: string;
  observedAt: number;
  assistantText: string;
  tools: ReadonlyArray<{ name: string; isError: boolean }>;
  evidenceRevision: number;
}

export interface GoalProgressResult {
  state: GoalProgressState;
  shouldPause: boolean;
}

export function createGoalProgressState(now: number): GoalProgressState {
  return { observations: [], stagnationStreak: 0, lastProgressAt: Math.max(0, now) };
}

export function resetGoalProgress(now: number): GoalProgressState {
  return { observations: [], stagnationStreak: 0, lastProgressAt: Math.max(0, now) };
}

export function resumeGoalProgress(
  state: GoalProgressState | null,
  now: number,
): GoalProgressState {
  return {
    ...(state ?? createGoalProgressState(now)),
    stagnationStreak: 0,
    lastProgressAt: Math.max(0, now),
    pausedAt: undefined,
  };
}

export function observeGoalProgress(
  current: GoalProgressState | null,
  input: GoalProgressInput,
): GoalProgressResult {
  const state = current ?? createGoalProgressState(input.observedAt);
  const summary = normalizeSummary(input.assistantText);
  const observation: GoalProgressObservation = {
    goalId: input.goalId,
    observedAt: Math.max(0, input.observedAt),
    summaryFingerprint: simHash64(summary.tokens),
    summaryTokenCount: summary.tokens.length,
    toolPattern: hash64(
      input.tools.map((tool) => `${tool.name}:${tool.isError ? 'error' : 'success'}`).join('|'),
    ),
    evidenceRevision: Math.max(0, Math.floor(input.evidenceRevision)),
  };
  const repeated = state.observations.some(
    (recent) =>
      recent.goalId === input.goalId &&
      recent.evidenceRevision === observation.evidenceRevision &&
      recent.toolPattern === observation.toolPattern &&
      recent.summaryTokenCount >= MIN_STAGNATION_SUMMARY_TOKENS &&
      observation.summaryTokenCount >= MIN_STAGNATION_SUMMARY_TOKENS &&
      fingerprintSimilarity(recent.summaryFingerprint, observation.summaryFingerprint) >=
        GOAL_PROGRESS_SIMILARITY,
  );
  const stagnationStreak = repeated ? state.stagnationStreak + 1 : 0;
  const observations = [...state.observations, observation].slice(-GOAL_PROGRESS_WINDOW);
  const shouldPause = stagnationStreak >= GOAL_STAGNATION_THRESHOLD;
  return {
    state: {
      observations,
      stagnationStreak,
      lastProgressAt: repeated ? state.lastProgressAt : observation.observedAt,
      ...(shouldPause ? { pausedAt: observation.observedAt } : {}),
    },
    shouldPause,
  };
}

export function ledgerRevision(ledger: GoalEvidenceLedger | null): number {
  return ledger?.revision ?? 0;
}

export function normalizeSummary(text: string): { tokens: string[] } {
  const normalized = text
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z?)?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, '<id>')
    .replace(/\b(?:0x)?[0-9a-f]{12,}\b/g, '<id>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/[^a-z0-9_<>-]+/g, ' ')
    .trim();
  return { tokens: normalized ? normalized.split(/\s+/).slice(0, MAX_SUMMARY_TOKENS) : [] };
}

export function fingerprintSimilarity(left: string, right: string): number {
  if (!FINGERPRINT_PATTERN.test(left) || !FINGERPRINT_PATTERN.test(right)) return 0;
  let different = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (different > 0n) {
    distance += Number(different & 1n);
    different >>= 1n;
  }
  return (64 - distance) / 64;
}

export function simHash64(tokens: readonly string[]): string {
  if (tokens.length === 0) return '0000000000000000';
  const weights = new Array<number>(64).fill(0);
  for (const token of tokens) {
    const hash = BigInt(`0x${hash64(token)}`);
    for (let bit = 0; bit < 64; bit += 1)
      weights[bit] = (weights[bit] ?? 0) + ((hash & (1n << BigInt(bit))) === 0n ? -1 : 1);
  }
  let fingerprint = 0n;
  for (let bit = 0; bit < 64; bit += 1)
    if ((weights[bit] ?? 0) >= 0) fingerprint |= 1n << BigInt(bit);
  return fingerprint.toString(16).padStart(16, '0');
}

export function hash64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function parseGoalProgressState(value: unknown, goalId: string): GoalProgressState | null {
  if (!isRecord(value) || !Array.isArray(value.observations)) return null;
  if (value.observations.length > GOAL_PROGRESS_WINDOW) return null;
  if (!nonNegativeInteger(value.stagnationStreak) || !nonNegativeNumber(value.lastProgressAt))
    return null;
  if (value.pausedAt !== undefined && !nonNegativeNumber(value.pausedAt)) return null;
  const observations: GoalProgressObservation[] = [];
  for (const raw of value.observations) {
    if (!isRecord(raw) || raw.goalId !== goalId) return null;
    if (
      !nonNegativeNumber(raw.observedAt) ||
      typeof raw.summaryFingerprint !== 'string' ||
      !FINGERPRINT_PATTERN.test(raw.summaryFingerprint) ||
      !nonNegativeInteger(raw.summaryTokenCount) ||
      raw.summaryTokenCount > MAX_SUMMARY_TOKENS ||
      typeof raw.toolPattern !== 'string' ||
      !FINGERPRINT_PATTERN.test(raw.toolPattern) ||
      !nonNegativeInteger(raw.evidenceRevision)
    )
      return null;
    observations.push({
      goalId,
      observedAt: raw.observedAt,
      summaryFingerprint: raw.summaryFingerprint,
      summaryTokenCount: raw.summaryTokenCount,
      toolPattern: raw.toolPattern,
      evidenceRevision: raw.evidenceRevision,
    });
  }
  return {
    observations,
    stagnationStreak: value.stagnationStreak,
    lastProgressAt: value.lastProgressAt,
    ...(value.pausedAt === undefined ? {} : { pausedAt: value.pausedAt }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function nonNegativeInteger(value: unknown): value is number {
  return nonNegativeNumber(value) && Number.isInteger(value);
}
