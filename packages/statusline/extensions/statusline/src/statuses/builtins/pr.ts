import type { StatuslineCollectContext, StatuslineItem, StatuslineProvider } from '../types.ts';
import { formatPullRequest } from '../../git-status.ts';

function shouldCollect(requestedKeys: Set<string>): boolean {
  return requestedKeys.size === 0 || requestedKeys.has('pr');
}

export const prProvider: StatuslineProvider = {
  keys: ['pr'],
  collect(context: StatuslineCollectContext): StatuslineItem[] {
    if (!shouldCollect(context.requestedKeys)) {
      return [];
    }

    const text = formatPullRequest(context.gitStatusSource.pullRequest);
    if (!text) {
      return [];
    }

    return [{ key: 'pr', text }];
  },
};
