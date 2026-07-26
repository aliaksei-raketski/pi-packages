import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createCommandArtifacts,
  createPiSessionEnvironment,
  scheduleRunDirectoryCleanup,
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
      env: { SHELL: '/bin/zsh', SECRET: 'hidden', SAFE_VALUE: "quoted'value" },
    });

    const script = await readFile(artifacts.scriptFile, 'utf8');
    expect(script).toContain('unset SECRET');
    expect(script).toContain('unset TMUX');
    expect(script).toContain("export SAFE_VALUE='quoted'\"'\"'value'");
    expect(script).not.toContain('${SHELL');

    await expect(
      execFileAsync(artifacts.scriptFile, [], {
        env: { ...process.env, SHELL: '/bin/zsh', SECRET: 'inherited', TMUX: 'stale' },
      }),
    ).rejects.toMatchObject({ code: 7 });
    expect(await readFile(artifacts.outputFile, 'utf8')).toBe(
      '$ printf output; exit 7\nstdout\nstderr\n',
    );
    expect(await readFile(artifacts.exitCodeFile, 'utf8')).toBe('7\n');
    await expect(readFile(artifacts.temporaryExitCodeFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(artifacts.scriptFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('bounds the on-disk output spool without cutting off command stdout', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'tmux-artifacts-quota-'));
    directories.push(runDir);
    const artifacts = await createCommandArtifacts({
      runDir,
      runId: 'quota123',
      command: "printf '%5000s' '' | tr ' ' x",
      displayCommand: `produce large output ${'header'.repeat(1_000)}`,
      config: { ...DEFAULT_TMUX_BASH_CONFIG, maxSpoolBytes: 1_024 },
    });

    const { stdout } = await execFileAsync(artifacts.scriptFile, []);
    const output = await readFile(artifacts.outputFile, 'utf8');

    expect(stdout).toHaveLength(5_000);
    expect((await stat(artifacts.outputFile)).size).toBeLessThanOrEqual(1_024);
    expect(output).toContain('tmux-bash spool limit reached');
  });

  it('removes retained artifacts after a live command exits', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'tmux-artifacts-cleanup-'));
    directories.push(runDir);
    const artifacts = await createCommandArtifacts({
      runDir,
      runId: 'cleanup123',
      command: 'sleep 0.2; printf done',
      displayCommand: 'delayed output',
      config: DEFAULT_TMUX_BASH_CONFIG,
    });

    const completion = execFileAsync(artifacts.scriptFile, []);
    await scheduleRunDirectoryCleanup(runDir);
    await completion;

    await expect(stat(runDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses Bash even when the inherited login shell is not Bash', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'tmux-artifacts-bash-'));
    directories.push(runDir);
    const artifacts = await createCommandArtifacts({
      runDir,
      runId: 'bash123',
      command: 'shopt -s extglob; printf \'%s:%s\\n\' "$BASH_VERSION" "${SECRET-unset}"',
      displayCommand: 'verify bash',
      config: { ...DEFAULT_TMUX_BASH_CONFIG, environmentDenylist: ['SECRET'] },
      env: { SHELL: '/bin/zsh' },
    });

    await execFileAsync(artifacts.scriptFile, [], {
      env: { ...process.env, SHELL: '/bin/zsh', SECRET: 'inherited' },
    });

    expect(await readFile(artifacts.outputFile, 'utf8')).toMatch(
      /^\$ verify bash\n[^:\n]+:unset\n$/,
    );
  });
});
