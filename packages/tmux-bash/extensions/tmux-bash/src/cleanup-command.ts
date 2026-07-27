import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type { TmuxBashRuntime } from './runtime.js';

export function registerTmuxCleanupCommands(pi: ExtensionAPI, runtime: TmuxBashRuntime): void {
  if (runtime.config.enabledTmuxActions.includes('cleanup-preview')) {
    pi.registerCommand('tmux-cleanup-preview', {
      description: 'Preview validated completed tmux-bash artifacts eligible for cleanup',
      handler: async (_args, ctx) => {
        const result = await runtime.cleanupPreview(ctx);
        const text = result.content[0]?.type === 'text' ? result.content[0].text : 'No preview.';
        ctx.ui.notify(text, 'info');
      },
    });
  }
  if (runtime.config.enabledTmuxActions.includes('cleanup')) {
    pi.registerCommand('tmux-cleanup', {
      description: 'Confirm and remove validated non-running tmux-bash artifacts',
      handler: async (_args, ctx) => {
        const preview = await runtime.cleanupPreview(ctx, true);
        const candidates = preview.details.cleanup ?? [];
        const summary = preview.details.cleanupSummary;
        if ((summary?.candidateCount ?? candidates.length) === 0) {
          ctx.ui.notify('No completed tmux-bash artifacts are available for cleanup.', 'info');
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify('tmux cleanup requires an interactive confirmation.', 'warning');
          return;
        }
        const count = summary?.candidateCount ?? candidates.length;
        const bytes =
          summary?.reclaimableBytes ??
          candidates.reduce((total, candidate) => total + candidate.bytes, 0);
        const confirmed = await ctx.ui.confirm(
          `Remove ${count} completed tmux run(s)?`,
          `This will reclaim approximately ${bytes} bytes. Live and unowned resources are always protected.`,
        );
        if (!confirmed) return;
        const result = await runtime.cleanup(ctx, true);
        const text =
          result.content[0]?.type === 'text' ? result.content[0].text : 'Cleanup finished.';
        ctx.ui.notify(text, 'info');
      },
    });
  }
}
