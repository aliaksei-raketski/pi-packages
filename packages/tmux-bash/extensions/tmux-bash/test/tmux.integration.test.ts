import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

import { createCommandArtifacts } from '../src/command-artifacts.js';
import { DEFAULT_TMUX_BASH_CONFIG } from '../src/config.js';
import { readExitCode } from '../src/output.js';
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
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for tmux command completion.');
}
