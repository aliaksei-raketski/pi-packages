import type {
  AgentToolResult,
  BashToolDetails,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { ContinuationGateController } from '@aliaksei-raketski/pi-continuation-gate-protocol';
import type {
  CompletionDelivery,
  CompletionDeliveryState,
  ManagedRunState,
  TmuxWorkspaceScope,
} from '@aliaksei-raketski/pi-tmux-bash-core';
import type { FSWatcher } from 'node:fs';

export const TMUX_BASH_STATUS_KEY = 'tmux-bash';
export const TMUX_BASH_STATUS_SOURCE = 'pi-tmux-bash';
export const TMUX_BASH_GATE_SOURCE = 'pi-tmux-bash';
export const TMUX_BASH_COMPLETION_MESSAGE = 'tmux-bash-completion';
export const TMUX_BASH_PENDING_COMPLETION = 'pi-tmux-bash-pending-completion';
export const TMUX_BASH_CONSUMED_COMPLETION = 'pi-tmux-bash-consumed-completion';
export const TMUX_BASH_DISPLAY_COMPLETION = 'pi-tmux-bash-display-completion';

export type TmuxAction =
  | 'list'
  | 'peek'
  | 'kill'
  | 'poll'
  | 'unpoll'
  | 'list-polls'
  | 'await'
  | 'unawait'
  | 'attach'
  | 'send-input'
  | 'send-key'
  | 'cleanup-preview'
  | 'cleanup';

export type InteractiveKey = 'enter' | 'escape' | 'ctrl-c' | 'ctrl-d';

export interface TmuxBashConfig {
  bashToolName: string;
  tmuxToolName: string;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  defaultTimeoutAction: 'background' | 'kill';
  foregroundUpdateIntervalMs: number;
  tmuxBinary: string;
  tmuxSessionScope: 'global' | 'workspace';
  globalTmuxSessionName: string;
  gitRootTmuxSessionNameTemplate: string;
  cwdTmuxSessionNameTemplate: string;
  tmuxWindowScope: 'pi-session' | 'workspace' | 'all';
  tmuxWindowNameTemplate: string;
  maxTmuxWindowNameLength: number;
  autoCloseWindowsOnCompletion: boolean;
  defaultPollIntervalSeconds: number;
  minimumModelPollIntervalSeconds: number;
  pollDelivery: 'model' | 'display';
  maxOutputBytes: number;
  maxSpoolBytes: number;
  foregroundContextLines: number;
  completionContextLines: number;
  pollContextLines: number;
  peekContextLines: number;
  completedCompactDisplayLines: number;
  completedExpandedDisplayLines: number;
  completionDeliveryMaxAttempts: number;
  completionDeliveryRetryBaseMs: number;
  outputDir: string;
  preserveOutputFiles: boolean;
  environmentDenylist: string[];
  defaultWaitForBackgroundCompletion: boolean;
  defaultWaitAfterForegroundTimeout: boolean;
  enabledTmuxActions: TmuxAction[];
  systemPrompt: boolean;
  statusbarEnabled: boolean;
  adoptionPolicy: 'off' | 'same-pi-session';
  adoptionScanTimeoutMs: number;
  adoptPolling: boolean;
  durableOutputDir: string;
  interactiveInputEnabled: boolean;
  maxInputBytes: number;
  routeUserBash: boolean;
  defaultCompletionDelivery: CompletionDelivery;
  maxConcurrentRuns: number;
  maxArtifactBytesPerRun: number;
  maxArtifactBytesTotal: number;
  maxCompletedRuns: number;
  completedArtifactRetentionSeconds: number;
  resourceScanIntervalSeconds: number;
  quotaPolicy: 'reject-new' | 'cleanup-completed';
  nonGitScope: 'error' | 'cwd';
}

export interface CommandArtifacts {
  commandFile: string;
  scriptFile: string;
  outputFile: string;
  exitCodeFile: string;
  temporaryExitCodeFile: string;
  liveFile: string;
  spoolFile: string;
  cleanupSentinelFile: string;
  rotationMarkerFile: string;
  manifestPath: string;
  streamFile?: string;
}

export interface CommandRun extends CommandArtifacts {
  runId: string;
  completionId: string;
  sessionId: string;
  scope: TmuxWorkspaceScope;
  cwd: string;
  tmuxSession: string;
  windowId?: string;
  command: string;
  displayCommand: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  mode: 'foreground' | 'background';
  state: ManagedRunState;
  backgroundReady: boolean;
  gateId?: string;
  awaited: boolean;
  continuationDomain: string;
  completionDelivery: CompletionDelivery;
  deliveryState: CompletionDeliveryState;
  completionDelivered: boolean;
  completionClaimed: boolean;
  completionPromise?: Promise<AgentToolResult<TmuxBashDetails> | undefined>;
  completionRetryTimer?: ReturnType<typeof setTimeout>;
  completionDeliveryFailures: number;
  completionDeliveryFailed: boolean;
  killed: boolean;
  adopted: boolean;
  outputWasRotated: boolean;
  reservationPath?: string;
  polling?: { intervalSeconds: number; lines: number };
}

export interface Poller {
  key: string;
  timer: ReturnType<typeof setInterval>;
  runId: string;
  intervalSeconds: number;
  lines: number;
  lastOutput: string;
}

export interface TmuxBashRuntimeState {
  runDir: string | null;
  commands: Map<string, CommandRun>;
  watcher: FSWatcher | null;
  completionMonitor: ReturnType<typeof setInterval> | null;
  pollers: Map<string, Poller>;
  gateController: ContinuationGateController;
  clearStatusProvider?: () => void;
  statusContext: ExtensionContext | null;
  currentScope?: TmuxWorkspaceScope;
  disposed: boolean;
}

export interface TmuxBashDetails extends BashToolDetails {
  runId: string;
  completionId: string;
  windowId?: string;
  tmuxSession: string;
  command: string;
  outputFile: string;
  exitCode?: number;
  state: 'running' | 'completed' | 'failed' | 'killed' | 'orphaned';
  background: boolean;
  awaited: boolean;
  durationMs: number;
  completionDelivery: CompletionDelivery;
  adopted: boolean;
  outputWasRotated: boolean;
}

interface ResourceUsageDetails {
  artifactBytes: number;
  artifactLimitBytes: number;
  activeRuns: number;
  reservations: number;
  concurrentRunLimit: number;
  completedRuns: number;
  completedRunLimit: number;
}

export interface TmuxToolDetails {
  action: TmuxAction;
  attach?: { binary: string; args: string[]; display: string; insideTmux: boolean };
  usage?: ResourceUsageDetails;
  cleanup?: Array<{ runId: string; ageMs: number; bytes: number; state: string }>;
  cleanupSummary?: { candidateCount: number; reclaimableBytes: number; truncated: boolean };
  runs: Array<{
    runId: string;
    completionId: string;
    windowId?: string;
    command: string;
    state: 'running' | 'completed' | 'failed' | 'killed' | 'orphaned';
    background: boolean;
    awaited: boolean;
    polling: boolean;
    ageMs: number;
    outputFile: string;
    completionDelivery: CompletionDelivery;
    adopted: boolean;
    outputWasRotated: boolean;
  }>;
}
