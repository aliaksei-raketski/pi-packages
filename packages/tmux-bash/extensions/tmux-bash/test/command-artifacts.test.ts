import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createCommandArtifacts,
  createPiSessionEnvironment,
  shellQuote,
} from '../src/command-artifacts.js';
import { DEFAULT_TMUX_BASH_CONFIG } from '../src/config.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('command artifacts', () => {
  it('quotes arbitrary shell values without evaluation', async () => {
    const quoted = shellQuote("a'b $(touch nope)");
    const { stdout } = await execFileAsync('/bin/bash', ['-c', `printf %s ${quoted}`]);
    expect(stdout).toBe("a'b $(touch nope)");
  });

  it('constructs the same per-call Pi session environment as built-in bash', () => {
    const environment = createPiSessionEnvironment(
      {
        sessionManager: {
          getSessionId: () => 'session-1',
          getSessionFile: () => '/tmp/session.jsonl',
        },
        model: { provider: 'anthropic', id: 'claude-test' },
        thinkingLevel: 'high',
      } as never,
      {
        PATH: '/bin',
        PI_SESSION_ID: 'stale-session',
        PI_SESSION_FILE: '/tmp/stale.jsonl',
        PI_PROVIDER: 'stale-provider',
        PI_MODEL: 'stale-model',
        PI_REASONING_LEVEL: 'off',
      },
    );

    expect(environment).toMatchObject({
      PATH: '/bin',
      PI_SESSION_ID: 'session-1',
      PI_SESSION_FILE: '/tmp/session.jsonl',
      PI_PROVIDER: 'anthropic',
      PI_MODEL: 'claude-test',
      PI_REASONING_LEVEL: 'high',
    });
  });

  it('removes stale optional Pi metadata when the current call has no value', () => {
    const environment = createPiSessionEnvironment(
      {
        sessionManager: {
          getSessionId: () => 'session-2',
          getSessionFile: () => undefined,
        },
        model: undefined,
        thinkingLevel: undefined,
      } as never,
      {
        PI_SESSION_FILE: '/tmp/stale.jsonl',
        PI_PROVIDER: 'stale-provider',
        PI_MODEL: 'stale-model',
        PI_REASONING_LEVEL: 'high',
      },
    );

    expect(environment).toEqual({ PI_SESSION_ID: 'session-2' });
  });

  it('captures ordered output and preserves the command exit code atomically', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'tmux-artifacts-'));
    directories.push(runDir);
    const artifacts = await createCommandArtifacts({
      runDir,
      runId: 'run123',
      command: "printf 'stdout\\n'; printf 'stderr\\n' >&2; exit 7",
      displayCommand: 'printf output; exit 7',
      config: { ...DEFAULT_TMUX_BASH_CONFIG, environmentDenylist: ['SECRET', 'TMUX'] },
      env: { SHELL: '/bin/bash', SECRET: 'hidden', SAFE_VALUE: "quoted'value" },
    });

    await expect(execFileAsync(artifacts.scriptFile, [])).rejects.toMatchObject({ code: 7 });
    expect(await readFile(artifacts.outputFile, 'utf8')).toBe(
      '$ printf output; exit 7\nstdout\nstderr\n',
    );
    expect(await readFile(artifacts.exitCodeFile, 'utf8')).toBe('7\n');
    await expect(readFile(artifacts.temporaryExitCodeFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const script = await readFile(artifacts.scriptFile, 'utf8');
    expect(script).not.toContain('SECRET');
    expect(script).toContain("export SAFE_VALUE='quoted'\"'\"'value'");
  });
});
