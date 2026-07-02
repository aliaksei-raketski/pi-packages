import type { StatuslineCollectContext, StatuslineItem, StatuslineProvider } from '../types.ts';

function shouldCollect(requestedKeys: Set<string>): boolean {
  return requestedKeys.size === 0 || requestedKeys.has('title');
}

export const titleProvider: StatuslineProvider = {
  keys: ['title'],
  collect(context: StatuslineCollectContext): StatuslineItem[] {
    if (!shouldCollect(context.requestedKeys)) {
      return [];
    }

    const sessionName = context.extensionContext.sessionManager.getSessionName();
    if (!sessionName) {
      return [];
    }

    return [{ key: 'title', text: sessionName }];
  },
};
