export interface UsageSnapshot {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export function tokenDeltaFromUsage(usage: UsageSnapshot | null | undefined): number {
  if (!usage) return 0;
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) {
    return boundedTokenCount(usage.totalTokens);
  }

  const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  const total = values.reduce<number>((sum, value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return sum;
    return sum + Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, value));
  }, 0);
  return boundedTokenCount(total);
}

function boundedTokenCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}
