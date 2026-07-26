import { describe, expect, it, vi } from 'vitest';
import { caffeinate } from '../src/caffeinate.ts';
import { parseCaffeinateCommand } from '../src/commands.ts';
import { buildInhibitorCandidates } from '../src/inhibitors.ts';
import { collectCaffeinateStatus } from '../src/status.ts';

function createPi() {
  return {
    on: vi.fn(),
    registerCommand: vi.fn(),
    events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
  };
}

describe('caffeinate extension', () => {
  it('registers lifecycle hooks, continuation observation, and commands without starting work', () => {
    const pi = createPi();
    caffeinate(pi as never);

    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith('agent_settled', expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
    expect(pi.registerCommand).toHaveBeenCalledWith(
      'caffeinate',
      expect.objectContaining({
        handler: expect.any(Function),
        getArgumentCompletions: expect.any(Function),
      }),
    );
  });
});

describe('caffeinate pure contracts', () => {
  it('keeps gates alive after Pi settles', () => {
    expect(
      collectCaffeinateStatus({
        enabled: true,
        manualStop: false,
        holding: true,
        inhibitorRunning: true,
        unavailable: false,
        gateCount: 2,
        piIdle: true,
      }),
    ).toMatchObject({ text: 'awake · 2 waiting', state: 'waiting' });
  });

  it('builds exact platform candidates', () => {
    expect(buildInhibitorCandidates({ platform: 'darwin' }, 'sleep')[0]?.args).toEqual(['-ims']);
    expect(buildInhibitorCandidates({ platform: 'linux' }, 'display')[0]?.args).toEqual([
      '--what=idle:sleep',
      '--who=pi-caffeinate',
      '--mode=block',
      '--why=Keep the computer awake while Pi is active',
      'sleep',
      'infinity',
    ]);
  });

  it('rejects trailing or unknown command input', () => {
    expect(parseCaffeinateCommand('quiet on')).toEqual({ kind: 'quiet', enabled: true });
    expect(parseCaffeinateCommand('status extra')).toBeUndefined();
  });
});
