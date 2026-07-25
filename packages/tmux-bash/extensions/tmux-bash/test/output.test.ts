import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { formatOutput, readOutput } from '../src/output.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('bounded output reads', () => {
  it('reads only the configured artifact tail and reports the full file size', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-tmux-output-'));
    directories.push(directory);
    const path = join(directory, 'large.out');
    await writeFile(path, `BEGIN-ONLY\n${'middle\n'.repeat(10_000)}final-line\n`);

    const output = await readOutput(path, 1_024);

    expect(output.readBytes).toBe(1_024);
    expect(output.totalBytes).toBeGreaterThan(output.readBytes);
    expect(output.content).not.toContain('BEGIN-ONLY');
    expect(output.content.endsWith('final-line\n')).toBe(true);
    expect(
      formatOutput(output, { maxLines: 200, maxBytes: 1_024, fullOutputPath: path }).text,
    ).toMatch(/Output truncated: showing a bounded tail.*Full output:/s);
  });

  it('returns an empty bounded value for a missing artifact', async () => {
    await expect(readOutput('/definitely/missing/pi-tmux-output', 1_024)).resolves.toEqual({
      content: '',
      totalBytes: 0,
      readBytes: 0,
      truncated: false,
    });
  });
});
