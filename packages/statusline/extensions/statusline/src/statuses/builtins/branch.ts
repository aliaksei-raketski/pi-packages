import type { StatuslineCollectContext, StatuslineItem, StatuslineProvider } from '../types.ts';
import { isBranchDirty } from '../../git-status.ts';

function shouldCollect(requestedKeys: Set<string>): boolean {
  return requestedKeys.size === 0 || requestedKeys.has('branch');
}

export const branchProvider: StatuslineProvider = {
  keys: ['branch'],
  collect(context: StatuslineCollectContext): StatuslineItem[] {
    if (!shouldCollect(context.requestedKeys)) {
      return [];
    }

    const branch = context.footerData.getGitBranch() || context.gitStatusSource.gitStatus?.branch;
    if (!branch) {
      return [];
    }

    return [
      {
        key: 'branch',
        text: branch,
        state: isBranchDirty(context.gitStatusSource.gitStatus) ? 'dirty' : 'clean',
      },
    ];
  },
};
