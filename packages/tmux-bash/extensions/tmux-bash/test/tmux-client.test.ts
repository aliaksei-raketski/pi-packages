import { describe, expect, it, vi } from 'vitest';

import { TmuxClient, type TmuxExecutor } from '../src/tmux-client.js';

function ok(stdout = '') {
  return { stdout, stderr: '', code: 0 };
}

describe('TmuxClient', () => {
  it('uses argument arrays, stable IDs, and window metadata', async () => {
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
      metadata: {
        version: 'v1',
        gitRoot: '/tmp/repo',
        piSessionId: 'session-1',
        runId: 'run-1',
        startedAt: 123,
        outputFile: '/tmp/run.out',
        displayCommand: 'printf untrusted; rm -rf /',
      },
    });

    expect(windowId).toBe('@123');
    const newWindow = execute.mock.calls.find((call) => call[1][0] === 'new-window');
    expect(newWindow?.[1]).toContain("exec '/tmp/run with '\"'\"'quote.sh'");
    expect(execute).toHaveBeenCalledWith(
      '/usr/bin/tmux',
      expect.arrayContaining(['set-option', '-w', '-t', '@123', '@pi_tmux_bash_run_id', 'run-1']),
    );
  });

  it('validates all ownership fields instead of trusting a reused stable ID', async () => {
    const metadata = new Map([
      ['@pi_tmux_bash', 'v1'],
      ['@pi_tmux_bash_git_root', '/repo'],
      ['@pi_tmux_bash_session_id', 'session-1'],
      ['@pi_tmux_bash_run_id', 'run-1'],
    ]);
    const execute = vi.fn<TmuxExecutor>(async (_binary, args) => {
      if (args[0] === 'display-message') return ok('@123\n');
      if (args[0] === 'show-options') return ok(`${metadata.get(args.at(-1) ?? '') ?? ''}\n`);
      return ok();
    });
    const client = new TmuxClient('tmux', execute);
    const expected = {
      version: 'v1',
      gitRoot: '/repo',
      piSessionId: 'session-1',
      runId: 'run-1',
    };

    await expect(client.isOwnedWindow('@123', expected)).resolves.toBe(true);
    metadata.set('@pi_tmux_bash_run_id', 'unrelated-run');
    await expect(client.isOwnedWindow('@123', expected)).resolves.toBe(false);
    metadata.delete('@pi_tmux_bash');
    await expect(client.isOwnedWindow('@123', expected)).resolves.toBe(false);
  });

  it('rejects unstable targets before invoking tmux', async () => {
    const execute = vi.fn<TmuxExecutor>(async () => ok());
    const client = new TmuxClient('tmux', execute);
    await expect(client.killWindow('1')).rejects.toThrow(/Invalid tmux window ID/);
    expect(execute).not.toHaveBeenCalled();
  });
});
