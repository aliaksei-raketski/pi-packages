import {
  CONTINUATION_GATE_ACQUIRE_EVENT,
  CONTINUATION_GATE_RELEASE_EVENT,
  CONTINUATION_GATE_RESUME_ABORT_EVENT,
  CONTINUATION_GATE_RESUME_CLAIM_EVENT,
  CONTINUATION_GATE_RESUME_COMMIT_EVENT,
  CONTINUATION_GATE_SNAPSHOT_EVENT,
  CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT,
  CONTINUATION_GATE_UNBLOCKED_EVENT,
  CONTINUATION_GATE_WAKE_ABORTED_EVENT,
  CONTINUATION_GATE_WAKE_COMMITTED_EVENT,
  CONTINUATION_GATE_WAKE_PENDING_EVENT,
  type ContinuationGate,
  type ContinuationGateProtocolHost,
  type ContinuationGateResumeClaim,
  type ContinuationGateTelemetryEvent,
  type ContinuationGateTimer,
  type ContinuationGateTimerClear,
  type ContinuationGateTimerFactory,
  type ContinuationGateUnblocked,
  type ContinuationGateWakeHandoff,
  type ContinuationGateWakeDisposition,
} from './protocol.js';
import {
  MAX_DOMAIN_LENGTH,
  MAX_ID_LENGTH,
  MAX_DIAGNOSTIC_COUNT,
  MAX_HANDOFFS,
  MAX_RESUME_CLAIMS,
  MAX_GENERATION,
  parseBoundedString,
  parseContinuationGateAcquire,
  parseContinuationGateRelease,
  parseContinuationGateResumeClaim,
  parseContinuationGateSnapshot,
  parseContinuationGateSnapshotRequest,
  parseContinuationGateUnblocked,
  parseContinuationGateWakeHandoff,
} from './validation.js';
import { hashContinuationGateValue } from './telemetry.js';

const DEFAULT_RESUME_CLAIM_TTL = 2_000;
const DEFAULT_SNAPSHOT_TIMEOUT = 5_000;

export interface ContinuationGateRegistryChange {
  kind: 'acquired' | 'released' | 'snapshot' | 'unblocked';
  sessionId: string;
  source?: string;
  gateId?: string;
  domain?: string;
  transitionId?: string;
  wakeDisposition?: ContinuationGateWakeDisposition;
  handoffId?: string;
  autoResumeAllowed?: boolean;
  generation?: number;
}

export interface ContinuationGateRegistryDiagnostic {
  code: string;
  timestamp: number;
  sessionId?: string;
  source?: string;
  gateId?: string;
  domain?: string;
}

export interface ContinuationGateRegistry {
  isBlocked(sessionId: string, options?: { domains?: readonly string[] }): boolean;
  list(
    sessionId: string,
    options?: { domains?: readonly string[]; includeStale?: boolean },
  ): readonly ContinuationGate[];
  listStale(
    sessionId: string,
    options?: { domains?: readonly string[] },
  ): readonly ContinuationGate[];
  leaseState(gate: ContinuationGate, now?: number): 'none' | 'active' | 'stale';
  requestSnapshot(sessionId: string): string;
  claimAutoResume(input: {
    transitionId: string;
    sessionId: string;
    domain: string;
    consumerId: string;
    generation: number;
  }): ContinuationGateResumeClaim | undefined;
  commitAutoResume(claim: ContinuationGateResumeClaim): boolean;
  abortAutoResume(claim: ContinuationGateResumeClaim): boolean;
  diagnostics(): readonly ContinuationGateRegistryDiagnostic[];
  clear(): void;
  dispose(): void;
}

export interface ContinuationGateRegistryOptions {
  onChange?: (change: ContinuationGateRegistryChange) => void;
  onTelemetry?: (event: ContinuationGateTelemetryEvent) => void;
  onDiagnostic?: (diagnostic: ContinuationGateRegistryDiagnostic) => void;
  createRequestId?: () => string;
  createClaimId?: () => string;
  now?: () => number;
  snapshotTimeoutMs?: number;
  resumeClaimTtlMs?: number;
  setTimeout?: ContinuationGateTimerFactory;
  clearTimeout?: ContinuationGateTimerClear;
}

type SourceGates = Map<string, Map<string, ContinuationGate>>;
interface PendingSnapshot {
  sessionId: string;
  requestId: string;
  expected: Set<string>;
  answered: Set<string>;
  timer?: ContinuationGateTimer;
}
interface TransitionState extends ContinuationGateUnblocked {
  key: string;
  autoResumeAllowed: boolean;
  autoResumeCommitted: boolean;
}
interface ClaimState {
  claim: ContinuationGateResumeClaim;
  state: 'pending' | 'committed' | 'aborted';
}

function cloneGate(gate: ContinuationGate): ContinuationGate {
  return {
    ...gate,
    ...(gate.resource ? { resource: { ...gate.resource } } : {}),
    ...(gate.lease ? { lease: { ...gate.lease } } : {}),
  };
}
function cloneClaim(claim: ContinuationGateResumeClaim): ContinuationGateResumeClaim {
  return { ...claim };
}
function cloneDiagnostic(
  diagnostic: ContinuationGateRegistryDiagnostic,
): ContinuationGateRegistryDiagnostic {
  return { ...diagnostic };
}

class EventContinuationGateRegistry implements ContinuationGateRegistry {
  private readonly sessions = new Map<string, SourceGates>();
  private readonly handoffs = new Map<
    string,
    { handoff: ContinuationGateWakeHandoff; state: 'pending' | 'committed' | 'aborted' }
  >();
  private readonly transitions = new Map<string, TransitionState>();
  private readonly generations = new Map<string, number>();
  private readonly claims = new Map<string, ClaimState>();
  private readonly diagnosticsBuffer: ContinuationGateRegistryDiagnostic[] = [];
  private readonly off: Array<() => void>;
  private readonly now: () => number;
  private readonly setTimer: ContinuationGateTimerFactory;
  private readonly clearTimer: ContinuationGateTimerClear;
  private snapshotCounter = 0;
  private transitionCounter = 0;
  private claimTimer: ContinuationGateTimer | undefined;
  private disposed = false;

  constructor(
    private readonly host: ContinuationGateProtocolHost,
    private readonly options: ContinuationGateRegistryOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimeout ??
      ((callback, delay) => setTimeout(callback, delay) as ContinuationGateTimer);
    this.clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.off = [
      host.events.on(CONTINUATION_GATE_ACQUIRE_EVENT, this.handleAcquire),
      host.events.on(CONTINUATION_GATE_RELEASE_EVENT, this.handleRelease),
      host.events.on(CONTINUATION_GATE_SNAPSHOT_EVENT, this.handleSnapshot),
      host.events.on(CONTINUATION_GATE_UNBLOCKED_EVENT, this.handleUnblocked),
      host.events.on(CONTINUATION_GATE_WAKE_PENDING_EVENT, this.handleWakePending),
      host.events.on(CONTINUATION_GATE_WAKE_COMMITTED_EVENT, this.handleWakeCommitted),
      host.events.on(CONTINUATION_GATE_WAKE_ABORTED_EVENT, this.handleWakeAborted),
      host.events.on(CONTINUATION_GATE_RESUME_CLAIM_EVENT, this.handleResumeClaim),
      host.events.on(CONTINUATION_GATE_RESUME_COMMIT_EVENT, this.handleResumeCommit),
      host.events.on(CONTINUATION_GATE_RESUME_ABORT_EVENT, this.handleResumeAbort),
    ];
  }

  isBlocked(sessionId: string, options: { domains?: readonly string[] } = {}): boolean {
    return this.list(sessionId, { domains: options.domains, includeStale: true }).length > 0;
  }

  list(
    sessionId: string,
    options: { domains?: readonly string[]; includeStale?: boolean } = {},
  ): readonly ContinuationGate[] {
    const normalizedSessionId = parseBoundedString(sessionId, MAX_ID_LENGTH);
    if (!normalizedSessionId) return [];
    const domains = this.normalizeDomains(options.domains);
    const output: ContinuationGate[] = [];
    for (const sourceGates of this.sessions.get(normalizedSessionId)?.values() ?? [])
      for (const gate of sourceGates.values()) {
        if (domains && !domains.has(gate.domain)) continue;
        if (options.includeStale === false && this.leaseState(gate) === 'stale') continue;
        output.push(cloneGate(gate));
      }
    return output.sort(
      (left, right) =>
        left.domain.localeCompare(right.domain) ||
        left.source.localeCompare(right.source) ||
        left.gateId.localeCompare(right.gateId) ||
        left.acquiredAt - right.acquiredAt,
    );
  }

  listStale(
    sessionId: string,
    options: { domains?: readonly string[] } = {},
  ): readonly ContinuationGate[] {
    return this.list(sessionId, { domains: options.domains }).filter(
      (gate) => this.leaseState(gate) === 'stale',
    );
  }

  leaseState(gate: ContinuationGate, now = this.now()): 'none' | 'active' | 'stale' {
    if (!gate.lease) return 'none';
    return gate.lease.expiresAt <= Math.max(0, now) ? 'stale' : 'active';
  }

  requestSnapshot(sessionId: string): string {
    const normalizedSessionId = parseBoundedString(sessionId, MAX_ID_LENGTH);
    if (!normalizedSessionId)
      throw new TypeError('Invalid continuation gate snapshot request input.');
    this.snapshotCounter += 1;
    const requestId = parseBoundedString(
      this.options.createRequestId?.() ??
        `${this.now().toString(36)}-${this.snapshotCounter.toString(36)}`,
      MAX_ID_LENGTH,
    );
    if (!requestId) throw new TypeError('Invalid continuation gate snapshot request input.');
    const request = parseContinuationGateSnapshotRequest({
      requestId,
      sessionId: normalizedSessionId,
    });
    if (!request) throw new TypeError('Invalid continuation gate snapshot request input.');
    const expected = new Set(this.sessions.get(normalizedSessionId)?.keys() ?? []);
    const previous = this.pendingSnapshots.get(normalizedSessionId);
    if (previous?.timer) this.clearTimer(previous.timer);
    const pending: PendingSnapshot = {
      sessionId: normalizedSessionId,
      requestId,
      expected,
      answered: new Set(),
    };
    this.pendingSnapshots.set(normalizedSessionId, pending);
    this.emitTelemetry({
      kind: 'snapshot_requested',
      timestamp: this.now(),
      sessionHash: hashContinuationGateValue(normalizedSessionId),
      requestHash: hashContinuationGateValue(requestId),
    });
    this.host.events.emit(CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT, request);
    const timeoutMs = Math.min(
      60_000,
      Math.max(0, this.options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT),
    );
    if (this.pendingSnapshots.get(normalizedSessionId) === pending && timeoutMs > 0) {
      pending.timer = this.setTimer(() => this.finishSnapshotRequest(pending), timeoutMs);
      pending.timer.unref?.();
    } else if (this.pendingSnapshots.get(normalizedSessionId) === pending) {
      this.pendingSnapshots.delete(normalizedSessionId);
    }
    return request.requestId;
  }

  claimAutoResume(input: {
    transitionId: string;
    sessionId: string;
    domain: string;
    consumerId: string;
    generation: number;
  }): ContinuationGateResumeClaim | undefined {
    const transitionId = parseBoundedString(input.transitionId, MAX_ID_LENGTH);
    const sessionId = parseBoundedString(input.sessionId, MAX_ID_LENGTH);
    const domain = parseBoundedString(input.domain, MAX_DOMAIN_LENGTH);
    const consumerId = parseBoundedString(input.consumerId, MAX_ID_LENGTH);
    const generation = input.generation;
    if (
      !transitionId ||
      !sessionId ||
      !domain ||
      !consumerId ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      generation > MAX_GENERATION
    )
      return undefined;
    const transition = this.transitions.get(this.transitionKey(sessionId, domain, transitionId));
    if (
      !transition ||
      transition.generation !== generation ||
      this.generations.get(this.domainGenerationKey(sessionId, domain)) !== generation ||
      !transition.autoResumeAllowed ||
      transition.autoResumeCommitted ||
      transition.sessionId !== sessionId ||
      transition.domain !== domain ||
      this.isBlocked(sessionId, { domains: [domain] })
    )
      return undefined;
    const claimKey = this.claimKey({ sessionId, domain, transitionId, generation });
    const existing = this.claims.get(claimKey);
    if (
      existing?.state === 'committed' ||
      (existing?.state === 'pending' && existing.claim.expiresAt > this.now())
    )
      return undefined;
    if (existing) this.claims.delete(claimKey);
    const expiresAt =
      this.now() +
      Math.min(60_000, Math.max(1, this.options.resumeClaimTtlMs ?? DEFAULT_RESUME_CLAIM_TTL));
    const claimId = parseBoundedString(
      this.options.createClaimId?.() ??
        `claim-${this.now().toString(36)}-${(++this.transitionCounter).toString(36)}`,
      MAX_ID_LENGTH,
    );
    if (!claimId) return undefined;
    const claim = parseContinuationGateResumeClaim({
      claimId,
      transitionId,
      sessionId,
      domain,
      consumerId,
      generation: transition.generation,
      expiresAt,
    });
    if (!claim) return undefined;
    this.claims.set(this.claimKey(claim), { claim, state: 'pending' });
    while (this.claims.size > MAX_RESUME_CLAIMS)
      this.claims.delete(this.claims.keys().next().value as string);
    this.emitTelemetry({
      kind: 'resume_claimed',
      timestamp: this.now(),
      sessionHash: hashContinuationGateValue(sessionId),
      domain,
      transitionHash: hashContinuationGateValue(transitionId),
    });
    this.host.events.emit(CONTINUATION_GATE_RESUME_CLAIM_EVENT, cloneClaim(claim));
    this.scheduleClaimTimer();
    return cloneClaim(claim);
  }

  commitAutoResume(claim: ContinuationGateResumeClaim): boolean {
    const parsed = parseContinuationGateResumeClaim(claim);
    const transition =
      parsed &&
      this.transitions.get(
        this.transitionKey(parsed.sessionId, parsed.domain, parsed.transitionId),
      );
    const state = parsed && this.claims.get(this.claimKey(parsed));
    if (
      !parsed ||
      !transition ||
      !transition.autoResumeAllowed ||
      transition.autoResumeCommitted ||
      transition.generation !== parsed.generation ||
      this.generations.get(this.domainGenerationKey(parsed.sessionId, parsed.domain)) !==
        parsed.generation ||
      !state ||
      state.state !== 'pending' ||
      state.claim.claimId !== parsed.claimId ||
      parsed.expiresAt <= this.now() ||
      this.isBlocked(parsed.sessionId, { domains: [parsed.domain] })
    )
      return false;
    state.state = 'committed';
    transition.autoResumeCommitted = true;
    this.emitTelemetry({
      kind: 'resume_committed',
      timestamp: this.now(),
      sessionHash: hashContinuationGateValue(parsed.sessionId),
      domain: parsed.domain,
      transitionHash: hashContinuationGateValue(parsed.transitionId),
    });
    this.host.events.emit(CONTINUATION_GATE_RESUME_COMMIT_EVENT, cloneClaim(parsed));
    return true;
  }

  abortAutoResume(claim: ContinuationGateResumeClaim): boolean {
    const parsed = parseContinuationGateResumeClaim(claim);
    const state = parsed && this.claims.get(this.claimKey(parsed));
    if (!parsed || !state || state.state !== 'pending' || state.claim.claimId !== parsed.claimId)
      return false;
    state.state = 'aborted';
    this.emitTelemetry({
      kind: 'resume_aborted',
      timestamp: this.now(),
      sessionHash: hashContinuationGateValue(parsed.sessionId),
      domain: parsed.domain,
      transitionHash: hashContinuationGateValue(parsed.transitionId),
    });
    this.host.events.emit(CONTINUATION_GATE_RESUME_ABORT_EVENT, cloneClaim(parsed));
    return true;
  }

  diagnostics(): readonly ContinuationGateRegistryDiagnostic[] {
    return this.diagnosticsBuffer.map(cloneDiagnostic);
  }

  clear(): void {
    this.sessions.clear();
    this.transitions.clear();
    this.generations.clear();
    this.claims.clear();
    this.handoffs.clear();
    for (const pending of this.pendingSnapshots.values())
      if (pending.timer) this.clearTimer(pending.timer);
    this.pendingSnapshots.clear();
    if (this.claimTimer) {
      this.clearTimer(this.claimTimer);
      this.claimTimer = undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.off) off();
    this.clear();
  }

  private readonly pendingSnapshots = new Map<string, PendingSnapshot>();

  private readonly handleAcquire = (payload: unknown): void => {
    const gate = parseContinuationGateAcquire(payload);
    if (!gate) return;
    this.markProviderAnswered(gate.sessionId, gate.source);
    const before = this.domainSet(gate.sessionId);
    const gates = this.getOrCreateSource(gate.sessionId, gate.source);
    const previous = gates.get(gate.gateId);
    if (previous && this.gatesEqual(previous, gate)) return;
    gates.set(gate.gateId, gate);
    this.invalidateClaimsForGate(gate.sessionId, gate.domain);
    this.notifyChange({
      kind: 'acquired',
      sessionId: gate.sessionId,
      source: gate.source,
      gateId: gate.gateId,
      domain: gate.domain,
    });
    this.emitUnblockedTransitions(
      gate.sessionId,
      before,
      this.domainSet(gate.sessionId),
      undefined,
    );
  };

  private readonly handleRelease = (payload: unknown): void => {
    const release = parseContinuationGateRelease(payload);
    if (!release) return;
    this.markProviderAnswered(release.sessionId, release.source);
    const gates = this.sessions.get(release.sessionId)?.get(release.source);
    const current = gates?.get(release.gateId);
    if (!current || current.domain !== release.domain) return;
    const before = this.domainSet(release.sessionId);
    let wakeDisposition = release.wake;
    let handoffId = release.handoffId;
    let autoResumeAllowed = true;
    if (
      release.wake === 'producer-message' &&
      (!handoffId ||
        this.handoffs.get(handoffId)?.state !== 'committed' ||
        !this.handoffMatchesGate(this.handoffs.get(handoffId)?.handoff, current))
    ) {
      this.recordDiagnostic({
        code: 'wake-handoff-invalid',
        timestamp: this.now(),
        sessionId: release.sessionId,
        source: release.source,
        gateId: release.gateId,
        domain: release.domain,
      });
      wakeDisposition = 'none';
      handoffId = undefined;
      autoResumeAllowed = false;
    }
    gates?.delete(release.gateId);
    this.prune(release.sessionId, release.source);
    this.notifyChange({
      kind: 'released',
      sessionId: release.sessionId,
      source: release.source,
      gateId: release.gateId,
      domain: release.domain,
      wakeDisposition,
      ...(handoffId ? { handoffId } : {}),
    });
    this.emitUnblockedTransitions(release.sessionId, before, this.domainSet(release.sessionId), {
      wakeDisposition,
      handoffId,
      transitionId: release.releaseId,
      autoResumeAllowed,
    });
  };

  private readonly handleSnapshot = (payload: unknown): void => {
    const snapshot = parseContinuationGateSnapshot(payload);
    if (!snapshot) return;
    this.markProviderAnswered(snapshot.sessionId, snapshot.source);
    const before = this.domainSet(snapshot.sessionId);
    const replacement = new Map<string, ContinuationGate>();
    for (const gate of snapshot.gates) replacement.set(gate.gateId, gate);
    if (replacement.size === 0) this.sessions.get(snapshot.sessionId)?.delete(snapshot.source);
    else this.getOrCreateSession(snapshot.sessionId).set(snapshot.source, replacement);
    this.pruneSession(snapshot.sessionId);
    this.notifyChange({
      kind: 'snapshot',
      sessionId: snapshot.sessionId,
      source: snapshot.source,
    });
    this.emitTelemetry({
      kind: 'snapshot_applied',
      timestamp: this.now(),
      sessionHash: hashContinuationGateValue(snapshot.sessionId),
      sourceHash: hashContinuationGateValue(snapshot.source),
      count: snapshot.gates.length,
    });
    const requestTransition = snapshot.requestId
      ? `snapshot-${snapshot.requestId}`
      : this.requestlessSnapshotTransitionId(snapshot);
    this.emitUnblockedTransitions(snapshot.sessionId, before, this.domainSet(snapshot.sessionId), {
      wakeDisposition: 'none',
      transitionId: requestTransition,
    });
  };

  private readonly handleUnblocked = (payload: unknown): void => {
    const unblocked = parseContinuationGateUnblocked(payload);
    if (!unblocked) return;
    const key = this.transitionKey(unblocked.sessionId, unblocked.domain, unblocked.transitionId);
    const current = this.transitions.get(key);
    const latestGeneration = this.generations.get(
      this.domainGenerationKey(unblocked.sessionId, unblocked.domain),
    );
    if (
      !current ||
      unblocked.generation <= current.generation ||
      (latestGeneration !== undefined && unblocked.generation < latestGeneration)
    )
      return;
    this.generations.set(
      this.domainGenerationKey(unblocked.sessionId, unblocked.domain),
      unblocked.generation,
    );
    const transition: TransitionState = {
      ...current,
      ...unblocked,
      key,
      handoffId: unblocked.handoffId,
      autoResumeCommitted: false,
    };
    this.transitions.set(key, transition);
    this.queueUnblockedNotification(transition, true);
  };

  private readonly handleWakePending = (payload: unknown): void => {
    const handoff = parseContinuationGateWakeHandoff(payload);
    if (handoff) {
      this.handoffs.set(handoff.handoffId, { handoff, state: 'pending' });
      while (this.handoffs.size > MAX_HANDOFFS)
        this.handoffs.delete(this.handoffs.keys().next().value as string);
    }
  };
  private readonly handleWakeCommitted = (payload: unknown): void => {
    const handoff = parseContinuationGateWakeHandoff(payload);
    const current = handoff && this.handoffs.get(handoff.handoffId);
    if (
      handoff &&
      current &&
      this.handoffEquals(current.handoff, handoff) &&
      current.state === 'pending'
    )
      current.state = 'committed';
  };
  private readonly handleWakeAborted = (payload: unknown): void => {
    const handoff = parseContinuationGateWakeHandoff(payload);
    const current = handoff && this.handoffs.get(handoff.handoffId);
    if (handoff && current && current.state === 'pending') current.state = 'aborted';
  };

  private readonly handleResumeClaim = (payload: unknown): void => {
    const claim = parseContinuationGateResumeClaim(payload);
    if (!claim || claim.expiresAt <= this.now()) return;
    const transition = this.transitions.get(
      this.transitionKey(claim.sessionId, claim.domain, claim.transitionId),
    );
    if (
      !transition ||
      transition.generation !== claim.generation ||
      this.generations.get(this.domainGenerationKey(claim.sessionId, claim.domain)) !==
        claim.generation ||
      !transition.autoResumeAllowed ||
      transition.autoResumeCommitted ||
      this.isBlocked(claim.sessionId, { domains: [claim.domain] })
    )
      return;
    const current = this.claims.get(this.claimKey(claim));
    if (current?.state === 'committed') return;
    if (
      current?.state === 'pending' &&
      current.claim.claimId !== claim.claimId &&
      current.claim.expiresAt > this.now()
    )
      return;
    this.claims.set(this.claimKey(claim), { claim, state: 'pending' });
    while (this.claims.size > MAX_RESUME_CLAIMS)
      this.claims.delete(this.claims.keys().next().value as string);
  };
  private readonly handleResumeCommit = (payload: unknown): void => {
    this.updateClaimState(payload, 'committed');
  };
  private readonly handleResumeAbort = (payload: unknown): void => {
    this.updateClaimState(payload, 'aborted');
  };

  private updateClaimState(payload: unknown, state: 'committed' | 'aborted'): void {
    const claim = parseContinuationGateResumeClaim(payload);
    if (!claim) return;
    const key = this.claimKey(claim);
    const current = this.claims.get(key);
    if (current?.claim.claimId !== claim.claimId) return;
    if (state === 'committed') {
      const transition = this.transitions.get(
        this.transitionKey(claim.sessionId, claim.domain, claim.transitionId),
      );
      if (
        transition?.generation !== claim.generation ||
        this.generations.get(this.domainGenerationKey(claim.sessionId, claim.domain)) !==
          claim.generation ||
        !transition.autoResumeAllowed
      )
        return;
      transition.autoResumeCommitted = true;
    }
    if (current.state === 'pending') current.state = state;
  }

  private emitUnblockedTransitions(
    sessionId: string,
    before: Set<string>,
    after: Set<string>,
    release:
      | {
          wakeDisposition: ContinuationGateWakeDisposition;
          handoffId?: string;
          transitionId: string;
          autoResumeAllowed?: boolean;
        }
      | undefined,
  ): void {
    for (const domain of before)
      if (!after.has(domain)) {
        const transitionId =
          release?.transitionId ?? `snapshot-${++this.transitionCounter}:${domain}`;
        const generation = this.nextGeneration(this.domainGenerationKey(sessionId, domain));
        if (generation === undefined) {
          this.recordDiagnostic({
            code: 'generation-exhausted',
            timestamp: this.now(),
            sessionId,
            domain,
          });
          continue;
        }
        const corrected: ContinuationGateUnblocked = {
          transitionId,
          sessionId,
          domain,
          wakeDisposition: release?.wakeDisposition ?? 'none',
          ...(release?.handoffId ? { handoffId: release.handoffId } : {}),
          generation,
        };
        const autoResumeAllowed = release?.autoResumeAllowed ?? true;
        const transition: TransitionState = {
          ...corrected,
          key: this.transitionKey(sessionId, domain, transitionId),
          autoResumeAllowed,
          autoResumeCommitted: false,
        };
        this.transitions.set(transition.key, transition);
        queueMicrotask(() => {
          if (
            this.disposed ||
            this.transitions.get(transition.key) !== transition ||
            this.generations.get(this.domainGenerationKey(sessionId, domain)) !==
              corrected.generation ||
            this.isBlocked(sessionId, { domains: [domain] })
          )
            return;
          this.host.events.emit(CONTINUATION_GATE_UNBLOCKED_EVENT, { ...corrected });
          this.queueUnblockedNotification(transition);
        });
      }
  }

  private queueUnblockedNotification(transition: TransitionState, defer = false): void {
    const notify = (): void => {
      const current = this.transitions.get(transition.key);
      if (
        this.disposed ||
        current !== transition ||
        this.generations.get(this.domainGenerationKey(transition.sessionId, transition.domain)) !==
          transition.generation ||
        this.isBlocked(transition.sessionId, { domains: [transition.domain] })
      )
        return;
      this.notifyChange({
        kind: 'unblocked',
        sessionId: current.sessionId,
        domain: current.domain,
        transitionId: current.transitionId,
        generation: current.generation,
        wakeDisposition: current.wakeDisposition,
        ...(current.handoffId ? { handoffId: current.handoffId } : {}),
        autoResumeAllowed: current.autoResumeAllowed,
      });
    };
    if (defer) queueMicrotask(() => queueMicrotask(notify));
    else queueMicrotask(notify);
  }

  private nextGeneration(key: string): number | undefined {
    const generation = this.generations.get(key) ?? 0;
    if (generation >= MAX_GENERATION - 1) {
      return undefined;
    }
    const next = generation + 1;
    this.generations.set(key, next);
    return next;
  }
  private domainSet(sessionId: string): Set<string> {
    const result = new Set<string>();
    for (const source of this.sessions.get(sessionId)?.values() ?? [])
      for (const gate of source.values()) result.add(gate.domain);
    return result;
  }
  private normalizeDomains(domains: readonly string[] | undefined): Set<string> | undefined {
    return domains
      ? new Set(
          domains
            .map((domain) => parseBoundedString(domain, MAX_DOMAIN_LENGTH))
            .filter((domain): domain is string => !!domain),
        )
      : undefined;
  }
  private getOrCreateSource(sessionId: string, source: string): Map<string, ContinuationGate> {
    return (
      this.getOrCreateSession(sessionId).get(source) ??
      (() => {
        const gates = new Map<string, ContinuationGate>();
        this.getOrCreateSession(sessionId).set(source, gates);
        return gates;
      })()
    );
  }
  private getOrCreateSession(sessionId: string): SourceGates {
    let sources = this.sessions.get(sessionId);
    if (!sources) {
      sources = new Map();
      this.sessions.set(sessionId, sources);
    }
    return sources;
  }
  private prune(sessionId: string, source: string): void {
    const sources = this.sessions.get(sessionId);
    if (!sources) return;
    if (sources.get(source)?.size === 0) sources.delete(source);
    this.pruneSession(sessionId);
  }
  private pruneSession(sessionId: string): void {
    const sources = this.sessions.get(sessionId);
    if (sources?.size === 0) this.sessions.delete(sessionId);
  }
  private gatesEqual(left: ContinuationGate, right: ContinuationGate): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  private handoffEquals(
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
  private handoffMatchesGate(
    handoff: ContinuationGateWakeHandoff | undefined,
    gate: ContinuationGate,
  ): boolean {
    return (
      !!handoff &&
      handoff.sessionId === gate.sessionId &&
      handoff.source === gate.source &&
      handoff.gateId === gate.gateId &&
      handoff.domain === gate.domain
    );
  }
  private requestlessSnapshotTransitionId(snapshot: {
    sessionId: string;
    source: string;
    gates: readonly ContinuationGate[];
  }): string {
    const fingerprint = [
      snapshot.sessionId,
      snapshot.source,
      ...snapshot.gates.map((gate) =>
        [gate.gateId, gate.domain, gate.acquiredAt, gate.updatedAt].join('\0'),
      ),
    ].join('\0');
    return `snapshot-${hashContinuationGateValue(fingerprint)}`;
  }
  private transitionKey(sessionId: string, domain: string, transitionId: string): string {
    return `${sessionId}\0${domain}\0${transitionId}`;
  }
  private domainGenerationKey(sessionId: string, domain: string): string {
    return `${sessionId}\0${domain}`;
  }
  private claimKey(
    claim: Pick<
      ContinuationGateResumeClaim,
      'sessionId' | 'domain' | 'transitionId' | 'generation'
    >,
  ): string {
    return `${this.transitionKey(claim.sessionId, claim.domain, claim.transitionId)}\0${claim.generation}`;
  }
  private markProviderAnswered(sessionId: string, source: string): void {
    const pending = this.pendingSnapshots.get(sessionId);
    if (!pending || !pending.expected.has(source) || pending.answered.has(source)) return;
    pending.answered.add(source);
    this.emitTelemetry({
      kind: 'provider_recovered',
      timestamp: this.now(),
      sessionHash: hashContinuationGateValue(sessionId),
      sourceHash: hashContinuationGateValue(source),
    });
    if (pending.answered.size === pending.expected.size) {
      if (pending.timer) this.clearTimer(pending.timer);
      this.pendingSnapshots.delete(sessionId);
    }
  }
  private finishSnapshotRequest(pending: PendingSnapshot): void {
    if (this.pendingSnapshots.get(pending.sessionId) !== pending) return;
    this.pendingSnapshots.delete(pending.sessionId);
    for (const source of pending.expected)
      if (!pending.answered.has(source)) {
        this.recordDiagnostic({
          code: 'provider-unresponsive',
          timestamp: this.now(),
          sessionId: pending.sessionId,
          source,
        });
        this.emitTelemetry({
          kind: 'provider_unresponsive',
          timestamp: this.now(),
          sessionHash: hashContinuationGateValue(pending.sessionId),
          sourceHash: hashContinuationGateValue(source),
        });
      }
    this.emitTelemetry({
      kind: 'snapshot_timeout',
      timestamp: this.now(),
      sessionHash: hashContinuationGateValue(pending.sessionId),
      requestHash: hashContinuationGateValue(pending.requestId),
      count: pending.expected.size - pending.answered.size,
    });
  }
  private scheduleClaimTimer(): void {
    if (this.claimTimer) this.clearTimer(this.claimTimer);
    let deadline = Number.POSITIVE_INFINITY;
    for (const state of this.claims.values())
      if (state.state === 'pending') deadline = Math.min(deadline, state.claim.expiresAt);
    if (!Number.isFinite(deadline)) {
      this.claimTimer = undefined;
      return;
    }
    this.claimTimer = this.setTimer(
      () => {
        this.claimTimer = undefined;
        const now = this.now();
        for (const [key, state] of this.claims)
          if (state.state === 'pending' && state.claim.expiresAt <= now) this.claims.delete(key);
        this.scheduleClaimTimer();
      },
      Math.min(2_147_483_647, Math.max(0, deadline - this.now())),
    );
    this.claimTimer.unref?.();
  }
  private invalidateClaimsForGate(sessionId: string, domain: string): void {
    for (const [key, state] of this.claims)
      if (
        state.claim.sessionId === sessionId &&
        state.claim.domain === domain &&
        state.state === 'pending'
      )
        this.claims.delete(key);
    this.scheduleClaimTimer();
  }
  private recordDiagnostic(diagnostic: ContinuationGateRegistryDiagnostic): void {
    this.diagnosticsBuffer.push(diagnostic);
    while (this.diagnosticsBuffer.length > MAX_DIAGNOSTIC_COUNT) this.diagnosticsBuffer.shift();
    try {
      this.options.onDiagnostic?.(cloneDiagnostic(diagnostic));
    } catch {
      /* diagnostics are observer-only */
    }
  }
  private notifyChange(change: ContinuationGateRegistryChange): void {
    try {
      this.options.onChange?.(change);
    } catch {
      /* observers must not affect gate state */
    }
  }
  private emitTelemetry(event: ContinuationGateTelemetryEvent): void {
    try {
      this.options.onTelemetry?.(event);
    } catch {
      /* telemetry must not affect event listeners */
    }
  }
}

export function createContinuationGateRegistry(
  host: ContinuationGateProtocolHost,
  options: ContinuationGateRegistryOptions = {},
): ContinuationGateRegistry {
  return new EventContinuationGateRegistry(host, options);
}
