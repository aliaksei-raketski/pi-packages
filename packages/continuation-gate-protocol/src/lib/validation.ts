import {
  CONTINUATION_GATE_DEFAULT_DOMAIN,
  type ContinuationGate,
  type ContinuationGateLease,
  type ContinuationGateLeasePolicy,
  type ContinuationGateRelease,
  type ContinuationGateReleaseOutcome,
  type ContinuationGateResource,
  type ContinuationGateResumeClaim,
  type ContinuationGateSnapshot,
  type ContinuationGateSnapshotRequest,
  type ContinuationGateTelemetryEvent,
  type ContinuationGateWakeHandoff,
  type ContinuationGateWakeDisposition,
  type ContinuationGateUnblocked,
} from './protocol.js';

export const MAX_ID_LENGTH = 256;
export const MAX_REASON_LENGTH = 2_048;
export const MAX_LABEL_LENGTH = 512;
export const MAX_DOMAIN_LENGTH = 128;
export const MAX_SNAPSHOT_GATES = 512;
export const MAX_DIAGNOSTIC_COUNT = 128;
export const MAX_HANDOFFS = 256;
export const MAX_RESUME_CLAIMS = 256;
export const MAX_TIMESTAMP = 8_640_000_000_000_000;
export const MAX_GENERATION = Number.MAX_SAFE_INTEGER - 1;

const RELEASE_OUTCOMES = new Set<ContinuationGateReleaseOutcome>([
  'completed',
  'failed',
  'cancelled',
  'killed',
  'abandoned',
  'expired',
]);
const WAKE_DISPOSITIONS = new Set<ContinuationGateWakeDisposition>([
  'producer-message',
  'current-turn',
  'none',
]);
const LEASE_POLICIES = new Set<ContinuationGateLeasePolicy>(['diagnose', 'expire']);
const TELEMETRY_FIELDS: Record<string, readonly string[]> = {
  gate_acquired: ['sessionHash', 'sourceHash', 'gateHash', 'domain'],
  gate_reacquired: ['sessionHash', 'sourceHash', 'gateHash', 'domain'],
  gate_released: ['sessionHash', 'sourceHash', 'gateHash', 'domain', 'outcome'],
  gate_expired: ['sessionHash', 'sourceHash', 'gateHash', 'domain', 'outcome'],
  gate_stale: ['sessionHash', 'sourceHash', 'gateHash', 'domain', 'expiresAt'],
  gate_renewed: ['sessionHash', 'sourceHash', 'gateHash', 'domain', 'expiresAt'],
  snapshot_requested: ['sessionHash', 'requestHash'],
  snapshot_applied: ['sessionHash', 'sourceHash', 'count'],
  snapshot_timeout: ['sessionHash', 'requestHash', 'count'],
  provider_unresponsive: ['sessionHash', 'sourceHash'],
  provider_recovered: ['sessionHash', 'sourceHash'],
  wake_handoff_invalid: ['sessionHash', 'sourceHash', 'gateHash', 'diagnosticCode'],
  resume_claimed: ['sessionHash', 'domain', 'transitionHash'],
  resume_committed: ['sessionHash', 'domain', 'transitionHash'],
  resume_aborted: ['sessionHash', 'domain', 'transitionHash'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseBoundedString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string' || value.length > maximumLength) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function parseTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP
    ? value
    : undefined;
}

function parseIdentity(
  payload: Record<string, unknown>,
): Pick<ContinuationGate, 'sessionId' | 'source' | 'gateId'> | undefined {
  const sessionId = parseBoundedString(payload.sessionId, MAX_ID_LENGTH);
  const source = parseBoundedString(payload.source, MAX_ID_LENGTH);
  const gateId = parseBoundedString(payload.gateId, MAX_ID_LENGTH);
  return sessionId && source && gateId ? { sessionId, source, gateId } : undefined;
}

function parseResource(value: unknown): ContinuationGateResource | undefined {
  if (!isRecord(value)) return undefined;
  const kind = parseBoundedString(value.kind, MAX_ID_LENGTH);
  const id = parseBoundedString(value.id, MAX_ID_LENGTH);
  if (!kind || !id) return undefined;
  if (value.label === undefined) return { kind, id };
  const label = parseBoundedString(value.label, MAX_LABEL_LENGTH);
  return label ? { kind, id, label } : undefined;
}

function parseLease(value: unknown, updatedAt: number): ContinuationGateLease | undefined {
  if (!isRecord(value)) return undefined;
  const expiresAt = parseTimestamp(value.expiresAt);
  const policy = value.policy;
  if (
    expiresAt === undefined ||
    expiresAt <= updatedAt ||
    typeof policy !== 'string' ||
    !LEASE_POLICIES.has(policy as ContinuationGateLeasePolicy)
  )
    return undefined;
  return { expiresAt, policy: policy as ContinuationGateLeasePolicy };
}

function parseGate(payload: unknown): ContinuationGate | undefined {
  if (!isRecord(payload)) return undefined;
  const identity = parseIdentity(payload);
  const domain = parseBoundedString(
    payload.domain ?? CONTINUATION_GATE_DEFAULT_DOMAIN,
    MAX_DOMAIN_LENGTH,
  );
  const reason = parseBoundedString(payload.reason, MAX_REASON_LENGTH);
  const acquiredAt = parseTimestamp(payload.acquiredAt);
  const updatedAt = parseTimestamp(payload.updatedAt ?? acquiredAt);
  if (
    !identity ||
    !domain ||
    !reason ||
    acquiredAt === undefined ||
    updatedAt === undefined ||
    updatedAt < acquiredAt
  ) {
    return undefined;
  }
  let resource: ContinuationGateResource | undefined;
  if (payload.resource !== undefined) {
    resource = parseResource(payload.resource);
    if (!resource) return undefined;
  }
  let lease: ContinuationGateLease | undefined;
  if (payload.lease !== undefined) {
    lease = parseLease(payload.lease, updatedAt);
    if (!lease) return undefined;
  }
  return {
    ...identity,
    domain,
    reason,
    acquiredAt,
    updatedAt,
    ...(resource ? { resource } : {}),
    ...(lease ? { lease } : {}),
  };
}

export function parseContinuationGateAcquire(payload: unknown): ContinuationGate | undefined {
  try {
    return parseGate(payload);
  } catch {
    return undefined;
  }
}

export function isContinuationGate(value: unknown): value is ContinuationGate {
  return parseContinuationGateAcquire(value) !== undefined;
}

export function parseContinuationGateRelease(
  payload: unknown,
): ContinuationGateRelease | undefined {
  try {
    if (!isRecord(payload)) return undefined;
    const identity = parseIdentity(payload);
    const domain = parseBoundedString(payload.domain, MAX_DOMAIN_LENGTH);
    const releaseId = parseBoundedString(payload.releaseId, MAX_ID_LENGTH);
    const releasedAt = parseTimestamp(payload.releasedAt);
    const outcome = payload.outcome;
    const wake = payload.wake;
    const handoffId =
      payload.handoffId === undefined
        ? undefined
        : parseBoundedString(payload.handoffId, MAX_ID_LENGTH);
    if (
      !identity ||
      !domain ||
      !releaseId ||
      releasedAt === undefined ||
      typeof outcome !== 'string' ||
      !RELEASE_OUTCOMES.has(outcome as ContinuationGateReleaseOutcome) ||
      typeof wake !== 'string' ||
      !WAKE_DISPOSITIONS.has(wake as ContinuationGateWakeDisposition) ||
      (wake === 'producer-message' && !handoffId)
    )
      return undefined;
    return {
      ...identity,
      domain,
      releaseId,
      outcome: outcome as ContinuationGateReleaseOutcome,
      wake: wake as ContinuationGateWakeDisposition,
      ...(handoffId ? { handoffId } : {}),
      releasedAt,
    };
  } catch {
    return undefined;
  }
}

export function parseContinuationGateSnapshotRequest(
  payload: unknown,
): ContinuationGateSnapshotRequest | undefined {
  try {
    if (!isRecord(payload)) return undefined;
    const requestId = parseBoundedString(payload.requestId, MAX_ID_LENGTH);
    const sessionId = parseBoundedString(payload.sessionId, MAX_ID_LENGTH);
    return requestId && sessionId ? { requestId, sessionId } : undefined;
  } catch {
    return undefined;
  }
}

export function parseContinuationGateSnapshot(
  payload: unknown,
): ContinuationGateSnapshot | undefined {
  try {
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.gates) ||
      payload.gates.length > MAX_SNAPSHOT_GATES
    )
      return undefined;
    const sessionId = parseBoundedString(payload.sessionId, MAX_ID_LENGTH);
    const source = parseBoundedString(payload.source, MAX_ID_LENGTH);
    if (!sessionId || !source) return undefined;
    let requestId: string | undefined;
    if (payload.requestId !== undefined) {
      requestId = parseBoundedString(payload.requestId, MAX_ID_LENGTH);
      if (!requestId) return undefined;
    }
    const gates: ContinuationGate[] = [];
    const gateIds = new Set<string>();
    for (const candidate of payload.gates) {
      const gate = parseContinuationGateAcquire(candidate);
      if (
        !gate ||
        gate.sessionId !== sessionId ||
        gate.source !== source ||
        gateIds.has(gate.gateId)
      )
        return undefined;
      gateIds.add(gate.gateId);
      gates.push(gate);
    }
    return { ...(requestId ? { requestId } : {}), sessionId, source, gates };
  } catch {
    return undefined;
  }
}

function parseHandoff(payload: unknown): ContinuationGateWakeHandoff | undefined {
  try {
    if (!isRecord(payload)) return undefined;
    const handoffId = parseBoundedString(payload.handoffId, MAX_ID_LENGTH);
    const sessionId = parseBoundedString(payload.sessionId, MAX_ID_LENGTH);
    const source = parseBoundedString(payload.source, MAX_ID_LENGTH);
    const gateId = parseBoundedString(payload.gateId, MAX_ID_LENGTH);
    const domain = parseBoundedString(payload.domain, MAX_DOMAIN_LENGTH);
    const createdAt = parseTimestamp(payload.createdAt);
    return handoffId && sessionId && source && gateId && domain && createdAt !== undefined
      ? { handoffId, sessionId, source, gateId, domain, createdAt }
      : undefined;
  } catch {
    return undefined;
  }
}

export const parseContinuationGateWakeHandoff = parseHandoff;

export function parseContinuationGateResumeClaim(
  payload: unknown,
): ContinuationGateResumeClaim | undefined {
  try {
    if (!isRecord(payload)) return undefined;
    const claimId = parseBoundedString(payload.claimId, MAX_ID_LENGTH);
    const transitionId = parseBoundedString(payload.transitionId, MAX_ID_LENGTH);
    const sessionId = parseBoundedString(payload.sessionId, MAX_ID_LENGTH);
    const domain = parseBoundedString(payload.domain, MAX_DOMAIN_LENGTH);
    const consumerId = parseBoundedString(payload.consumerId, MAX_ID_LENGTH);
    const generation = payload.generation;
    const expiresAt = parseTimestamp(payload.expiresAt);
    return claimId &&
      transitionId &&
      sessionId &&
      domain &&
      consumerId &&
      typeof generation === 'number' &&
      Number.isSafeInteger(generation) &&
      generation >= 0 &&
      generation < MAX_GENERATION &&
      expiresAt !== undefined
      ? { claimId, transitionId, sessionId, domain, consumerId, generation, expiresAt }
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseContinuationGateUnblocked(
  payload: unknown,
): ContinuationGateUnblocked | undefined {
  try {
    if (!isRecord(payload)) return undefined;
    const transitionId = parseBoundedString(payload.transitionId, MAX_ID_LENGTH);
    const sessionId = parseBoundedString(payload.sessionId, MAX_ID_LENGTH);
    const domain = parseBoundedString(payload.domain, MAX_DOMAIN_LENGTH);
    const wakeDisposition = payload.wakeDisposition;
    const handoffId =
      payload.handoffId === undefined
        ? undefined
        : parseBoundedString(payload.handoffId, MAX_ID_LENGTH);
    const generation = payload.generation;
    if (
      !transitionId ||
      !sessionId ||
      !domain ||
      typeof wakeDisposition !== 'string' ||
      !WAKE_DISPOSITIONS.has(wakeDisposition as ContinuationGateWakeDisposition) ||
      (wakeDisposition === 'producer-message' && !handoffId) ||
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      generation >= MAX_GENERATION
    )
      return undefined;
    return {
      transitionId,
      sessionId,
      domain,
      wakeDisposition: wakeDisposition as ContinuationGateWakeDisposition,
      ...(handoffId ? { handoffId } : {}),
      generation,
    };
  } catch {
    return undefined;
  }
}

export function isContinuationGateTelemetryEvent(
  value: unknown,
): value is ContinuationGateTelemetryEvent {
  try {
    if (
      !isRecord(value) ||
      typeof value.kind !== 'string' ||
      parseTimestamp(value.timestamp) === undefined ||
      value.kind.length > MAX_ID_LENGTH
    )
      return false;
    const fields = TELEMETRY_FIELDS[value.kind];
    if (!fields) return false;
    return fields.every((field) =>
      field === 'count'
        ? typeof value[field] === 'number' &&
          Number.isSafeInteger(value[field]) &&
          value[field] >= 0 &&
          value[field] <= MAX_SNAPSHOT_GATES
        : field === 'expiresAt'
          ? parseTimestamp(value[field]) !== undefined
          : !!parseBoundedString(
              value[field],
              field === 'domain' ? MAX_DOMAIN_LENGTH : MAX_ID_LENGTH,
            ),
    );
  } catch {
    return false;
  }
}
