export type GoalRequirementStatus = 'pending' | 'in_progress' | 'verified' | 'blocked';
export type GoalEvidenceKind =
  | 'file'
  | 'command'
  | 'test'
  | 'log'
  | 'url'
  | 'user_confirmation'
  | 'other';

export interface GoalEvidenceItem {
  id: string;
  kind: GoalEvidenceKind;
  reference: string;
  claim: string;
  recordedAt: number;
}

export interface GoalRequirementEvidence {
  id: string;
  requirement: string;
  status: GoalRequirementStatus;
  evidence: GoalEvidenceItem[];
  blocker?: string;
  updatedAt: number;
}

export interface GoalEvidenceLedger {
  goalId: string;
  revision: number;
  requirements: GoalRequirementEvidence[];
  updatedAt: number;
}

export const MAX_GOAL_REQUIREMENTS = 50;
export const MAX_GOAL_EVIDENCE_PER_REQUIREMENT = 20;
export const MAX_GOAL_EVIDENCE_LEDGER_BYTES = 16 * 1_024;
export const MAX_GOAL_ID_LENGTH = 128;
export const MAX_REQUIREMENT_ID_LENGTH = 96;
export const MAX_REQUIREMENT_LENGTH = 2_000;
export const MAX_EVIDENCE_REFERENCE_LENGTH = 1_024;
export const MAX_EVIDENCE_CLAIM_LENGTH = 1_024;
export const MAX_BLOCKER_LENGTH = 2_000;

const REQUIREMENT_STATUSES = new Set<GoalRequirementStatus>([
  'pending',
  'in_progress',
  'verified',
  'blocked',
]);
const EVIDENCE_KINDS = new Set<GoalEvidenceKind>([
  'file',
  'command',
  'test',
  'log',
  'url',
  'user_confirmation',
  'other',
]);

export type GoalEvidenceMutation =
  | {
      action: 'initialize_requirements';
      expectedRevision: number;
      requirements: Array<{ id: string; requirement: string }>;
    }
  | {
      action: 'upsert_requirement';
      expectedRevision: number;
      requirementId: string;
      requirement: string;
    }
  | {
      action: 'add_evidence';
      expectedRevision: number;
      requirementId: string;
      evidence: Omit<GoalEvidenceItem, 'recordedAt'>;
    }
  | {
      action: 'set_requirement_status';
      expectedRevision: number;
      requirementId: string;
      status: GoalRequirementStatus;
      blocker?: string;
    }
  | {
      action: 'remove_evidence';
      expectedRevision: number;
      requirementId: string;
      evidenceId: string;
    };

export interface GoalEvidenceSummary {
  revision: number;
  total: number;
  pending: number;
  inProgress: number;
  verified: number;
  blocked: number;
}

export function createGoalEvidenceLedger(goalId: string, now: number): GoalEvidenceLedger {
  return {
    goalId: bounded(goalId, MAX_GOAL_ID_LENGTH, 'goal id'),
    revision: 0,
    requirements: [],
    updatedAt: boundedCounter(now),
  };
}

export function summarizeGoalEvidence(ledger: GoalEvidenceLedger | null): GoalEvidenceSummary {
  const requirements = ledger?.requirements ?? [];
  return {
    revision: ledger?.revision ?? 0,
    total: requirements.length,
    pending: requirements.filter((item) => item.status === 'pending').length,
    inProgress: requirements.filter((item) => item.status === 'in_progress').length,
    verified: requirements.filter((item) => item.status === 'verified').length,
    blocked: requirements.filter((item) => item.status === 'blocked').length,
  };
}

export function formatGoalEvidenceSummary(ledger: GoalEvidenceLedger | null): string {
  return formatGoalEvidenceSummaryValue(summarizeGoalEvidence(ledger));
}

export function formatGoalEvidenceSummaryValue(summary: GoalEvidenceSummary): string {
  return `revision ${summary.revision}; ${summary.verified}/${summary.total} verified; ${summary.pending} pending; ${summary.inProgress} in progress; ${summary.blocked} blocked`;
}

export function formatGoalEvidenceChecklist(ledger: GoalEvidenceLedger | null): string {
  if (!ledger || ledger.requirements.length === 0)
    return 'No goal evidence requirements are initialized.';
  return [
    `Goal evidence (${formatGoalEvidenceSummary(ledger)}):`,
    ...ledger.requirements.map((item) => {
      const mark = item.status === 'verified' ? 'x' : ' ';
      const blocker = item.blocker ? `; blocker: ${item.blocker}` : '';
      return `- [${mark}] ${item.id}: ${item.requirement} (${item.status}, ${item.evidence.length} evidence)${blocker}`;
    }),
  ].join('\n');
}

export function completionEvidenceErrors(
  ledger: GoalEvidenceLedger | null,
  goalId: string,
): string[] {
  if (!ledger) return ['The evidence ledger is missing.'];
  if (ledger.goalId !== goalId) return ['The evidence ledger belongs to a different goal.'];
  if (ledger.requirements.length === 0) return ['The evidence ledger has no requirements.'];
  const errors: string[] = [];
  for (const requirement of ledger.requirements) {
    if (requirement.status !== 'verified')
      errors.push(`${requirement.id} is ${requirement.status}, not verified.`);
    else if (requirement.evidence.length === 0)
      errors.push(`${requirement.id} is verified without evidence.`);
  }
  return errors;
}

export function mutateGoalEvidence(
  current: GoalEvidenceLedger | null,
  goalId: string,
  mutation: GoalEvidenceMutation,
  now: number,
): GoalEvidenceLedger {
  const timestamp = boundedCounter(now);
  const ledger = current ?? createGoalEvidenceLedger(goalId, timestamp);
  if (ledger.goalId !== goalId) throw new Error('Evidence update targets a different goal.');
  if (
    !nonNegativeSafeInteger(mutation.expectedRevision) ||
    mutation.expectedRevision !== ledger.revision
  )
    throw new Error(`Stale evidence revision: expected ${ledger.revision}.`);
  let requirements = ledger.requirements.map(cloneRequirement);
  if (mutation.action === 'initialize_requirements') {
    if (requirements.length > 0)
      throw new Error('Requirements are already initialized; use user-confirmed evidence reset.');
    if (mutation.requirements.length === 0)
      throw new Error('At least one requirement is required.');
    if (mutation.requirements.length > MAX_GOAL_REQUIREMENTS)
      throw new Error(`At most ${MAX_GOAL_REQUIREMENTS} requirements are allowed.`);
    const ids = new Set<string>();
    requirements = mutation.requirements.map((item) => {
      const id = bounded(item.id, MAX_REQUIREMENT_ID_LENGTH, 'requirement id');
      if (ids.has(id)) throw new Error(`Duplicate requirement id: ${id}.`);
      ids.add(id);
      return {
        id,
        requirement: bounded(item.requirement, MAX_REQUIREMENT_LENGTH, 'requirement'),
        status: 'pending' as const,
        evidence: [],
        updatedAt: timestamp,
      };
    });
  } else if (mutation.action === 'upsert_requirement') {
    const id = bounded(mutation.requirementId, MAX_REQUIREMENT_ID_LENGTH, 'requirement id');
    const requirement = bounded(mutation.requirement, MAX_REQUIREMENT_LENGTH, 'requirement');
    const index = requirements.findIndex((item) => item.id === id);
    if (index < 0) {
      if (requirements.length >= MAX_GOAL_REQUIREMENTS)
        throw new Error(`At most ${MAX_GOAL_REQUIREMENTS} requirements are allowed.`);
      requirements.push({
        id,
        requirement,
        status: 'pending',
        evidence: [],
        updatedAt: timestamp,
      });
    } else {
      const currentRequirement = requirements[index];
      if (!currentRequirement) throw new Error(`Unknown requirement id: ${id}.`);
      if (currentRequirement.requirement === requirement) return ledger;
      requirements[index] = {
        id,
        requirement,
        status: 'pending',
        evidence: [],
        updatedAt: timestamp,
      };
    }
  } else if (mutation.action === 'add_evidence') {
    const requirement = findRequirement(requirements, mutation.requirementId);
    if (requirement.evidence.length >= MAX_GOAL_EVIDENCE_PER_REQUIREMENT)
      throw new Error(
        `At most ${MAX_GOAL_EVIDENCE_PER_REQUIREMENT} evidence items are allowed per requirement.`,
      );
    const evidence = normalizeEvidenceItem({ ...mutation.evidence, recordedAt: timestamp });
    if (requirement.evidence.some((item) => item.id === evidence.id))
      throw new Error(`Duplicate evidence id: ${evidence.id}.`);
    requirement.evidence.push(evidence);
    requirement.updatedAt = timestamp;
  } else if (mutation.action === 'set_requirement_status') {
    const requirement = findRequirement(requirements, mutation.requirementId);
    if (!REQUIREMENT_STATUSES.has(mutation.status)) throw new Error('Unknown requirement status.');
    const blocker = mutation.blocker?.trim();
    if (mutation.status === 'verified' && requirement.evidence.length === 0)
      throw new Error('Verified requirements must have at least one evidence item.');
    if (mutation.status === 'blocked' && !blocker)
      throw new Error('Blocked requirements must include a blocker.');
    const nextBlocker =
      mutation.status === 'blocked' ? bounded(blocker, MAX_BLOCKER_LENGTH, 'blocker') : undefined;
    if (requirement.status === mutation.status && requirement.blocker === nextBlocker)
      return ledger;
    requirement.status = mutation.status;
    requirement.blocker = nextBlocker;
    requirement.updatedAt = timestamp;
  } else if (mutation.action === 'remove_evidence') {
    const requirement = findRequirement(requirements, mutation.requirementId);
    const index = requirement.evidence.findIndex((item) => item.id === mutation.evidenceId);
    if (index < 0) throw new Error(`Unknown evidence id: ${mutation.evidenceId}.`);
    if (requirement.status === 'verified' && requirement.evidence.length === 1)
      throw new Error('Cannot remove the last evidence item from a verified requirement.');
    requirement.evidence.splice(index, 1);
    requirement.updatedAt = timestamp;
  } else {
    return assertNever(mutation);
  }

  if (!nonNegativeSafeInteger(ledger.revision) || ledger.revision === Number.MAX_SAFE_INTEGER)
    throw new Error('Evidence revision cannot be incremented safely.');
  const next = {
    goalId,
    revision: ledger.revision + 1,
    requirements,
    updatedAt: timestamp,
  };
  if (goalEvidenceLedgerByteLength(next) > MAX_GOAL_EVIDENCE_LEDGER_BYTES)
    throw new Error(
      `Evidence ledger cannot exceed ${MAX_GOAL_EVIDENCE_LEDGER_BYTES} serialized bytes.`,
    );
  return next;
}

export function parseGoalEvidenceLedger(value: unknown, goalId: string): GoalEvidenceLedger | null {
  if (
    !isRecord(value) ||
    value.goalId !== goalId ||
    !parseBounded(value.goalId, MAX_GOAL_ID_LENGTH) ||
    !nonNegativeSafeInteger(value.revision)
  )
    return null;
  if (!Array.isArray(value.requirements) || value.requirements.length > MAX_GOAL_REQUIREMENTS)
    return null;
  if (!boundedNonNegativeNumber(value.updatedAt)) return null;
  const requirements: GoalRequirementEvidence[] = [];
  const ids = new Set<string>();
  for (const raw of value.requirements) {
    const requirement = parseRequirement(raw);
    if (!requirement || ids.has(requirement.id)) return null;
    ids.add(requirement.id);
    requirements.push(requirement);
  }
  const ledger = { goalId, revision: value.revision, requirements, updatedAt: value.updatedAt };
  return goalEvidenceLedgerByteLength(ledger) <= MAX_GOAL_EVIDENCE_LEDGER_BYTES ? ledger : null;
}

export function goalEvidenceLedgerByteLength(ledger: GoalEvidenceLedger): number {
  return new TextEncoder().encode(JSON.stringify(ledger)).byteLength;
}

function parseRequirement(value: unknown): GoalRequirementEvidence | null {
  if (!isRecord(value)) return null;
  const id = parseBounded(value.id, MAX_REQUIREMENT_ID_LENGTH);
  const requirement = parseBounded(value.requirement, MAX_REQUIREMENT_LENGTH);
  if (!id || !requirement || !REQUIREMENT_STATUSES.has(value.status as GoalRequirementStatus))
    return null;
  if (!Array.isArray(value.evidence) || value.evidence.length > MAX_GOAL_EVIDENCE_PER_REQUIREMENT)
    return null;
  const evidence: GoalEvidenceItem[] = [];
  const ids = new Set<string>();
  for (const raw of value.evidence) {
    const item = parseEvidenceItem(raw);
    if (!item || ids.has(item.id)) return null;
    ids.add(item.id);
    evidence.push(item);
  }
  const blocker =
    value.blocker === undefined ? undefined : parseBounded(value.blocker, MAX_BLOCKER_LENGTH);
  if (value.blocker !== undefined && !blocker) return null;
  if (blocker && value.status !== 'blocked') return null;
  if (value.status === 'verified' && evidence.length === 0) return null;
  if (value.status === 'blocked' && !blocker) return null;
  if (!boundedNonNegativeNumber(value.updatedAt)) return null;
  return {
    id,
    requirement,
    status: value.status as GoalRequirementStatus,
    evidence,
    ...(blocker ? { blocker } : {}),
    updatedAt: value.updatedAt,
  };
}

function parseEvidenceItem(value: unknown): GoalEvidenceItem | null {
  if (!isRecord(value)) return null;
  const id = parseBounded(value.id, MAX_REQUIREMENT_ID_LENGTH);
  const reference = parseBounded(value.reference, MAX_EVIDENCE_REFERENCE_LENGTH);
  const claim = parseBounded(value.claim, MAX_EVIDENCE_CLAIM_LENGTH);
  if (!id || !reference || !claim || !EVIDENCE_KINDS.has(value.kind as GoalEvidenceKind))
    return null;
  if (!boundedNonNegativeNumber(value.recordedAt)) return null;
  return {
    id,
    kind: value.kind as GoalEvidenceKind,
    reference,
    claim,
    recordedAt: value.recordedAt,
  };
}

function normalizeEvidenceItem(value: GoalEvidenceItem): GoalEvidenceItem {
  if (!EVIDENCE_KINDS.has(value.kind)) throw new Error('Unknown evidence kind.');
  return {
    id: bounded(value.id, MAX_REQUIREMENT_ID_LENGTH, 'evidence id'),
    kind: value.kind,
    reference: bounded(value.reference, MAX_EVIDENCE_REFERENCE_LENGTH, 'evidence reference'),
    claim: bounded(value.claim, MAX_EVIDENCE_CLAIM_LENGTH, 'evidence claim'),
    recordedAt: boundedCounter(value.recordedAt),
  };
}

function findRequirement(
  requirements: GoalRequirementEvidence[],
  id: string,
): GoalRequirementEvidence {
  const normalized = bounded(id, MAX_REQUIREMENT_ID_LENGTH, 'requirement id');
  const requirement = requirements.find((item) => item.id === normalized);
  if (!requirement) throw new Error(`Unknown requirement id: ${normalized}.`);
  return requirement;
}

function cloneRequirement(item: GoalRequirementEvidence): GoalRequirementEvidence {
  return { ...item, evidence: item.evidence.map((evidence) => ({ ...evidence })) };
}

function bounded(value: string | undefined, maximum: number, label: string): string {
  const parsed = parseBounded(value, maximum);
  if (!parsed)
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters.`);
  return parsed;
}

function parseBounded(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function boundedNonNegativeNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}
function nonNegativeSafeInteger(value: unknown): value is number {
  return boundedNonNegativeNumber(value) && Number.isSafeInteger(value);
}
function boundedCounter(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, value);
}
function assertNever(value: never): never {
  throw new Error(`Unknown evidence action: ${JSON.stringify(value)}`);
}
