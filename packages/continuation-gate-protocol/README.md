# @aliaksei-raketski/pi-continuation-gate-protocol

A shared, compiled JavaScript protocol for Pi extensions that suppresses
synthetic continuation while asynchronous work is pending. It is a normal
library, not a Pi resource, and communicates only through `pi.events`, so
separately installed copies remain interoperable.

## Model

Gate identity is `(sessionId, source, gateId)`. `domain` is a mutable policy
field and defaults to `autonomous-continuation`; it is not part of identity.
The unversioned namespaced event family is shared by all repository consumers.
Snapshots replace only one `(sessionId, source)` state.

Leases are optional. `diagnose` gates become stale after `expiresAt` but remain
blocking; `expire` gates are released by their authoritative controller with
`outcome: 'expired'` and `wake: 'none'`. Re-acquisition preserves `acquiredAt`,
updates descriptive fields, and clears stale diagnostics.

```ts
const gate = controller.acquire({
  sessionId,
  gateId: job.id,
  domain: 'autonomous-continuation',
  reason: 'Waiting for the remote job',
  resource: { kind: 'ci-run', id: job.id, label: job.name },
  lease: { durationMs: 15 * 60_000, policy: 'diagnose' },
});
```

## Producer wake handoff

The protocol never sends a model message itself. A producer queues its message,
commits the handoff, and only then releases the gate:

```ts
const handoff = controller.prepareWake({ sessionId, gateId: gate.gateId });
try {
  pi.sendMessage(message, { triggerTurn: true, deliverAs: 'followUp' });
  controller.commitWake(handoff);
  controller.release({
    sessionId,
    gateId: gate.gateId,
    outcome: 'completed',
    wake: 'producer-message',
    handoffId: handoff.handoffId,
  });
} catch {
  controller.abortWake(handoff);
  controller.release({ sessionId, gateId: gate.gateId, outcome: 'failed', wake: 'none' });
}
```

Invalid or out-of-order handoffs are diagnostic-only and never auto-resume.
`current-turn` means the current turn carries the result; `none` has no wake
expectation. Releasing never wakes the model on its own.

## Consumers and claims

A consumer creates a registry, requests recovery during `session_start`, and
re-checks live state immediately before any continuation. It may filter by one
or more domains:

```ts
const registry = createContinuationGateRegistry(pi, {
  onChange: (change) => {
    if (change.kind === 'acquired') invalidateQueuedWork();
  },
});
registry.requestSnapshot(sessionId);
const waiting = registry.list(sessionId, { domains: ['autonomous-continuation'] });
```

On an eligible `unblocked` transition, opt-in consumers use
`claimAutoResume()`, then validate workflow/session identity, idle state,
pending messages, live gates, claim ownership, and generation in a microtask.
Queue first and call `commitAutoResume()` second. Abort failed final checks.
The first synchronous claim owns the transition; auto-resume remains off unless
a consumer explicitly implements this policy.

## Diagnostics and telemetry

`listStale`, `leaseState`, and `diagnostics` are read-only. Optional local
`onTelemetry` callbacks receive bounded redacted events containing hashes,
domains, timestamps, counts, outcomes, and diagnostic codes—never reasons,
commands, output, resource labels, environment values, or arbitrary metadata.
`publishContinuationGateTelemetry` is an explicit namespaced cross-copy
adapter; no telemetry backend or network I/O is required.

All parser listeners ignore malformed payloads, snapshot arrays and handoffs
are bounded, nested return values are cloned, and timers are injectable and
idempotently disposed. Pre-enhancement tmux windows are not restored by the
protocol; their producer remains authoritative.

## Build and test

```bash
pnpm nx run @aliaksei-raketski/pi-continuation-gate-protocol:build
pnpm nx run @aliaksei-raketski/pi-continuation-gate-protocol:test
```
