import type { StatuslineCollectContext, StatuslineItem, StatuslineProvider } from '../types.ts';

function shouldCollect(requestedKeys: Set<string>): boolean {
  return requestedKeys.size === 0 || requestedKeys.has('thinking');
}

export const thinkingProvider: StatuslineProvider = {
  keys: ['thinking'],
  collect(context: StatuslineCollectContext): StatuslineItem[] {
    if (!shouldCollect(context.requestedKeys)) {
      return [];
    }

    const level = context.extensionApi.getThinkingLevel();
    return [{ key: 'thinking', text: level, state: level }];
  },
};
