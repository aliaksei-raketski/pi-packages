import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { shellQuote } from './command-artifacts.js';

const execFileAsync = promisify(execFile);

export interface TmuxExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface TmuxExecutor {
  (binary: string, args: string[], signal?: AbortSignal): Promise<TmuxExecResult>;
}

export interface ManagedWindowIdentity {
  version: string;
  gitRoot: string;
  piSessionId: string;
  runId: string;
}

export interface ManagedWindowMetadata extends ManagedWindowIdentity {
  startedAt: number;
  outputFile: string;
  displayCommand: string;
}

export class TmuxClient {
  constructor(
    private readonly binary: string,
    private readonly executeProcess: TmuxExecutor = executeTmux,
  ) {}

  async checkAvailable(signal?: AbortSignal): Promise<void> {
    const result = await this.executeProcess(this.binary, ['-V'], signal);
    if (result.code !== 0) throw new Error(`tmux is unavailable: ${result.stderr.trim()}`);
  }

  async ensureSession(sessionName: string, signal?: AbortSignal): Promise<void> {
    const exists = await this.executeProcess(
      this.binary,
      ['has-session', '-t', sessionName],
      signal,
    );
    if (exists.code !== 0) {
      const created = await this.executeProcess(
        this.binary,
        ['new-session', '-d', '-s', sessionName, '-n', 'pi-idle'],
        signal,
      );
      if (created.code !== 0) {
        const raced = await this.executeProcess(
          this.binary,
          ['has-session', '-t', sessionName],
          signal,
        );
        if (raced.code !== 0) throw tmuxError('create session', created);
      }
    }
    const remain = await this.executeProcess(
      this.binary,
      ['set-window-option', '-g', '-t', sessionName, 'remain-on-exit', 'on'],
      signal,
    );
    if (remain.code !== 0) throw tmuxError('configure session', remain);
  }

  async createWindow(input: {
    sessionName: string;
    windowName: string;
    cwd: string;
    scriptFile: string;
    metadata: ManagedWindowMetadata;
    signal?: AbortSignal;
  }): Promise<string> {
    await this.ensureSession(input.sessionName, input.signal);
    throwIfAborted(input.signal);
    // Let this short operation return its stable ID even if cancellation arrives mid-call,
    // so a window created by tmux can always be cleaned up deterministically.
    const result = await this.executeProcess(this.binary, [
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{window_id}',
      '-t',
      input.sessionName,
      '-n',
      input.windowName,
      '-c',
      input.cwd,
      `exec ${shellQuote(input.scriptFile)}`,
    ]);
    if (result.code !== 0) throw tmuxError('create window', result);
    const windowId = result.stdout.trim();
    if (!/^@\d+$/.test(windowId)) {
      throw new Error(`tmux returned an invalid stable window ID: ${windowId || '(empty)'}.`);
    }

    try {
      throwIfAborted(input.signal);
      await this.setMetadata(windowId, input.metadata, input.signal);
    } catch (error) {
      await this.killWindow(windowId).catch(() => undefined);
      throw error;
    }
    return windowId;
  }

  async setMetadata(
    windowId: string,
    metadata: ManagedWindowMetadata,
    signal?: AbortSignal,
  ): Promise<void> {
    const entries: Array<[string, string]> = [
      ['@pi_tmux_bash', metadata.version],
      ['@pi_tmux_bash_git_root', metadata.gitRoot],
      ['@pi_tmux_bash_session_id', metadata.piSessionId],
      ['@pi_tmux_bash_run_id', metadata.runId],
      ['@pi_tmux_bash_started_at', String(metadata.startedAt)],
      ['@pi_tmux_bash_output_file', metadata.outputFile],
      ['@pi_tmux_bash_command', metadata.displayCommand],
    ];
    for (const [key, value] of entries) {
      const result = await this.executeProcess(
        this.binary,
        ['set-option', '-w', '-t', windowId, key, value],
        signal,
      );
      if (result.code !== 0) throw tmuxError(`tag window ${windowId}`, result);
    }
  }

  async killWindow(windowId: string): Promise<void> {
    assertWindowId(windowId);
    const result = await this.executeProcess(this.binary, ['kill-window', '-t', windowId]);
    if (result.code !== 0 && !/can't find window|no server running/i.test(result.stderr)) {
      throw tmuxError(`kill window ${windowId}`, result);
    }
  }

  async capturePane(windowId: string, lines: number): Promise<string> {
    assertWindowId(windowId);
    const result = await this.executeProcess(this.binary, [
      'capture-pane',
      '-p',
      '-J',
      '-S',
      `-${Math.max(1, Math.floor(lines))}`,
      '-t',
      windowId,
    ]);
    if (result.code !== 0) throw tmuxError(`capture window ${windowId}`, result);
    return result.stdout;
  }

  async hasWindow(windowId: string): Promise<boolean> {
    assertWindowId(windowId);
    const result = await this.executeProcess(this.binary, [
      'display-message',
      '-p',
      '-t',
      windowId,
      '#{window_id}',
    ]);
    return result.code === 0 && result.stdout.trim() === windowId;
  }

  async isOwnedWindow(windowId: string, expected: ManagedWindowIdentity): Promise<boolean> {
    if (!(await this.hasWindow(windowId))) return false;
    const options: Array<[keyof ManagedWindowIdentity, string]> = [
      ['version', '@pi_tmux_bash'],
      ['gitRoot', '@pi_tmux_bash_git_root'],
      ['piSessionId', '@pi_tmux_bash_session_id'],
      ['runId', '@pi_tmux_bash_run_id'],
    ];
    for (const [field, option] of options) {
      const result = await this.executeProcess(this.binary, [
        'show-options',
        '-w',
        '-v',
        '-t',
        windowId,
        option,
      ]);
      if (result.code !== 0 || result.stdout.replace(/\r?\n$/, '') !== expected[field])
        return false;
    }
    return true;
  }

  attachHint(
    sessionName: string,
    windowId: string,
    insideTmux = Boolean(process.env.TMUX),
  ): string {
    assertWindowId(windowId);
    return insideTmux
      ? `tmux select-window -t ${windowId}`
      : `tmux attach-session -t ${shellQuote(sessionName)} \\; select-window -t ${windowId}`;
  }
}

export async function executeTmux(
  binary: string,
  args: string[],
  signal?: AbortSignal,
): Promise<TmuxExecResult> {
  try {
    const result = await execFileAsync(binary, args, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      signal,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    if (signal?.aborted) throw abortError();
    if (failed.code === 'ENOENT') {
      throw new Error(`tmux binary not found: ${binary}. Install tmux or configure tmuxBinary.`);
    }
    return {
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? failed.message,
      code: typeof failed.code === 'number' ? failed.code : 1,
    };
  }
}

export function assertWindowId(windowId: string): void {
  if (!/^@\d+$/.test(windowId)) throw new Error(`Invalid tmux window ID: ${windowId}.`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error('tmux bash command was cancelled.');
  error.name = 'AbortError';
  return error;
}

function tmuxError(operation: string, result: TmuxExecResult): Error {
  return new Error(`Failed to ${operation}: ${result.stderr.trim() || `tmux exit ${result.code}`}`);
}
