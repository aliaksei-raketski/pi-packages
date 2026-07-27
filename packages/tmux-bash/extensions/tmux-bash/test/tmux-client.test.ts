import {
  managedWindowMetadataEntries,
  shortHash,
  TMUX_BASH_METADATA_KEYS,
  TMUX_BASH_OWNERSHIP_MARKER,
  type ManagedWindowMetadata,
} from '@aliaksei-raketski/pi-tmux-bash-core';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_TMUX_BASH_CONFIG } from '../src/config.js';
import { validateInteractiveKey, validateLiteralInput } from '../src/interactive-input.js';
import { TmuxClient, type TmuxExecutor } from '../src/tmux-client.js';

function ok(stdout = '') {
  return { stdout, stderr: '', code: 0 };
}

const metadata: ManagedWindowMetadata = {
  owner: TMUX_BASH_OWNERSHIP_MARKER,
  scope: { kind: 'git-root', root: '/tmp/repo', hash: shortHash('/tmp/repo') },
  piSessionId: 'session-1',
  runId: 'run-12345678',
  manifestPath: '/tmp/artifacts/run-12345678.manifest.json',
  completionId: 'completion-12345678',
  completionDelivery: 'model',
  startedAt: 123,
  displayCommand: 'printf untrusted; rm -rf /',
};

describe('interactive input validation', () => {
  it('is opt-in and enforces UTF-8 byte bounds, NUL rejection, and the fixed key allowlist', () => {
    expect(() => validateLiteralInput(DEFAULT_TMUX_BASH_CONFIG, 'text')).toThrow('disabled');
    const config = {
      ...DEFAULT_TMUX_BASH_CONFIG,
      interactiveInputEnabled: true,
      maxInputBytes: 4,
    };
    expect(() => validateLiteralInput(config, 'λ')).not.toThrow();
    expect(() => validateLiteralInput(config, 'λλλ')).toThrow('exceeds 4 bytes');
    expect(() => validateLiteralInput(config, 'a\0b')).toThrow('NUL');
    for (const key of ['enter', 'escape', 'ctrl-c', 'ctrl-d'] as const) {
      expect(() => validateInteractiveKey(config, key)).not.toThrow();
    }
    expect(() => validateInteractiveKey(config, 'tab' as never)).toThrow('Unsupported');
  });
});

describe('TmuxClient', () => {
  it('uses argument arrays, stable IDs, and complete window metadata', async () => {
    const execute = vi.fn<TmuxExecutor>(async (_binary, args) => {
      if (args[0] === 'new-window') return ok('@123\n');
      return ok();
    });
    const client = new TmuxClient('/usr/bin/tmux', execute);
    const windowId = await client.createWindow({
      sessionName: 'pi-session',
      windowName: 'build-run',
      cwd: "/tmp/repo with 'quote",
      scriptFile: "/tmp/run with 'quote.sh",
      metadata,
    });

    expect(windowId).toBe('@123');
    const newWindow = execute.mock.calls.find((call) => call[1][0] === 'new-window');
    expect(newWindow?.[1]).toContain("exec '/tmp/run with '\"'\"'quote.sh'");
    expect(execute).toHaveBeenCalledWith(
      '/usr/bin/tmux',
      expect.arrayContaining([
        'set-option',
        '-w',
        '-t',
        '@123',
        TMUX_BASH_METADATA_KEYS.runId,
        metadata.runId,
      ]),
      undefined,
    );
  });

  it('validates every ownership field instead of trusting a reused stable ID', async () => {
    const values = new Map(managedWindowMetadataEntries(metadata));
    const execute = vi.fn<TmuxExecutor>(async (_binary, args) => {
      if (args[0] === 'display-message') return ok('@123\n');
      if (args[0] === 'show-options') {
        const value = values.get(args.at(-1) ?? '');
        return value === undefined ? { stdout: '', stderr: 'missing', code: 1 } : ok(`${value}\n`);
      }
      return ok();
    });
    const client = new TmuxClient('tmux', execute);

    await expect(client.isOwnedWindow('@123', metadata)).resolves.toBe(true);
    values.set(TMUX_BASH_METADATA_KEYS.runId, 'unrelated-run');
    await expect(client.isOwnedWindow('@123', metadata)).resolves.toBe(false);
    values.delete(TMUX_BASH_METADATA_KEYS.owner);
    await expect(client.isOwnedWindow('@123', metadata)).resolves.toBe(false);
  });

  it('reports remain-on-exit panes as dead', async () => {
    const execute = vi.fn<TmuxExecutor>(async (_binary, args) =>
      ok(args.at(-1) === '#{pane_dead}' ? '1\n' : ''),
    );
    const client = new TmuxClient('tmux', execute);

    await expect(client.isPaneDead('@123')).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith('tmux', [
      'display-message',
      '-p',
      '-t',
      '@123',
      '#{pane_dead}',
    ]);
  });

  it('sends literal input separately from fixed control keys and deletes its buffer', async () => {
    const execute = vi.fn<TmuxExecutor>(async () => ok());
    const client = new TmuxClient('tmux', execute);
    await client.sendLiteralInput('@123', 'without submit', false);
    expect(execute.mock.calls.some((call) => call[1].includes('Enter'))).toBe(false);
    execute.mockClear();
    await client.sendLiteralInput('@123', '$(touch nope)\nUTF-8: λ', true);
    const setBuffer = execute.mock.calls.find((call) => call[1][0] === 'set-buffer');
    expect(setBuffer?.[1].at(-1)).toBe('$(touch nope)\nUTF-8: λ');
    expect(execute.mock.calls.some((call) => call[1][0] === 'paste-buffer')).toBe(true);
    expect(execute.mock.calls.some((call) => call[1].includes('Enter'))).toBe(true);
    expect(execute.mock.calls.some((call) => call[1][0] === 'delete-buffer')).toBe(true);
    await client.sendKey('@123', 'escape');
    await client.sendKey('@123', 'ctrl-c');
    await client.sendKey('@123', 'ctrl-d');
    expect(execute.mock.calls.some((call) => call[1].includes('Escape'))).toBe(true);
    expect(execute.mock.calls.some((call) => call[1].includes('C-c'))).toBe(true);
    expect(execute.mock.calls.some((call) => call[1].includes('C-d'))).toBe(true);
  });

  it('revalidates ownership after preparing literal input and still removes its buffer', async () => {
    const execute = vi.fn<TmuxExecutor>(async () => ok());
    const client = new TmuxClient('tmux', execute);
    await expect(
      client.sendLiteralInput('@123', 'private input', true, async () =>
        Promise.reject(new Error('ownership changed')),
      ),
    ).rejects.toThrow('ownership changed');
    expect(execute.mock.calls.some((call) => call[1][0] === 'paste-buffer')).toBe(false);
    expect(execute.mock.calls.some((call) => call[1][0] === 'delete-buffer')).toBe(true);
  });

  it('rejects unstable targets before invoking tmux', async () => {
    const execute = vi.fn<TmuxExecutor>(async () => ok());
    const client = new TmuxClient('tmux', execute);
    await expect(client.killWindow('1')).rejects.toThrow(/Invalid tmux window ID/);
    expect(execute).not.toHaveBeenCalled();
  });
});
