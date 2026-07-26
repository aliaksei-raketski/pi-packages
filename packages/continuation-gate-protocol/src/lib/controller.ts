import {
  CONTINUATION_GATE_ACQUIRE_EVENT,
  CONTINUATION_GATE_DEFAULT_DOMAIN,
  CONTINUATION_GATE_RELEASE_EVENT,
  CONTINUATION_GATE_SNAPSHOT_EVENT,
  CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT,
  CONTINUATION_GATE_TELEMETRY_EVENT,
  CONTINUATION_GATE_WAKE_ABORTED_EVENT,
  CONTINUATION_GATE_WAKE_COMMITTED_EVENT,
  CONTINUATION_GATE_WAKE_PENDING_EVENT,
  type ContinuationGate,
  type ContinuationGateLeasePolicy,
  type ContinuationGateProtocolHost,
  type ContinuationGateReleaseOutcome,
  type ContinuationGateResource,
  type ContinuationGateTimer,
  type ContinuationGateTimerClear,
  type ContinuationGateTimerFactory,
  type ContinuationGateWakeHandoff,
  type ContinuationGateWakeDisposition,
  type ContinuationGateTelemetryEvent,
} from './protocol.js';
import {
  parseBoundedString,
  parseContinuationGateAcquire,
  parseContinuationGateRelease,
  parseContinuationGateSnapshot,
  parseContinuationGateSnapshotRequest,
  parseContinuationGateWakeHandoff,
  MAX_DOMAIN_LENGTH,
  MAX_ID_LENGTH,
  MAX_HANDOFFS,
} from './validation.js';
import { createContinuationGateTelemetryEvent, hashContinuationGateValue } from './telemetry.js';

const MAX_TIMER_DELAY = 2_147_483_647;

export interface ContinuationGateController {
  acquire(input: {
    sessionId: string;
    gateId: string;
    domain?: string;
    reason: string;
    resource?: ContinuationGateResource;
    lease?:
      | { durationMs: number; policy: ContinuationGateLeasePolicy }
      | { expiresAt: number; policy: ContinuationGateLeasePolicy };
  }): ContinuationGate;
  renew(input: {
    sessionId: string;
    gateId: string;
    durationMs: number;
    policy?: ContinuationGateLeasePolicy;
  }): ContinuationGate | undefined;
  release(input: {
    sessionId: string;
    gateId: string;
    outcome: ContinuationGateReleaseOutcome;
    wake: ContinuationGateWakeDisposition;
    handoffId?: string;
    domain?: string;
  }): boolean;
  prepareWake(input: { sessionId: string; gateId: string }): ContinuationGateWakeHandoff;
  commitWake(handoff: ContinuationGateWakeHandoff): boolean;
  abortWake(handoff: ContinuationGateWakeHandoff): boolean;
  list(
    sessionId?: string,
    options?: { domains?: readonly string[]; includeStale?: boolean },
  ): readonly ContinuationGate[];
  publishSnapshot(sessionId: string, requestId?: string): void;
  clearSession(sessionId: string, outcome?: ContinuationGateReleaseOutcome): void;
  dispose(options?: { release?: boolean }): void;
}

export interface ContinuationGateControllerOptions {
  source: string;
  now?: () => number;
  setTimeout?: ContinuationGateTimerFactory;
  clearTimeout?: ContinuationGateTimerClear;
  onTelemetry?: (event: ContinuationGateTelemetryEvent) => void;
}

function cloneGate(gate: ContinuationGate): ContinuationGate {
  return {
    ...gate,
    ...(gate.resource ? { resource: { ...gate.resource } } : {}),
    ...(gate.lease ? { lease: { ...gate.lease } } : {}),
  };
}

function cloneHandoff(handoff: ContinuationGateWakeHandoff): ContinuationGateWakeHandoff {
  return { ...handoff };
}

function compareGates(left: ContinuationGate, right: ContinuationGate): number {
  return (
    left.sessionId.localeCompare(right.sessionId) ||
    left.domain.localeCompare(right.domain) ||
    left.source.localeCompare(right.source) ||
    left.gateId.localeCompare(right.gateId) ||
    left.acquiredAt - right.acquiredAt
  );
}

class EventContinuationGateController implements ContinuationGateController {
  private readonly source: string;
  private readonly now: () => number;
  private readonly setTimer: ContinuationGateTimerFactory;
  private readonly clearTimer: ContinuationGateTimerClear;
  private readonly sessions = new Map<string, Map<string, ContinuationGate>>();
  private readonly handoffs = new Map<
    string,
    { handoff: ContinuationGateWakeHandoff; state: 'pending' | 'committed' | 'aborted' }
  >();
  private readonly staleRevisions = new Set<string>();
  private readonly offSnapshotRequest: () => void;
  private timer: ContinuationGateTimer | undefined;
  private sequence = 0;
  private disposed = false;

  constructor(
    private readonly host: ContinuationGateProtocolHost,
    options: ContinuationGateControllerOptions,
  ) {
    const source = parseBoundedString(options.source, MAX_ID_LENGTH);
    if (!source)
      throw new TypeError('Continuation gate source must be a non-empty bounded string.');
    this.source = source;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimeout ??
      ((callback, delay) => setTimeout(callback, delay) as ContinuationGateTimer);
    this.clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.onTelemetry = options.onTelemetry;
    this.offSnapshotRequest = host.events.on(
      CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT,
      this.handleSnapshotRequest,
    );
  }

  private readonly onTelemetry?: (event: ContinuationGateTelemetryEvent) => void;

  acquire(input: {
    sessionId: string;
    gateId: string;
    domain?: string;
    reason: string;
    resource?: ContinuationGateResource;
    lease?:
      | { durationMs: number; policy: ContinuationGateLeasePolicy }
      | { expiresAt: number; policy: ContinuationGateLeasePolicy };
  }): ContinuationGate {
    this.assertNotDisposed();
    const sessionId = parseBoundedString(input.sessionId, MAX_ID_LENGTH);
    const gateId = parseBoundedString(input.gateId, MAX_ID_LENGTH);
    const domain = parseBoundedString(
      input.domain ?? CONTINUATION_GATE_DEFAULT_DOMAIN,
      MAX_DOMAIN_LENGTH,
    );
    const existing = sessionId && gateId ? this.sessions.get(sessionId)?.get(gateId) : undefined;
    const rawNow = this.now();
    const now = Math.max(0, rawNow, existing?.updatedAt ?? 0, existing?.acquiredAt ?? 0);
    const lease = this.resolveLease(input.lease, now);
    const gate = parseContinuationGateAcquire({
      sessionId,
      source: this.source,
      gateId,
      domain,
      reason: input.reason,
      acquiredAt: existing?.acquiredAt ?? now,
      updatedAt: now,
      ...(input.resource === undefined ? {} : { resource: input.resource }),
      ...(lease ? { lease } : {}),
    });
    if (!gate) throw new TypeError('Invalid continuation gate acquisition input.');
    let sessionGates = this.sessions.get(gate.sessionId);
    if (!sessionGates) {
      sessionGates = new Map();
      this.sessions.set(gate.sessionId, sessionGates);
    }
    sessionGates.set(gate.gateId, gate);
    this.clearStaleLatch(gate);
    this.emitTelemetry({
      kind: existing ? 'gate_reacquired' : 'gate_acquired',
      timestamp: now,
      ...this.hashGate(gate),
    });
    this.host.events.emit(CONTINUATION_GATE_ACQUIRE_EVENT, cloneGate(gate));
    this.scheduleTimer();
    return cloneGate(gate);
  }

  renew(input: {
    sessionId: string;
    gateId: string;
    durationMs: number;
    policy?: ContinuationGateLeasePolicy;
  }): ContinuationGate | undefined {
    const sessionId = parseBoundedString(input.sessionId, MAX_ID_LENGTH);
    const gateId = parseBoundedString(input.gateId, MAX_ID_LENGTH);
    if (!sessionId || !gateId || !Number.isFinite(input.durationMs) || input.durationMs <= 0)
      return undefined;
    const gate = this.sessions.get(sessionId)?.get(gateId);
    if (!gate) return undefined;
    const updatedAt = Math.max(0, this.now(), gate.updatedAt, gate.acquiredAt);
    const expiresAt = updatedAt + input.durationMs;
    const policy = input.policy ?? gate.lease?.policy ?? 'diagnose';
    const renewed = parseContinuationGateAcquire({
      ...gate,
      updatedAt,
      lease: { expiresAt, policy },
    });
    if (!renewed) return undefined;
    this.sessions.get(sessionId)?.set(gateId, renewed);
    this.clearStaleLatch(renewed);
    this.emitTelemetry({
      kind: 'gate_renewed',
      timestamp: updatedAt,
      ...this.hashGate(renewed),
      expiresAt,
    });
    this.host.events.emit(CONTINUATION_GATE_ACQUIRE_EVENT, cloneGate(renewed));
    this.scheduleTimer();
    return cloneGate(renewed);
  }

  release(input: {
    sessionId: string;
    gateId: string;
    outcome: ContinuationGateReleaseOutcome;
    wake: ContinuationGateWakeDisposition;
    handoffId?: string;
    domain?: string;
  }): boolean {
    this.assertNotDisposed();
    const sessionId = parseBoundedString(input.sessionId, MAX_ID_LENGTH);
    const gateId = parseBoundedString(input.gateId, MAX_ID_LENGTH);
    const gate = sessionId && gateId ? this.sessions.get(sessionId)?.get(gateId) : undefined;
    const requestedDomain =
      input.domain === undefined ? undefined : parseBoundedString(input.domain, MAX_DOMAIN_LENGTH);
    if (!gate || (input.domain !== undefined && requestedDomain !== gate.domain)) return false;
    if (input.wake === 'producer-message') {
      const handoff = input.handoffId && this.handoffs.get(input.handoffId);
      if (
        !handoff ||
        handoff.state !== 'committed' ||
        !this.sameHandoffGate(handoff.handoff, gate)
      ) {
        this.emitInvalidHandoff(gate, 'release-before-committed');
        return false;
      }
    }
    const release = parseContinuationGateRelease({
      releaseId: this.nextId('release'),
      sessionId: gate.sessionId,
      source: this.source,
      gateId: gate.gateId,
      domain: gate.domain,
      outcome: input.outcome,
      wake: input.wake,
      ...(input.handoffId ? { handoffId: input.handoffId } : {}),
      releasedAt: this.now(),
    });
    if (!release) return false;
    this.sessions.get(gate.sessionId)?.delete(gate.gateId);
    if (this.sessions.get(gate.sessionId)?.size === 0) this.sessions.delete(gate.sessionId);
    this.emitTelemetry({
      kind: release.outcome === 'expired' ? 'gate_expired' : 'gate_released',
      timestamp: release.releasedAt,
      ...this.hashGate(gate),
      outcome: release.outcome,
    });
    this.host.events.emit(CONTINUATION_GATE_RELEASE_EVENT, release);
    if (release.handoffId) this.handoffs.delete(release.handoffId);
    this.scheduleTimer();
    return true;
  }

  prepareWake(input: { sessionId: string; gateId: string }): ContinuationGateWakeHandoff {
    this.assertNotDisposed();
    const sessionId = parseBoundedString(input.sessionId, MAX_ID_LENGTH);
    const gateId = parseBoundedString(input.gateId, MAX_ID_LENGTH);
    const gate = sessionId && gateId ? this.sessions.get(sessionId)?.get(gateId) : undefined;
    if (!gate) throw new TypeError('Cannot prepare wake for an unknown continuation gate.');
    const handoff = parseContinuationGateWakeHandoff({
      handoffId: this.nextId('handoff'),
      sessionId: gate.sessionId,
      source: this.source,
      gateId: gate.gateId,
      domain: gate.domain,
      createdAt: this.now(),
    });
    if (!handoff) throw new TypeError('Invalid continuation wake handoff.');
    this.handoffs.set(handoff.handoffId, { handoff, state: 'pending' });
    while (this.handoffs.size > MAX_HANDOFFS)
      this.handoffs.delete(this.handoffs.keys().next().value as string);
    this.host.events.emit(CONTINUATION_GATE_WAKE_PENDING_EVENT, cloneHandoff(handoff));
    return cloneHandoff(handoff);
  }

  commitWake(handoff: ContinuationGateWakeHandoff): boolean {
    const parsed = parseContinuationGateWakeHandoff(handoff);
    const current = parsed && this.handoffs.get(parsed.handoffId);
    if (
      !parsed ||
      !current ||
      current.state !== 'pending' ||
      !this.sameHandoff(current.handoff, parsed)
    ) {
      if (parsed) this.emitInvalidHandoffByIdentity(parsed, 'commit-out-of-order');
      return false;
    }
    current.state = 'committed';
    this.host.events.emit(CONTINUATION_GATE_WAKE_COMMITTED_EVENT, cloneHandoff(parsed));
    return true;
  }

  abortWake(handoff: ContinuationGateWakeHandoff): boolean {
    const parsed = parseContinuationGateWakeHandoff(handoff);
    const current = parsed && this.handoffs.get(parsed.handoffId);
    if (
      !parsed ||
      !current ||
      current.state === 'aborted' ||
      current.state === 'committed' ||
      !this.sameHandoff(current.handoff, parsed)
    ) {
      if (parsed) this.emitInvalidHandoffByIdentity(parsed, 'abort-out-of-order');
      return false;
    }
    current.state = 'aborted';
    this.host.events.emit(CONTINUATION_GATE_WAKE_ABORTED_EVENT, cloneHandoff(parsed));
    return true;
  }

  list(
    sessionId?: string,
    options: { domains?: readonly string[]; includeStale?: boolean } = {},
  ): readonly ContinuationGate[] {
    const domains = this.normalizeDomains(options.domains);
    const gates: ContinuationGate[] = [];
    const sessions =
      sessionId === undefined
        ? this.sessions
        : new Map([[sessionId.trim(), this.sessions.get(sessionId.trim()) ?? new Map()]]);
    for (const sourceGates of sessions.values())
      for (const gate of sourceGates?.values() ?? []) {
        if (!domains || domains.has(gate.domain)) gates.push(cloneGate(gate));
      }
    return gates.sort(compareGates);
  }

  publishSnapshot(sessionId: string, requestId?: string): void {
    this.processLeases();
    const snapshot = parseContinuationGateSnapshot({
      ...(requestId === undefined ? {} : { requestId }),
      sessionId,
      source: this.source,
      gates: this.list(sessionId),
    });
    if (snapshot) this.host.events.emit(CONTINUATION_GATE_SNAPSHOT_EVENT, snapshot);
  }

  clearSession(sessionId: string, outcome: ContinuationGateReleaseOutcome = 'abandoned'): void {
    const normalized = parseBoundedString(sessionId, MAX_ID_LENGTH);
    if (!normalized) return;
    for (const gateId of [...(this.sessions.get(normalized)?.keys() ?? [])])
      this.release({ sessionId: normalized, gateId, outcome, wake: 'none' });
    this.publishSnapshot(normalized);
  }

  dispose(options: { release?: boolean } = {}): void {
    if (this.disposed) return;
    this.offSnapshotRequest();
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (options.release) {
      for (const [sessionId, gates] of [...this.sessions])
        for (const gateId of [...gates.keys()]) {
          this.release({ sessionId, gateId, outcome: 'abandoned', wake: 'none' });
        }
    }
    this.disposed = true;
    this.handoffs.clear();
  }

  private readonly handleSnapshotRequest = (payload: unknown): void => {
    const request = parseContinuationGateSnapshotRequest(payload);
    if (request) this.publishSnapshot(request.sessionId, request.requestId);
  };

  private resolveLease(
    lease:
      | { durationMs: number; policy: ContinuationGateLeasePolicy }
      | { expiresAt: number; policy: ContinuationGateLeasePolicy }
      | undefined,
    now: number,
  ): { expiresAt: number; policy: ContinuationGateLeasePolicy } | undefined {
    if (!lease) return undefined;
    const expiresAt = 'durationMs' in lease ? now + lease.durationMs : lease.expiresAt;
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      (lease.policy !== 'diagnose' && lease.policy !== 'expire')
    )
      return undefined;
    return { expiresAt, policy: lease.policy };
  }

  private processLeases(): void {
    const now = this.now();
    for (const [sessionId, gates] of [...this.sessions])
      for (const [gateId, gate] of [...gates]) {
        if (!gate.lease || gate.lease.expiresAt > now) continue;
        const revision = this.leaseRevision(gate);
        if (gate.lease.policy === 'diagnose') {
          if (!this.staleRevisions.has(revision)) {
            this.staleRevisions.add(revision);
            this.emitTelemetry({
              kind: 'gate_stale',
              timestamp: now,
              ...this.hashGate(gate),
              expiresAt: gate.lease.expiresAt,
            });
          }
        } else {
          this.release({ sessionId, gateId, outcome: 'expired', wake: 'none' });
        }
      }
  }

  private scheduleTimer(): void {
    if (this.disposed) return;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    let deadline = Number.POSITIVE_INFINITY;
    const now = this.now();
    for (const gates of this.sessions.values())
      for (const gate of gates.values())
        if (
          gate.lease &&
          !(
            gate.lease.policy === 'diagnose' &&
            gate.lease.expiresAt <= now &&
            this.staleRevisions.has(this.leaseRevision(gate))
          )
        )
          deadline = Math.min(deadline, gate.lease.expiresAt);
    if (!Number.isFinite(deadline)) return;
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, deadline - this.now()));
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.processLeases();
      this.scheduleTimer();
    }, delay);
    this.timer.unref?.();
  }

  private normalizeDomains(domains: readonly string[] | undefined): Set<string> | undefined {
    if (!domains) return undefined;
    return new Set(
      domains
        .map((domain) => parseBoundedString(domain, MAX_DOMAIN_LENGTH))
        .filter((domain): domain is string => !!domain),
    );
  }

  private normalizeKey(gate: ContinuationGate): string {
    return `${gate.sessionId}\0${gate.gateId}`;
  }
  private leaseRevision(gate: ContinuationGate): string {
    return `${this.normalizeKey(gate)}\0${gate.updatedAt}\0${gate.lease?.expiresAt}`;
  }
  private clearStaleLatch(gate: ContinuationGate): void {
    for (const revision of [...this.staleRevisions])
      if (revision.startsWith(`${this.normalizeKey(gate)}\0`)) this.staleRevisions.delete(revision);
  }
  private sameHandoff(
    left: ContinuationGateWakeHandoff,
    right: ContinuationGateWakeHandoff,
  ): boolean {
    return (
      left.handoffId === right.handoffId &&
      left.sessionId === right.sessionId &&
      left.source === right.source &&
      left.gateId === right.gateId &&
      left.domain === right.domain &&
      left.createdAt === right.createdAt
    );
  }
  private sameHandoffGate(handoff: ContinuationGateWakeHandoff, gate: ContinuationGate): boolean {
    return (
      handoff.sessionId === gate.sessionId &&
      handoff.source === gate.source &&
      handoff.gateId === gate.gateId &&
      handoff.domain === gate.domain
    );
  }
  private hashGate(gate: ContinuationGate): {
    sessionHash: string;
    sourceHash: string;
    gateHash: string;
    domain: string;
  } {
    return {
      sessionHash: hashContinuationGateValue(gate.sessionId),
      sourceHash: hashContinuationGateValue(gate.source),
      gateHash: hashContinuationGateValue(gate.gateId),
      domain: gate.domain,
    };
  }
  private emitInvalidHandoff(gate: ContinuationGate, diagnosticCode: string): void {
    this.emitTelemetry({
      kind: 'wake_handoff_invalid',
      timestamp: this.now(),
      ...this.hashGate(gate),
      diagnosticCode,
    });
  }
  private emitInvalidHandoffByIdentity(
    handoff: ContinuationGateWakeHandoff,
    diagnosticCode: string,
  ): void {
    this.emitTelemetry({
      kind: 'wake_handoff_invalid',
      timestamp: this.now(),
      sessionHash: hashContinuationGateValue(handoff.sessionId),
      sourceHash: hashContinuationGateValue(handoff.source),
      gateHash: hashContinuationGateValue(handoff.gateId),
      diagnosticCode,
    });
  }
  private emitTelemetry(event: ContinuationGateTelemetryEvent): void {
    try {
      this.onTelemetry?.(event);
    } catch {
      /* telemetry must never affect gate lifecycle */
    }
  }
  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.now().toString(36)}-${this.sequence.toString(36)}`;
  }
  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('Continuation gate controller is disposed.');
  }
}

export function createContinuationGateController(
  host: ContinuationGateProtocolHost,
  options: ContinuationGateControllerOptions,
): ContinuationGateController {
  return new EventContinuationGateController(host, options);
}

export function attachContinuationGateTelemetryPublisher(
  host: ContinuationGateProtocolHost,
  onTelemetry: (event: ContinuationGateTelemetryEvent) => void,
): () => void {
  return host.events.on(CONTINUATION_GATE_TELEMETRY_EVENT, (payload) => {
    if (payload && typeof payload === 'object')
      try {
        onTelemetry(
          createContinuationGateTelemetryEvent(payload as ContinuationGateTelemetryEvent),
        );
      } catch {
        /* observer isolation */
      }
  });
}
