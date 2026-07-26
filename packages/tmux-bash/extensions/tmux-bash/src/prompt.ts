import type { TmuxBashConfig } from './types.js';

export const BASH_PROMPT_SNIPPET =
  'Execute shell commands in managed tmux windows with optional background completion reporting';

export function createBashPromptGuidelines(config: TmuxBashConfig): string[] {
  const configuredDefault = config.defaultWaitForBackgroundCompletion ? 'true' : 'false';

  return [
    'Use bash background mode for servers, watchers, REPLs, and long-running jobs.',
    'For every background bash call, set waitForCompletion explicitly: true for finite asynchronous work when no productive step remains until its result; false for persistent servers, watchers, and REPLs.',
    `If omitted for an explicit background command, waitForCompletion defaults to ${configuredDefault} in this installation.`,
    'Background bash completion is reported automatically while this Pi process remains running.',
    'Use stable @-prefixed window IDs with tmux actions; tmux window indexes are not stable.',
  ];
}

export const TMUX_PROMPT_SNIPPET =
  'Inspect or control tmux windows created by the tmux-backed bash tool';
