import type { StatuslineCollectContext, StatuslineItem, StatuslineProvider } from '../types.ts';

function shouldCollect(requestedKeys: Set<string>): boolean {
  return requestedKeys.size === 0 || requestedKeys.has('context');
}

function collectContextState(percent: number): string {
  if (percent >= 90) {
    return 'full';
  }
  if (percent >= 70) {
    return 'warning';
  }

  return 'normal';
}

function formatContextWindow(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${Math.round(value)}`;
}

function formatContextPercent(percent: number): string {
  return `${percent.toFixed(1).replace(/\.0$/, '')}%`;
}

export const contextProvider: StatuslineProvider = {
  keys: ['context'],
  collect(context: StatuslineCollectContext): StatuslineItem[] {
    if (!shouldCollect(context.requestedKeys)) {
      return [];
    }

    const usage = context.extensionContext.getContextUsage();
    if (!usage || usage.tokens === null || usage.percent === null) {
      return [];
    }

    return [
      {
        key: 'context',
        text: `${formatContextPercent(usage.percent)}/${formatContextWindow(usage.contextWindow)}`,
        state: collectContextState(usage.percent),
      },
    ];
  },
};
