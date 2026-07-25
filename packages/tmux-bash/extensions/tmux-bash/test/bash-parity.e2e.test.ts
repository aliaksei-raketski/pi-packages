import { createBashTool } from '@earendil-works/pi-coding-agent';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { createCommandArtifacts } from '../src/command-artifacts.js';
import { DEFAULT_TMUX_BASH_CONFIG } from '../src/config.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('built-in bash parity', () => {
  for (const [name, command] of [
    ['stdout', "printf 'hello'"],
    ['stderr', "printf 'problem' >&2"],
    ['multiline', "printf 'one\\ntwo\\n'"],
    ['empty output', ':'],
  ]) {
    it(`matches built-in combined output for ${name}`, async () => {
      const builtIn = createBashTool(process.cwd());
      const expected = await builtIn.execute('built-in', { command }, undefined, undefined);
      const expectedText = expected.content[0]?.type === 'text' ? expected.content[0].text : '';
      expect(await executeWrapper(command)).toBe(expectedText);
    });
  }

  it('preserves non-zero output and exit status', async () => {
    const command = "printf 'before failure\\n'; exit 23";
    const builtIn = createBashTool(process.cwd());
    await expect(builtIn.execute('built-in', { command }, undefined, undefined)).rejects.toThrow(
      /before failure[\s\S]*code 23/,
    );
    await expect(executeWrapper(command)).rejects.toMatchObject({
      output: 'before failure\n',
      exitCode: 23,
    });
  });
});

async function executeWrapper(command: string): Promise<string> {
  const runDir = await mkdtemp(join(tmpdir(), 'pi-bash-parity-'));
  directories.push(runDir);
  const artifacts = await createCommandArtifacts({
    runDir,
    runId: `parity${directories.length}`,
    command,
    displayCommand: 'parity',
    config: DEFAULT_TMUX_BASH_CONFIG,
  });
  let exitCode = 0;
  try {
    await execFileAsync(artifacts.scriptFile, []);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    exitCode = typeof code === 'number' ? code : 1;
  }
  const output = (await readFile(artifacts.outputFile, 'utf8')).replace(/^\$ parity\n/, '');
  if (exitCode !== 0) return Promise.reject({ output, exitCode });
  return output || '(no output)';
}
