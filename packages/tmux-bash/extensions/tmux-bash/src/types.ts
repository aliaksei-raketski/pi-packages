import type {
  AgentToolResult,
  BashToolDetails,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { ContinuationGateController } from '@aliaksei-raketski/pi-continuation-gate-protocol';
import type { FSWatcher } from 'node:fs';

export const TMUX_BASH_STATUS_KEY = 'tmux-bash';
export const TMUX_BASH_STATUS_SOURCE = 'pi-tmux-bash';
export const TMUX_BASH_GATE_SOURCE = 'pi-tmux-bash';
export const TMUX_BASH_COMPLETION_MESSAGE = 'tmux-bash-completion';

export type TmuxAction =
  | 'list'
  | 'peek'
  | 'kill'
  | 'poll'
  | 'unpoll'
  | 'list-polls'
  | 'await'
  | 'unawait';

export interface TmuxBashConfig {
  bashToolName: string;
  tmuxToolName: string;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  defaultTimeoutAction: 'background' | 'kill';
  foregroundUpdateIntervalMs: number;
  tmuxBinary: string;
  tmuxSessionScope: 'global' | 'git-root';
  globalTmuxSessionName: string;
  gitRootTmuxSessionNameTemplate: string;
  tmuxWindowScope: 'pi-session' | 'git-root' | 'all';
  tmuxWindowNameTemplate: string;
  maxTmuxWindowNameLength: number;
  autoCloseWindowsOnCompletion: boolean;
  defaultPollIntervalSeconds: number;
  minimumModelPollIntervalSeconds: number;
  pollDelivery: 'model' | 'display';
  maxOutputBytes: number;
  foregroundContextLines: number;
  completionContextLines: number;
  pollContextLines: number;
  peekContextLines: number;
  outputDir: string;
  preserveOutputFiles: boolean;
  environmentDenylist: string[];
  defaultWaitForBackgroundCompletion: boolean;
  defaultWaitAfterForegroundTimeout: boolean;
  enabledTmuxActions: TmuxAction[];
  systemPrompt: boolean;
  statusbarEnabled: boolean;
}

export interface CommandArtifacts {
  commandFile: string;
  scriptFile: string;
  outputFile: string;
  exitCodeFile: string;
  temporaryExitCodeFile: string;
}

export interface CommandRun extends CommandArtifacts {
  runId: string;
  sessionId: string;
  gitRoot: string;
  tmuxSession: string;
  windowId?: string;
  command: string;
  displayCommand: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  mode: 'foreground' | 'background';
  backgroundReady: boolean;
  gateId?: string;
  completionDelivered: boolean;
  completionClaimed: boolean;
  completionPromise?: Promise<AgentToolResult<TmuxBashDetails> | undefined>;
  completionRetryTimer?: ReturnType<typeof setTimeout>;
  completionDeliveryFailures: number;
  killed: boolean;
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
  disposed: boolean;
}

export interface TmuxBashDetails extends BashToolDetails {
  runId: string;
  windowId?: string;
  tmuxSession: string;
  command: string;
  outputFile: string;
  exitCode?: number;
  state: 'running' | 'completed' | 'failed' | 'killed';
  background: boolean;
  awaited: boolean;
  durationMs: number;
}

export interface TmuxToolDetails {
  action: TmuxAction;
  runs: Array<{
    runId: string;
    windowId?: string;
    command: string;
    state: 'running' | 'completed' | 'failed' | 'killed';
    background: boolean;
    awaited: boolean;
    polling: boolean;
    ageMs: number;
    outputFile: string;
  }>;
}
