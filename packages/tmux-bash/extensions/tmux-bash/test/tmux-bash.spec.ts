import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { tmuxBash } from '../src/tmux-bash.js';

const missingConfig = `/tmp/pi-tmux-bash-missing-${process.pid}.jsonc`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('tmux-bash extension', () => {
  it('registers tools and lifecycle hooks without starting long-lived resources', async () => {
    vi.stubEnv('PI_TMUX_BASH_CONFIG', missingConfig);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const pi = {
      events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerEntryRenderer: vi.fn(),
      appendEntry: vi.fn(),
    };

    tmuxBash(pi as never);

    expect(pi.registerTool).toHaveBeenCalledTimes(2);
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'bash' }));
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'tmux' }));
    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
    expect(pi.on).not.toHaveBeenCalledWith('user_bash', expect.any(Function));
    expect(setIntervalSpy).not.toHaveBeenCalled();

    const tmuxTool = pi.registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === 'tmux');
    expect(tmuxTool).toBeDefined();
    await expect(
      tmuxTool?.execute('call-1', { action: 'cleanup', windowId: '@7' }, undefined, undefined, {}),
    ).rejects.toThrow('does not accept windowId');
    await expect(
      tmuxTool?.execute(
        'call-2',
        { action: 'send-input', windowId: '@7', text: 'value' },
        undefined,
        undefined,
        {},
      ),
    ).rejects.toThrow('send-input is disabled');
  });

  it('registers an opt-in standard BashOperations user_bash router', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tmux-bash-extension-'));
    const configPath = join(directory, 'config.jsonc');
    await writeFile(configPath, '{ "routeUserBash": true }');
    vi.stubEnv('PI_TMUX_BASH_CONFIG', configPath);
    const pi = {
      events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerEntryRenderer: vi.fn(),
      appendEntry: vi.fn(),
    };
    try {
      tmuxBash(pi as never);
      const registration = pi.on.mock.calls.find((call) => call[0] === 'user_bash');
      expect(registration).toBeDefined();
      const routed = registration?.[1]({ command: 'exit 7', excludeFromContext: true }, {});
      expect(routed).toMatchObject({ operations: { exec: expect.any(Function) } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
