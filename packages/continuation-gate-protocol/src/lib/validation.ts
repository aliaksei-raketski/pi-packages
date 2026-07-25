import {
  CONTINUATION_GATE_PROTOCOL_VERSION,
  type ContinuationGate,
  type ContinuationGateRelease,
  type ContinuationGateReleaseOutcome,
  type ContinuationGateResource,
  type ContinuationGateSnapshot,
  type ContinuationGateSnapshotRequest,
  type ContinuationGateWakeDisposition,
} from './protocol.js';

const MAX_ID_LENGTH = 256;
const MAX_REASON_LENGTH = 2_048;
const MAX_LABEL_LENGTH = 512;

const RELEASE_OUTCOMES = new Set<ContinuationGateReleaseOutcome>([
  'completed',
  'failed',
  'cancelled',
  'killed',
  'abandoned',
]);
const WAKE_DISPOSITIONS = new Set<ContinuationGateWakeDisposition>([
  'producer-message',
  'current-turn',
  'none',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseBoundedString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string' || value.length > maximumLength) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasSupportedVersion(payload: unknown): payload is Record<string, unknown> {
  return isRecord(payload) && payload.protocolVersion === CONTINUATION_GATE_PROTOCOL_VERSION;
}

function parseGateIdentity(
  payload: Record<string, unknown>,
): Pick<ContinuationGate, 'sessionId' | 'source' | 'gateId'> | undefined {
  const sessionId = parseBoundedString(payload.sessionId, MAX_ID_LENGTH);
  const source = parseBoundedString(payload.source, MAX_ID_LENGTH);
  const gateId = parseBoundedString(payload.gateId, MAX_ID_LENGTH);
  return sessionId && source && gateId ? { sessionId, source, gateId } : undefined;
}

function parseResource(value: unknown): ContinuationGateResource | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const kind = parseBoundedString(value.kind, MAX_ID_LENGTH);
  const id = parseBoundedString(value.id, MAX_ID_LENGTH);
  if (!kind || !id) {
    return undefined;
  }

  if (value.label === undefined) {
    return { kind, id };
  }

  const label = parseBoundedString(value.label, MAX_LABEL_LENGTH);
  return label ? { kind, id, label } : undefined;
}

function parseGate(payload: unknown): ContinuationGate | undefined {
  if (!hasSupportedVersion(payload)) {
    return undefined;
  }

  const identity = parseGateIdentity(payload);
  const reason = parseBoundedString(payload.reason, MAX_REASON_LENGTH);
  const acquiredAt = parseTimestamp(payload.acquiredAt);
  if (!identity || !reason || acquiredAt === undefined) {
    return undefined;
  }
  const { sessionId, source, gateId } = identity;

  if (payload.resource === undefined) {
    return {
      protocolVersion: CONTINUATION_GATE_PROTOCOL_VERSION,
      sessionId,
      source,
      gateId,
      reason,
      acquiredAt,
    };
  }

  const resource = parseResource(payload.resource);
  if (!resource) {
    return undefined;
  }

  return {
    protocolVersion: CONTINUATION_GATE_PROTOCOL_VERSION,
    sessionId,
    source,
    gateId,
    reason,
    acquiredAt,
    resource,
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
    if (!hasSupportedVersion(payload)) {
      return undefined;
    }

    const identity = parseGateIdentity(payload);
    const releasedAt = parseTimestamp(payload.releasedAt);
    const outcome = payload.outcome;
    const wake = payload.wake;
    if (
      !identity ||
      releasedAt === undefined ||
      typeof outcome !== 'string' ||
      !RELEASE_OUTCOMES.has(outcome as ContinuationGateReleaseOutcome) ||
      typeof wake !== 'string' ||
      !WAKE_DISPOSITIONS.has(wake as ContinuationGateWakeDisposition)
    ) {
      return undefined;
    }

    return {
      protocolVersion: CONTINUATION_GATE_PROTOCOL_VERSION,
      ...identity,
      outcome: outcome as ContinuationGateReleaseOutcome,
      wake: wake as ContinuationGateWakeDisposition,
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
    if (!hasSupportedVersion(payload)) {
      return undefined;
    }

    const requestId = parseBoundedString(payload.requestId, MAX_ID_LENGTH);
    const sessionId = parseBoundedString(payload.sessionId, MAX_ID_LENGTH);
    if (!requestId || !sessionId) {
      return undefined;
    }

    return {
      protocolVersion: CONTINUATION_GATE_PROTOCOL_VERSION,
      requestId,
      sessionId,
    };
  } catch {
    return undefined;
  }
}

export function parseContinuationGateSnapshot(
  payload: unknown,
): ContinuationGateSnapshot | undefined {
  try {
    if (!hasSupportedVersion(payload) || !Array.isArray(payload.gates)) {
      return undefined;
    }

    const sessionId = parseBoundedString(payload.sessionId, MAX_ID_LENGTH);
    const source = parseBoundedString(payload.source, MAX_ID_LENGTH);
    if (!sessionId || !source) {
      return undefined;
    }

    let requestId: string | undefined;
    if (payload.requestId !== undefined) {
      requestId = parseBoundedString(payload.requestId, MAX_ID_LENGTH);
      if (!requestId) {
        return undefined;
      }
    }

    const gates: ContinuationGate[] = [];
    for (const candidate of payload.gates) {
      const gate = parseContinuationGateAcquire(candidate);
      if (gate && gate.sessionId === sessionId && gate.source === source) {
        gates.push(gate);
      }
    }

    return {
      protocolVersion: CONTINUATION_GATE_PROTOCOL_VERSION,
      ...(requestId ? { requestId } : {}),
      sessionId,
      source,
      gates,
    };
  } catch {
    return undefined;
  }
}
