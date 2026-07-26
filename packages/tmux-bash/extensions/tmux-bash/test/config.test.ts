import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TMUX_BASH_CONFIG,
  clampPollInterval,
  clampTimeout,
  loadTmuxBashConfig,
  validateTmuxBashConfig,
} from '../src/config.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('tmux-bash config', () => {
  it('loads JSONC and validates values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tmux-config-'));
    tempDirectories.push(directory);
    const path = join(directory, 'config.jsonc');
    await writeFile(
      path,
      `{
        // finite foreground timeout
        "defaultTimeoutSeconds": 42,
        "enabledTmuxActions": ["list", "peek"],
      }`,
    );

    const config = loadTmuxBashConfig({ path });
    expect(config.defaultTimeoutSeconds).toBe(42);
    expect(config.enabledTmuxActions).toEqual(['list', 'peek']);
    expect(config.defaultWaitForBackgroundCompletion).toBe(false);
    expect(config.defaultWaitAfterForegroundTimeout).toBe(true);
    expect(config.completionContextLines).toBe(20);
    expect(config.completedCompactDisplayLines).toBe(5);
    expect(config.completedExpandedDisplayLines).toBe(20);
    expect(config.maxSpoolBytes).toBe(10 * 1024 * 1024);
  });

  it('rejects invalid security-sensitive paths and actions', () => {
    expect(() =>
      validateTmuxBashConfig({ ...DEFAULT_TMUX_BASH_CONFIG, tmuxBinary: './tmux' }),
    ).toThrow(/tmuxBinary/);
    expect(() =>
      validateTmuxBashConfig({ ...DEFAULT_TMUX_BASH_CONFIG, enabledTmuxActions: ['attach'] }),
    ).toThrow(/enabledTmuxActions/);
    expect(() =>
      validateTmuxBashConfig({ ...DEFAULT_TMUX_BASH_CONFIG, maxSpoolBytes: 100 }),
    ).toThrow(/maxSpoolBytes/);
    expect(() =>
      validateTmuxBashConfig({ ...DEFAULT_TMUX_BASH_CONFIG, completionDeliveryMaxAttempts: 0 }),
    ).toThrow(/completionDeliveryMaxAttempts/);
  });

  it('clamps timeouts and model polling', () => {
    const config = validateTmuxBashConfig({
      ...DEFAULT_TMUX_BASH_CONFIG,
      defaultTimeoutSeconds: 50,
      maxTimeoutSeconds: 100,
      pollDelivery: 'model',
      minimumModelPollIntervalSeconds: 15,
    });
    expect(clampTimeout(config, 500)).toBe(100);
    expect(clampTimeout(config, -1)).toBe(1);
    expect(clampPollInterval(config, 2)).toBe(15);
  });
});
