import { describe, expect, it } from 'vitest';

import { renderBashResult } from '../src/render.js';

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
});
