import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { TMUX_PROMPT_SNIPPET } from '../prompt.js';
import { renderTmuxCall, renderTmuxResult } from '../render.js';
import { createTmuxInputSchema, type TmuxInput } from '../schemas.js';
import type { TmuxBashRuntime } from '../runtime.js';
import type { TmuxAction, TmuxToolDetails } from '../types.js';

export function registerTmuxTool(pi: ExtensionAPI, runtime: TmuxBashRuntime): void {
  pi.registerTool({
    name: runtime.config.tmuxToolName,
    label: 'tmux jobs',
    description:
      'List, inspect, poll, await, unawait, present attach commands, send opt-in literal input, preview cleanup, clean artifacts, or kill only tmux windows managed by this extension and allowed by the configured scope. Targets are stable @-prefixed window IDs.',
    promptSnippet: TMUX_PROMPT_SNIPPET,
    promptGuidelines: [
      'Use tmux only with stable @-prefixed window IDs returned by bash or tmux list.',
      'Tmux polling reports progress but does not implicitly await or unawait a command.',
      'Never use tmux send-input for secrets because model tool arguments are session-visible.',
      'Tmux attach only presents a safe command; it never suspends Pi or attaches by itself.',
      'Use tmux cleanup-preview before cleanup; cleanup never deletes a validated live run.',
    ],
    parameters: createTmuxInputSchema(runtime.config),
    execute: async (_toolCallId, rawParams, _signal, _onUpdate, ctx) => {
      const params = rawParams as TmuxInput;
      validateActionInput(params, runtime.config.enabledTmuxActions);
      switch (params.action) {
        case 'list':
          return runtime.listResult(ctx);
        case 'list-polls':
          return runtime.listPollsResult(ctx);
        case 'peek':
          return runtime.peek(requireWindowId(params), ctx, params.lines);
        case 'kill':
          return runtime.kill(requireWindowId(params), ctx);
        case 'poll':
          return runtime.poll(requireWindowId(params), ctx, params.interval, params.lines);
        case 'unpoll':
          return runtime.unpoll(requireWindowId(params), ctx);
        case 'await':
          return runtime.await(requireWindowId(params), ctx);
        case 'unawait':
          return runtime.unawait(requireWindowId(params), ctx);
        case 'attach':
          return runtime.attach(requireWindowId(params), ctx);
        case 'send-input':
          if (typeof params.text !== 'string') {
            throw new Error('tmux action send-input requires text.');
          }
          return runtime.sendInput(
            requireWindowId(params),
            params.text,
            params.submit ?? true,
            ctx,
          );
        case 'send-key':
          if (!params.key) throw new Error('tmux action send-key requires key.');
          return runtime.sendKey(requireWindowId(params), params.key, ctx);
        case 'cleanup-preview':
          rejectWindowId(params);
          return runtime.cleanupPreview(ctx);
        case 'cleanup':
          rejectWindowId(params);
          return runtime.cleanup(ctx);
        default:
          return assertNever(params.action);
      }
    },
    renderCall: (args, theme) => renderTmuxCall(args as TmuxInput, theme),
    renderResult: (result, options, theme) =>
      renderTmuxResult(result as typeof result & { details?: TmuxToolDetails }, options, theme),
  });
}

const ACTION_FIELDS: Record<TmuxAction, ReadonlySet<keyof TmuxInput>> = {
  list: new Set(['action']),
  peek: new Set(['action', 'windowId', 'lines']),
  kill: new Set(['action', 'windowId']),
  poll: new Set(['action', 'windowId', 'interval', 'lines']),
  unpoll: new Set(['action', 'windowId']),
  'list-polls': new Set(['action']),
  await: new Set(['action', 'windowId']),
  unawait: new Set(['action', 'windowId']),
  attach: new Set(['action', 'windowId']),
  'send-input': new Set(['action', 'windowId', 'text', 'submit']),
  'send-key': new Set(['action', 'windowId', 'key']),
  'cleanup-preview': new Set(['action']),
  cleanup: new Set(['action']),
};

function validateActionInput(params: TmuxInput, enabledActions: readonly TmuxAction[]): void {
  if (!enabledActions.includes(params.action)) {
    throw new Error(`tmux action ${params.action} is disabled.`);
  }
  const allowed = ACTION_FIELDS[params.action];
  for (const [field, value] of Object.entries(params)) {
    if (value !== undefined && !allowed.has(field as keyof TmuxInput)) {
      throw new Error(`tmux action ${params.action} does not accept ${field}.`);
    }
  }
}

function requireWindowId(params: TmuxInput): string {
  if (!params.windowId) throw new Error(`tmux action ${params.action} requires windowId.`);
  return params.windowId;
}

function rejectWindowId(params: TmuxInput): void {
  if (params.windowId) throw new Error(`tmux action ${params.action} does not accept windowId.`);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported tmux action: ${String(value)}.`);
}
