import type { TmuxAction, TmuxBashConfig } from './types.js';

export const BASH_PROMPT_SNIPPET =
  'Execute shell commands in managed tmux windows with optional background completion reporting';

export function createBashPromptGuidelines(config: TmuxBashConfig): string[] {
  const configuredDefault = config.defaultWaitForBackgroundCompletion ? 'true' : 'false';
  const guidelines = [
    'Use bash background mode for servers, watchers, REPLs, and long-running jobs.',
    'Set bash waitForCompletion: true for every finite background command whose result is required, including tests, builds, and subagents, regardless of how long it may run or whether other productive work can continue.',
    'Set bash waitForCompletion: false only for processes intentionally expected to remain alive indefinitely, such as servers, watchers, and REPLs; never set it false merely because a command is slow or long-running.',
    'Launch a finite background command that requires waiting as the only tool call in its assistant response so its terminating result can stop the current agent loop.',
    'After bash returns an awaited background command, stop immediately; completion will resume work automatically.',
  ];

  if (config.enabledTmuxActions.includes('await')) {
    guidelines.push(
      'If required finite work was started without a continuation gate, call tmux action await once on its stable window, then stop immediately; do not repeatedly call goal tools, poll, or emit waiting updates.',
    );
  }

  guidelines.push(
    `If omitted for an explicit background command, waitForCompletion defaults to ${configuredDefault} in this installation.`,
    config.adoptionPolicy === 'same-pi-session'
      ? 'Background bash completion is durable and may be recovered after a same-session Pi restart; another Pi session never adopts it.'
      : 'Background bash completion is reported automatically only while this Pi runtime remains active because restart adoption is disabled.',
    'Choose completionDelivery independently from waiting: model wakes with a follow-up, display stays out of model context with wake=none, and next-turn waits for the next natural model turn.',
  );
  return guidelines;
}

export const TMUX_PROMPT_SNIPPET =
  'Inspect or control tmux windows created by the tmux-backed bash tool';

const WINDOW_TARGET_ACTIONS: readonly TmuxAction[] = [
  'peek',
  'kill',
  'poll',
  'unpoll',
  'await',
  'unawait',
  'attach',
  'send-input',
  'send-key',
];

export function createTmuxToolDescription(config: TmuxBashConfig): string {
  const targetNote = config.enabledTmuxActions.some((action) =>
    WINDOW_TARGET_ACTIONS.includes(action),
  )
    ? ' Actions that target a run use stable @-prefixed window IDs.'
    : '';
  return `Manage only tmux windows created by this extension and allowed by the configured scope. Available actions: ${config.enabledTmuxActions.join(', ')}.${targetNote}`;
}

export function createTmuxPromptGuidelines(config: TmuxBashConfig): string[] {
  const enabled = new Set(config.enabledTmuxActions);
  const guidelines: string[] = [];

  if (WINDOW_TARGET_ACTIONS.some((action) => enabled.has(action))) {
    guidelines.push(
      'Use tmux only with stable @-prefixed window IDs returned by bash or tmux list.',
    );
  }
  if (['poll', 'unpoll', 'list-polls'].some((action) => enabled.has(action as TmuxAction))) {
    guidelines.push(
      'Tmux polling reports progress but does not implicitly await or unawait a command.',
    );
  }
  if (enabled.has('send-input')) {
    guidelines.push(
      'Never use tmux send-input for secrets because model tool arguments are session-visible.',
    );
  }
  if (enabled.has('attach')) {
    guidelines.push(
      'Tmux attach only presents a safe command; it never suspends Pi or attaches by itself.',
    );
  }
  if (enabled.has('cleanup') && enabled.has('cleanup-preview')) {
    guidelines.push(
      'Use tmux cleanup-preview before tmux cleanup; cleanup never deletes a validated live run.',
    );
  } else if (enabled.has('cleanup')) {
    guidelines.push('Tmux cleanup never deletes a validated live run.');
  } else if (enabled.has('cleanup-preview')) {
    guidelines.push('Tmux cleanup-preview reports only validated inactive artifacts.');
  }

  return guidelines;
}
