# @aliaksei-raketski/pi-continuation-gate-protocol

A shared event protocol for Pi extensions that need to suppress synthetic
automatic continuation while asynchronous external work is pending.

This is a normal compiled JavaScript library, not a Pi extension. It
communicates through `pi.events`; it does not use process globals or
module-singleton state. Consequently, extensions with separate installed
copies of this package remain interoperable.

## Semantics

A continuation gate means:

> While the gate exists, autonomous extensions must not create a synthetic
> continuation solely because the agent is idle or settled.

A gate does not stop an active turn, user messages, or tools. It does not pause
or complete a workflow, imply that every background process must be awaited, or
wake the model when released. Acquisition is explicit: do not gate long-lived
servers or every background process merely because they are running.

Gate identity is `(sessionId, source, gateId)`. Sessions and producers are
isolated. Acquisition and release are idempotent, and snapshots replace state
only for their own `(sessionId, source)` pair.

## Producer

Create one controller for a stable producer source. The controller owns
authoritative transient gate state and answers snapshot requests.

```ts
import { createContinuationGateController } from '@aliaksei-raketski/pi-continuation-gate-protocol';

const gates = createContinuationGateController(pi, {
  source: '@example/pi-remote-jobs',
});

const gate = gates.acquire({
  sessionId,
  gateId: job.id,
  reason: 'Waiting for the remote job',
  resource: { kind: 'ci-run', id: job.id, label: job.name },
});
```

When meaningful asynchronous output is ready, queue its message **before**
releasing the gate:

```ts
pi.sendMessage(completionMessage, {
  triggerTurn: true,
  deliverAs: 'followUp',
});

gates.release({
  sessionId: gate.sessionId,
  gateId: gate.gateId,
  outcome: 'completed',
  wake: 'producer-message',
});
```

For cancellation during a tool turn, use `wake: 'current-turn'`; use
`wake: 'none'` when no turn is expected. `wake` is descriptive in protocol v1.
Releasing a gate never wakes the model by itself.

Call `dispose()` to remove the snapshot listener while retaining current
controller state, or `dispose({ release: true })` to abandon and publish the
removal of active gates. Do not restore gates solely from historical Pi session
entries: the external resource owner must inspect live resources and republish
only current state.

## Consumer

Autonomous continuation drivers keep a registry and request recovery during
`session_start`:

```ts
import { createContinuationGateRegistry } from '@aliaksei-raketski/pi-continuation-gate-protocol';

const registry = createContinuationGateRegistry(pi, {
  onChange(change) {
    if (change.kind === 'acquired') cancelQueuedContinuation();
  },
});

registry.requestSnapshot(sessionId);

if (!registry.isBlocked(sessionId)) {
  scheduleAtMostOneContinuation();
}
```

Immediately before sending a queued continuation, re-check the workflow
identity, session identity, pending messages, and
`registry.isBlocked(sessionId)`. A gate acquired after scheduling must cancel or
invalidate the queued continuation. The registry reports state; continuation
scheduling policy remains the consumer's responsibility.

Snapshot requests allow a newly loaded consumer to recover gates already owned
by producers. Producers answer with their complete state for the requested
session, including an empty snapshot. No extension load order is required after
factories have registered their listeners.

Dispose registries and controllers when replacing a session lifecycle. All
disposal methods are idempotent.

## Compatibility and versioning

Event names and payloads are namespaced with `v1`. Parsers accept only protocol
version 1, ignore unknown properties, and safely reject malformed or
incompatible payloads. A malformed snapshot member is filtered without
discarding valid siblings. Breaking payload or semantic changes require new
versioned event names; additive optional fields may remain within v1.

Always import the exported event constants instead of duplicating raw event
strings. Do not replace this event protocol with a module-level `Map`:
independently installed package copies do not share JavaScript object identity.

## Build and test

```bash
pnpm nx run @aliaksei-raketski/pi-continuation-gate-protocol:build
pnpm nx run @aliaksei-raketski/pi-continuation-gate-protocol:test
```
