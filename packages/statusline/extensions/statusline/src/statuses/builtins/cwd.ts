import { basename, relative } from 'node:path';
import type { StatuslineCollectContext, StatuslineItem, StatuslineProvider } from '../types.ts';

function shortPath(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) {
    const suffix = cwd === home ? '' : relative(home, cwd);
    return `~${suffix ? `/${suffix}` : ''}`;
  }

  return basename(cwd);
}

function shouldCollect(requestedKeys: Set<string>): boolean {
  return requestedKeys.size === 0 || requestedKeys.has('cwd');
}

export const cwdProvider: StatuslineProvider = {
  keys: ['cwd'],
  collect(context: StatuslineCollectContext): StatuslineItem[] {
    if (!shouldCollect(context.requestedKeys)) {
      return [];
    }

    return [{ key: 'cwd', text: shortPath(context.extensionContext.cwd) }];
  },
};
