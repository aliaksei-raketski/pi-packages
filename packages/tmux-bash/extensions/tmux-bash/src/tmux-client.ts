import {
  assertWindowId,
  buildAttachCommand,
  listManagedTmuxWindows,
  managedWindowMetadataEntries,
  parseManagedWindowMetadata,
  sameManagedWindowOwner,
  shellQuote,
  TMUX_BASH_METADATA_KEYS,
  type ListManagedTmuxWindowsOptions,
  type ListedManagedTmuxWindow,
  type ManagedWindowIdentity,
  type ManagedWindowMetadata,
  type StructuredTmuxCommand,
} from '@aliaksei-raketski/pi-tmux-bash-core';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import type { InteractiveKey } from './types.js';

const execFileAsync = promisify(execFile);

interface TmuxExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface TmuxExecutor {
  (binary: string, args: string[], signal?: AbortSignal): Promise<TmuxExecResult>;
}

export type { ManagedWindowIdentity, ManagedWindowMetadata };

export class TmuxClient {
  constructor(
    readonly binary: string,
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
    assertWindowId(windowId);

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
    assertWindowId(windowId);
    for (const [key, value] of managedWindowMetadataEntries(metadata)) {
      const result = await this.executeProcess(
        this.binary,
        ['set-option', '-w', '-t', windowId, key, value],
        signal,
      );
      if (result.code !== 0) throw tmuxError(`tag window ${windowId}`, result);
    }
  }

  async getMetadata(
    windowId: string,
    signal?: AbortSignal,
  ): Promise<ManagedWindowMetadata | undefined> {
    assertWindowId(windowId);
    if (!(await this.hasWindow(windowId))) return undefined;
    const values: Record<string, string | undefined> = {};
    for (const key of Object.values(TMUX_BASH_METADATA_KEYS)) {
      const result = await this.executeProcess(
        this.binary,
        ['show-options', '-w', '-v', '-t', windowId, key],
        signal,
      );
      if (result.code === 0) values[key] = result.stdout.replace(/\r?\n$/, '');
    }
    try {
      return parseManagedWindowMetadata(values);
    } catch {
      return undefined;
    }
  }

  async listManaged(
    options: ListManagedTmuxWindowsOptions = {},
  ): Promise<ListedManagedTmuxWindow[]> {
    return listManagedTmuxWindows(
      (args, signal) => this.executeProcess(this.binary, [...args], signal),
      options,
    );
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
    const actual = await this.getMetadata(windowId);
    return actual !== undefined && sameManagedWindowOwner(actual, expected);
  }

  async sendLiteralInput(
    windowId: string,
    text: string,
    submit: boolean,
    beforePaste?: () => Promise<void>,
  ): Promise<void> {
    assertWindowId(windowId);
    if (text.includes('\0')) throw new Error('Interactive tmux input cannot contain NUL bytes.');
    const bufferName = `pi-tmux-${randomUUID().replaceAll('-', '')}`;
    try {
      const set = await this.executeProcess(this.binary, [
        'set-buffer',
        '-b',
        bufferName,
        '--',
        text,
      ]);
      if (set.code !== 0) throw tmuxError(`prepare input for ${windowId}`, set);
      await beforePaste?.();
      const paste = await this.executeProcess(this.binary, [
        'paste-buffer',
        '-b',
        bufferName,
        '-t',
        windowId,
        '-d',
      ]);
      if (paste.code !== 0) throw tmuxError(`send input to ${windowId}`, paste);
      if (submit) await this.sendKey(windowId, 'enter');
    } finally {
      await this.executeProcess(this.binary, ['delete-buffer', '-b', bufferName]).catch(
        () => undefined,
      );
    }
  }

  async sendKey(windowId: string, key: InteractiveKey): Promise<void> {
    assertWindowId(windowId);
    const token: Record<InteractiveKey, string> = {
      enter: 'Enter',
      escape: 'Escape',
      'ctrl-c': 'C-c',
      'ctrl-d': 'C-d',
    };
    const result = await this.executeProcess(this.binary, [
      'send-keys',
      '-t',
      windowId,
      token[key],
    ]);
    if (result.code !== 0) throw tmuxError(`send key to ${windowId}`, result);
  }

  attachCommand(
    sessionName: string,
    windowId: string,
    insideTmux = Boolean(process.env.TMUX),
  ): StructuredTmuxCommand {
    return buildAttachCommand({
      binary: this.binary,
      sessionName,
      windowId,
      insideTmux,
    });
  }

  attachHint(
    sessionName: string,
    windowId: string,
    insideTmux = Boolean(process.env.TMUX),
  ): string {
    return this.attachCommand(sessionName, windowId, insideTmux).display;
  }
}

async function executeTmux(
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
