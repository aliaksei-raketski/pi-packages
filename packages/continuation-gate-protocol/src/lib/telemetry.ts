import {
  CONTINUATION_GATE_TELEMETRY_EVENT,
  type ContinuationGateProtocolHost,
  type ContinuationGateReleaseOutcome,
  type ContinuationGateTelemetryEvent,
} from './protocol.js';
import {
  MAX_DOMAIN_LENGTH,
  MAX_ID_LENGTH,
  parseBoundedString,
  parseTimestamp,
} from './validation.js';

/** Process-local correlation hash; this is intentionally not an identity boundary. */
export function hashContinuationGateValue(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function publishContinuationGateTelemetry(
  host: ContinuationGateProtocolHost,
  event: ContinuationGateTelemetryEvent,
): void {
  try {
    host.events.emit(
      CONTINUATION_GATE_TELEMETRY_EVENT,
      createContinuationGateTelemetryEvent(event),
    );
  } catch {
    // Telemetry is optional and must not interrupt a producer or consumer.
  }
}

export function createContinuationGateTelemetryEvent(
  event: ContinuationGateTelemetryEvent,
): ContinuationGateTelemetryEvent {
  const value = event as unknown as Record<string, unknown>;
  const kind = parseBoundedString(value.kind, MAX_ID_LENGTH);
  const timestamp = parseTimestamp(value.timestamp);
  if (!kind || timestamp === undefined)
    throw new TypeError('Invalid continuation gate telemetry event.');
  const base = { kind, timestamp } as { kind: string; timestamp: number };
  const readString = (name: string, maximumLength = MAX_ID_LENGTH): string => {
    const parsed = parseBoundedString(value[name], maximumLength);
    if (!parsed) throw new TypeError('Invalid continuation gate telemetry event.');
    return parsed;
  };
  if (kind === 'snapshot_requested' || kind === 'snapshot_timeout') {
    return {
      ...base,
      sessionHash: readString('sessionHash'),
      requestHash: readString('requestHash'),
      ...(kind === 'snapshot_timeout' ? { count: readCount(value.count) } : {}),
    } as ContinuationGateTelemetryEvent;
  }
  if (kind === 'snapshot_applied') {
    return {
      ...base,
      sessionHash: readString('sessionHash'),
      sourceHash: readString('sourceHash'),
      count: readCount(value.count),
    } as ContinuationGateTelemetryEvent;
  }
  if (kind === 'provider_unresponsive' || kind === 'provider_recovered') {
    return {
      ...base,
      sessionHash: readString('sessionHash'),
      sourceHash: readString('sourceHash'),
    } as ContinuationGateTelemetryEvent;
  }
  if (kind === 'resume_claimed' || kind === 'resume_committed' || kind === 'resume_aborted') {
    return {
      ...base,
      sessionHash: readString('sessionHash'),
      domain: readString('domain', MAX_DOMAIN_LENGTH),
      transitionHash: readString('transitionHash'),
    } as ContinuationGateTelemetryEvent;
  }
  if (kind === 'wake_handoff_invalid') {
    return {
      ...base,
      sessionHash: readString('sessionHash'),
      sourceHash: readString('sourceHash'),
      gateHash: readString('gateHash'),
      diagnosticCode: readString('diagnosticCode'),
    } as ContinuationGateTelemetryEvent;
  }
  if (kind === 'gate_acquired' || kind === 'gate_reacquired') {
    return {
      ...base,
      sessionHash: readString('sessionHash'),
      sourceHash: readString('sourceHash'),
      gateHash: readString('gateHash'),
      domain: readString('domain', MAX_DOMAIN_LENGTH),
    } as ContinuationGateTelemetryEvent;
  }
  if (kind === 'gate_stale' || kind === 'gate_renewed') {
    return {
      ...base,
      sessionHash: readString('sessionHash'),
      sourceHash: readString('sourceHash'),
      gateHash: readString('gateHash'),
      domain: readString('domain', MAX_DOMAIN_LENGTH),
      expiresAt: readTimestamp(value.expiresAt),
    } as ContinuationGateTelemetryEvent;
  }
  if (kind === 'gate_released' || kind === 'gate_expired') {
    const outcome = readString('outcome');
    if (!['completed', 'failed', 'cancelled', 'killed', 'abandoned', 'expired'].includes(outcome))
      throw new TypeError('Invalid continuation gate telemetry event.');
    return {
      ...base,
      sessionHash: readString('sessionHash'),
      sourceHash: readString('sourceHash'),
      gateHash: readString('gateHash'),
      domain: readString('domain', MAX_DOMAIN_LENGTH),
      outcome: outcome as ContinuationGateReleaseOutcome,
    } as ContinuationGateTelemetryEvent;
  }
  throw new TypeError('Invalid continuation gate telemetry event.');
}

function readTimestamp(value: unknown): number {
  const timestamp = parseTimestamp(value);
  if (timestamp === undefined) throw new TypeError('Invalid continuation gate telemetry event.');
  return timestamp;
}
function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 512)
    throw new TypeError('Invalid continuation gate telemetry event.');
  return value;
}
