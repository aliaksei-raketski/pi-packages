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

  it('rejects unstable targets before invoking tmux', async () => {
    const execute = vi.fn<TmuxExecutor>(async () => ok());
    const client = new TmuxClient('tmux', execute);
    await expect(client.killWindow('1')).rejects.toThrow(/Invalid tmux window ID/);
    expect(execute).not.toHaveBeenCalled();
  });
});
