import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  clearStatus,
  publishStatus,
  type StatuslineStatus,
  type StatuslineUICtx,
} from '@aliaksei-raketski/pi-statusline-protocol';

import {
  TMUX_BASH_STATUS_KEY,
  TMUX_BASH_STATUS_SOURCE,
  type CommandRun,
  type TmuxBashConfig,
} from './types.js';

export function collectTmuxBashStatus(
  commands: Iterable<CommandRun>,
): StatuslineStatus | undefined {
  let backgroundCount = 0;
  let awaitedCount = 0;
  for (const run of commands) {
    if (run.mode !== 'background' || run.endedAt !== undefined || run.killed) continue;
    backgroundCount += 1;
    if (run.gateId) awaitedCount += 1;
  }
  if (backgroundCount === 0) return undefined;

  const jobs = `${backgroundCount} bg ${backgroundCount === 1 ? 'job' : 'jobs'}`;
  return {
    key: TMUX_BASH_STATUS_KEY,
    text: awaitedCount > 0 ? `${jobs} · ${awaitedCount} awaited` : jobs,
    state: awaitedCount > 0 ? 'awaiting' : 'running',
    fallbackColor: awaitedCount > 0 ? 'warning' : 'accent',
  };
}

export function updateTmuxBashStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: TmuxBashConfig,
  commands: Iterable<CommandRun>,
): void {
  const statusContext = createStatusContext(ctx);
  const status = config.statusbarEnabled ? collectTmuxBashStatus(commands) : undefined;
  if (status) publishStatus(pi, statusContext, status, TMUX_BASH_STATUS_SOURCE);
  else clearStatus(pi, statusContext, TMUX_BASH_STATUS_KEY, TMUX_BASH_STATUS_SOURCE);
}

function createStatusContext(ctx: ExtensionContext): StatuslineUICtx {
  return {
    setStatus: (key, text) => ctx.ui.setStatus(key, text),
    theme: ctx.ui.theme,
  };
}
