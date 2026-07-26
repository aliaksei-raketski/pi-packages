import {
  createContinuationGateRegistry,
  type ContinuationGate,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import {
  clearStatus,
  publishStatus,
  registerStatusProvider,
} from '@aliaksei-raketski/pi-statusline-protocol';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { formatGates, formatGoalStatus, GOAL_COMMAND_COMPLETIONS } from './goal-command.ts';
import { goalEventContent } from './goal-prompt.ts';
import { registerGoalRenderer, type GoalEventDetails } from './goal-renderer.ts';
import {
  allGatesWereConfirmed,
  captureContinuation,
  continuationCaptureIsCurrent,
  createGoalRuntime,
  invalidateContinuation,
  isContinuationEligible,
  type GoalRuntime,
} from './goal-runtime.ts';
import {
  createGoalState,
  createPersistedState,
  GOAL_EVENT_CUSTOM_TYPE,
  GOAL_STATE_CUSTOM_TYPE,
  parseTokenBudget,
  restoreGoalState,
  truncateObjective,
  type GoalEventKind,
  type GoalState,
} from './goal-state.ts';
import { collectGoalStatus, GOAL_STATUS_KEY, GOAL_STATUS_SOURCE } from './goal-status.ts';
import { registerGoalTools, syncGoalTools } from './goal-tools.ts';
import { accountGoalTurn } from './goal-state.ts';
import { tokenDeltaFromUsage, type UsageSnapshot } from './usage.ts';

function createStatusContext(ctx: ExtensionContext) {
  return {
    setStatus: (key: string, text: string | undefined) => ctx.ui.setStatus(key, text),
    theme: ctx.ui.theme,
  };
}

export function goal(pi: ExtensionAPI): void {
  const gateRegistry = createContinuationGateRegistry(pi, {
    onChange: (change) => {
      if (change.sessionId !== runtime.sessionId) return;
      if (change.kind === 'acquired') invalidateContinuation(runtime);
      if (runtime.statusContext) updateStatus(runtime.statusContext);
    },
  });
  const runtime: GoalRuntime = createGoalRuntime(gateRegistry);

  const currentGates = (): readonly ContinuationGate[] =>
    runtime.sessionId ? runtime.gateRegistry.list(runtime.sessionId) : [];

  const disposeStatusProvider = (): void => {
    runtime.clearStatusProvider?.();
    runtime.clearStatusProvider = undefined;
  };

  const ensureStatusProvider = (): void => {
    if (!runtime.statusBarEnabled || !runtime.goal) {
      disposeStatusProvider();
      return;
    }
    if (runtime.clearStatusProvider) return;
    const provider = registerStatusProvider(
      pi,
      () => {
        if (!runtime.statusBarEnabled || !runtime.goal) return [];
        const status = collectGoalStatus(runtime.goal, currentGates().length);
        return status ? [status] : [];
      },
      GOAL_STATUS_SOURCE,
    );
    runtime.clearStatusProvider = provider.dispose;
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    runtime.statusContext = ctx;
    ensureStatusProvider();
    const status =
      runtime.statusBarEnabled && runtime.goal
        ? collectGoalStatus(runtime.goal, currentGates().length)
        : undefined;
    if (!status) {
      clearStatus(pi, createStatusContext(ctx), GOAL_STATUS_KEY, GOAL_STATUS_SOURCE);
      return;
    }
    publishStatus(pi, createStatusContext(ctx), status, GOAL_STATUS_SOURCE);
  };

  const persist = (ctx: ExtensionContext, nextGoal: GoalState | null): void => {
    const previous = runtime.goal;
    if (previous?.id !== nextGoal?.id || previous?.status !== nextGoal?.status) {
      invalidateContinuation(runtime);
    }
    runtime.goal = nextGoal;
    pi.appendEntry(
      GOAL_STATE_CUSTOM_TYPE,
      createPersistedState(runtime.goal, runtime.statusBarEnabled),
    );
    syncGoalTools(pi, runtime);
    updateStatus(ctx);
  };

  const persistSettings = (ctx: ExtensionContext): void => {
    pi.appendEntry(
      GOAL_STATE_CUSTOM_TYPE,
      createPersistedState(runtime.goal, runtime.statusBarEnabled),
    );
    updateStatus(ctx);
  };

  const emitGoalEvent = (
    kind: GoalEventKind,
    state: GoalState,
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
  ): void => {
    const details: GoalEventDetails = {
      kind,
      goal: state,
      gates: currentGates(),
      timestamp: Date.now(),
    };
    pi.sendMessage(
      {
        customType: GOAL_EVENT_CUSTOM_TYPE,
        content: goalEventContent(kind, state),
        display: true,
        details,
      },
      options,
    );
  };

  const eligible = (ctx: ExtensionContext, continuationQueued = runtime.continuationQueued) =>
    isContinuationEligible({
      goal: runtime.goal,
      sessionId: runtime.sessionId ?? '',
      hasPendingMessages: ctx.hasPendingMessages(),
      isIdle: ctx.isIdle(),
      continuationQueued,
      activeGates: currentGates(),
    });

  const maybeQueueContinuation = (ctx: ExtensionContext): void => {
    if (!eligible(ctx)) return;
    const capture = captureContinuation(runtime);
    if (!capture) return;
    runtime.continuationQueued = true;

    queueMicrotask(() => {
      if (!continuationCaptureIsCurrent(runtime, capture)) return;
      runtime.continuationQueued = false;
      if (!eligible(ctx, false) || !runtime.goal) return;
      // Reserve delivery before invoking Pi so a synchronously-started turn can
      // clear the flag without being overwritten after sendMessage returns.
      runtime.continuationQueued = true;
      try {
        emitGoalEvent('continuation', runtime.goal, {
          triggerTurn: true,
          deliverAs: 'followUp',
        });
      } catch (error) {
        runtime.continuationQueued = false;
        throw error;
      }
    });
  };

  registerGoalRenderer(pi);
  registerGoalTools(pi, {
    runtime,
    persist,
    emit: emitGoalEvent,
    gates: currentGates,
  });

  pi.registerCommand('goal', {
    description: 'Create, inspect, pause, resume, continue, clear, or configure a persistent goal',
    getArgumentCompletions: (prefix) => {
      const matches = GOAL_COMMAND_COMPLETIONS.filter((value) => value.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const input = args.trim();

      if (!input || input === 'status') {
        ctx.ui.notify(
          formatGoalStatus(runtime.goal, runtime.statusBarEnabled, currentGates()),
          'info',
        );
        return;
      }

      if (input === 'waits') {
        if (runtime.sessionId) runtime.gateRegistry.requestSnapshot(runtime.sessionId);
        ctx.ui.notify(formatGates(currentGates()), 'info');
        return;
      }

      if (input === 'statusbar on' || input === 'statusbar off') {
        runtime.statusBarEnabled = input.endsWith('on');
        if (!runtime.statusBarEnabled) disposeStatusProvider();
        persistSettings(ctx);
        ctx.ui.notify(
          `Goal status bar ${runtime.statusBarEnabled ? 'enabled' : 'disabled'}.`,
          'info',
        );
        return;
      }

      if (input === 'clear') {
        if (!runtime.goal) {
          ctx.ui.notify('No goal is set.', 'info');
          return;
        }
        const previous = runtime.goal;
        persist(ctx, null);
        emitGoalEvent('cleared', previous);
        return;
      }

      if (input === 'pause') {
        if (runtime.goal?.status !== 'active') {
          ctx.ui.notify('No active goal is available to pause.', 'warning');
          return;
        }
        const next: GoalState = { ...runtime.goal, status: 'paused', updatedAt: Date.now() };
        persist(ctx, next);
        emitGoalEvent('paused', next);
        return;
      }

      if (input === 'resume') {
        if (runtime.goal?.status !== 'paused') {
          ctx.ui.notify('Only a paused goal can be resumed.', 'warning');
          return;
        }
        const next: GoalState = { ...runtime.goal, status: 'active', updatedAt: Date.now() };
        persist(ctx, next);
        emitGoalEvent('resumed', next, { triggerTurn: true, deliverAs: 'followUp' });
        return;
      }

      if (input === 'continue') {
        if (runtime.goal?.status !== 'active') {
          ctx.ui.notify('A current active goal is required.', 'warning');
          return;
        }
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify(
            'Pi is already running or has pending messages; no goal turn was queued.',
            'warning',
          );
          return;
        }

        const goalId = runtime.goal.id;
        const sessionId = runtime.sessionId;
        const gatesAtConfirmation = currentGates();
        if (gatesAtConfirmation.length > 0) {
          if (!ctx.hasUI) {
            ctx.ui.notify(
              'Cannot bypass continuation gates without an interactive confirmation.',
              'warning',
            );
            return;
          }
          const confirmed = await ctx.ui.confirm(
            'Continue despite active waits?',
            `${formatGates(gatesAtConfirmation)}\n\nThis bypass applies to one turn and does not release gates.`,
          );
          if (!confirmed) return;
        }

        const liveGates = currentGates();
        if (
          runtime.goal?.id !== goalId ||
          runtime.goal.status !== 'active' ||
          runtime.sessionId !== sessionId ||
          !ctx.isIdle() ||
          ctx.hasPendingMessages() ||
          !allGatesWereConfirmed(liveGates, gatesAtConfirmation)
        ) {
          ctx.ui.notify(
            'Goal, session, pending work, or gate state changed; no turn was queued.',
            'warning',
          );
          return;
        }

        invalidateContinuation(runtime);
        emitGoalEvent('continuation', runtime.goal, {
          triggerTurn: true,
          deliverAs: 'followUp',
        });
        return;
      }

      const parsed = parseTokenBudget(input);
      if (parsed.error) {
        ctx.ui.notify(parsed.error, 'warning');
        return;
      }
      if (!parsed.objective) {
        ctx.ui.notify('Usage: /goal [--tokens 50k] <objective>', 'warning');
        return;
      }
      if (runtime.goal && runtime.goal.status !== 'complete' && ctx.hasUI) {
        const confirmed = await ctx.ui.confirm(
          'Replace goal?',
          `Current: ${runtime.goal.objective}\n\nNew: ${parsed.objective}`,
        );
        if (!confirmed) return;
      }

      const next = createGoalState(parsed.objective, parsed.tokenBudget);
      persist(ctx, next);
      emitGoalEvent('active', next, { triggerTurn: true, deliverAs: 'followUp' });
    },
  });

  pi.on('session_start', (event, ctx) => {
    runtime.disposed = false;
    runtime.statusContext = ctx;
    runtime.sessionId = ctx.sessionManager.getSessionId();
    runtime.activeTurnStartedAt = null;
    runtime.activeGoalThisTurnId = null;
    invalidateContinuation(runtime);

    const restored = restoreGoalState(ctx.sessionManager.getBranch());
    runtime.goal = restored.goal;
    runtime.statusBarEnabled = restored.statusBarEnabled;
    runtime.gateRegistry.requestSnapshot(runtime.sessionId);
    syncGoalTools(pi, runtime);

    if (runtime.goal?.status === 'active' && event.reason === 'reload') {
      const paused: GoalState = {
        ...runtime.goal,
        status: 'paused',
        updatedAt: Date.now(),
      };
      persist(ctx, paused);
      ctx.ui.notify(
        `Goal paused after reload: ${truncateObjective(paused.objective)}\nUse /goal resume to continue.`,
        'info',
      );
      return;
    }

    updateStatus(ctx);
    if (runtime.goal?.status === 'active' || runtime.goal?.status === 'paused') {
      ctx.ui.notify(
        `Goal restored (${runtime.goal.status}): ${truncateObjective(runtime.goal.objective)}`,
        'info',
      );
    }
  });

  pi.on('session_tree', (_event, ctx) => {
    invalidateContinuation(runtime);
    const restored = restoreGoalState(ctx.sessionManager.getBranch());
    runtime.goal = restored.goal;
    runtime.statusBarEnabled = restored.statusBarEnabled;
    if (runtime.sessionId) runtime.gateRegistry.requestSnapshot(runtime.sessionId);
    syncGoalTools(pi, runtime);
    updateStatus(ctx);
  });

  pi.on('turn_start', () => {
    runtime.continuationQueued = false;
    runtime.activeTurnStartedAt = Date.now();
    runtime.activeGoalThisTurnId = runtime.goal?.status === 'active' ? runtime.goal.id : null;
  });

  pi.on('turn_end', (event, ctx) => {
    const startedAt = runtime.activeTurnStartedAt;
    const capturedGoalId = runtime.activeGoalThisTurnId;
    runtime.activeTurnStartedAt = null;
    runtime.activeGoalThisTurnId = null;
    if (!runtime.goal || capturedGoalId !== runtime.goal.id) return;

    const usage = (event.message as { usage?: UsageSnapshot } | undefined)?.usage;
    const elapsedSeconds =
      startedAt === null ? 0 : Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const previousStatus = runtime.goal.status;
    const next = accountGoalTurn(runtime.goal, tokenDeltaFromUsage(usage), elapsedSeconds);
    persist(ctx, next);
    if (previousStatus === 'active' && next.status === 'budget_limited') {
      emitGoalEvent('budget_limited', next, {
        triggerTurn: true,
        deliverAs: 'followUp',
      });
    }
  });

  const settledEvents = pi as unknown as {
    on(event: 'agent_settled', handler: (event: unknown, ctx: ExtensionContext) => void): void;
  };
  settledEvents.on('agent_settled', (_event, ctx) => {
    maybeQueueContinuation(ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    runtime.disposed = true;
    invalidateContinuation(runtime);
    disposeStatusProvider();
    clearStatus(pi, createStatusContext(ctx), GOAL_STATUS_KEY, GOAL_STATUS_SOURCE);
    runtime.gateRegistry.dispose();
    runtime.statusContext = null;
  });
}
