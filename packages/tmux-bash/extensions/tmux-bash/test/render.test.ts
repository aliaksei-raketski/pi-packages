import { describe, expect, it } from 'vitest';

import { renderBashCall, renderBashResult } from '../src/render.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe('bash result rendering', () => {
  it('renders textual tool errors when tmux details are unavailable', () => {
    const rendered = renderBashResult(
      { content: [{ type: 'text', text: 'tmux bash command was cancelled.' }] },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(rendered.render(100).join('\n')).toContain('tmux bash command was cancelled.');
    expect(rendered.render(100).join('\n')).not.toContain('No output');
  });

  it('keeps completion summaries while applying independent compact and expanded limits', () => {
    const result = {
      content: [
        {
          type: 'text',
          text: Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join('\n'),
        },
      ],
      details: {
        state: 'completed',
        exitCode: 0,
        awaited: false,
        outputFile: '/tmp/full.out',
      },
    } as never;
    const limits = {
      completedCompactDisplayLines: 5,
      completedExpandedDisplayLines: 7,
    };

    const compact = renderBashResult(result, { expanded: false, isPartial: false }, theme, limits)
      .render(200)
      .map((line) => line.trimEnd());
    const expanded = renderBashResult(result, { expanded: true, isPartial: false }, theme, limits)
      .render(200)
      .map((line) => line.trimEnd());

    expect(compact).toEqual([
      'completed (0)',
      'Full output: /tmp/full.out',
      '… 7 earlier lines omitted from display …',
      'line-8',
      'line-9',
      'line-10',
    ]);
    expect(expanded).toHaveLength(8);
    expect(expanded[0]).toBe('completed (0)');
    expect(expanded).toContain('line-10');
  });

  it('preserves model truncation notices and full-output paths when display is collapsed', () => {
    const rendered = renderBashResult(
      {
        content: [
          {
            type: 'text',
            text: '[Output truncated: Full output: /tmp/model-full.out]\na\nb\nc\nd\ne\nf',
          },
        ],
        details: {
          state: 'completed',
          exitCode: 0,
          awaited: false,
          outputFile: '/tmp/model-full.out',
        },
      } as never,
      { expanded: false, isPartial: false },
      theme,
      { completedCompactDisplayLines: 4, completedExpandedDisplayLines: 20 },
    );
    const lines = rendered.render(200).map((line) => line.trimEnd());

    expect(lines[0]).toBe('completed (0)');
    expect(lines[1]).toContain('Output truncated');
    expect(lines[1]).toContain('/tmp/model-full.out');
    expect(lines[2]).toBe('… 4 earlier lines omitted from display …');
    expect(lines.slice(-2)).toEqual(['e', 'f']);
  });

  it('does not pass untrusted command or output control sequences to Text', () => {
    const call = renderBashCall({ command: 'printf safe\u001b]0;hostile\u0007-title' }, theme);
    const result = renderBashResult(
      { content: [{ type: 'text', text: 'safe\u001b]52;c;YQ==\u0007-output' }] },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(call.render(100).join('\n')).toContain('printf safe-title');
    expect(result.render(100).join('\n')).toContain('safe-output');
    expect(`${call.render(100).join('\n')}${result.render(100).join('\n')}`).not.toContain(
      '\u001b]',
    );
  });
});
