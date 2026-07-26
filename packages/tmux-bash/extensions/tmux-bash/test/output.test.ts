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
    const formatted = formatOutput(output, {
      maxLines: 200,
      maxBytes: 1_024,
      fullOutputPath: path,
    });
    expect(formatted.text).toMatch(/Output truncated: showing a bounded tail.*Full output:/s);
    expect(formatted.truncation?.truncated).toBe(true);
  });

  it('removes terminal and binary control sequences from model-visible output', () => {
    const path = '/tmp/untrusted.out';
    const formatted = formatOutput(
      `safe\u001b[31m red\u001b[0m\n\u001b]0;hostile-title\u0007title-safe\n\u001b]52;c;Y2xpcGJvYXJk\u001b\\clipboard-safe\u0000`,
      { maxLines: 200, maxBytes: 1_024, fullOutputPath: path },
    );

    expect(formatted.text).toBe('safe red\ntitle-safe\nclipboard-safe');
    expect(formatted.text).not.toContain(String.fromCodePoint(0x00));
    expect(formatted.text).not.toContain(String.fromCodePoint(0x1b));
    expect(formatted.text).not.toContain(String.fromCodePoint(0x9b));
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
