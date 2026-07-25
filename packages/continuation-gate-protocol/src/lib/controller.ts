import {
  CONTINUATION_GATE_ACQUIRE_EVENT,
  CONTINUATION_GATE_PROTOCOL_VERSION,
  CONTINUATION_GATE_RELEASE_EVENT,
  CONTINUATION_GATE_SNAPSHOT_EVENT,
  CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT,
  type ContinuationGate,
  type ContinuationGateProtocolHost,
  type ContinuationGateReleaseOutcome,
  type ContinuationGateResource,
  type ContinuationGateWakeDisposition,
} from './protocol.js';
import {
  parseContinuationGateAcquire,
  parseContinuationGateRelease,
  parseContinuationGateSnapshot,
  parseContinuationGateSnapshotRequest,
} from './validation.js';

export interface ContinuationGateController {
  acquire(input: {
    sessionId: string;
    gateId: string;
    reason: string;
    resource?: ContinuationGateResource;
  }): ContinuationGate;
  release(input: {
    sessionId: string;
    gateId: string;
    outcome: ContinuationGateReleaseOutcome;
    wake: ContinuationGateWakeDisposition;
  }): boolean;
  list(sessionId?: string): readonly ContinuationGate[];
  publishSnapshot(sessionId: string, requestId?: string): void;
  clearSession(sessionId: string, outcome?: ContinuationGateReleaseOutcome): void;
  dispose(options?: { release?: boolean }): void;
}

export interface ContinuationGateControllerOptions {
  source: string;
  now?: () => number;
}

function cloneGate(gate: ContinuationGate): ContinuationGate {
  return {
    ...gate,
    ...(gate.resource ? { resource: { ...gate.resource } } : {}),
  };
}

function compareGates(left: ContinuationGate, right: ContinuationGate): number {
  return (
    left.sessionId.localeCompare(right.sessionId) ||
    left.gateId.localeCompare(right.gateId) ||
    left.acquiredAt - right.acquiredAt
  );
}

class EventContinuationGateController implements ContinuationGateController {
  private readonly source: string;
  private readonly now: () => number;
  private readonly sessions = new Map<string, Map<string, ContinuationGate>>();
  private readonly offSnapshotRequest: () => void;
  private snapshotListenerDisposed = false;

  constructor(
    private readonly host: ContinuationGateProtocolHost,
    options: ContinuationGateControllerOptions,
  ) {
    const sourceProbe = parseContinuationGateSnapshot({
      protocolVersion: CONTINUATION_GATE_PROTOCOL_VERSION,
      sessionId: 'validation-session',
      source: options.source,
      gates: [],
    });
    if (!sourceProbe) {
      throw new TypeError('Continuation gate source must be a non-empty bounded string.');
    }

    this.source = sourceProbe.source;
    this.now = options.now ?? Date.now;
    this.offSnapshotRequest = host.events.on(
      CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT,
      this.handleSnapshotRequest,
    );
  }

  acquire(input: {
    sessionId: string;
    gateId: string;
    reason: string;
    resource?: ContinuationGateResource;
  }): ContinuationGate {
    const normalizedSessionId = this.normalizeSessionId(input.sessionId);
    const existing = normalizedSessionId
      ? this.sessions.get(normalizedSessionId)?.get(input.gateId.trim())
      : undefined;
    const gate = parseContinuationGateAcquire({
      protocolVersion: CONTINUATION_GATE_PROTOCOL_VERSION,
      sessionId: input.sessionId,
      source: this.source,
      gateId: input.gateId,
      reason: input.reason,
      acquiredAt: existing?.acquiredAt ?? this.now(),
      ...(input.resource === undefined ? {} : { resource: input.resource }),
    });
    if (!gate) {
      throw new TypeError('Invalid continuation gate acquisition input.');
    }

    let sessionGates = this.sessions.get(gate.sessionId);
    if (!sessionGates) {
      sessionGates = new Map();
      this.sessions.set(gate.sessionId, sessionGates);
    }
    sessionGates.set(gate.gateId, gate);
    this.host.events.emit(CONTINUATION_GATE_ACQUIRE_EVENT, cloneGate(gate));
    return cloneGate(gate);
  }

  release(input: {
    sessionId: string;
    gateId: string;
    outcome: ContinuationGateReleaseOutcome;
    wake: ContinuationGateWakeDisposition;
  }): boolean {
    const event = parseContinuationGateRelease({
      protocolVersion: CONTINUATION_GATE_PROTOCOL_VERSION,
      sessionId: input.sessionId,
      source: this.source,
      gateId: input.gateId,
      outcome: input.outcome,
      wake: input.wake,
      releasedAt: this.now(),
    });
    if (!event) {
      return false;
    }

    const sessionGates = this.sessions.get(event.sessionId);
    if (!sessionGates?.delete(event.gateId)) {
      return false;
    }
    if (sessionGates.size === 0) {
      this.sessions.delete(event.sessionId);
    }
    this.host.events.emit(CONTINUATION_GATE_RELEASE_EVENT, event);
    return true;
  }

  list(sessionId?: string): readonly ContinuationGate[] {
    const gates: ContinuationGate[] = [];
    if (sessionId !== undefined) {
      this.collectSessionGates(sessionId, gates);
    } else {
      for (const sessionGates of this.sessions.values()) {
        for (const gate of sessionGates.values()) {
          gates.push(cloneGate(gate));
        }
      }
    }
    return gates.sort(compareGates);
  }

  publishSnapshot(sessionId: string, requestId?: string): void {
    const snapshot = parseContinuationGateSnapshot({
      protocolVersion: CONTINUATION_GATE_PROTOCOL_VERSION,
      ...(requestId === undefined ? {} : { requestId }),
      sessionId,
      source: this.source,
      gates: this.list(sessionId),
    });
    if (snapshot) {
      this.host.events.emit(CONTINUATION_GATE_SNAPSHOT_EVENT, snapshot);
    }
  }

  clearSession(sessionId: string, outcome: ContinuationGateReleaseOutcome = 'abandoned'): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    const gateIds = [...(this.sessions.get(normalizedSessionId)?.keys() ?? [])];
    for (const gateId of gateIds) {
      this.release({
        sessionId: normalizedSessionId,
        gateId,
        outcome,
        wake: 'none',
      });
    }
    this.publishSnapshot(normalizedSessionId);
  }

  dispose(options: { release?: boolean } = {}): void {
    if (!this.snapshotListenerDisposed) {
      this.snapshotListenerDisposed = true;
      this.offSnapshotRequest();
    }
    if (options.release) {
      for (const sessionId of [...this.sessions.keys()]) {
        this.clearSession(sessionId, 'abandoned');
      }
    }
  }

  private readonly handleSnapshotRequest = (payload: unknown): void => {
    const request = parseContinuationGateSnapshotRequest(payload);
    if (request) {
      this.publishSnapshot(request.sessionId, request.requestId);
    }
  };

  private normalizeSessionId(sessionId: string): string | undefined {
    return parseContinuationGateSnapshot({
      protocolVersion: CONTINUATION_GATE_PROTOCOL_VERSION,
      sessionId,
      source: this.source,
      gates: [],
    })?.sessionId;
  }

  private collectSessionGates(sessionId: string, output: ContinuationGate[]): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    for (const gate of this.sessions.get(normalizedSessionId)?.values() ?? []) {
      output.push(cloneGate(gate));
    }
  }
}

export function createContinuationGateController(
  host: ContinuationGateProtocolHost,
  options: ContinuationGateControllerOptions,
): ContinuationGateController {
  return new EventContinuationGateController(host, options);
}
