import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { spawnSync } from 'node:child_process';

import type { TmuxBashRuntime } from './runtime.js';
import { sanitizeTerminalText } from './sanitize.js';

export function registerTmuxAttachCommand(
  pi: ExtensionAPI,
  runtime: TmuxBashRuntime,
  spawnProcess: typeof spawnSync = spawnSync,
): void {
  if (!runtime.config.enabledTmuxActions.includes('attach')) return;
  pi.registerCommand('tmux-attach', {
    description: 'Attach to a validated tmux-bash managed window',
    handler: async (args, ctx) => {
      let windowId = args.trim();
      if (!windowId) {
        const runs = runtime
          .list(ctx)
          .filter((run) => run.state === 'running' && run.windowId)
          .map((run) => ({
            id: run.windowId as string,
            label: `${run.windowId} ${sanitizeTerminalText(run.displayCommand).slice(0, 200)}`,
          }));
        if (runs.length === 0) {
          ctx.ui.notify('No live managed tmux windows are available.', 'warning');
          return;
        }
        if (ctx.mode !== 'tui') {
          ctx.ui.notify(
            `Specify one of these stable window IDs: ${runs.map((run) => run.id).join(', ')}`,
            'info',
          );
          return;
        }
        const selected = await ctx.ui.select(
          'Select a managed tmux window',
          runs.map((run) => run.label),
        );
        if (!selected) return;
        windowId = selected.split(' ', 1)[0] ?? '';
      }

      const presentation = await runtime.attach(windowId, ctx);
      const attach = presentation.details.attach;
      if (!attach) throw new Error('tmux-bash could not construct an attach command.');
      if (ctx.mode !== 'tui') {
        ctx.ui.notify(attach.display, 'info');
        return;
      }
      const confirmed = await ctx.ui.confirm(
        `Attach to ${windowId}?`,
        attach.insideTmux
          ? 'Pi stays in its current tmux window. Return by selecting the Pi window again.'
          : 'Detach with the tmux prefix followed by d to return to Pi.',
      );
      if (!confirmed) return;

      // Revalidate after selection and confirmation, immediately before terminal control changes.
      const revalidated = await runtime.attach(windowId, ctx);
      const command = revalidated.details.attach;
      if (!command) throw new Error('tmux-bash ownership changed before attach.');
      await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
        try {
          tui.stop();
          const spawned = spawnProcess(command.binary, command.args, { stdio: 'inherit' });
          if (spawned.error) throw spawned.error;
          if (spawned.status !== 0) {
            throw new Error(`tmux attach exited with code ${spawned.status ?? 'unknown'}.`);
          }
        } finally {
          tui.start();
          tui.requestRender(true);
          done(undefined);
        }
        return { render: () => [], invalidate: () => undefined };
      });
    },
  });
}
