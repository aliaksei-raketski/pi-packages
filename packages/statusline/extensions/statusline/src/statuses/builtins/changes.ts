import type { StatuslineCollectContext, StatuslineItem, StatuslineProvider } from '../types.ts';
import { formatGitStatusChanges } from '../../git-status.ts';

function shouldCollect(requestedKeys: Set<string>): boolean {
  return requestedKeys.size === 0 || requestedKeys.has('changes');
}

export const changesProvider: StatuslineProvider = {
  keys: ['changes'],
  collect(context: StatuslineCollectContext): StatuslineItem[] {
    if (!shouldCollect(context.requestedKeys)) {
      return [];
    }

    const text = formatGitStatusChanges(context.gitStatusSource.gitStatus);
    if (!text) {
      return [];
    }

    return [{ key: 'changes', text }];
  },
};
