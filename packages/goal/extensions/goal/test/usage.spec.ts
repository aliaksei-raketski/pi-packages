import { describe, expect, it } from 'vitest';
import { tokenDeltaFromUsage } from '../src/usage.ts';

describe('usage accounting', () => {
  it('prefers totalTokens', () => {
    expect(
      tokenDeltaFromUsage({
        totalTokens: 123,
        input: 100,
        output: 25,
        cacheRead: 50,
        cacheWrite: 75,
      }),
    ).toBe(123);
  });

  it('sums all usage categories when totalTokens is absent', () => {
    expect(tokenDeltaFromUsage({ input: 100, output: 25, cacheRead: 50, cacheWrite: 75 })).toBe(
      250,
    );
  });

  it('clamps negative and missing totals', () => {
    expect(tokenDeltaFromUsage({ input: -100, output: 25 })).toBe(0);
    expect(tokenDeltaFromUsage(undefined)).toBe(0);
  });
});
