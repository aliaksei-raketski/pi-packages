import { describe, expect, it } from 'vitest';
import { createContinuationGateController } from './controller.js';
import {
  CONTINUATION_GATE_ACQUIRE_EVENT,
  CONTINUATION_GATE_RELEASE_EVENT,
  CONTINUATION_GATE_SNAPSHOT_EVENT,
  CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT,
  type ContinuationGate,
  type ContinuationGateProtocolHost,
} from './protocol.js';
import { createContinuationGateRegistry } from './registry.js';
import {
  parseContinuationGateAcquire,
  parseContinuationGateRelease,
  parseContinuationGateSnapshot,
  parseContinuationGateSnapshotRequest,
} from './validation.js';

class FakeEventBus {
  readonly emitted: Array<{ eventName: string; payload: unknown }> = [];
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  emit(eventName: string, payload: unknown): void {
    this.emitted.push({ eventName, payload });
    for (const handler of [...(this.listeners.get(eventName) ?? [])]) handler(payload);
  }
  on(eventName: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.listeners.get(eventName) ?? new Set();
    handlers.add(handler);
    this.listeners.set(eventName, handlers);
    return () => handlers.delete(handler);
  }
  listenerCount(eventName: string): number {
    return this.listeners.get(eventName)?.size ?? 0;
  }
}
function createHost(): { bus: FakeEventBus; host: ContinuationGateProtocolHost } {
  const bus = new FakeEventBus();
  return { bus, host: { events: bus } };
}
function gate(overrides: Partial<ContinuationGate> = {}): ContinuationGate {
  return {
    sessionId: 'session-1',
    source: 'tmux',
    gateId: 'process-1',
    domain: 'autonomous-continuation',
    reason: 'Waiting for command completion',
    acquiredAt: 100,
    updatedAt: 100,
    resource: { kind: 'process', id: 'pane-1', label: 'tests' },
    ...overrides,
  };
}

describe('continuation gate payload validation', () => {
  it('accepts the unversioned model and normalizes defaults', () => {
    expect(parseContinuationGateAcquire({ ...gate(), domain: undefined, unknown: true })).toEqual(
      gate(),
    );
    expect(
      parseContinuationGateRelease({
        releaseId: 'release-1',
        sessionId: 'session-1',
        source: 'tmux',
        gateId: 'process-1',
        domain: 'autonomous-continuation',
        outcome: 'completed',
        wake: 'none',
        releasedAt: 101,
      }),
    ).toMatchObject({ releaseId: 'release-1', domain: 'autonomous-continuation' });
    expect(
      parseContinuationGateSnapshotRequest({ requestId: 'request-1', sessionId: 'session-1' }),
    ).toEqual({ requestId: 'request-1', sessionId: 'session-1' });
    expect(
      parseContinuationGateSnapshot({
        requestId: 'request-1',
        sessionId: 'session-1',
        source: 'tmux',
        gates: [gate()],
      }),
    ).toMatchObject({ source: 'tmux', gates: [gate()] });
  });
  it('rejects versioned and invalid payloads without throwing', () => {
    expect(parseContinuationGateAcquire({ ...gate(), protocolVersion: 1 })).toEqual(gate());
    expect(
      parseContinuationGateRelease({
        releaseId: 'x',
        sessionId: 's',
        source: 'p',
        gateId: 'g',
        domain: 'd',
        outcome: 'completed',
        wake: 'producer-message',
        releasedAt: 1,
      }),
    ).toBeUndefined();
    expect(parseContinuationGateAcquire({ ...gate(), updatedAt: 99 })).toBeUndefined();
    expect(
      parseContinuationGateAcquire({ ...gate(), lease: { expiresAt: 100, policy: 'diagnose' } }),
    ).toBeUndefined();
    expect(
      parseContinuationGateSnapshot({
        sessionId: 's',
        source: 'p',
        gates: Array.from({ length: 513 }, () => gate()),
      }),
    ).toBeUndefined();
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('hostile');
        },
      },
    );
    expect(() => parseContinuationGateAcquire(hostile)).not.toThrow();
    expect(() => parseContinuationGateRelease(hostile)).not.toThrow();
    expect(() => parseContinuationGateSnapshotRequest(hostile)).not.toThrow();
    expect(() => parseContinuationGateSnapshot(hostile)).not.toThrow();
  });
});

describe('controller leases and snapshots', () => {
  it('reacquires and renews a gate while preserving acquisition time', () => {
    const { host } = createHost();
    let now = 10;
    const controller = createContinuationGateController(host, { source: 'tmux', now: () => now });
    const first = controller.acquire({
      sessionId: 's',
      gateId: 'g',
      reason: 'first',
      lease: { durationMs: 100, policy: 'diagnose' },
    });
    now = 20;
    const second = controller.acquire({ sessionId: 's', gateId: 'g', reason: 'second' });
    expect(second.acquiredAt).toBe(first.acquiredAt);
    expect(second.updatedAt).toBe(20);
    now = 30;
    expect(
      controller.renew({ sessionId: 's', gateId: 'g', durationMs: 50 })?.lease?.expiresAt,
    ).toBe(80);
  });
  it('expires opt-in leases but keeps diagnose leases blocking', () => {
    const { host, bus } = createHost();
    let now = 10;
    const controller = createContinuationGateController(host, { source: 'p', now: () => now });
    const registry = createContinuationGateRegistry(host, { now: () => now });
    controller.acquire({
      sessionId: 's',
      gateId: 'diagnose',
      reason: 'wait',
      lease: { expiresAt: 20, policy: 'diagnose' },
    });
    controller.acquire({
      sessionId: 's',
      gateId: 'expire',
      reason: 'wait',
      lease: { expiresAt: 20, policy: 'expire' },
    });
    now = 20;
    controller.publishSnapshot('s');
    expect(registry.listStale('s').map((item) => item.gateId)).toEqual(['diagnose']);
    expect(registry.isBlocked('s')).toBe(true);
    expect(
      bus.emitted.some(
        ({ eventName, payload }) =>
          eventName === CONTINUATION_GATE_RELEASE_EVENT &&
          (payload as { outcome: string }).outcome === 'expired',
      ),
    ).toBe(true);
    registry.dispose();
    controller.dispose();
  });
  it('expires at the exact deadline before a snapshot can republish the gate', () => {
    const { host } = createHost();
    const timers: Array<() => void> = [];
    let now = 0;
    const controller = createContinuationGateController(host, {
      source: 'p',
      now: () => now,
      setTimeout: (callback) => {
        timers.push(callback);
        return { unref: () => undefined } as never;
      },
      clearTimeout: () => undefined,
    });
    const registry = createContinuationGateRegistry(host, { now: () => now });
    controller.acquire({
      sessionId: 's',
      gateId: 'expires',
      reason: 'wait',
      lease: { expiresAt: 10, policy: 'expire' },
    });
    now = 10;
    timers.at(-1)?.();
    expect(controller.list('s')).toEqual([]);
    expect(registry.isBlocked('s')).toBe(false);
    registry.dispose();
    controller.dispose();
  });
  it('commits producer wake before a producer-message unblock and scopes telemetry', () => {
    const { host } = createHost();
    const telemetry: unknown[] = [];
    const controller = createContinuationGateController(host, {
      source: 'p',
      now: () => 10,
      onTelemetry: (event) => telemetry.push(event),
    });
    const changes: Array<{ wakeDisposition?: string; handoffId?: string }> = [];
    const registry = createContinuationGateRegistry(host, {
      onChange: (change) => {
        if (change.kind === 'unblocked') changes.push(change);
      },
    });
    controller.acquire({
      sessionId: 's',
      gateId: 'g',
      reason: 'secret command',
      resource: { kind: 'process', id: 'private', label: 'private label' },
    });
    const handoff = controller.prepareWake({ sessionId: 's', gateId: 'g' });
    controller.commitWake(handoff);
    controller.release({
      sessionId: 's',
      gateId: 'g',
      outcome: 'completed',
      wake: 'producer-message',
      handoffId: handoff.handoffId,
    });
    expect(changes.at(-1)).toMatchObject({
      wakeDisposition: 'producer-message',
      handoffId: handoff.handoffId,
    });
    expect(JSON.stringify(telemetry)).not.toContain('secret command');
    expect(JSON.stringify(telemetry)).not.toContain('private label');
    registry.dispose();
    controller.dispose();
  });
  it('rejects auto-resume claims for invalid producer-message handoffs', () => {
    const { bus, host } = createHost();
    const unblocked: Array<{
      transitionId?: string;
      domain?: string;
      wakeDisposition?: string;
      autoResumeAllowed?: boolean;
    }> = [];
    const registry = createContinuationGateRegistry(host, {
      onChange: (change) => {
        if (change.kind === 'unblocked') unblocked.push(change);
      },
    });
    bus.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate());
    bus.emit(CONTINUATION_GATE_RELEASE_EVENT, {
      releaseId: 'invalid-handoff-release',
      sessionId: 'session-1',
      source: 'tmux',
      gateId: 'process-1',
      domain: 'autonomous-continuation',
      outcome: 'completed',
      wake: 'producer-message',
      handoffId: 'not-committed',
      releasedAt: 200,
    });

    expect(unblocked.at(-1)).toMatchObject({
      wakeDisposition: 'none',
      autoResumeAllowed: false,
    });
    const transition = unblocked.at(-1);
    expect(
      registry.claimAutoResume({
        transitionId: transition?.transitionId ?? '',
        sessionId: 'session-1',
        domain: transition?.domain ?? '',
        consumerId: 'goal',
      }),
    ).toBeUndefined();
    expect(registry.diagnostics()).toContainEqual(
      expect.objectContaining({ code: 'wake-handoff-invalid', gateId: 'process-1' }),
    );
    registry.dispose();
  });

  it('uses one disposable timer and isolates sessions/domains', () => {
    const { host } = createHost();
    const timers: Array<() => void> = [];
    let cleared = 0;
    const controller = createContinuationGateController(host, {
      source: 'p',
      now: () => 10,
      setTimeout: (callback) => {
        timers.push(callback);
        return { unref: () => undefined } as never;
      },
      clearTimeout: () => {
        cleared += 1;
      },
    });
    controller.acquire({
      sessionId: 's1',
      gateId: 'one',
      domain: 'a',
      reason: 'a',
      lease: { expiresAt: 20, policy: 'diagnose' },
    });
    controller.acquire({
      sessionId: 's1',
      gateId: 'two',
      domain: 'b',
      reason: 'b',
      lease: { expiresAt: 30, policy: 'diagnose' },
    });
    expect(controller.list('s1', { domains: ['b'] }).map(({ gateId }) => gateId)).toEqual(['two']);
    controller.dispose();
    controller.dispose();
    expect(cleared).toBeGreaterThan(0);
    expect(timers.length).toBeGreaterThan(0);
  });
  it('answers only the requested session', () => {
    const { bus, host } = createHost();
    const controller = createContinuationGateController(host, { source: 'p', now: () => 10 });
    controller.acquire({ sessionId: 's1', gateId: 'one', reason: 'one' });
    controller.acquire({ sessionId: 's2', gateId: 'two', reason: 'two' });
    bus.emitted.length = 0;
    bus.emit(CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT, { requestId: 'r', sessionId: 's1' });
    const snapshot = bus.emitted.find(
      ({ eventName }) => eventName === CONTINUATION_GATE_SNAPSHOT_EVENT,
    )?.payload as { gates: ContinuationGate[] };
    expect(snapshot.gates.map(({ gateId }) => gateId)).toEqual(['one']);
  });
});

describe('registry and resume claims', () => {
  it('replaces one source, emits one domain unblock, and has a single winner', () => {
    const { bus, host } = createHost();
    const changes: string[] = [];
    const registry = createContinuationGateRegistry(host, {
      onChange: (change) => changes.push(change.kind),
    });
    bus.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate({ source: 'a', gateId: 'same', domain: 'one' }));
    bus.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate({ source: 'b', gateId: 'same', domain: 'two' }));
    bus.emit(CONTINUATION_GATE_RELEASE_EVENT, {
      releaseId: 'r',
      sessionId: 'session-1',
      source: 'a',
      gateId: 'same',
      domain: 'one',
      outcome: 'completed',
      wake: 'none',
      releasedAt: 200,
    });
    expect(registry.list('session-1', { domains: ['one'] })).toEqual([]);
    const unblock = bus.emitted.find(
      ({ eventName }) => eventName === 'pi-continuation-gate:unblocked',
    )?.payload as { transitionId: string; domain: string };
    expect(unblock.domain).toBe('one');
    const first = registry.claimAutoResume({
      transitionId: unblock.transitionId,
      sessionId: 'session-1',
      domain: 'one',
      consumerId: 'first',
    });
    expect(first).toBeDefined();
    expect(
      registry.claimAutoResume({
        transitionId: unblock.transitionId,
        sessionId: 'session-1',
        domain: 'one',
        consumerId: 'second',
      }),
    ).toBeUndefined();
    expect(changes).toContain('unblocked');
  });
  it('coordinates separately installed registry copies through the shared bus', () => {
    const { bus, host } = createHost();
    const controller = createContinuationGateController(host, {
      source: 'producer',
      now: () => 10,
    });
    const first = createContinuationGateRegistry(host);
    const second = createContinuationGateRegistry(host);
    controller.acquire({ sessionId: 's', gateId: 'g', reason: 'waiting' });
    first.requestSnapshot('s');
    expect(second.isBlocked('s')).toBe(true);
    controller.release({ sessionId: 's', gateId: 'g', outcome: 'completed', wake: 'none' });
    const transitionId = (
      bus.emitted
        .filter(({ eventName }) => eventName === 'pi-continuation-gate:unblocked')
        .slice(-1)[0]?.payload as { transitionId: string }
    ).transitionId;
    const claim = first.claimAutoResume({
      transitionId,
      sessionId: 's',
      domain: 'autonomous-continuation',
      consumerId: 'consumer-a',
    });
    expect(claim).toBeDefined();
    expect(
      second.claimAutoResume({
        transitionId,
        sessionId: 's',
        domain: 'autonomous-continuation',
        consumerId: 'consumer-b',
      }),
    ).toBeUndefined();
    expect(claim && first.commitAutoResume(claim)).toBe(true);
    expect(claim && second.commitAutoResume(claim)).toBe(false);
    first.dispose();
    second.dispose();
    controller.dispose();
  });
  it('returns defensive nested copies and disposes listeners', () => {
    const { bus, host } = createHost();
    const registry = createContinuationGateRegistry(host);
    bus.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate());
    const returned = registry.list('session-1') as ContinuationGate[];
    const returnedGate = returned[0];
    if (returnedGate?.resource) returnedGate.resource.label = 'mutated';
    if (returnedGate) returnedGate.lease = { expiresAt: 200, policy: 'expire' };
    expect(registry.list('session-1')[0]).toEqual(gate());
    registry.dispose();
    expect(bus.listenerCount(CONTINUATION_GATE_ACQUIRE_EVENT)).toBe(0);
  });
});
