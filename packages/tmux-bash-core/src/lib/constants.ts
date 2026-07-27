export const TMUX_BASH_OWNERSHIP_MARKER = 'pi-tmux-bash' as const;

export const TMUX_BASH_METADATA_KEYS = {
  owner: '@pi_tmux_bash_owner',
  scopeKind: '@pi_tmux_bash_scope_kind',
  scopeRoot: '@pi_tmux_bash_scope_root',
  scopeHash: '@pi_tmux_bash_scope_hash',
  piSessionId: '@pi_tmux_bash_session_id',
  runId: '@pi_tmux_bash_run_id',
  manifestPath: '@pi_tmux_bash_manifest_path',
  completionId: '@pi_tmux_bash_completion_id',
  completionDelivery: '@pi_tmux_bash_completion_delivery',
  startedAt: '@pi_tmux_bash_started_at',
  displayCommand: '@pi_tmux_bash_command',
} as const;

export const MANAGED_RUN_MANIFEST_FIELDS = [
  'runId',
  'origin',
  'completionId',
  'piSessionId',
  'scope',
  'cwd',
  'tmuxSession',
  'windowId',
  'commandFile',
  'scriptFile',
  'outputFile',
  'exitCodeFile',
  'displayCommand',
  'startedAt',
  'endedAt',
  'exitCode',
  'mode',
  'state',
  'awaited',
  'continuationDomain',
  'completionDelivery',
  'deliveryState',
  'completionDeliveryAttempts',
  'completionDeliveryExhausted',
  'polling',
  'outputWasRotated',
  'updatedAt',
] as const;

export const MAX_TMUX_DISCOVERY_BYTES = 1024 * 1024;
export const MAX_MANIFEST_DISPLAY_COMMAND_BYTES = 4096;
