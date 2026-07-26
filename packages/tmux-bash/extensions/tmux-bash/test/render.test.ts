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
