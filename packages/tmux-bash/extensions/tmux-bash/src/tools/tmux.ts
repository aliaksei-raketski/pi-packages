import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { TMUX_PROMPT_SNIPPET } from '../prompt.js';
import { renderTmuxCall, renderTmuxResult } from '../render.js';
import { createTmuxInputSchema, type TmuxInput } from '../schemas.js';
import type { TmuxBashRuntime } from '../runtime.js';
import type { TmuxToolDetails } from '../types.js';

export function registerTmuxTool(pi: ExtensionAPI, runtime: TmuxBashRuntime): void {
  pi.registerTool({
    name: runtime.config.tmuxToolName,
    label: 'tmux jobs',
    description:
      'List, inspect, poll, await, unawait, or kill only tmux windows managed by this extension and allowed by the configured scope. Targets are stable @-prefixed window IDs.',
    promptSnippet: TMUX_PROMPT_SNIPPET,
    promptGuidelines: [
      'Use tmux only with stable @-prefixed window IDs returned by bash or tmux list.',
      'Tmux polling reports progress but does not implicitly await or unawait a command.',
    ],
    parameters: createTmuxInputSchema(runtime.config),
    execute: async (_toolCallId, rawParams, _signal, _onUpdate, ctx) => {
      const params = rawParams as TmuxInput;
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
        default:
          return assertNever(params.action);
      }
    },
    renderCall: (args, theme) => renderTmuxCall(args as TmuxInput, theme),
    renderResult: (result, options, theme) =>
      renderTmuxResult(result as typeof result & { details?: TmuxToolDetails }, options, theme),
  });
}

function requireWindowId(params: TmuxInput): string {
  if (!params.windowId) throw new Error(`tmux action ${params.action} requires windowId.`);
  return params.windowId;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported tmux action: ${String(value)}.`);
}
