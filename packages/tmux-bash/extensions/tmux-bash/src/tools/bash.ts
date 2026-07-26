import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createBashPromptGuidelines, BASH_PROMPT_SNIPPET } from '../prompt.js';
import { renderBashCall, renderBashResult } from '../render.js';
import { createBashInputSchema, type BashInput } from '../schemas.js';
import type { TmuxBashDetails } from '../types.js';
import type { TmuxBashRuntime } from '../runtime.js';

export function registerBashTool(pi: ExtensionAPI, runtime: TmuxBashRuntime): void {
  pi.registerTool({
    name: runtime.config.bashToolName,
    label: 'bash (tmux)',
    description:
      'Execute a shell command in an owned tmux window. Foreground output is returned when complete; background commands return a stable window ID and report completion automatically. Output is bounded and full logs remain in a private artifact file.',
    promptSnippet: BASH_PROMPT_SNIPPET,
    promptGuidelines: runtime.config.systemPrompt ? createBashPromptGuidelines(runtime.config) : [],
    parameters: createBashInputSchema(runtime.config),
    execute: (_toolCallId, params, signal, onUpdate, ctx) =>
      runtime.executeBash(
        params as unknown as BashInput,
        signal,
        onUpdate as Parameters<TmuxBashRuntime['executeBash']>[2],
        ctx,
      ),
    renderCall: (args, theme) => renderBashCall(args as unknown as BashInput, theme),
    renderResult: (result, options, theme) =>
      renderBashResult(result as typeof result & { details?: TmuxBashDetails }, options, theme),
  });
}
