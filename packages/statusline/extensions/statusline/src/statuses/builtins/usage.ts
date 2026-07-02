import type { StatuslineCollectContext, StatuslineItem, StatuslineProvider } from '../types.ts';

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return `${Math.round(value)}`;
}

function collectUsageTotals(context: StatuslineCollectContext): UsageTotals {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };

  for (const entry of context.extensionContext.sessionManager.getBranch()) {
    if (entry.type !== 'message') {
      continue;
    }

    const message = entry.message as {
      role?: string;
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: { total?: number };
      };
    };

    if (message.role !== 'assistant' || !message.usage) {
      continue;
    }

    const usage = message.usage;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.cost += usage.cost?.total ?? 0;
  }

  return totals;
}

function shouldCollect(context: StatuslineCollectContext): boolean {
  return (
    context.requestedKeys.size === 0 ||
    context.requestedKeys.has('tokens') ||
    context.requestedKeys.has('cache') ||
    context.requestedKeys.has('cost')
  );
}

export const usageProvider: StatuslineProvider = {
  keys: ['tokens', 'cache', 'cost'],
  collect(context: StatuslineCollectContext): StatuslineItem[] {
    if (!shouldCollect(context)) {
      return [];
    }

    const needsTokens = context.requestedKeys.size === 0 || context.requestedKeys.has('tokens');
    const needsCache = context.requestedKeys.size === 0 || context.requestedKeys.has('cache');
    const needsCost = context.requestedKeys.size === 0 || context.requestedKeys.has('cost');

    const totals = collectUsageTotals(context);
    const result: StatuslineItem[] = [];

    if (needsTokens) {
      result.push({
        key: 'tokens',
        text: `${formatNumber(totals.input)}↑ ${formatNumber(totals.output)}↓`,
      });
    }

    if (needsCache) {
      const totalCache = totals.cacheRead + totals.cacheWrite;
      const cacheHitPercent =
        totalCache > 0 ? Math.round((totals.cacheRead / totalCache) * 100) : 0;
      result.push({
        key: 'cache',
        text: `${formatNumber(totals.cacheRead)}/${formatNumber(totals.cacheWrite)} ${cacheHitPercent}%`,
      });
    }

    if (needsCost) {
      result.push({ key: 'cost', text: `$${totals.cost.toFixed(2)}` });
    }

    return result;
  },
};
