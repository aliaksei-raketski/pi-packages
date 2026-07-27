import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { renderGetGoalCall, renderGetGoalResult } from '../src/goal-tool-renderer.ts';

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe('get_goal tool renderer', () => {
  it('uses a readable call label and a compact collapsed summary', () => {
    expect(renderGetGoalCall(theme).render(200).join('\n')).toContain('Get Goal');

    const component = renderGetGoalResult(
      {
        content: [],
        details: {
          goal: { id: 'goal-1', status: 'active', objective: 'ship it' },
          evidenceSummary: { revision: 3, total: 12, verified: 7 },
          gates: [{ source: 'tmux', gateId: 'run-1' }],
          truncation: null,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );
    const rendered = component
      .render(500)
      .map((line) => line.trimEnd())
      .join('\n');

    expect(rendered).toBe('active · evidence 7/12 verified · 1 gate');
    expect(rendered).not.toContain('{"goal"');
  });

  it('bounds expanded details and sanitizes user-controlled values', () => {
    const requirements = Array.from({ length: 30 }, (_, index) => ({
      id: `requirement-${index}`,
      requirement: `${'x'.repeat(300)}\u001b]0;unsafe`,
      status: index === 0 ? 'verified' : 'pending',
    }));
    const gates = Array.from({ length: 10 }, (_, index) => ({
      source: 'tmux',
      gateId: `gate-${index}`,
      reason: 'waiting'.repeat(50),
    }));
    const component = renderGetGoalResult(
      {
        content: [],
        details: {
          goal: {
            id: 'goal-1',
            status: 'active',
            objective: `${'objective '.repeat(100)}\u001b]52;c;unsafe`,
            tokensUsed: 10,
            tokenBudget: 100,
            activeWallTimeSeconds: 5,
            wallTimeBudgetSeconds: 60,
          },
          remainingTokens: 90,
          remainingWallTimeSeconds: 55,
          ledger: { requirements },
          evidenceSummary: {
            revision: 1,
            total: 30,
            pending: 29,
            inProgress: 0,
            verified: 1,
            blocked: 0,
          },
          noProgressEnabled: true,
          restartPolicy: 'pause',
          pendingBudgetSummary: false,
          gates,
          truncation: { truncated: true, notice: 'bounded recovery payload' },
        },
      },
      { expanded: true, isPartial: false },
      theme,
    );
    const lines = component.render(500).map((line) => line.trimEnd());
    const rendered = lines.join('\n');

    expect(lines.length).toBeLessThanOrEqual(20);
    expect(rendered).toContain('Requirements (30):');
    expect(rendered).toContain('… 26 more requirements');
    expect(rendered).toContain('… 8 more gates');
    expect(rendered).toContain('Payload: bounded recovery payload');
    expect(rendered).not.toContain('\u001b');
    expect(rendered.length).toBeLessThan(4_000);

    const narrowLines = component.render(60);
    expect(narrowLines.length).toBeLessThanOrEqual(20);
    expect(narrowLines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  it('recovers the bounded payload from text when details were omitted', () => {
    const payload = {
      goal: { id: 'goal-1', status: 'active' },
      evidenceSummary: { total: 1, verified: 1 },
      gates: [],
    };
    const rendered = renderGetGoalResult(
      { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      { expanded: false, isPartial: false },
      theme,
    )
      .render(500)
      .map((line) => line.trimEnd())
      .join('\n');

    expect(rendered).toBe('active · evidence 1/1 verified · 0 gates');
  });
});
