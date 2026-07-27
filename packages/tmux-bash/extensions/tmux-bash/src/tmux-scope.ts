import {
  deriveTmuxSession,
  deriveWindowName,
  resolveTmuxWorkspaceScope,
  shortHash,
  type TmuxWorkspaceScope,
} from '@aliaksei-raketski/pi-tmux-bash-core';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { TmuxBashConfig } from './types.js';

const execFileAsync = promisify(execFile);

async function resolveGitRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 5_000,
      signal,
    });
    return stdout.trim() || undefined;
  } catch {
    if (signal?.aborted) throw cancelledError();
    return undefined;
  }
}

export async function resolveWorkspaceScope(
  config: Pick<TmuxBashConfig, 'nonGitScope'>,
  cwd: string,
  signal?: AbortSignal,
): Promise<TmuxWorkspaceScope> {
  return resolveTmuxWorkspaceScope(
    cwd,
    { resolveGitRoot, realpath },
    { nonGitScope: config.nonGitScope, signal },
  );
}

function cancelledError(): Error {
  const error = new Error('tmux bash command was cancelled.');
  error.name = 'AbortError';
  return error;
}

export { deriveTmuxSession, deriveWindowName, shortHash, type TmuxWorkspaceScope };
