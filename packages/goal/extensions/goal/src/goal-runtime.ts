import { randomUUID } from 'node:crypto';
import {
  CONTINUATION_GATE_DEFAULT_DOMAIN,
  createContinuationGateRegistry,
  type ContinuationGate,
  type ContinuationGateRegistryChange,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import {
  clearStatus,
  publishStatus,
  registerStatusProvider,
} from '@aliaksei-raketski/pi-statusline-protocol';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  checkpointActiveClock,
  checkpointAndRestartActiveClock,
  evaluateBudgetLimit,
  transitionGoal,
} from './goal-clock.ts';
import { registerGoalCommand } from './goal-command.ts';
import { appendGoalRuntimeState, restoreGoalRuntimeState } from './goal-persistence.ts';
import { budgetLimitPrompt, goalEventContent } from './goal-prompt.ts';
import { ledgerRevision, observeGoalProgress } from './goal-progress.ts';
import { registerGoalRenderer, type GoalEventDetails } from './goal-renderer.ts';
import { applyRestartPolicy, restoreActiveWithoutOfflineGap } from './goal-restart.ts';
import {
  cancelGoalDeadline,
  captureContinuation,
  continuationCaptureIsCurrent,
  createGoalRuntime,
  invalidateContinuation,
  isContinuationEligible,
  scheduleGoalDeadline,
  type GoalRuntime,
  type GoalTurnOrigin,
} from './goal-runtime-core.ts';

export * from './goal-runtime-core.ts';
import {
  accountGoalTurn,
  GOAL_EVENT_CUSTOM_TYPE,
  summarizeGoalEvidence,
  truncateObjective,
  type GoalEventKind,
  type GoalPauseReason,
  type GoalState,
  type GoalStatus,
} from './goal-state.ts';
import { collectGoalStatus, GOAL_STATUS_KEY, GOAL_STATUS_SOURCE } from './goal-status.ts';
import { registerGoalTools, syncGoalTools } from './goal-tools.ts';
import { tokenDeltaFromUsage, type UsageSnapshot } from './usage.ts';

const GOAL_GATE_DOMAINS = [CONTINUATION_GATE_DEFAULT_DOMAIN] as const;
const GOAL_RESUME_CONSUMER_ID = 'pi-goal';
const MAX_CONTINUATION_DELIVERY_ATTEMPTS = 2;

function createStatusContext(ctx: ExtensionContext) {
  return {
    setStatus: (key: string, text: string | undefined) => ctx.ui.setStatus(key, text),
    theme: ctx.ui.theme,
  };
}

export function registerGoalRuntime(pi: ExtensionAPI): void {
  const gateRegistry = createContinuationGateRegistry(pi, {
    onChange: (change) => handleGateChange(change),
  });
  const runtime: GoalRuntime = createGoalRuntime(gateRegistry);
  let deferBudgetSummaryUntilNaturalTurn = false;
  let budgetSummaryInFlight: { goalId: string; deliveryId: string } | null = null;
  let continuationInFlight: {
    goalId: string;
    deliveryId: string;
    origin: GoalTurnOrigin;
    attempt: number;
    acknowledged: boolean;
  } | null = null;
  let activeContinuationDeliveryAttempt = 0;
  let pendingContinuationTurnFailure: {
    goalId: string;
    origin: GoalTurnOrigin;
    attempt: number;
  } | null = null;

  const currentGates = (): readonly ContinuationGate[] =>
    runtime.sessionId
      ? runtime.gateRegistry.list(runtime.sessionId, { domains: GOAL_GATE_DOMAINS })
      : [];

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
        const status = collectGoalStatus(runtime.goal, currentGates().length, runtime.now());
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
        ? collectGoalStatus(runtime.goal, currentGates().length, runtime.now())
        : undefined;
    if (!status) {
      clearStatus(pi, createStatusContext(ctx), GOAL_STATUS_KEY, GOAL_STATUS_SOURCE);
      return;
    }
    publishStatus(pi, createStatusContext(ctx), status, GOAL_STATUS_SOURCE);
  };

  const persist = (ctx: ExtensionContext): void => {
    if (runtime.goal?.status === 'active')
      runtime.goal = checkpointAndRestartActiveClock(runtime.goal, runtime.now());
    appendGoalRuntimeState(pi, runtime);
    syncGoalTools(pi, runtime);
    updateStatus(ctx);
    scheduleGoalDeadline(runtime, handleDeadline);
  };

  const replaceGoal = (ctx: ExtensionContext, next: GoalState): void => {
    invalidateContinuation(runtime);
    cancelGoalDeadline(runtime);
    runtime.restartContinuationPending = false;
    runtime.goal = next;
    runtime.pendingBudgetSummary = false;
    budgetSummaryInFlight = null;
    continuationInFlight = null;
    activeContinuationDeliveryAttempt = 0;
    pendingContinuationTurnFailure = null;
    persist(ctx);
  };

  const clearGoal = (ctx: ExtensionContext): void => {
    invalidateContinuation(runtime);
    cancelGoalDeadline(runtime);
    runtime.goal = null;
    runtime.restartContinuationPending = false;
    runtime.ledger = null;
    runtime.progress = null;
    runtime.pendingBudgetSummary = false;
    budgetSummaryInFlight = null;
    continuationInFlight = null;
    activeContinuationDeliveryAttempt = 0;
    pendingContinuationTurnFailure = null;
    persist(ctx);
  };

  const transition = (
    ctx: ExtensionContext,
    status: GoalStatus,
    options: { pauseReason?: GoalPauseReason } = {},
  ): GoalState => {
    if (!runtime.goal) throw new Error('No goal is set.');
    const previousStatus = runtime.goal.status;
    const budgetReason =
      status === 'budget_limited' ? evaluateBudgetLimit(runtime.goal, runtime.now()) : null;
    const next = transitionGoal(runtime.goal, status, runtime.now(), {
      pauseReason: options.pauseReason,
      budgetLimitReason: budgetReason,
    });
    if (previousStatus !== status || status !== 'active') invalidateContinuation(runtime);
    if (status !== 'active') {
      runtime.restartContinuationPending = false;
      cancelGoalDeadline(runtime);
    }
    runtime.goal = next;
    continuationInFlight = null;
    activeContinuationDeliveryAttempt = 0;
    pendingContinuationTurnFailure = null;
    if (status === 'budget_limited') {
      runtime.pendingBudgetSummary = true;
      budgetSummaryInFlight = null;
    } else {
      budgetSummaryInFlight = null;
    }
    persist(ctx);
    return next;
  };

  const emitGoalEvent = (
    kind: GoalEventKind,
    state: GoalState,
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
    origin: GoalTurnOrigin = 'other',
    contentOverride?: string,
    deliveryId?: string,
  ): void => {
    if (options?.triggerTurn) runtime.pendingTurnOrigin = origin;
    const details: GoalEventDetails = {
      kind,
      goal: state,
      gates: currentGates(),
      evidenceSummary: summarizeGoalEvidence(runtime.ledger),
      noProgressStreak: runtime.progress?.stagnationStreak ?? 0,
      timestamp: runtime.now(),
      ...(deliveryId ? { deliveryId } : {}),
    };
    pi.sendMessage(
      {
        customType: GOAL_EVENT_CUSTOM_TYPE,
        content:
          contentOverride ??
          goalEventContent(kind, state, { ledger: runtime.ledger, now: runtime.now() }),
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

  const pauseForContinuationDeliveryFailure = (
    ctx: ExtensionContext,
    goalId: string,
    reason: string,
  ): void => {
    continuationInFlight = null;
    runtime.continuationQueued = false;
    runtime.pendingTurnOrigin = 'other';
    if (runtime.goal?.id !== goalId || runtime.goal.status !== 'active') return;
    transition(ctx, 'paused', { pauseReason: 'delivery_failure' });
    ctx.ui.notify(
      `Goal paused after repeated continuation delivery failures: ${reason}. Use /goal resume to retry.`,
      'error',
    );
  };

  const queueContinuation = (ctx: ExtensionContext, origin: GoalTurnOrigin, attempt = 1): void => {
    if (!eligible(ctx)) return;
    const capture = captureContinuation(runtime);
    if (!capture) return;
    runtime.continuationQueued = true;
    queueMicrotask(() => {
      if (!continuationCaptureIsCurrent(runtime, capture)) return;
      runtime.continuationQueued = false;
      if (!eligible(ctx, false) || !runtime.goal || enforceBudgetLimit(ctx)) return;
      runtime.continuationQueued = true;
      if (origin === 'restart') runtime.restartContinuationPending = false;
      const delivery = {
        goalId: runtime.goal.id,
        deliveryId: randomUUID(),
        origin,
        attempt,
        acknowledged: false,
      };
      continuationInFlight = delivery;
      try {
        emitGoalEvent(
          'continuation',
          runtime.goal,
          { triggerTurn: true, deliverAs: 'followUp' },
          origin,
          undefined,
          delivery.deliveryId,
        );
      } catch (error) {
        if (continuationInFlight?.deliveryId === delivery.deliveryId) continuationInFlight = null;
        runtime.continuationQueued = false;
        runtime.pendingTurnOrigin = 'other';
        const message = safeErrorMessage(error);
        ctx.ui.notify(`Failed to deliver goal continuation: ${message}`, 'error');
        if (attempt < MAX_CONTINUATION_DELIVERY_ATTEMPTS)
          queueContinuation(ctx, origin, attempt + 1);
        else pauseForContinuationDeliveryFailure(ctx, delivery.goalId, message);
      }
    });
  };

  const maybeDeliverBudgetSummary = (ctx: ExtensionContext): void => {
    if (
      deferBudgetSummaryUntilNaturalTurn ||
      !runtime.pendingBudgetSummary ||
      runtime.goal?.status !== 'budget_limited' ||
      budgetSummaryInFlight?.goalId === runtime.goal.id ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      currentGates().length > 0
    )
      return;
    const delivery = { goalId: runtime.goal.id, deliveryId: randomUUID() };
    budgetSummaryInFlight = delivery;
    try {
      emitGoalEvent(
        'budget_limited',
        runtime.goal,
        { triggerTurn: true, deliverAs: 'followUp' },
        'other',
        undefined,
        delivery.deliveryId,
      );
    } catch (error) {
      if (budgetSummaryInFlight?.deliveryId === delivery.deliveryId) budgetSummaryInFlight = null;
      deferBudgetSummaryUntilNaturalTurn = true;
      ctx.ui.notify(`Failed to deliver goal budget summary: ${safeErrorMessage(error)}`, 'error');
    }
  };

  function enforceBudgetLimit(ctx: ExtensionContext): boolean {
    if (runtime.goal?.status !== 'active' || !evaluateBudgetLimit(runtime.goal, runtime.now()))
      return false;
    transition(ctx, 'budget_limited');
    maybeDeliverBudgetSummary(ctx);
    return true;
  }

  function handleDeadline(): void {
    const ctx = runtime.statusContext;
    if (!ctx || runtime.goal?.status !== 'active') return;
    if (!enforceBudgetLimit(ctx)) scheduleGoalDeadline(runtime, handleDeadline);
  }

  function handleGateChange(change: ContinuationGateRegistryChange): void {
    if (!runtime || change.sessionId !== runtime.sessionId) return;
    if (change.kind === 'acquired' && change.domain === CONTINUATION_GATE_DEFAULT_DOMAIN)
      invalidateContinuation(runtime);
    const ctx = runtime.statusContext;
    if (!ctx) return;
    updateStatus(ctx);
    if (change.kind !== 'unblocked' || change.domain !== CONTINUATION_GATE_DEFAULT_DOMAIN) return;
    maybeDeliverBudgetSummary(ctx);
    if (
      change.wakeDisposition !== 'none' ||
      change.autoResumeAllowed !== true ||
      !change.transitionId ||
      change.generation === undefined ||
      !runtime.sessionId ||
      !eligible(ctx)
    )
      return;
    const claim = runtime.gateRegistry.claimAutoResume({
      transitionId: change.transitionId,
      sessionId: runtime.sessionId,
      domain: CONTINUATION_GATE_DEFAULT_DOMAIN,
      consumerId: GOAL_RESUME_CONSUMER_ID,
      generation: change.generation,
    });
    if (!claim) return;
    runtime.activeResumeClaim = claim;
    const capture = captureContinuation(runtime);
    if (!capture) {
      runtime.gateRegistry.abortAutoResume(claim);
      runtime.activeResumeClaim = undefined;
      return;
    }
    runtime.continuationQueued = true;
    queueMicrotask(() => {
      if (
        runtime.activeResumeClaim?.claimId !== claim.claimId ||
        !continuationCaptureIsCurrent(runtime, capture) ||
        !eligible(ctx, false) ||
        !runtime.goal
      ) {
        runtime.gateRegistry.abortAutoResume(claim);
        if (runtime.activeResumeClaim?.claimId === claim.claimId)
          runtime.activeResumeClaim = undefined;
        runtime.continuationQueued = false;
        return;
      }
      if (enforceBudgetLimit(ctx)) {
        runtime.gateRegistry.abortAutoResume(claim);
        runtime.activeResumeClaim = undefined;
        runtime.continuationQueued = false;
        return;
      }
      const origin: GoalTurnOrigin = runtime.restartContinuationPending ? 'restart' : 'synthetic';
      runtime.restartContinuationPending = false;
      const delivery = {
        goalId: runtime.goal.id,
        deliveryId: randomUUID(),
        origin,
        attempt: 1,
        acknowledged: false,
      };
      continuationInFlight = delivery;
      try {
        emitGoalEvent(
          'continuation',
          runtime.goal,
          { triggerTurn: true, deliverAs: 'followUp' },
          origin,
          undefined,
          delivery.deliveryId,
        );
      } catch (error) {
        runtime.gateRegistry.abortAutoResume(claim);
        runtime.activeResumeClaim = undefined;
        if (continuationInFlight?.deliveryId === delivery.deliveryId) continuationInFlight = null;
        runtime.continuationQueued = false;
        runtime.pendingTurnOrigin = 'other';
        const message = safeErrorMessage(error);
        ctx.ui.notify(`Failed to deliver goal continuation: ${message}`, 'error');
        pauseForContinuationDeliveryFailure(ctx, delivery.goalId, message);
        return;
      }
      if (!runtime.gateRegistry.commitAutoResume(claim)) {
        runtime.activeResumeClaim = undefined;
        ctx.ui.notify(
          'Goal continuation was queued, but its auto-resume claim could not be committed.',
          'warning',
        );
        return;
      }
      runtime.activeResumeClaim = undefined;
    });
  }

  registerGoalRenderer(pi);
  registerGoalTools(pi, {
    runtime,
    replace: replaceGoal,
    persist,
    transition: (ctx, status) => transition(ctx, status),
    emit: emitGoalEvent,
    gates: currentGates,
    now: runtime.now,
  });

  registerGoalCommand(pi, {
    runtime,
    currentGates,
    persist,
    replaceGoal,
    clearGoal,
    transition,
    enforceBudgetLimit,
    emitGoalEvent,
    disposeStatusProvider,
  });

  pi.on('session_start', (event, ctx) => {
    runtime.disposed = false;
    runtime.statusContext = ctx;
    runtime.sessionId = ctx.sessionManager.getSessionId();
    runtime.activeTurnStartedAt = null;
    runtime.activeGoalThisTurnId = null;
    runtime.activeTurnOrigin = 'other';
    invalidateContinuation(runtime);
    cancelGoalDeadline(runtime);
    budgetSummaryInFlight = null;
    continuationInFlight = null;
    activeContinuationDeliveryAttempt = 0;
    pendingContinuationTurnFailure = null;

    restoreGoalRuntimeState(runtime, ctx.sessionManager.getBranch());
    deferBudgetSummaryUntilNaturalTurn =
      runtime.restartPolicy === 'restore-idle' &&
      (event.reason === 'startup' || event.reason === 'reload');

    let restartContinuation = false;
    if (
      runtime.goal?.status === 'active' &&
      (event.reason === 'startup' || event.reason === 'reload')
    ) {
      const restarted = applyRestartPolicy(runtime.goal, runtime.restartPolicy, runtime.now());
      runtime.goal = restarted.goal;
      restartContinuation = restarted.queueContinuation;
      persist(ctx);
      const budgetLimited = enforceBudgetLimit(ctx);
      if (budgetLimited) restartContinuation = false;
      ctx.ui.notify(
        `${budgetLimited ? 'Goal restored at its budget limit.' : restarted.notification}\n${truncateObjective(runtime.goal.objective)}`,
        'info',
      );
    } else {
      if (runtime.goal?.status === 'active')
        runtime.goal = restoreActiveWithoutOfflineGap(runtime.goal, runtime.now());
      syncGoalTools(pi, runtime);
      updateStatus(ctx);
      scheduleGoalDeadline(runtime, handleDeadline);
      if (runtime.goal?.status === 'active' || runtime.goal?.status === 'paused')
        ctx.ui.notify(
          `Goal restored (${runtime.goal.status}): ${truncateObjective(runtime.goal.objective)}`,
          'info',
        );
    }
    runtime.restartContinuationPending = restartContinuation;
    runtime.gateRegistry.requestSnapshot(runtime.sessionId);
    maybeDeliverBudgetSummary(ctx);
    deferBudgetSummaryUntilNaturalTurn = false;
    if (restartContinuation) {
      if (currentGates().length > 0) return;
      if (eligible(ctx)) queueContinuation(ctx, 'restart');
      else if (!runtime.activeResumeClaim) runtime.restartContinuationPending = false;
    }
  });

  pi.on('session_before_tree', () => {
    if (runtime.goal?.status !== 'active') return;
    runtime.goal = checkpointAndRestartActiveClock(runtime.goal, runtime.now());
    appendGoalRuntimeState(pi, runtime);
  });

  pi.on('session_tree', (_event, ctx) => {
    invalidateContinuation(runtime);
    cancelGoalDeadline(runtime);
    runtime.restartContinuationPending = false;
    deferBudgetSummaryUntilNaturalTurn = false;
    budgetSummaryInFlight = null;
    continuationInFlight = null;
    activeContinuationDeliveryAttempt = 0;
    pendingContinuationTurnFailure = null;
    restoreGoalRuntimeState(runtime, ctx.sessionManager.getBranch());
    if (runtime.goal?.status === 'active')
      runtime.goal = restoreActiveWithoutOfflineGap(runtime.goal, runtime.now());
    if (runtime.sessionId) runtime.gateRegistry.requestSnapshot(runtime.sessionId);
    persist(ctx);
    maybeDeliverBudgetSummary(ctx);
  });

  pi.on('before_agent_start', () => {
    deferBudgetSummaryUntilNaturalTurn = false;
    if (
      !runtime.pendingBudgetSummary ||
      runtime.goal?.status !== 'budget_limited' ||
      budgetSummaryInFlight?.goalId === runtime.goal.id
    )
      return;
    const state = runtime.goal;
    const delivery = { goalId: state.id, deliveryId: randomUUID() };
    budgetSummaryInFlight = delivery;
    const injection = {
      message: {
        customType: GOAL_EVENT_CUSTOM_TYPE,
        content: budgetLimitPrompt(state, { ledger: runtime.ledger, now: runtime.now() }),
        display: true,
        details: {
          kind: 'budget_limited' as const,
          goal: state,
          gates: currentGates(),
          evidenceSummary: summarizeGoalEvidence(runtime.ledger),
          noProgressStreak: runtime.progress?.stagnationStreak ?? 0,
          timestamp: runtime.now(),
          deliveryId: delivery.deliveryId,
        } satisfies GoalEventDetails,
      },
    };
    return injection;
  });

  pi.on('message_start', (event, ctx) => {
    if (
      continuationInFlight &&
      isGoalDeliveryMessage(event.message, continuationInFlight, 'continuation')
    )
      continuationInFlight.acknowledged = true;
    const goal = runtime.goal;
    if (
      !runtime.pendingBudgetSummary ||
      goal?.status !== 'budget_limited' ||
      !budgetSummaryInFlight ||
      !isGoalDeliveryMessage(event.message, budgetSummaryInFlight, 'budget_limited')
    )
      return;
    runtime.pendingBudgetSummary = false;
    budgetSummaryInFlight = null;
    persist(ctx);
  });

  pi.on('turn_start', () => {
    deferBudgetSummaryUntilNaturalTurn = false;
    const acknowledgedContinuation = continuationInFlight?.acknowledged
      ? continuationInFlight
      : null;
    if (acknowledgedContinuation) continuationInFlight = null;
    if (continuationInFlight) runtime.pendingTurnOrigin = 'other';
    activeContinuationDeliveryAttempt = acknowledgedContinuation?.attempt ?? 0;
    runtime.continuationQueued = false;
    runtime.activeTurnStartedAt = runtime.now();
    runtime.activeGoalThisTurnId = runtime.goal?.status === 'active' ? runtime.goal.id : null;
    runtime.activeTurnOrigin =
      acknowledgedContinuation?.origin ??
      (continuationInFlight ? 'other' : runtime.pendingTurnOrigin);
    runtime.pendingTurnOrigin = 'other';
    runtime.restartContinuationPending = false;
  });

  pi.on('turn_end', (event, ctx) => {
    const startedAt = runtime.activeTurnStartedAt;
    const capturedGoalId = runtime.activeGoalThisTurnId;
    const origin = runtime.activeTurnOrigin;
    runtime.activeTurnStartedAt = null;
    runtime.activeGoalThisTurnId = null;
    const failedContinuationTurn =
      capturedGoalId &&
      activeContinuationDeliveryAttempt > 0 &&
      isTerminalContinuationFailure(event.message)
        ? {
            goalId: capturedGoalId,
            origin,
            attempt: activeContinuationDeliveryAttempt,
          }
        : null;
    pendingContinuationTurnFailure = failedContinuationTurn;
    runtime.activeTurnOrigin = 'other';
    if (!failedContinuationTurn) activeContinuationDeliveryAttempt = 0;
    if (!runtime.goal || capturedGoalId !== runtime.goal.id) return;

    const usage = (event.message as { usage?: UsageSnapshot } | undefined)?.usage;
    const elapsedSeconds =
      startedAt === null ? 0 : Math.max(0, Math.round((runtime.now() - startedAt) / 1_000));
    const previousStatus = runtime.goal.status;
    runtime.goal = accountGoalTurn(
      runtime.goal,
      tokenDeltaFromUsage(usage),
      elapsedSeconds,
      runtime.now(),
    );

    if (runtime.noProgressEnabled && origin === 'synthetic' && runtime.goal.status === 'active') {
      const observation = observeGoalProgress(runtime.progress, {
        goalId: runtime.goal.id,
        observedAt: runtime.now(),
        assistantText: assistantText(event.message),
        tools: toolPattern(event),
        evidenceRevision: ledgerRevision(runtime.ledger),
      });
      runtime.progress = observation.state;
      if (observation.shouldPause) {
        const streak = observation.state.stagnationStreak;
        const next = transition(ctx, 'paused', { pauseReason: 'no_progress' });
        const recovery = `Goal paused after ${streak} repeated synthetic continuation patterns. Inspect /goal evidence, choose a materially different path, then use /goal resume. No continuation gates were changed.`;
        emitGoalEvent('paused', next, undefined, 'other', recovery);
        ctx.ui.notify(recovery, 'warning');
        return;
      }
    }

    if (previousStatus === 'active' && runtime.goal.status === 'budget_limited')
      runtime.pendingBudgetSummary = true;
    persist(ctx);
    maybeDeliverBudgetSummary(ctx);
  });

  pi.on('agent_settled', (_event, ctx) => {
    const failedContinuationTurn = pendingContinuationTurnFailure;
    if (failedContinuationTurn) {
      pendingContinuationTurnFailure = null;
      activeContinuationDeliveryAttempt = 0;
      if (runtime.goal?.status !== 'active' || runtime.goal.id !== failedContinuationTurn.goalId)
        return;
      if (failedContinuationTurn.attempt < MAX_CONTINUATION_DELIVERY_ATTEMPTS)
        queueContinuation(ctx, failedContinuationTurn.origin, failedContinuationTurn.attempt + 1);
      else
        pauseForContinuationDeliveryFailure(
          ctx,
          failedContinuationTurn.goalId,
          'continuation turn ended with a provider failure',
        );
      return;
    }
    if (
      runtime.goal?.status === 'active' &&
      runtime.activeTurnStartedAt !== null &&
      activeContinuationDeliveryAttempt > 0
    ) {
      const failedGoalId = runtime.goal.id;
      const failedOrigin = runtime.activeTurnOrigin;
      const failedAttempt = activeContinuationDeliveryAttempt;
      runtime.activeTurnStartedAt = null;
      runtime.activeGoalThisTurnId = null;
      runtime.activeTurnOrigin = 'other';
      activeContinuationDeliveryAttempt = 0;
      if (failedAttempt < MAX_CONTINUATION_DELIVERY_ATTEMPTS)
        queueContinuation(ctx, failedOrigin, failedAttempt + 1);
      else
        pauseForContinuationDeliveryFailure(
          ctx,
          failedGoalId,
          'continuation turn settled without completing',
        );
      return;
    }
    if (runtime.goal?.status === 'active') {
      if (continuationInFlight) {
        const failed = continuationInFlight;
        continuationInFlight = null;
        runtime.continuationQueued = false;
        runtime.pendingTurnOrigin = 'other';
        if (failed.attempt < MAX_CONTINUATION_DELIVERY_ATTEMPTS)
          queueContinuation(ctx, failed.origin, failed.attempt + 1);
        else
          pauseForContinuationDeliveryFailure(
            ctx,
            failed.goalId,
            failed.acknowledged
              ? 'acknowledged continuation did not start'
              : 'queued continuation was not acknowledged',
          );
        return;
      }
      if (runtime.continuationQueued) {
        runtime.continuationQueued = false;
        runtime.pendingTurnOrigin = 'other';
        return;
      }
      queueContinuation(ctx, 'synthetic');
      return;
    }
    if (runtime.pendingBudgetSummary && budgetSummaryInFlight) {
      budgetSummaryInFlight = null;
      deferBudgetSummaryUntilNaturalTurn = true;
      return;
    }
    maybeDeliverBudgetSummary(ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    if (runtime.goal?.status === 'active' && runtime.goal.activeSince !== null) {
      runtime.goal = checkpointActiveClock(runtime.goal, runtime.now());
      appendGoalRuntimeState(pi, runtime);
    }
    runtime.disposed = true;
    invalidateContinuation(runtime);
    cancelGoalDeadline(runtime);
    disposeStatusProvider();
    clearStatus(pi, createStatusContext(ctx), GOAL_STATUS_KEY, GOAL_STATUS_SOURCE);
    runtime.gateRegistry.dispose();
    runtime.statusContext = null;
  });
}

function isGoalDeliveryMessage(
  message: unknown,
  expected: { goalId: string; deliveryId: string },
  kind: 'budget_limited' | 'continuation',
): boolean {
  if (!isRecord(message) || message.customType !== GOAL_EVENT_CUSTOM_TYPE) return false;
  const details = message.details;
  if (!isRecord(details) || details.kind !== kind || details.deliveryId !== expected.deliveryId)
    return false;
  const goal = details.goal;
  return isRecord(goal) && goal.id === expected.goalId;
}

function isTerminalContinuationFailure(message: unknown): boolean {
  if (!isRecord(message)) return false;
  return message.stopReason === 'error' || message.stopReason === 'aborted';
}

function safeErrorMessage(error: unknown): string {
  try {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unknown delivery error';
    return message.slice(0, 512);
  } catch {
    return 'Unknown delivery error';
  }
}

function assistantText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return '';
  const text: string[] = [];
  for (const item of message.content)
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string')
      text.push(item.text);
  return text.join('\n');
}

function toolPattern(event: unknown): Array<{ name: string; isError: boolean }> {
  if (!isRecord(event)) return [];
  const results = Array.isArray(event.toolResults) ? event.toolResults : [];
  const byId = new Map<string, boolean>();
  for (const result of results)
    if (isRecord(result) && typeof result.toolCallId === 'string')
      byId.set(result.toolCallId, result.isError === true);
  const message = event.message;
  const pattern: Array<{ name: string; isError: boolean }> = [];
  if (!isRecord(message) || !Array.isArray(message.content)) {
    for (const result of results)
      if (isRecord(result))
        pattern.push({
          name: typeof result.toolName === 'string' ? result.toolName : 'unknown',
          isError: result.isError === true,
        });
    return pattern;
  }
  for (const item of message.content)
    if (isRecord(item) && item.type === 'toolCall')
      pattern.push({
        name: typeof item.name === 'string' ? item.name : 'unknown',
        isError: typeof item.id === 'string' ? (byId.get(item.id) ?? false) : false,
      });
  return pattern;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
