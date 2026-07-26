import type { ContinuationGate } from '@aliaksei-raketski/pi-continuation-gate-protocol';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { remainingWallTime } from './goal-clock.ts';
import {
  formatGoalEvidenceChecklist,
  formatGoalEvidenceSummary,
  createGoalEvidenceLedger,
  type GoalEvidenceLedger,
} from './goal-evidence.ts';
import { resetGoalProgress, type GoalProgressState } from './goal-progress.ts';
import {
  allGatesWereConfirmed,
  invalidateContinuation,
  type GoalRuntime,
  type GoalTurnOrigin,
} from './goal-runtime-core.ts';
import {
  formatElapsed,
  formatGoalUsage,
  createGoalState,
  parseGoalCommand,
  remainingTokens,
  type GoalEventKind,
  type GoalPauseReason,
  type GoalRestartPolicy,
  type GoalState,
  type GoalStatus,
} from './goal-state.ts';

export const GOAL_COMMAND_COMPLETIONS = [
  'status',
  'waits',
  'evidence',
  'evidence reset',
  'pause',
  'resume',
  'continue',
  'clear',
  'restart pause',
  'restart restore-idle',
  'restart resume',
  'no-progress on',
  'no-progress off',
  'no-progress reset',
  'statusbar on',
  'statusbar off',
] as const;

export interface GoalStatusOptions {
  now?: number;
  ledger?: GoalEvidenceLedger | null;
  progress?: GoalProgressState | null;
  restartPolicy?: GoalRestartPolicy;
  noProgressEnabled?: boolean;
  pendingBudgetSummary?: boolean;
}

export function formatGate(gate: ContinuationGate, now = Date.now()): string {
  const ageSeconds = Math.max(0, Math.floor((now - gate.acquiredAt) / 1000));
  let resource = '';
  if (gate.resource) {
    const label = gate.resource.label ? ` (${gate.resource.label})` : '';
    resource = `; resource=${gate.resource.kind}:${gate.resource.id}${label}`;
  }
  const lease = gate.lease
    ? `; domain=${gate.domain}; lease=${gate.lease.policy} expires=${new Date(gate.lease.expiresAt).toISOString()}${gate.lease.expiresAt <= now ? ` stale-age=${formatElapsed(Math.floor((now - gate.lease.expiresAt) / 1000))}` : ''}`
    : `; domain=${gate.domain}; lease=none`;
  return `${gate.source}/${gate.gateId}: ${gate.reason}; age=${formatElapsed(ageSeconds)}${resource}${lease}`;
}

export function formatGates(gates: readonly ContinuationGate[], now = Date.now()): string {
  if (gates.length === 0) return 'No active continuation gates.';
  return [
    `Active continuation gates (${gates.length}):`,
    ...gates.map((gate) => `- ${formatGate(gate, now)}`),
  ].join('\n');
}

export function formatGoalEvidence(ledger: GoalEvidenceLedger | null): string {
  return formatGoalEvidenceChecklist(ledger);
}

export function formatGoalStatus(
  goal: GoalState | null,
  statusBarEnabled: boolean,
  gates: readonly ContinuationGate[],
  options: GoalStatusOptions = {},
): string {
  const restartPolicy = options.restartPolicy ?? 'pause';
  const noProgressEnabled = options.noProgressEnabled ?? false;
  if (!goal) {
    return [
      'No goal is set.',
      `Status bar: ${statusBarEnabled ? 'on' : 'off'}`,
      `Restart policy: ${restartPolicy}`,
      `No-progress detection: ${noProgressEnabled ? 'on' : 'off'}`,
      formatGates(gates),
    ].join('\n');
  }

  const now = options.now ?? Date.now();
  const tokens = remainingTokens(goal);
  const wall = remainingWallTime(goal, now);
  return [
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Usage: ${formatGoalUsage(goal, now)}`,
    `Remaining tokens: ${tokens === null ? 'n/a' : tokens}`,
    `Remaining active wall time: ${wall === null ? 'n/a' : formatElapsed(wall)}`,
    `Pause reason: ${goal.pauseReason ?? 'n/a'}`,
    `Budget-limit reason: ${goal.budgetLimitReason ?? 'n/a'}`,
    `Evidence: ${formatGoalEvidenceSummary(options.ledger ?? null)}`,
    `No-progress detection: ${noProgressEnabled ? 'on' : 'off'}; streak ${options.progress?.stagnationStreak ?? 0}`,
    `Restart policy: ${restartPolicy}`,
    `Pending budget summary: ${options.pendingBudgetSummary ? 'yes' : 'no'}`,
    `Status bar: ${statusBarEnabled ? 'on' : 'off'}`,
    formatGates(gates),
  ].join('\n');
}

export interface GoalCommandController {
  runtime: GoalRuntime;
  currentGates(): readonly ContinuationGate[];
  persist(ctx: ExtensionContext): void;
  replaceGoal(ctx: ExtensionContext, goal: GoalState): void;
  clearGoal(ctx: ExtensionContext): void;
  transition(
    ctx: ExtensionContext,
    status: GoalStatus,
    options?: { pauseReason?: GoalPauseReason },
  ): GoalState;
  emitGoalEvent(
    kind: GoalEventKind,
    state: GoalState,
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
    origin?: GoalTurnOrigin,
  ): void;
  disposeStatusProvider(): void;
}

export function registerGoalCommand(pi: ExtensionAPI, controller: GoalCommandController): void {
  pi.registerCommand('goal', {
    description: 'Create, inspect, pause, resume, continue, clear, or configure a persistent goal',
    getArgumentCompletions: (prefix) => {
      const matches = GOAL_COMMAND_COMPLETIONS.filter((value) => value.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => handleGoalCommand(args.trim(), ctx, controller),
  });
}

async function handleGoalCommand(
  input: string,
  ctx: ExtensionContext,
  controller: GoalCommandController,
): Promise<void> {
  const { runtime } = controller;
  if (!input || input === 'status') {
    ctx.ui.notify(
      formatGoalStatus(runtime.goal, runtime.statusBarEnabled, controller.currentGates(), {
        now: runtime.now(),
        ledger: runtime.ledger,
        progress: runtime.progress,
        restartPolicy: runtime.restartPolicy,
        noProgressEnabled: runtime.noProgressEnabled,
        pendingBudgetSummary: runtime.pendingBudgetSummary,
      }),
      'info',
    );
    return;
  }

  if (input === 'waits') {
    if (runtime.sessionId) runtime.gateRegistry.requestSnapshot(runtime.sessionId);
    ctx.ui.notify(formatGates(controller.currentGates(), runtime.now()), 'info');
    return;
  }
  if (input === 'evidence') {
    ctx.ui.notify(formatGoalEvidence(runtime.ledger), 'info');
    return;
  }
  if (input === 'evidence reset') {
    await resetEvidence(ctx, controller);
    return;
  }
  if (input === 'statusbar on' || input === 'statusbar off') {
    runtime.statusBarEnabled = input.endsWith('on');
    if (!runtime.statusBarEnabled) controller.disposeStatusProvider();
    controller.persist(ctx);
    ctx.ui.notify(`Goal status bar ${runtime.statusBarEnabled ? 'enabled' : 'disabled'}.`, 'info');
    return;
  }
  if (input === 'restart pause' || input === 'restart restore-idle' || input === 'restart resume') {
    runtime.restartPolicy = input.slice('restart '.length) as GoalRuntime['restartPolicy'];
    controller.persist(ctx);
    ctx.ui.notify(`Goal restart policy set to ${runtime.restartPolicy}.`, 'info');
    return;
  }
  if (input === 'no-progress on' || input === 'no-progress off') {
    runtime.noProgressEnabled = input.endsWith('on');
    if (!runtime.noProgressEnabled)
      runtime.progress = resetGoalProgress(runtime.progress, runtime.now());
    controller.persist(ctx);
    ctx.ui.notify(
      `Goal no-progress detection ${runtime.noProgressEnabled ? 'enabled' : 'disabled'}.`,
      'info',
    );
    return;
  }
  if (input === 'no-progress reset') {
    runtime.progress = resetGoalProgress(runtime.progress, runtime.now());
    controller.persist(ctx);
    ctx.ui.notify('Goal no-progress diagnostics reset.', 'info');
    return;
  }
  if (input === 'clear') {
    if (!runtime.goal) {
      ctx.ui.notify('No goal is set.', 'info');
      return;
    }
    const previous = runtime.goal;
    controller.clearGoal(ctx);
    controller.emitGoalEvent('cleared', previous);
    return;
  }
  if (input === 'pause') {
    if (runtime.goal?.status !== 'active') {
      ctx.ui.notify('No active goal is available to pause.', 'warning');
      return;
    }
    const next = controller.transition(ctx, 'paused', { pauseReason: 'user' });
    controller.emitGoalEvent('paused', next);
    return;
  }
  if (input === 'resume') {
    if (runtime.goal?.status !== 'paused') {
      ctx.ui.notify('Only a paused goal can be resumed.', 'warning');
      return;
    }
    runtime.progress = resetGoalProgress(runtime.progress, runtime.now());
    const next = controller.transition(ctx, 'active');
    controller.emitGoalEvent(
      'resumed',
      next,
      { triggerTurn: true, deliverAs: 'followUp' },
      'resume',
    );
    return;
  }
  if (input === 'continue') {
    await continueGoal(ctx, controller);
    return;
  }
  await createCommandGoal(input, ctx, controller);
}

async function resetEvidence(
  ctx: ExtensionContext,
  controller: GoalCommandController,
): Promise<void> {
  const { runtime } = controller;
  if (!runtime.goal) {
    ctx.ui.notify('No goal is set.', 'info');
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify('Evidence reset requires interactive confirmation.', 'warning');
    return;
  }
  const confirmed = await ctx.ui.confirm(
    'Reset goal evidence?',
    'This removes every requirement and evidence reference for the current goal.',
  );
  if (!confirmed) return;
  runtime.ledger = createGoalEvidenceLedger(runtime.goal.id, runtime.now());
  runtime.progress = resetGoalProgress(runtime.progress, runtime.now());
  controller.persist(ctx);
  ctx.ui.notify('Goal evidence reset.', 'info');
}

async function continueGoal(
  ctx: ExtensionContext,
  controller: GoalCommandController,
): Promise<void> {
  const { runtime } = controller;
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
  const gatesAtConfirmation = controller.currentGates();
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
      `${formatGates(gatesAtConfirmation, runtime.now())}\n\nThis bypass applies to one turn and does not release gates.`,
    );
    if (!confirmed) return;
  }
  const liveGates = controller.currentGates();
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
  controller.emitGoalEvent(
    'continuation',
    runtime.goal,
    { triggerTurn: true, deliverAs: 'followUp' },
    'manual',
  );
}

async function createCommandGoal(
  input: string,
  ctx: ExtensionContext,
  controller: GoalCommandController,
): Promise<void> {
  const { runtime } = controller;
  const parsed = parseGoalCommand(input);
  if (parsed.error) {
    ctx.ui.notify(parsed.error, 'warning');
    return;
  }
  if (!parsed.objective) {
    ctx.ui.notify('Usage: /goal [--tokens 50k] [--time 30m] <objective>', 'warning');
    return;
  }
  if (runtime.goal && runtime.goal.status !== 'complete' && ctx.hasUI) {
    const confirmed = await ctx.ui.confirm(
      'Replace goal?',
      `Current: ${runtime.goal.objective}\n\nNew: ${parsed.objective}`,
    );
    if (!confirmed) return;
  }
  const timestamp = runtime.now();
  const next = createGoalState(
    parsed.objective,
    parsed.tokenBudget,
    timestamp,
    undefined,
    parsed.wallTimeBudgetSeconds,
  );
  runtime.ledger = createGoalEvidenceLedger(next.id, timestamp);
  runtime.progress = null;
  controller.replaceGoal(ctx, next);
  controller.emitGoalEvent('active', next, { triggerTurn: true, deliverAs: 'followUp' }, 'other');
}
