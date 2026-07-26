import { describe, expect, it } from 'vitest';
import {
  buildInhibitorCandidates,
  powerShellScript,
  WINDOWS_CLEAR_FLAGS,
  WINDOWS_DISPLAY_FLAGS,
  WINDOWS_SLEEP_FLAGS,
} from '../src/inhibitors.ts';

describe('inhibitor candidates', () => {
  it('uses the exact macOS and Linux mode arguments', () => {
    expect(buildInhibitorCandidates({ platform: 'darwin' }, 'sleep')[0]?.args).toEqual(['-ims']);
    expect(buildInhibitorCandidates({ platform: 'darwin' }, 'display')[0]?.args).toEqual([
      '-dimsu',
    ]);
    expect(buildInhibitorCandidates({ platform: 'linux', env: {} }, 'display')[0]?.args).toEqual([
      '--what=idle:sleep',
      '--who=pi-caffeinate',
      '--mode=block',
      '--why=Keep the computer awake while Pi is active',
      'sleep',
      'infinity',
    ]);
  });

  it('tries PowerShell and then Linux inhibitors on WSL', () => {
    const candidates = buildInhibitorCandidates(
      { platform: 'linux', env: { WSL_INTEROP: '/run/WSL/1_interop' } },
      'display',
    );

    expect(candidates.map(({ id }) => id)).toEqual([
      'powershell-0',
      'powershell-1',
      'systemd-inhibit',
      'caffeinate-fallback',
    ]);
  });

  it('refreshes and clears a checked unsigned PowerShell request', () => {
    const display = powerShellScript('display');
    const sleep = powerShellScript('sleep');

    expect(display).toContain(`$flags = [uint32]${WINDOWS_DISPLAY_FLAGS}`);
    expect(sleep).toContain(`$flags = [uint32]${WINDOWS_SLEEP_FLAGS}`);
    expect(display).toContain('$readTask.Wait(30000)');
    expect(display).toContain("throw 'SetThreadExecutionState failed'");
    expect(display).toContain(`[uint32]0x${WINDOWS_CLEAR_FLAGS.toString(16)}`);
    expect(display).toContain('finally');
  });
});
