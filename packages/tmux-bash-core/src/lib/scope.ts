import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export interface TmuxWorkspaceScope {
  kind: 'git-root' | 'cwd';
  root: string;
  hash: string;
  displayName: string;
}

export interface TmuxWorkspaceScopeHost {
  resolveGitRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined>;
  realpath(path: string): Promise<string>;
}

export interface ResolveTmuxWorkspaceScopeOptions {
  nonGitScope?: 'error' | 'cwd';
  signal?: AbortSignal;
}

export async function resolveTmuxWorkspaceScope(
  cwd: string,
  host: TmuxWorkspaceScopeHost,
  options: ResolveTmuxWorkspaceScopeOptions = {},
): Promise<TmuxWorkspaceScope> {
  assertSafePath(cwd, 'cwd');
  throwIfAborted(options.signal);

  const gitRoot = await host.resolveGitRoot(cwd, options.signal);
  throwIfAborted(options.signal);
  if (gitRoot !== undefined) {
    assertSafePath(gitRoot, 'Git root');
    return createScope('git-root', await canonicalize(gitRoot, host));
  }

  if ((options.nonGitScope ?? 'error') !== 'cwd') {
    throw new Error(`tmux-bash requires a Git worktree; no Git root found for ${cwd}.`);
  }
  return createScope('cwd', await canonicalize(cwd, host));
}

export function sameTmuxWorkspaceScope(
  left: Pick<TmuxWorkspaceScope, 'kind' | 'root' | 'hash'>,
  right: Pick<TmuxWorkspaceScope, 'kind' | 'root' | 'hash'>,
): boolean {
  return left.kind === right.kind && left.root === right.root && left.hash === right.hash;
}

export function shortHash(value: string, length = 10): string {
  if (!Number.isInteger(length) || length < 1 || length > 64) {
    throw new Error('Hash length must be an integer from 1 to 64.');
  }
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function sanitizeTmuxName(value: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new Error('Tmux name maximum length must be a positive integer.');
  }
  const normalized = value
    .replace(/[.:\s/\\]+/g, '-')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, maxLength);
  return normalized || 'pi-command';
}

export interface TmuxNameConfig {
  tmuxSessionScope: 'global' | 'workspace';
  globalTmuxSessionName: string;
  gitRootTmuxSessionNameTemplate: string;
  cwdTmuxSessionNameTemplate: string;
  tmuxWindowNameTemplate: string;
  maxTmuxWindowNameLength: number;
}

export function deriveTmuxSession(config: TmuxNameConfig, scope: TmuxWorkspaceScope): string {
  if (config.tmuxSessionScope === 'global') {
    return sanitizeTmuxName(config.globalTmuxSessionName, 80);
  }
  const template =
    scope.kind === 'git-root'
      ? config.gitRootTmuxSessionNameTemplate
      : config.cwdTmuxSessionNameTemplate;
  return sanitizeTmuxName(
    applyTemplate(template, {
      gitHash: scope.hash,
      gitName: scope.displayName,
      scopeHash: scope.hash,
      scopeName: scope.displayName,
    }),
    80,
  );
}

export function deriveWindowName(
  config: Pick<TmuxNameConfig, 'tmuxWindowNameTemplate' | 'maxTmuxWindowNameLength'>,
  input: { name?: string; runId: string; command: string },
): string {
  const raw = applyTemplate(config.tmuxWindowNameTemplate, {
    name: input.name?.trim() || firstCommandWord(input.command),
    runId: input.runId.slice(0, 8),
  });
  return sanitizeTmuxName(raw, config.maxTmuxWindowNameLength);
}

function createScope(kind: TmuxWorkspaceScope['kind'], root: string): TmuxWorkspaceScope {
  return {
    kind,
    root,
    hash: shortHash(root),
    displayName: basename(root) || 'workspace',
  };
}

async function canonicalize(path: string, host: TmuxWorkspaceScopeHost): Promise<string> {
  const canonical = await host.realpath(path);
  assertSafePath(canonical, 'canonical workspace path');
  return canonical;
}

function assertSafePath(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`Invalid ${label}: expected a non-empty path without NUL bytes.`);
  }
}

function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (match, key: string) => values[key] ?? match);
}

function firstCommandWord(command: string): string {
  return command.trim().split(/\s+/)[0]?.slice(0, 32) || 'command';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('tmux-bash scope resolution was cancelled.');
  error.name = 'AbortError';
  throw error;
}
