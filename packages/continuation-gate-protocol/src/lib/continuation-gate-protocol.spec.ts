import { describe, expect, it, vi } from 'vitest';
import { createContinuationGateController } from './controller.js';
import {
  CONTINUATION_GATE_ACQUIRE_EVENT,
  CONTINUATION_GATE_PROTOCOL_VERSION,
  CONTINUATION_GATE_RELEASE_EVENT,
  CONTINUATION_GATE_SNAPSHOT_EVENT,
  CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT,
  type ContinuationGate,
  type ContinuationGateProtocolHost,
} from './protocol.js';
import { createContinuationGateRegistry } from './registry.js';
import {
  isContinuationGate,
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
    for (const handler of [...(this.listeners.get(eventName) ?? [])]) {
      handler(payload);
    }
  }

  on(eventName: string, handler: (payload: unknown) => void): () => void {
    let handlers = this.listeners.get(eventName);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(eventName, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
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
    protocolVersion: CONTINUATION_GATE_PROTOCOL_VERSION,
    sessionId: 'session-1',
    source: 'tmux',
    gateId: 'process-1',
    reason: 'Waiting for command completion',
    acquiredAt: 100,
    resource: { kind: 'process', id: 'pane-1', label: 'tests' },
    ...overrides,
  };
}

describe('continuation gate payload validation', () => {
  it('accepts and normalizes valid v1 payloads', () => {
    expect(
      parseContinuationGateAcquire({
        ...gate(),
        sessionId: ' session-1 ',
        unknown: true,
      }),
    ).toEqual(gate());
    expect(isContinuationGate(gate())).toBe(true);

    expect(
      parseContinuationGateRelease({
        protocolVersion: 1,
        sessionId: 'session-1',
        source: 'tmux',
        gateId: 'process-1',
        outcome: 'completed',
        wake: 'producer-message',
        releasedAt: 101,
      }),
    ).toMatchObject({ outcome: 'completed', wake: 'producer-message' });

    expect(
      parseContinuationGateSnapshotRequest({
        protocolVersion: 1,
        requestId: 'request-1',
        sessionId: 'session-1',
      }),
    ).toEqual({ protocolVersion: 1, requestId: 'request-1', sessionId: 'session-1' });

    expect(
      parseContinuationGateSnapshot({
        protocolVersion: 1,
        requestId: 'request-1',
        sessionId: 'session-1',
        source: 'tmux',
        gates: [gate()],
      }),
    ).toMatchObject({ source: 'tmux', gates: [gate()] });
  });

  it('rejects unsupported versions, blank identities, and invalid timestamps', () => {
    expect(parseContinuationGateAcquire({ ...gate(), protocolVersion: 2 })).toBeUndefined();
    for (const key of ['sessionId', 'source', 'gateId'] as const) {
      expect(parseContinuationGateAcquire({ ...gate(), [key]: '   ' })).toBeUndefined();
    }
    expect(parseContinuationGateAcquire({ ...gate(), acquiredAt: -1 })).toBeUndefined();
    expect(parseContinuationGateAcquire({ ...gate(), acquiredAt: Number.NaN })).toBeUndefined();
    expect(parseContinuationGateRelease({ releasedAt: 1 })).toBeUndefined();
    expect(parseContinuationGateSnapshotRequest(undefined)).toBeUndefined();
    expect(
      parseContinuationGateSnapshot({ protocolVersion: 1, sessionId: 'session-1', gates: [] }),
    ).toBeUndefined();
  });

  it('bounds strings and validates resources', () => {
    expect(parseContinuationGateAcquire({ ...gate(), gateId: 'x'.repeat(257) })).toBeUndefined();
    expect(parseContinuationGateAcquire({ ...gate(), reason: 'x'.repeat(2_049) })).toBeUndefined();
    expect(
      parseContinuationGateAcquire({ ...gate(), resource: { kind: '', id: 'pane-1' } }),
    ).toBeUndefined();
  });

  it('filters malformed and mismatched gates without rejecting a valid snapshot envelope', () => {
    const snapshot = parseContinuationGateSnapshot({
      protocolVersion: 1,
      sessionId: 'session-1',
      source: 'tmux',
      gates: [
        gate(),
        { ...gate(), gateId: '', reason: 42 },
        gate({ source: 'ci', gateId: 'other-source' }),
        gate({ sessionId: 'session-2', gateId: 'other-session' }),
      ],
    });

    expect(snapshot?.gates).toEqual([gate()]);
  });

  it('never throws for malformed payloads, including hostile property access', () => {
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

describe('continuation gate controller', () => {
  it('acquires, updates, and releases one authoritative gate idempotently', () => {
    const { bus, host } = createHost();
    let currentTime = 10;
    const controller = createContinuationGateController(host, {
      source: 'tmux',
      now: () => currentTime++,
    });

    const first = controller.acquire({
      sessionId: 'session-1',
      gateId: 'process-1',
      reason: 'first reason',
    });
    const updated = controller.acquire({
      sessionId: 'session-1',
      gateId: 'process-1',
      reason: 'updated reason',
      resource: { kind: 'process', id: 'pane-1' },
    });

    expect(first.acquiredAt).toBe(10);
    expect(updated.acquiredAt).toBe(10);
    expect(controller.list('session-1')).toEqual([updated]);
    expect(
      bus.emitted.filter(({ eventName }) => eventName === CONTINUATION_GATE_ACQUIRE_EVENT),
    ).toHaveLength(2);

    expect(
      controller.release({
        sessionId: 'session-1',
        gateId: 'process-1',
        outcome: 'completed',
        wake: 'producer-message',
      }),
    ).toBe(true);
    expect(controller.list('session-1')).toEqual([]);
    expect(
      controller.release({
        sessionId: 'session-1',
        gateId: 'process-1',
        outcome: 'completed',
        wake: 'producer-message',
      }),
    ).toBe(false);
    expect(
      bus.emitted.filter(({ eventName }) => eventName === CONTINUATION_GATE_RELEASE_EVENT),
    ).toHaveLength(1);
  });

  it('rejects invalid producer acquisition input without emitting', () => {
    const { bus, host } = createHost();
    const controller = createContinuationGateController(host, { source: 'tmux' });

    expect(() => controller.acquire({ sessionId: '', gateId: 'gate', reason: 'wait' })).toThrow(
      TypeError,
    );
    expect(bus.emitted).toEqual([]);
  });

  it('answers snapshot requests for only the requested session, including empty sessions', () => {
    const { bus, host } = createHost();
    const controller = createContinuationGateController(host, { source: 'tmux', now: () => 10 });
    controller.acquire({ sessionId: 'session-1', gateId: 'one', reason: 'one' });
    controller.acquire({ sessionId: 'session-2', gateId: 'two', reason: 'two' });
    bus.emitted.length = 0;

    bus.emit(CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT, {
      protocolVersion: 1,
      requestId: 'request-1',
      sessionId: 'session-1',
    });
    bus.emit(CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT, {
      protocolVersion: 1,
      requestId: 'request-empty',
      sessionId: 'session-empty',
    });

    const snapshots = bus.emitted
      .filter(({ eventName }) => eventName === CONTINUATION_GATE_SNAPSHOT_EVENT)
      .map(({ payload }) => payload as { requestId: string; gates: ContinuationGate[] });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.gates.map(({ gateId }) => gateId)).toEqual(['one']);
    expect(snapshots[1]).toMatchObject({ requestId: 'request-empty', gates: [] });
  });

  it('clears a session with releases and an authoritative empty snapshot', () => {
    const { bus, host } = createHost();
    const controller = createContinuationGateController(host, { source: 'tmux', now: () => 10 });
    const registry = createContinuationGateRegistry(host);
    controller.acquire({ sessionId: 'session-1', gateId: 'one', reason: 'one' });
    controller.acquire({ sessionId: 'session-1', gateId: 'two', reason: 'two' });

    controller.clearSession('session-1', 'cancelled');

    expect(registry.isBlocked('session-1')).toBe(false);
    const releases = bus.emitted.filter(
      ({ eventName }) => eventName === CONTINUATION_GATE_RELEASE_EVENT,
    );
    expect(releases).toHaveLength(2);
    expect(
      bus.emitted.some(
        ({ eventName, payload }) =>
          eventName === CONTINUATION_GATE_SNAPSHOT_EVENT &&
          (payload as { gates: unknown[] }).gates.length === 0,
      ),
    ).toBe(true);
  });

  it('disposes the snapshot listener idempotently and retains or releases gates explicitly', () => {
    const { bus, host } = createHost();
    const controller = createContinuationGateController(host, { source: 'tmux', now: () => 10 });
    controller.acquire({ sessionId: 'session-1', gateId: 'one', reason: 'one' });

    expect(bus.listenerCount(CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT)).toBe(1);
    controller.dispose();
    controller.dispose();
    expect(bus.listenerCount(CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT)).toBe(0);
    expect(controller.list('session-1')).toHaveLength(1);

    controller.dispose({ release: true });
    controller.dispose({ release: true });
    expect(controller.list('session-1')).toEqual([]);
  });
});

describe('continuation gate registry', () => {
  it('keeps sources, gate identities, and sessions isolated with deterministic lists', () => {
    const { bus, host } = createHost();
    const registry = createContinuationGateRegistry(host);

    bus.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate({ source: 'tmux', gateId: 'same' }));
    bus.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate({ source: 'ci', gateId: 'same' }));
    bus.emit(
      CONTINUATION_GATE_ACQUIRE_EVENT,
      gate({ sessionId: 'session-2', source: 'tmux', gateId: 'other' }),
    );

    expect(registry.list('session-1').map(({ source }) => source)).toEqual(['ci', 'tmux']);
    expect(registry.list('session-2').map(({ gateId }) => gateId)).toEqual(['other']);

    bus.emit(CONTINUATION_GATE_RELEASE_EVENT, {
      protocolVersion: 1,
      sessionId: 'session-1',
      source: 'tmux',
      gateId: 'same',
      outcome: 'completed',
      wake: 'none',
      releasedAt: 101,
    });
    expect(registry.list('session-1').map(({ source }) => source)).toEqual(['ci']);
  });

  it('deduplicates acquisitions and ignores release-before-acquire', () => {
    const { bus, host } = createHost();
    const onChange = vi.fn();
    const registry = createContinuationGateRegistry(host, { onChange });

    bus.emit(CONTINUATION_GATE_RELEASE_EVENT, {
      protocolVersion: 1,
      sessionId: 'session-1',
      source: 'tmux',
      gateId: 'missing',
      outcome: 'completed',
      wake: 'none',
      releasedAt: 1,
    });
    bus.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate());
    bus.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate());

    expect(registry.list('session-1')).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('replaces only one source and session from snapshots, including empty snapshots', () => {
    const { bus, host } = createHost();
    const registry = createContinuationGateRegistry(host);
    bus.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate({ source: 'tmux', gateId: 'old' }));
    bus.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate({ source: 'ci', gateId: 'ci-1' }));
    bus.emit(
      CONTINUATION_GATE_ACQUIRE_EVENT,
      gate({ sessionId: 'session-2', source: 'tmux', gateId: 'session-2-gate' }),
    );

    bus.emit(CONTINUATION_GATE_SNAPSHOT_EVENT, {
      protocolVersion: 1,
      sessionId: 'session-1',
      source: 'tmux',
      gates: [gate({ gateId: 'new' })],
    });
    expect(registry.list('session-1').map(({ gateId }) => gateId)).toEqual(['ci-1', 'new']);

    bus.emit(CONTINUATION_GATE_SNAPSHOT_EVENT, {
      protocolVersion: 1,
      sessionId: 'session-1',
      source: 'tmux',
      gates: [],
    });
    expect(registry.list('session-1').map(({ gateId }) => gateId)).toEqual(['ci-1']);
    expect(registry.list('session-2').map(({ gateId }) => gateId)).toEqual(['session-2-gate']);
  });

  it('returns copies that cannot mutate registry state', () => {
    const { bus, host } = createHost();
    const registry = createContinuationGateRegistry(host);
    bus.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate());

    const returned = registry.list('session-1') as ContinuationGate[];
    const returnedGate = returned[0];
    expect(returnedGate).toBeDefined();
    if (returnedGate) {
      returnedGate.reason = 'mutated';
      if (returnedGate.resource) {
        returnedGate.resource.label = 'mutated';
      }
    }
    returned.push(gate({ gateId: 'injected' }));

    expect(registry.list('session-1')).toEqual([gate()]);
  });

  it('requests snapshots with a validated request ID', () => {
    const { bus, host } = createHost();
    const registry = createContinuationGateRegistry(host, {
      createRequestId: () => ' request-1 ',
    });

    expect(registry.requestSnapshot(' session-1 ')).toBe('request-1');
    expect(bus.emitted.at(-1)).toEqual({
      eventName: CONTINUATION_GATE_SNAPSHOT_REQUEST_EVENT,
      payload: { protocolVersion: 1, requestId: 'request-1', sessionId: 'session-1' },
    });
  });

  it('clears state and removes every listener on idempotent disposal', () => {
    const { bus, host } = createHost();
    const registry = createContinuationGateRegistry(host);
    bus.emit(CONTINUATION_GATE_ACQUIRE_EVENT, gate());

    registry.dispose();
    registry.dispose();

    expect(registry.list('session-1')).toEqual([]);
    expect(bus.listenerCount(CONTINUATION_GATE_ACQUIRE_EVENT)).toBe(0);
    expect(bus.listenerCount(CONTINUATION_GATE_RELEASE_EVENT)).toBe(0);
    expect(bus.listenerCount(CONTINUATION_GATE_SNAPSHOT_EVENT)).toBe(0);
  });
});

describe('continuation gate protocol contract', () => {
  it('observes completion queueing before release and never wakes by itself', () => {
    const { host } = createHost();
    const observations: string[] = [];
    const registry = createContinuationGateRegistry(host, {
      onChange: (change) => {
        if (change.kind === 'released') {
          observations.push('release-observed');
        }
      },
    });
    const controller = createContinuationGateController(host, { source: 'tmux', now: () => 10 });

    controller.acquire({ sessionId: 'session-1', gateId: 'process-1', reason: 'waiting' });
    expect(registry.isBlocked('session-1')).toBe(true);

    observations.push('completion-queued');
    controller.release({
      sessionId: 'session-1',
      gateId: 'process-1',
      outcome: 'completed',
      wake: 'producer-message',
    });

    expect(observations).toEqual(['completion-queued', 'release-observed']);
    expect(registry.isBlocked('session-1')).toBe(false);
  });

  it('recovers gates through a snapshot when the registry starts after acquisition', () => {
    const { host } = createHost();
    const controller = createContinuationGateController(host, { source: 'tmux', now: () => 10 });
    controller.acquire({ sessionId: 'session-1', gateId: 'process-1', reason: 'waiting' });

    const registry = createContinuationGateRegistry(host, { createRequestId: () => 'request-1' });
    expect(registry.isBlocked('session-1')).toBe(false);
    registry.requestSnapshot('session-1');
    expect(registry.isBlocked('session-1')).toBe(true);
  });
});
