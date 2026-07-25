import {
  CONTINUATION_GATE_ACQUIRE_EVENT,
  CONTINUATION_GATE_PROTOCOL_VERSION,
  CONTINUATION_GATE_RELEASE_EVENT,
  CONTINUATION_GATE_SNAPSHOT_EVENT,
  CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT,
  type ContinuationGate,
  type ContinuationGateProtocolHost,
} from './protocol.js';
import {
  parseContinuationGateAcquire,
  parseContinuationGateRelease,
  parseContinuationGateSnapshot,
  parseContinuationGateSnapshotRequest,
} from './validation.js';

export interface ContinuationGateRegistryChange {
  kind: 'acquired' | 'released' | 'snapshot';
  sessionId: string;
  source: string;
  gateId?: string;
}

export interface ContinuationGateRegistry {
  isBlocked(sessionId: string): boolean;
  list(sessionId: string): readonly ContinuationGate[];
  requestSnapshot(sessionId: string): string;
  clear(): void;
  dispose(): void;
}

export interface ContinuationGateRegistryOptions {
  onChange?: (change: ContinuationGateRegistryChange) => void;
  createRequestId?: () => string;
}

type SourceGates = Map<string, Map<string, ContinuationGate>>;

function cloneGate(gate: ContinuationGate): ContinuationGate {
  return {
    ...gate,
    ...(gate.resource ? { resource: { ...gate.resource } } : {}),
  };
}

function gatesEqual(left: ContinuationGate | undefined, right: ContinuationGate): boolean {
  return (
    left?.sessionId === right.sessionId &&
    left.source === right.source &&
    left.gateId === right.gateId &&
    left.reason === right.reason &&
    left.acquiredAt === right.acquiredAt &&
    left.resource?.kind === right.resource?.kind &&
    left.resource?.id === right.resource?.id &&
    left.resource?.label === right.resource?.label
  );
}

class EventContinuationGateRegistry implements ContinuationGateRegistry {
  private readonly sessions = new Map<string, SourceGates>();
  private readonly offAcquire: () => void;
  private readonly offRelease: () => void;
  private readonly offSnapshot: () => void;
  private requestCounter = 0;
  private disposed = false;

  constructor(
    private readonly host: ContinuationGateProtocolHost,
    private readonly options: ContinuationGateRegistryOptions,
  ) {
    this.offAcquire = host.events.on(CONTINUATION_GATE_ACQUIRE_EVENT, this.handleAcquire);
    this.offRelease = host.events.on(CONTINUATION_GATE_RELEASE_EVENT, this.handleRelease);
    this.offSnapshot = host.events.on(CONTINUATION_GATE_SNAPSHOT_EVENT, this.handleSnapshot);
  }

  isBlocked(sessionId: string): boolean {
    return this.list(sessionId).length > 0;
  }

  list(sessionId: string): readonly ContinuationGate[] {
    const gates: ContinuationGate[] = [];
    for (const sourceGates of this.sessions.get(sessionId.trim())?.values() ?? []) {
      for (const gate of sourceGates.values()) {
        gates.push(cloneGate(gate));
      }
    }
    return gates.sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.gateId.localeCompare(right.gateId) ||
        left.acquiredAt - right.acquiredAt,
    );
  }

  requestSnapshot(sessionId: string): string {
    this.requestCounter += 1;
    const requestId =
      this.options.createRequestId?.() ??
      `${Date.now().toString(36)}-${this.requestCounter.toString(36)}-${Math.random().toString(36).slice(2)}`;
    const request = parseContinuationGateSnapshotRequest({
      protocolVersion: CONTINUATION_GATE_PROTOCOL_VERSION,
      requestId,
      sessionId,
    });
    if (!request) {
      throw new TypeError('Invalid continuation gate snapshot request input.');
    }
    this.host.events.emit(CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT, request);
    return request.requestId;
  }

  clear(): void {
    this.sessions.clear();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.offAcquire();
    this.offRelease();
    this.offSnapshot();
    this.clear();
  }

  private readonly handleAcquire = (payload: unknown): void => {
    const gate = parseContinuationGateAcquire(payload);
    if (!gate) {
      return;
    }

    const gates = this.getOrCreateSource(gate.sessionId, gate.source);
    if (gatesEqual(gates.get(gate.gateId), gate)) {
      return;
    }
    gates.set(gate.gateId, gate);
    this.options.onChange?.({
      kind: 'acquired',
      sessionId: gate.sessionId,
      source: gate.source,
      gateId: gate.gateId,
    });
  };

  private readonly handleRelease = (payload: unknown): void => {
    const release = parseContinuationGateRelease(payload);
    if (!release) {
      return;
    }

    const gates = this.sessions.get(release.sessionId)?.get(release.source);
    if (!gates?.delete(release.gateId)) {
      return;
    }
    this.prune(release.sessionId, release.source);
    this.options.onChange?.({
      kind: 'released',
      sessionId: release.sessionId,
      source: release.source,
      gateId: release.gateId,
    });
  };

  private readonly handleSnapshot = (payload: unknown): void => {
    const snapshot = parseContinuationGateSnapshot(payload);
    if (!snapshot) {
      return;
    }

    const replacement = new Map<string, ContinuationGate>();
    for (const gate of snapshot.gates) {
      replacement.set(gate.gateId, gate);
    }
    this.replaceSource(snapshot.sessionId, snapshot.source, replacement);
    this.options.onChange?.({
      kind: 'snapshot',
      sessionId: snapshot.sessionId,
      source: snapshot.source,
    });
  };

  private getOrCreateSource(sessionId: string, source: string): Map<string, ContinuationGate> {
    let sourceMaps = this.sessions.get(sessionId);
    if (!sourceMaps) {
      sourceMaps = new Map();
      this.sessions.set(sessionId, sourceMaps);
    }

    let gates = sourceMaps.get(source);
    if (!gates) {
      gates = new Map();
      sourceMaps.set(source, gates);
    }
    return gates;
  }

  private replaceSource(
    sessionId: string,
    source: string,
    replacement: Map<string, ContinuationGate>,
  ): void {
    if (replacement.size === 0) {
      this.sessions.get(sessionId)?.delete(source);
      this.prune(sessionId, source);
      return;
    }
    this.getOrCreateSession(sessionId).set(source, replacement);
  }

  private getOrCreateSession(sessionId: string): SourceGates {
    let sourceMaps = this.sessions.get(sessionId);
    if (!sourceMaps) {
      sourceMaps = new Map();
      this.sessions.set(sessionId, sourceMaps);
    }
    return sourceMaps;
  }

  private prune(sessionId: string, source: string): void {
    const sourceMaps = this.sessions.get(sessionId);
    if (!sourceMaps) {
      return;
    }
    if (sourceMaps.get(source)?.size === 0) {
      sourceMaps.delete(source);
    }
    if (sourceMaps.size === 0) {
      this.sessions.delete(sessionId);
    }
  }
}

export function createContinuationGateRegistry(
  host: ContinuationGateProtocolHost,
  options: ContinuationGateRegistryOptions = {},
): ContinuationGateRegistry {
  return new EventContinuationGateRegistry(host, options);
}
