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
    return Math.max(0, usage.totalTokens);
  }

  const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  const total = values.reduce<number>(
    (sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0),
    0,
  );
  return Math.max(0, total);
}
