import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerStatusProvider } from '@aliaksei-raketski/pi-statusline-protocol';
import { Text } from '@earendil-works/pi-tui';

import { registerTmuxAttachCommand } from './attach.js';
import { registerTmuxCleanupCommands } from './cleanup-command.js';
import { loadTmuxBashConfig } from './config.js';
import { createTmuxGateController } from './gate-integration.js';
import { TmuxBashRuntime } from './runtime.js';
import { sanitizeTerminalText } from './sanitize.js';
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
    const fullContent = boundedText(messageText(message.content), 8_000);
    const content = options.expanded ? fullContent : compact(fullContent, 12);
    return new Text(theme.fg('accent', content), 0, 0);
  });
  for (const entryType of [TMUX_BASH_DISPLAY_COMPLETION, TMUX_BASH_PENDING_COMPLETION]) {
    pi.registerEntryRenderer(entryType, (entry, _options, theme) => {
      const data = safeEntryData(entry.data);
      const label = entryType === TMUX_BASH_PENDING_COMPLETION ? 'pending next turn' : 'display';
      return new Text(theme.fg('accent', `[tmux ${label}] ${data.runId}: ${data.summary}`), 0, 0);
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

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (item): item is { text: string } =>
        typeof item === 'object' && item !== null && typeof Reflect.get(item, 'text') === 'string',
    )
    .map((item) => item.text)
    .join('\n');
}

function safeEntryData(value: unknown): { runId: string; summary: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { runId: 'run', summary: '' };
  }
  const runId = Reflect.get(value, 'runId');
  const summary = Reflect.get(value, 'summary');
  const state = Reflect.get(value, 'state');
  return {
    runId: typeof runId === 'string' ? boundedText(runId.replaceAll('\n', ' '), 128) : 'run',
    summary: boundedText(
      compact(typeof summary === 'string' ? summary : typeof state === 'string' ? state : '', 12),
      2_000,
    ),
  };
}

function boundedText(value: string, maximum: number): string {
  const sanitized = sanitizeTerminalText(value);
  return sanitized.length <= maximum ? sanitized : `${sanitized.slice(0, maximum - 1)}…`;
}

function compact(value: string, maxLines: number): string {
  const lines = value.split('\n');
  if (lines.length <= maxLines) return value;
  return `${lines.slice(-maxLines).join('\n')}\n…`;
}
