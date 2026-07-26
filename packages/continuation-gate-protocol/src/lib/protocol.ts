export const CONTINUATION_GATE_DEFAULT_DOMAIN = 'autonomous-continuation';

export const CONTINUATION_GATE_ACQUIRE_EVENT = 'pi-continuation-gate:acquire';
export const CONTINUATION_GATE_RELEASE_EVENT = 'pi-continuation-gate:release';
export const CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT = 'pi-continuation-gate:snapshot-request';
export const CONTINUATION_GATE_SNAPSHOT_EVENT = 'pi-continuation-gate:snapshot';
export const CONTINUATION_GATE_WAKE_PENDING_EVENT = 'pi-continuation-gate:wake-pending';
export const CONTINUATION_GATE_WAKE_COMMITTED_EVENT = 'pi-continuation-gate:wake-committed';
export const CONTINUATION_GATE_WAKE_ABORTED_EVENT = 'pi-continuation-gate:wake-aborted';
export const CONTINUATION_GATE_RESUME_CLAIM_EVENT = 'pi-continuation-gate:resume-claim';
export const CONTINUATION_GATE_RESUME_COMMIT_EVENT = 'pi-continuation-gate:resume-commit';
export const CONTINUATION_GATE_RESUME_ABORT_EVENT = 'pi-continuation-gate:resume-abort';
export const CONTINUATION_GATE_UNBLOCKED_EVENT = 'pi-continuation-gate:unblocked';
export const CONTINUATION_GATE_TELEMETRY_EVENT = 'pi-continuation-gate:telemetry';

export type ContinuationGateLeasePolicy = 'diagnose' | 'expire';

export interface ContinuationGateLease {
  expiresAt: number;
  policy: ContinuationGateLeasePolicy;
}

export interface ContinuationGateResource {
  kind: string;
  id: string;
  label?: string;
}

export interface ContinuationGate {
  sessionId: string;
  source: string;
  gateId: string;
  domain: string;
  reason: string;
  acquiredAt: number;
  updatedAt: number;
  resource?: ContinuationGateResource;
  lease?: ContinuationGateLease;
}

/** Public alias for the enhanced unversioned gate shape. */
export type ContinuationGateV2 = ContinuationGate;

export type ContinuationGateReleaseOutcome =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'killed'
  | 'abandoned'
  | 'expired';

export type ContinuationGateWakeDisposition = 'producer-message' | 'current-turn' | 'none';

export interface ContinuationGateRelease {
  releaseId: string;
  sessionId: string;
  source: string;
  gateId: string;
  domain: string;
  outcome: ContinuationGateReleaseOutcome;
  wake: ContinuationGateWakeDisposition;
  handoffId?: string;
  releasedAt: number;
}

export interface ContinuationGateSnapshotRequest {
  requestId: string;
  sessionId: string;
}

export interface ContinuationGateSnapshot {
  requestId?: string;
  sessionId: string;
  source: string;
  gates: ContinuationGate[];
}

export interface ContinuationGateWakeHandoff {
  handoffId: string;
  sessionId: string;
  source: string;
  gateId: string;
  domain: string;
  createdAt: number;
}

export interface ContinuationGateResumeClaim {
  claimId: string;
  transitionId: string;
  sessionId: string;
  domain: string;
  consumerId: string;
  generation: number;
  expiresAt: number;
}

export type ResumeClaim = ContinuationGateResumeClaim;

export interface ContinuationGateUnblocked {
  transitionId: string;
  sessionId: string;
  domain: string;
  wakeDisposition: ContinuationGateWakeDisposition;
  handoffId?: string;
  generation: number;
}

export type ContinuationGateTelemetryEvent =
  | {
      kind: 'gate_acquired' | 'gate_reacquired';
      timestamp: number;
      sessionHash: string;
      sourceHash: string;
      gateHash: string;
      domain: string;
    }
  | {
      kind: 'gate_released' | 'gate_expired';
      timestamp: number;
      sessionHash: string;
      sourceHash: string;
      gateHash: string;
      domain: string;
      outcome: ContinuationGateReleaseOutcome;
    }
  | {
      kind: 'gate_stale' | 'gate_renewed';
      timestamp: number;
      sessionHash: string;
      sourceHash: string;
      gateHash: string;
      domain: string;
      expiresAt: number;
    }
  | { kind: 'snapshot_requested'; timestamp: number; sessionHash: string; requestHash: string }
  | {
      kind: 'snapshot_applied';
      timestamp: number;
      sessionHash: string;
      sourceHash: string;
      count: number;
    }
  | {
      kind: 'snapshot_timeout';
      timestamp: number;
      sessionHash: string;
      requestHash: string;
      count: number;
    }
  | {
      kind: 'provider_unresponsive' | 'provider_recovered';
      timestamp: number;
      sessionHash: string;
      sourceHash: string;
    }
  | {
      kind: 'wake_handoff_invalid';
      timestamp: number;
      sessionHash: string;
      sourceHash: string;
      gateHash: string;
      diagnosticCode: string;
    }
  | {
      kind: 'resume_claimed' | 'resume_committed' | 'resume_aborted';
      timestamp: number;
      sessionHash: string;
      domain: string;
      transitionHash: string;
    };

export interface ContinuationGateEmitChannel {
  emit(eventName: string, payload: unknown): void;
}

export interface ContinuationGateEventBus {
  on(eventName: string, handler: (payload: unknown) => void): () => void;
}

export interface ContinuationGateProtocolHost {
  events: ContinuationGateEventBus & ContinuationGateEmitChannel;
}

export type ContinuationGateTimer = ReturnType<typeof setTimeout> & { unref?: () => void };
export type ContinuationGateTimerFactory = (
  callback: () => void,
  delayMs: number,
) => ContinuationGateTimer;
export type ContinuationGateTimerClear = (timer: ContinuationGateTimer) => void;
