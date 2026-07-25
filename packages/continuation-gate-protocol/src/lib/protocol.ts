export const CONTINUATION_GATE_PROTOCOL_VERSION = 1 as const;

export const CONTINUATION_GATE_ACQUIRE_EVENT = 'pi-continuation-gate:v1:acquire';
export const CONTINUATION_GATE_RELEASE_EVENT = 'pi-continuation-gate:v1:release';
export const CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT = 'pi-continuation-gate:v1:snapshot-request';
export const CONTINUATION_GATE_SNAPSHOT_EVENT = 'pi-continuation-gate:v1:snapshot';

export interface ContinuationGateResource {
  kind: string;
  id: string;
  label?: string;
}

export interface ContinuationGate {
  protocolVersion: typeof CONTINUATION_GATE_PROTOCOL_VERSION;
  sessionId: string;
  source: string;
  gateId: string;
  reason: string;
  acquiredAt: number;
  resource?: ContinuationGateResource;
}

export type ContinuationGateReleaseOutcome =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'killed'
  | 'abandoned';

export type ContinuationGateWakeDisposition = 'producer-message' | 'current-turn' | 'none';

export interface ContinuationGateRelease {
  protocolVersion: typeof CONTINUATION_GATE_PROTOCOL_VERSION;
  sessionId: string;
  source: string;
  gateId: string;
  outcome: ContinuationGateReleaseOutcome;
  wake: ContinuationGateWakeDisposition;
  releasedAt: number;
}

export interface ContinuationGateSnapshotRequest {
  protocolVersion: typeof CONTINUATION_GATE_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
}

export interface ContinuationGateSnapshot {
  protocolVersion: typeof CONTINUATION_GATE_PROTOCOL_VERSION;
  requestId?: string;
  sessionId: string;
  source: string;
  gates: ContinuationGate[];
}

export interface ContinuationGateEmitChannel {
  emit(eventName: string, payload: unknown): void;
}

export interface ContinuationGateEventBus {
  on(eventName: string, handler: (payload: unknown) => void): () => void;
}

export interface ContinuationGateProtocolHost {
  events: ContinuationGateEventBus & ContinuationGateEmitChannel;
}
