import type { TmuxBashConfig } from './types.js';

export const BASH_PROMPT_SNIPPET =
  'Execute shell commands in managed tmux windows with optional background completion reporting';

export function createBashPromptGuidelines(config: TmuxBashConfig): string[] {
  const configuredDefault = config.defaultWaitForBackgroundCompletion ? 'true' : 'false';

  return [
    'Use bash background mode for servers, watchers, REPLs, and long-running jobs.',
    'Set bash waitForCompletion: true for every finite background command whose result is required, including tests, builds, and subagents, regardless of how long it may run or whether other productive work can continue.',
    'Set bash waitForCompletion: false only for processes intentionally expected to remain alive indefinitely, such as servers, watchers, and REPLs; never set it false merely because a command is slow or long-running.',
    'Launch a finite background command that requires waiting as the only tool call in its assistant response so its terminating result can stop the current agent loop.',
    'After bash returns an awaited background command, stop immediately: do not call get_goal, tmux await, tmux poll, or emit waiting commentary; completion will resume work automatically.',
    'If required finite work was started without a continuation gate, call tmux action await once on its stable window, then stop immediately; do not repeatedly call goal tools, poll, or emit waiting updates.',
    `If omitted for an explicit background command, waitForCompletion defaults to ${configuredDefault} in this installation.`,
    'Background bash completion is reported automatically while this Pi process remains running.',
    'Use stable @-prefixed window IDs with tmux actions; tmux window indexes are not stable.',
  ];
}

export const TMUX_PROMPT_SNIPPET =
  'Inspect or control tmux windows created by the tmux-backed bash tool';
