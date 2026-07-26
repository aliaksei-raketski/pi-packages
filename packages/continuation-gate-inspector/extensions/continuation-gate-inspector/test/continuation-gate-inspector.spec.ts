import { describe, expect, it, vi } from 'vitest';
import { continuationGateInspector } from '../src/continuation-gate-inspector.ts';

describe('continuation-gate-inspector extension', () => {
  it('registers the read-only /gates command and lifecycle hooks', () => {
    const events = { on: vi.fn(() => () => undefined), emit: vi.fn() };
    const pi = { events, on: vi.fn(), registerCommand: vi.fn() };
    continuationGateInspector(pi as never);
    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
    expect(pi.registerCommand).toHaveBeenCalledWith(
      'gates',
      expect.objectContaining({ handler: expect.any(Function) }),
    );
  });

  it('offers only read-only inspection subcommands', () => {
    const events = { on: vi.fn(() => () => undefined), emit: vi.fn() };
    const pi = { events, on: vi.fn(), registerCommand: vi.fn() };
    continuationGateInspector(pi as never);
    const command = pi.registerCommand.mock.calls[0]?.[1] as {
      getArgumentCompletions: (prefix: string) => Array<{ value: string }>;
    };
    expect(command.getArgumentCompletions('').map(({ value }) => value)).toEqual([
      'refresh',
      'stale',
      'diagnostics',
    ]);
  });
});
