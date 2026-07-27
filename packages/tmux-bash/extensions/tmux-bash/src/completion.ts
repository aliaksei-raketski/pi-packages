import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  ContinuationGateController,
  ContinuationGateWakeHandoff,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';

import { sanitizeTerminalText } from './sanitize.js';
import { RunStore } from './run-store.js';
import {
  TMUX_BASH_COMPLETION_MESSAGE,
  TMUX_BASH_CONSUMED_COMPLETION,
  TMUX_BASH_DISPLAY_COMPLETION,
  TMUX_BASH_PENDING_COMPLETION,
  type CommandRun,
  type TmuxBashDetails,
} from './types.js';

const MAX_PENDING_COMPLETIONS = 20;
const MAX_PENDING_COMPLETION_BYTES = 50 * 1024;
const PENDING_OVERFLOW_RESERVE_BYTES = 256;

export interface CompletionPayload {
  text: string;
  details: TmuxBashDetails;
}

export interface DeliveryOutcome {
  wake: 'producer-message' | 'none';
  handoff?: ContinuationGateWakeHandoff;
  alreadyDelivered: boolean;
}

export class CompletionDeliveryService {
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly store: RunStore,
    private readonly gateController: ContinuationGateController,
  ) {}

  async deliverCompletion(
    run: CommandRun,
    payload: CompletionPayload,
    ctx: ExtensionContext,
  ): Promise<DeliveryOutcome> {
    if (this.isCompletionRecorded(ctx, run.completionId)) {
      run.deliveryState = 'delivered';
      run.completionDelivered = true;
      await this.store.persist(run);
      return { wake: 'none', alreadyDelivered: true };
    }

    try {
      if (run.completionDelivery === 'model') {
        return await this.deliverModel(run, payload);
      }
      if (run.completionDelivery === 'display') {
        return await this.deliverDisplay(run, payload, ctx);
      }
      return await this.deliverNextTurn(run, payload);
    } catch (error) {
      run.deliveryState = 'failed';
      run.completionDeliveryFailed = true;
      await this.store.persist(run).catch(() => undefined);
      throw error;
    }
  }

  consumePending(ctx: ExtensionContext): string | undefined {
    const branch = sessionBranch(ctx);
    const consumed = new Set<string>();
    const pending = new Map<string, PendingCompletion>();
    for (const entry of branch) {
      if (entry.type !== 'custom') continue;
      if (entry.customType === TMUX_BASH_CONSUMED_COMPLETION) {
        const completionId = completionIdFromData(entry.data);
        if (completionId) consumed.add(completionId);
      }
      if (entry.customType === TMUX_BASH_PENDING_COMPLETION) {
        const candidate = pendingFromData(entry.data);
        if (candidate) pending.set(candidate.completionId, candidate);
      }
    }
    const available = [...pending.values()].filter(
      (candidate) => !consumed.has(candidate.completionId),
    );
    if (available.length === 0) return undefined;

    const selected: Array<{ candidate: PendingCompletion; text: string }> = [];
    let bytes = 0;
    for (const candidate of available) {
      if (selected.length >= MAX_PENDING_COMPLETIONS) break;
      const text = bounded(
        formatPending(candidate),
        MAX_PENDING_COMPLETION_BYTES - PENDING_OVERFLOW_RESERVE_BYTES,
      );
      const candidateBytes = Buffer.byteLength(text) + (selected.length > 0 ? 2 : 0);
      if (selected.length > 0 && bytes + candidateBytes > MAX_PENDING_COMPLETION_BYTES) break;
      selected.push({ candidate, text });
      bytes += candidateBytes;
    }
    for (const { candidate } of selected) {
      this.pi.appendEntry(TMUX_BASH_CONSUMED_COMPLETION, {
        completionId: candidate.completionId,
        consumedAt: Date.now(),
      });
    }
    const overflow = available.length - selected.length;
    const body = selected.map(({ text }) => text).join('\n\n');
    return overflow > 0
      ? `${body}\n\n${overflow} additional tmux completion(s) remain pending for a later natural turn.`
      : body;
  }

  isCompletionRecorded(ctx: ExtensionContext, completionId: string): boolean {
    for (const entry of sessionBranch(ctx)) {
      if (entry.type === 'custom') {
        if (
          (entry.customType === TMUX_BASH_CONSUMED_COMPLETION ||
            entry.customType === TMUX_BASH_DISPLAY_COMPLETION) &&
          completionIdFromData(entry.data) === completionId
        ) {
          return true;
        }
      }
      if (entry.type === 'custom_message' && entry.customType === TMUX_BASH_COMPLETION_MESSAGE) {
        const details = entry.details as { completionId?: unknown } | undefined;
        if (details?.completionId === completionId) return true;
      }
    }
    return false;
  }

  private async deliverModel(
    run: CommandRun,
    payload: CompletionPayload,
  ): Promise<DeliveryOutcome> {
    const handoff = run.gateId
      ? this.gateController.prepareWake({ sessionId: run.sessionId, gateId: run.gateId })
      : undefined;
    try {
      run.deliveryState = 'queued';
      await this.store.persist(run);
      this.pi.sendMessage(
        {
          customType: TMUX_BASH_COMPLETION_MESSAGE,
          content: payload.text,
          display: true,
          details: { ...payload.details, completionId: run.completionId },
        },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
      if (handoff && !this.gateController.commitWake(handoff)) {
        throw new Error('Continuation wake handoff could not be committed.');
      }
      run.deliveryState = 'delivered';
      run.completionDelivered = true;
      await this.store.persist(run);
      return { wake: handoff ? 'producer-message' : 'none', handoff, alreadyDelivered: false };
    } catch (error) {
      if (handoff) this.gateController.abortWake(handoff);
      throw error;
    }
  }

  private async deliverDisplay(
    run: CommandRun,
    payload: CompletionPayload,
    ctx: ExtensionContext,
  ): Promise<DeliveryOutcome> {
    this.pi.appendEntry(TMUX_BASH_DISPLAY_COMPLETION, {
      completionId: run.completionId,
      runId: run.runId,
      windowId: run.windowId,
      exitCode: run.exitCode,
      summary: bounded(payload.text),
      outputFile: run.outputFile,
      displayed: ctx.hasUI,
      createdAt: Date.now(),
    });
    run.deliveryState = 'persisted';
    run.completionDelivered = true;
    await this.store.persist(run);
    if (ctx.hasUI) ctx.ui.notify(bounded(payload.text), run.exitCode === 0 ? 'info' : 'error');
    return { wake: 'none', alreadyDelivered: false };
  }

  private async deliverNextTurn(
    run: CommandRun,
    payload: CompletionPayload,
  ): Promise<DeliveryOutcome> {
    this.pi.appendEntry(TMUX_BASH_PENDING_COMPLETION, {
      completionId: run.completionId,
      runId: run.runId,
      windowId: run.windowId,
      exitCode: run.exitCode,
      summary: bounded(payload.text),
      outputFile: run.outputFile,
      state: 'pending',
      createdAt: Date.now(),
    });
    run.deliveryState = 'persisted';
    run.completionDelivered = true;
    await this.store.persist(run);
    return { wake: 'none', alreadyDelivered: false };
  }
}

interface PendingCompletion {
  completionId: string;
  runId: string;
  windowId?: string;
  exitCode?: number;
  summary: string;
  outputFile: string;
}

function pendingFromData(value: unknown): PendingCompletion | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.completionId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value.completionId) ||
    typeof value.runId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value.runId) ||
    typeof value.summary !== 'string' ||
    typeof value.outputFile !== 'string' ||
    Buffer.byteLength(value.outputFile) > 4_096 ||
    value.outputFile.includes('\0')
  ) {
    return undefined;
  }
  return {
    completionId: value.completionId,
    runId: value.runId,
    ...(typeof value.windowId === 'string' && /^@[0-9]+$/.test(value.windowId)
      ? { windowId: value.windowId }
      : {}),
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
    summary: bounded(value.summary),
    outputFile: value.outputFile,
  };
}

function completionIdFromData(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.completionId !== 'string') return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value.completionId)
    ? value.completionId
    : undefined;
}

function formatPending(candidate: PendingCompletion): string {
  return `${candidate.windowId ?? candidate.runId} completed with exit code ${candidate.exitCode ?? 'unknown'}.\n${candidate.summary}\nArtifact: ${candidate.outputFile}`;
}

function bounded(value: string, maximumBytes = MAX_PENDING_COMPLETION_BYTES): string {
  const sanitized = sanitizeTerminalText(value);
  if (Buffer.byteLength(sanitized) <= maximumBytes) return sanitized;
  const suffix = '\n[bounded]';
  const budget = maximumBytes - Buffer.byteLength(suffix);
  const characters: string[] = [];
  let used = 0;
  for (let index = sanitized.length; index > 0; ) {
    const low = sanitized.charCodeAt(index - 1);
    const width = low >= 0xdc00 && low <= 0xdfff && index > 1 ? 2 : 1;
    const character = sanitized.slice(index - width, index);
    const size = Buffer.byteLength(character);
    if (used + size > budget) break;
    characters.push(character);
    used += size;
    index -= width;
  }
  return `${characters.reverse().join('')}${suffix}`;
}

function sessionBranch(
  ctx: ExtensionContext,
): ReturnType<ExtensionContext['sessionManager']['getBranch']> {
  const getBranch = ctx.sessionManager.getBranch;
  return typeof getBranch === 'function' ? getBranch.call(ctx.sessionManager) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
