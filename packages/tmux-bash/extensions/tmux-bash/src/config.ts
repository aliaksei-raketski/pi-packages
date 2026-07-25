import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse, type ParseError, printParseErrorCode } from 'jsonc-parser';

import type { TmuxAction, TmuxBashConfig } from './types.js';

const ALL_ACTIONS: readonly TmuxAction[] = [
  'list',
  'peek',
  'kill',
  'poll',
  'unpoll',
  'list-polls',
  'await',
  'unawait',
];

export const DEFAULT_TMUX_BASH_CONFIG: Readonly<TmuxBashConfig> = {
  bashToolName: 'bash',
  tmuxToolName: 'tmux',
  defaultTimeoutSeconds: 120,
  maxTimeoutSeconds: 86_400,
  defaultTimeoutAction: 'background',
  foregroundUpdateIntervalMs: 1_000,
  tmuxBinary: 'tmux',
  tmuxSessionScope: 'git-root',
  globalTmuxSessionName: 'pi-tmux-bash',
  gitRootTmuxSessionNameTemplate: 'pi-{gitHash}',
  tmuxWindowScope: 'pi-session',
  tmuxWindowNameTemplate: '{name}-{runId}',
  maxTmuxWindowNameLength: 64,
  autoCloseWindowsOnCompletion: true,
  defaultPollIntervalSeconds: 30,
  minimumModelPollIntervalSeconds: 15,
  pollDelivery: 'display',
  maxOutputBytes: 50 * 1024,
  foregroundContextLines: 2_000,
  completionContextLines: 200,
  pollContextLines: 80,
  peekContextLines: 200,
  outputDir: '',
  preserveOutputFiles: false,
  environmentDenylist: ['TMUX', 'TMUX_PANE', 'PWD', 'OLDPWD', 'SHLVL', '_'],
  defaultWaitForBackgroundCompletion: false,
  defaultWaitAfterForegroundTimeout: true,
  enabledTmuxActions: [...ALL_ACTIONS],
  systemPrompt: true,
  statusbarEnabled: true,
};

export interface LoadTmuxBashConfigOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
}

export function loadTmuxBashConfig(options: LoadTmuxBashConfigOptions = {}): TmuxBashConfig {
  const env = options.env ?? process.env;
  const configPath =
    options.path ?? env.PI_TMUX_BASH_CONFIG ?? join(getAgentDir(), 'tmux-bash.jsonc');
  let input: unknown = {};

  try {
    const errors: ParseError[] = [];
    input = parse(readFileSync(configPath, 'utf8'), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0) {
      const first = errors[0];
      throw new Error(`${printParseErrorCode(first?.error ?? 0)} at byte ${first?.offset ?? 0}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Invalid tmux-bash config ${configPath}: ${errorMessage(error)}`);
    }
  }

  if (!isRecord(input)) {
    throw new Error(`Invalid tmux-bash config ${configPath}: expected a JSON object.`);
  }

  return validateTmuxBashConfig({ ...DEFAULT_TMUX_BASH_CONFIG, ...input });
}

export function validateTmuxBashConfig(input: Record<string, unknown>): TmuxBashConfig {
  const config = input as unknown as TmuxBashConfig;
  requireToolName(config.bashToolName, 'bashToolName');
  requireToolName(config.tmuxToolName, 'tmuxToolName');
  requireInteger(config.defaultTimeoutSeconds, 'defaultTimeoutSeconds', 1);
  requireInteger(config.maxTimeoutSeconds, 'maxTimeoutSeconds', config.defaultTimeoutSeconds);
  requireEnum(config.defaultTimeoutAction, 'defaultTimeoutAction', ['background', 'kill']);
  requireInteger(config.foregroundUpdateIntervalMs, 'foregroundUpdateIntervalMs', 50);
  requireBinary(config.tmuxBinary);
  requireEnum(config.tmuxSessionScope, 'tmuxSessionScope', ['global', 'git-root']);
  requireTemplate(config.globalTmuxSessionName, 'globalTmuxSessionName');
  requireTemplate(config.gitRootTmuxSessionNameTemplate, 'gitRootTmuxSessionNameTemplate');
  requireEnum(config.tmuxWindowScope, 'tmuxWindowScope', ['pi-session', 'git-root', 'all']);
  requireTemplate(config.tmuxWindowNameTemplate, 'tmuxWindowNameTemplate');
  requireInteger(config.maxTmuxWindowNameLength, 'maxTmuxWindowNameLength', 8, 200);
  requireBoolean(config.autoCloseWindowsOnCompletion, 'autoCloseWindowsOnCompletion');
  requireInteger(config.defaultPollIntervalSeconds, 'defaultPollIntervalSeconds', 1);
  requireInteger(config.minimumModelPollIntervalSeconds, 'minimumModelPollIntervalSeconds', 1);
  requireEnum(config.pollDelivery, 'pollDelivery', ['model', 'display']);
  requireInteger(config.maxOutputBytes, 'maxOutputBytes', 1_024, 10 * 1024 * 1024);
  for (const key of [
    'foregroundContextLines',
    'completionContextLines',
    'pollContextLines',
    'peekContextLines',
  ] as const) {
    requireInteger(config[key], key, 1, 10_000);
  }
  if (typeof config.outputDir !== 'string' || config.outputDir.includes('\0')) {
    throw new Error('tmux-bash config outputDir must be a string without NUL bytes.');
  }
  if (config.outputDir && !isAbsolute(config.outputDir)) {
    throw new Error('tmux-bash config outputDir must be empty or absolute.');
  }
  requireBoolean(config.preserveOutputFiles, 'preserveOutputFiles');
  if (!Array.isArray(config.environmentDenylist) || !config.environmentDenylist.every(isEnvName)) {
    throw new Error(
      'tmux-bash config environmentDenylist must contain environment variable names.',
    );
  }
  requireBoolean(config.defaultWaitForBackgroundCompletion, 'defaultWaitForBackgroundCompletion');
  requireBoolean(config.defaultWaitAfterForegroundTimeout, 'defaultWaitAfterForegroundTimeout');
  if (
    !Array.isArray(config.enabledTmuxActions) ||
    config.enabledTmuxActions.length === 0 ||
    !config.enabledTmuxActions.every((action) => ALL_ACTIONS.includes(action))
  ) {
    throw new Error(`tmux-bash config enabledTmuxActions must use: ${ALL_ACTIONS.join(', ')}.`);
  }
  requireBoolean(config.systemPrompt, 'systemPrompt');
  requireBoolean(config.statusbarEnabled, 'statusbarEnabled');

  return {
    ...config,
    environmentDenylist: [...new Set(config.environmentDenylist)],
    enabledTmuxActions: [...new Set(config.enabledTmuxActions)],
  };
}

export function clampTimeout(config: TmuxBashConfig, timeout?: number): number {
  if (timeout === undefined || !Number.isFinite(timeout)) return config.defaultTimeoutSeconds;
  return Math.min(config.maxTimeoutSeconds, Math.max(1, Math.floor(timeout)));
}

export function clampPollInterval(config: TmuxBashConfig, interval?: number): number {
  const requested = interval ?? config.defaultPollIntervalSeconds;
  const minimum = config.pollDelivery === 'model' ? config.minimumModelPollIntervalSeconds : 1;
  return Math.min(config.maxTimeoutSeconds, Math.max(minimum, Math.floor(requested)));
}

function requireToolName(value: unknown, key: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`tmux-bash config ${key} must be a valid tool name.`);
  }
}

function requireTemplate(value: unknown, key: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`tmux-bash config ${key} must be a non-empty string without NUL bytes.`);
  }
}

function requireBinary(value: unknown): asserts value is string {
  requireTemplate(value, 'tmuxBinary');
  if (value.includes('/') && !isAbsolute(value)) {
    throw new Error('tmux-bash config tmuxBinary must be a command name or absolute path.');
  }
}

function requireInteger(
  value: unknown,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`tmux-bash config ${key} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function requireBoolean(value: unknown, key: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`tmux-bash config ${key} must be boolean.`);
}

function requireEnum<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[],
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`tmux-bash config ${key} must be one of: ${allowed.join(', ')}.`);
  }
}

function isEnvName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
