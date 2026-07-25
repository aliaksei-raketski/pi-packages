import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { TmuxBashConfig } from './types.js';

const execFileAsync = promisify(execFile);

export async function resolveGitRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 5_000,
      signal,
    });
    const root = stdout.trim();
    if (!root) throw new Error('Git returned an empty root.');
    return root;
  } catch {
    if (signal?.aborted) throw cancelledError();
    throw new Error(`tmux-bash requires a Git worktree; no Git root found for ${cwd}.`);
  }
}

function cancelledError(): Error {
  const error = new Error('tmux bash command was cancelled.');
  error.name = 'AbortError';
  return error;
}

export function shortHash(value: string, length = 10): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function deriveTmuxSession(config: TmuxBashConfig, gitRoot: string): string {
  const raw =
    config.tmuxSessionScope === 'global'
      ? config.globalTmuxSessionName
      : applyTemplate(config.gitRootTmuxSessionNameTemplate, {
          gitHash: shortHash(gitRoot),
          gitName: gitRoot.split('/').filter(Boolean).at(-1) ?? 'repo',
        });
  return sanitizeTmuxName(raw, 80);
}

export function deriveWindowName(
  config: TmuxBashConfig,
  input: { name?: string; runId: string; command: string },
): string {
  const raw = applyTemplate(config.tmuxWindowNameTemplate, {
    name: input.name?.trim() || firstCommandWord(input.command),
    runId: input.runId.slice(0, 8),
  });
  return sanitizeTmuxName(raw, config.maxTmuxWindowNameLength);
}

export function sanitizeTmuxName(value: string, maxLength: number): string {
  const normalized = value
    .replace(/[.:\s/\\]+/g, '-')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, maxLength);
  return normalized || 'pi-command';
}

function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (match, key: string) => values[key] ?? match);
}

function firstCommandWord(command: string): string {
  return command.trim().split(/\s+/)[0]?.slice(0, 32) || 'command';
}
