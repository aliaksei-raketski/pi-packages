import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { createCommandArtifacts, shellQuote } from '../src/command-artifacts.js';
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
