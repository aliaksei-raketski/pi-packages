import { describe, expect, it, vi } from 'vitest';

import { registerTmuxAttachCommand } from '../src/attach.js';
import { registerTmuxCleanupCommands } from '../src/cleanup-command.js';

function presentation() {
  return {
    content: [{ type: 'text', text: 'attach' }],
    details: {
      action: 'attach',
      runs: [],
      attach: {
        binary: '/usr/bin/tmux',
        args: ['attach-session', '-t', "odd session's name", ';', 'select-window', '-t', '@7'],
        display:
          "/usr/bin/tmux attach-session -t 'odd session'\"'\"'s name' ';' select-window -t @7",
        insideTmux: false,
      },
    },
  };
}

function setup() {
  let command: { handler(args: string, ctx: unknown): Promise<void> } | undefined;
  const pi = {
    registerCommand: vi.fn((_name: string, definition: typeof command) => {
      command = definition;
    }),
  };
  const runtime = {
    config: { enabledTmuxActions: ['attach'] },
    list: vi.fn(() => [
      { state: 'running', windowId: '@7', displayCommand: 'sleep 10' },
      { state: 'completed', windowId: '@8', displayCommand: 'done' },
    ]),
    attach: vi.fn(async () => presentation()),
  };
  return { pi, runtime, getCommand: () => command };
}

describe('/tmux-attach', () => {
  it('does not register when the attach action is disabled', () => {
    const { pi, runtime, getCommand } = setup();
    runtime.config.enabledTmuxActions = [];
    registerTmuxAttachCommand(pi as never, runtime as never);
    expect(getCommand()).toBeUndefined();
  });

  it('cancels selection without targeting a window', async () => {
    const { pi, runtime, getCommand } = setup();
    registerTmuxAttachCommand(pi as never, runtime as never);
    const ctx = {
      mode: 'tui',
      ui: { select: vi.fn(async () => undefined), notify: vi.fn() },
    };
    await getCommand()?.handler('', ctx);
    expect(runtime.attach).not.toHaveBeenCalled();
  });

  it('returns a safe presentation in non-TUI mode without terminal control', async () => {
    const { pi, runtime, getCommand } = setup();
    registerTmuxAttachCommand(pi as never, runtime as never);
    const ctx = {
      mode: 'rpc',
      ui: { notify: vi.fn(), custom: vi.fn() },
    };
    await getCommand()?.handler('@7', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("odd session'"), 'info');
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it('revalidates ownership after confirmation and restarts the TUI after spawn failure', async () => {
    const { pi, runtime, getCommand } = setup();
    const spawn = vi.fn(() => ({
      error: new Error('spawn failed'),
      pid: 0,
      output: [],
      stdout: null,
      stderr: null,
      status: null,
      signal: null,
    }));
    registerTmuxAttachCommand(pi as never, runtime as never, spawn as never);
    const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
    const ctx = {
      mode: 'tui',
      ui: {
        confirm: vi.fn(async () => true),
        custom: vi.fn(async (factory) => {
          factory(tui, {}, {}, vi.fn());
        }),
      },
    };
    await expect(getCommand()?.handler('@7', ctx)).rejects.toThrow('spawn failed');
    expect(runtime.attach).toHaveBeenCalledTimes(2);
    expect(tui.stop).toHaveBeenCalledOnce();
    expect(tui.start).toHaveBeenCalledOnce();
    expect(tui.requestRender).toHaveBeenCalledWith(true);
  });

  it('does not launch when ownership changes during post-confirmation revalidation', async () => {
    const { pi, runtime, getCommand } = setup();
    runtime.attach
      .mockResolvedValueOnce(presentation())
      .mockRejectedValueOnce(new Error('ownership changed'));
    const spawn = vi.fn();
    registerTmuxAttachCommand(pi as never, runtime as never, spawn as never);
    const ctx = {
      mode: 'tui',
      ui: { confirm: vi.fn(async () => true), custom: vi.fn() },
    };
    await expect(getCommand()?.handler('@7', ctx)).rejects.toThrow('ownership changed');
    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });
});

describe('/tmux-cleanup', () => {
  it('requires an explicit confirmation before including retained completed runs', async () => {
    const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
    const pi = {
      registerCommand: vi.fn(
        (name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) =>
          commands.set(name, command),
      ),
    };
    const runtime = {
      config: { enabledTmuxActions: ['cleanup-preview', 'cleanup'] },
      cleanupPreview: vi.fn(async (_ctx, includeYoung?: boolean) => ({
        content: [{ type: 'text', text: 'one candidate' }],
        details: {
          cleanup: includeYoung
            ? [{ runId: 'run-1', state: 'completed', ageMs: 0, bytes: 25 }]
            : [],
        },
      })),
      cleanup: vi.fn(async () => ({
        content: [{ type: 'text', text: 'removed one candidate' }],
        details: {},
      })),
    };
    registerTmuxCleanupCommands(pi as never, runtime as never);
    const ctx = {
      hasUI: true,
      ui: { confirm: vi.fn(async () => false), notify: vi.fn() },
    };
    await commands.get('tmux-cleanup')?.handler('', ctx);
    expect(runtime.cleanup).not.toHaveBeenCalled();

    ctx.ui.confirm.mockResolvedValueOnce(true);
    await commands.get('tmux-cleanup')?.handler('', ctx);
    expect(runtime.cleanup).toHaveBeenCalledWith(ctx, true, ['run-1']);
    expect(ctx.ui.notify).toHaveBeenCalledWith('removed one candidate', 'info');
  });
});
