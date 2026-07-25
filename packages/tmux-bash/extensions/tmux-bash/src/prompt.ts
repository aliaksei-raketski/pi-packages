export const BASH_PROMPT_SNIPPET =
  'Execute shell commands in managed tmux windows with optional background completion reporting';

export const BASH_PROMPT_GUIDELINES = [
  'Use bash background mode for servers, watchers, REPLs, and long-running jobs.',
  'Use bash waitForCompletion only for finite asynchronous work when no productive step remains until its result; never gate persistent servers or watchers.',
  'Background bash completion is reported automatically while this Pi process remains running.',
  'Use stable @-prefixed window IDs with tmux actions; tmux window indexes are not stable.',
];

export const TMUX_PROMPT_SNIPPET =
  'Inspect or control tmux windows created by the tmux-backed bash tool';
