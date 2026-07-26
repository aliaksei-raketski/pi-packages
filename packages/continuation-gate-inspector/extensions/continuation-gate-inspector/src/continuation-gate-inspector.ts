import {
  createContinuationGateRegistry,
  type ContinuationGate,
  type ContinuationGateRegistry,
  type ContinuationGateTelemetryEvent,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const COMMAND = 'gates';
const MAX_DIAGNOSTICS = 64;

type InspectorState = {
  sessionId: string | null;
  registry: ContinuationGateRegistry;
  diagnostics: ContinuationGateTelemetryEvent[];
};

function formatAge(acquiredAt: number, now: number): string {
  return `${Math.max(0, Math.floor((now - acquiredAt) / 1_000))}s`;
}

function formatInspectorGates(gates: readonly ContinuationGate[], now = Date.now()): string {
  if (gates.length === 0) return 'No active continuation gates for this Pi session.';
  return [
    `Continuation gates (${gates.length}):`,
    ...gates.map((gate) => {
      const resource = gate.resource
        ? ` resource=${gate.resource.kind}:${gate.resource.id}${gate.resource.label ? ` (${gate.resource.label})` : ''}`
        : '';
      const lease = gate.lease
        ? ` lease=${gate.lease.policy} until ${new Date(gate.lease.expiresAt).toISOString()}${gate.lease.expiresAt <= now ? ' (stale)' : ''}`
        : ' lease=none';
      return `- [${gate.domain}] ${gate.source}/${gate.gateId}: ${gate.reason}; age=${formatAge(gate.acquiredAt, now)}${resource}${lease}`;
    }),
  ].join('\n');
}

function formatInspectorDiagnostics(
  diagnostics: readonly ContinuationGateTelemetryEvent[],
): string {
  if (diagnostics.length === 0) return 'No continuation gate diagnostics.';
  return [
    'Continuation gate diagnostics:',
    ...diagnostics.map(
      (diagnostic) => `- ${diagnostic.kind} @ ${new Date(diagnostic.timestamp).toISOString()}`,
    ),
  ].join('\n');
}

function notify(ctx: ExtensionContext, message: string): void {
  // notify works in TUI and RPC contexts and keeps this extension read-only.
  ctx.ui.notify(message, 'info');
}

export function continuationGateInspector(pi: ExtensionAPI): void {
  const state: InspectorState = {
    sessionId: null,
    diagnostics: [],
    registry: createContinuationGateRegistry(pi, {
      onTelemetry: (event) => {
        state.diagnostics.push({ ...event });
        if (state.diagnostics.length > MAX_DIAGNOSTICS) state.diagnostics.shift();
      },
    }),
  };

  const show = (ctx: ExtensionContext, mode: string): void => {
    if (!state.sessionId) {
      notify(ctx, 'No active Pi session.');
      return;
    }
    if (mode === 'diagnostics') {
      notify(ctx, formatInspectorDiagnostics(state.diagnostics));
      return;
    }
    const gates =
      mode === 'stale'
        ? state.registry.listStale(state.sessionId)
        : state.registry.list(state.sessionId);
    notify(ctx, formatInspectorGates(gates));
  };

  pi.on('session_start', (_event, ctx) => {
    state.diagnostics.length = 0;
    state.sessionId = ctx.sessionManager.getSessionId();
    state.registry.requestSnapshot(state.sessionId);
  });

  pi.registerCommand(COMMAND, {
    description: 'Inspect continuation gates without mutating them',
    getArgumentCompletions: (prefix) =>
      ['refresh', 'stale', 'diagnostics']
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: (args, ctx) =>
      Promise.resolve().then(() => {
        const mode = args.trim();
        if (mode === 'refresh') {
          if (!state.sessionId) {
            notify(ctx, 'No active Pi session.');
            return;
          }
          state.registry.requestSnapshot(state.sessionId);
          show(ctx, 'all');
          return;
        }
        if (mode === 'stale' || mode === 'diagnostics' || !mode) {
          show(ctx, mode || 'all');
          return;
        }
        notify(ctx, 'Usage: /gates [refresh|stale|diagnostics]');
      }),
  });

  pi.on('session_shutdown', () => {
    state.registry.dispose();
    state.diagnostics.length = 0;
    state.sessionId = null;
  });
}
