import { createContinuationGateController } from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createCommandArtifacts } from '../src/command-artifacts.js';
import { DEFAULT_TMUX_BASH_CONFIG } from '../src/config.js';
import { readExitCode } from '../src/output.js';
import { TmuxBashRuntime } from '../src/runtime.js';
import { TmuxClient } from '../src/tmux-client.js';

const execFileAsync = promisify(execFile);
const tmuxAvailable = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const suite = tmuxAvailable ? describe : describe.skip;
const sessionName = `pi-tmux-test-${process.pid}-${Date.now()}`;
const directories: string[] = [];

afterAll(async () => {
  if (tmuxAvailable)
    await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => undefined);
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

suite('real tmux integration', () => {
  it('captures output, exact exit code, stable ID, and owned window metadata', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'pi-tmux-integration-'));
    directories.push(runDir);
    const artifacts = await createCommandArtifacts({
      runDir,
      runId: 'integration',
      command: "printf 'hello from tmux\\n'; exit 9",
      displayCommand: 'integration command',
      config: DEFAULT_TMUX_BASH_CONFIG,
    });
    const client = new TmuxClient('tmux');
    const windowId = await client.createWindow({
      sessionName,
      windowName: 'integration',
      cwd: process.cwd(),
      scriptFile: artifacts.scriptFile,
      metadata: {
        version: 'v1',
        gitRoot: process.cwd(),
        piSessionId: 'test-session',
        runId: 'integration',
        startedAt: Date.now(),
        outputFile: artifacts.outputFile,
        displayCommand: 'integration command',
      },
    });

    expect(windowId).toMatch(/^@\d+$/);
    await waitFor(async () => (await readExitCode(artifacts.exitCodeFile)) === 9);
    expect(await readFile(artifacts.outputFile, 'utf8')).toContain('hello from tmux');
    const { stdout: metadata } = await execFileAsync('tmux', [
      'show-options',
      '-w',
      '-v',
      '-t',
      windowId,
      '@pi_tmux_bash_run_id',
    ]);
    expect(metadata.trim()).toBe('integration');
    await client.killWindow(windowId);
  });

  it('lists, peeks, kills, and reports completion through the real runtime', async () => {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const events = {
      on(name: string, handler: (payload: unknown) => void) {
        const listeners = handlers.get(name) ?? new Set();
        listeners.add(handler);
        handlers.set(name, listeners);
        return () => listeners.delete(handler);
      },
      emit(name: string, payload: unknown) {
        for (const handler of handlers.get(name) ?? []) handler(payload);
      },
    };
    const pi = { events, sendMessage: vi.fn() };
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        tmuxSessionScope: 'global',
        globalTmuxSessionName: sessionName,
        autoCloseWindowsOnCompletion: false,
        statusbarEnabled: false,
      },
      controller,
    );
    const context = {
      cwd: process.cwd(),
      sessionManager: {
        getSessionId: () => 'real-runtime-session',
        getSessionFile: () => '/tmp/real-runtime-session.jsonl',
      },
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        theme: { fg: (_color: string, text: string) => text },
      },
    };

    try {
      await runtime.startSession(context as never);
      const longRunning = await runtime.executeBash(
        { command: "printf 'peek-ready\\n'; sleep 10", background: true },
        undefined,
        undefined,
        context as never,
      );
      const windowId = longRunning.details?.windowId;
      if (!windowId) throw new Error('Expected a stable tmux window ID.');
      await waitFor(async () =>
        (await readFile(longRunning.details?.outputFile ?? '', 'utf8')).includes('peek-ready'),
      );

      const listed = await runtime.listResult(context as never);
      expect(listed.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining(windowId),
      });
      const peeked = await runtime.peek(windowId, context as never);
      expect(peeked.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('peek-ready'),
      });
      await runtime.kill(windowId, context as never);
      await expect(new TmuxClient('tmux').hasWindow(windowId)).resolves.toBe(false);

      await runtime.executeBash(
        {
          command: "sleep 0.1; printf 'background-complete\\n'",
          background: true,
          waitForCompletion: true,
        },
        undefined,
        undefined,
        context as never,
      );
      // Completion delivery includes tmux shutdown, filesystem notification, and the
      // runtime's fallback scan. Give slower CI runners enough time for that chain.
      await waitFor(async () => pi.sendMessage.mock.calls.length === 1, 30_000);
      expect(pi.sendMessage.mock.calls[0]?.[0]).toMatchObject({
        content: expect.stringContaining('background-complete'),
      });
      expect(controller.list('real-runtime-session')).toHaveLength(0);
    } finally {
      await runtime.shutdown(context as never);
      controller.dispose();
    }
  }, 40_000);
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for tmux command completion.');
}
