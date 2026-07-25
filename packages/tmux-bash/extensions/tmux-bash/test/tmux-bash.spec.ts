import { afterEach, describe, expect, it, vi } from 'vitest';

import { tmuxBash } from '../src/tmux-bash.js';

const missingConfig = `/tmp/pi-tmux-bash-missing-${process.pid}.jsonc`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('tmux-bash extension', () => {
  it('registers tools and lifecycle hooks without starting long-lived resources', () => {
    vi.stubEnv('PI_TMUX_BASH_CONFIG', missingConfig);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const pi = {
      events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
      on: vi.fn(),
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
    };

    tmuxBash(pi as never);

    expect(pi.registerTool).toHaveBeenCalledTimes(2);
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'bash' }));
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'tmux' }));
    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
