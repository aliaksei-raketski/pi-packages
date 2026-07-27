import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerStatusProvider } from '@aliaksei-raketski/pi-statusline-protocol';
import { Text } from '@earendil-works/pi-tui';

import { registerTmuxAttachCommand } from './attach.js';
import { registerTmuxCleanupCommands } from './cleanup-command.js';
import { loadTmuxBashConfig } from './config.js';
import { createTmuxGateController } from './gate-integration.js';
import { TmuxBashRuntime } from './runtime.js';
import { collectTmuxBashStatus } from './status.js';
import { registerBashTool } from './tools/bash.js';
import { registerTmuxTool } from './tools/tmux.js';
import {
  TMUX_BASH_COMPLETION_MESSAGE,
  TMUX_BASH_DISPLAY_COMPLETION,
  TMUX_BASH_PENDING_COMPLETION,
  TMUX_BASH_STATUS_SOURCE,
} from './types.js';
import { createTmuxUserBashOperations } from './user-bash.js';

export function tmuxBash(pi: ExtensionAPI) {
  const config = loadTmuxBashConfig();
  const gateController = createTmuxGateController(pi);
  const runtime = new TmuxBashRuntime(pi, config, gateController);

  registerBashTool(pi, runtime);
  registerTmuxTool(pi, runtime);
  registerTmuxAttachCommand(pi, runtime);
  registerTmuxCleanupCommands(pi, runtime);

  pi.registerMessageRenderer(TMUX_BASH_COMPLETION_MESSAGE, (message, options, theme) => {
    const fullContent = messageText(message.content);
    const content = options.expanded ? fullContent : compact(fullContent, 12);
    return new Text(theme.fg('accent', content), 0, 0);
  });
  for (const entryType of [TMUX_BASH_DISPLAY_COMPLETION, TMUX_BASH_PENDING_COMPLETION]) {
    pi.registerEntryRenderer(entryType, (entry, _options, theme) => {
      const data = entry.data as { runId?: string; summary?: string; state?: string };
      const label = entryType === TMUX_BASH_PENDING_COMPLETION ? 'pending next turn' : 'display';
      return new Text(
        theme.fg(
          'accent',
          `[tmux ${label}] ${data.runId ?? 'run'}: ${data.summary ?? data.state ?? ''}`,
        ),
        0,
        0,
      );
    });
  }

  pi.on('session_start', async (_event, ctx) => {
    await runtime.startSession(ctx);
    runtime.state.clearStatusProvider?.();
    const provider = registerStatusProvider(
      pi,
      () => {
        if (!config.statusbarEnabled) return [];
        const status = collectTmuxBashStatus(runtime.state.commands.values());
        return status ? [status] : [];
      },
      TMUX_BASH_STATUS_SOURCE,
    );
    runtime.state.clearStatusProvider = provider.dispose;
  });

  pi.on('before_agent_start', (_event, ctx) => {
    const pending = runtime.consumePendingCompletions(ctx);
    if (!pending) return undefined;
    return {
      message: {
        customType: TMUX_BASH_COMPLETION_MESSAGE,
        content: pending,
        display: true,
      },
    };
  });

  if (config.routeUserBash) {
    const operations = createTmuxUserBashOperations(runtime);
    pi.on('user_bash', () => ({ operations }));
  }

  pi.on('session_shutdown', async (_event, ctx) => {
    runtime.state.clearStatusProvider?.();
    runtime.state.clearStatusProvider = undefined;
    await runtime.shutdown(ctx);
    gateController.dispose();
  });
}

function messageText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((item): item is { type: string; text: string } => typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function compact(value: string, maxLines: number): string {
  const lines = value.split('\n');
  if (lines.length <= maxLines) return value;
  return `${lines.slice(-maxLines).join('\n')}\n…`;
}
