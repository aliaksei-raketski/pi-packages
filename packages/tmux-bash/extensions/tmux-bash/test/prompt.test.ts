import { describe, expect, it } from 'vitest';

import { DEFAULT_TMUX_BASH_CONFIG } from '../src/config.js';
import {
  createBashPromptGuidelines,
  createTmuxPromptGuidelines,
  createTmuxToolDescription,
} from '../src/prompt.js';
import { createBashInputSchema } from '../src/schemas.js';
import type { TmuxBashConfig } from '../src/types.js';

function configWithBackgroundWaitDefault(value: boolean): TmuxBashConfig {
  return {
    ...DEFAULT_TMUX_BASH_CONFIG,
    defaultWaitForBackgroundCompletion: value,
  };
}

function waitForCompletionDescription(config: TmuxBashConfig): string {
  const schema = createBashInputSchema(config) as {
    properties: { waitForCompletion: { description?: string } };
  };
  return schema.properties.waitForCompletion.description ?? '';
}

describe('tmux-bash model guidance', () => {
  it.each([true, false])(
    'exposes the configured background wait default (%s) in prompt and schema guidance',
    (configuredDefault) => {
      const config = configWithBackgroundWaitDefault(configuredDefault);
      const guidelines = createBashPromptGuidelines(config).join('\n');
      const description = waitForCompletionDescription(config);

      expect(guidelines).toContain(
        `waitForCompletion defaults to ${String(configuredDefault)} in this installation`,
      );
      expect(guidelines).toContain(
        'waitForCompletion: true for every finite background command whose result is required',
      );
      expect(guidelines).toContain('regardless of how long it may run');
      expect(guidelines).toContain('waitForCompletion: false only for processes intentionally');
      expect(guidelines).toContain('as the only tool call in its assistant response');
      expect(guidelines).toContain('stop immediately; completion will resume work automatically');
      expect(guidelines).toContain('call tmux action await once');
      expect(guidelines).toContain(
        'do not repeatedly call goal tools, poll, or emit waiting updates',
      );
      expect(description).toContain(`configured default is ${String(configuredDefault)}`);
      expect(description).toContain('true for every finite command whose result is required');
      expect(description).toContain('false only for processes intentionally expected');
      expect(description).toContain('never set false merely because a command is slow');
    },
  );

  it('keeps tmux descriptions and guidance aligned with the enabled action schema', () => {
    const config: TmuxBashConfig = {
      ...DEFAULT_TMUX_BASH_CONFIG,
      enabledTmuxActions: ['list', 'peek', 'await', 'unawait'],
    };
    const bashGuidelines = createBashPromptGuidelines(config).join('\n');
    const tmuxGuidelines = createTmuxPromptGuidelines(config).join('\n');
    const description = createTmuxToolDescription(config);

    expect(description).toContain('Available actions: list, peek, await, unawait.');
    expect(description).not.toContain('cleanup');
    expect(tmuxGuidelines).not.toContain('cleanup');
    expect(tmuxGuidelines).not.toContain('attach');
    expect(tmuxGuidelines).not.toContain('send-input');
    expect(bashGuidelines).not.toContain('cleanup');
    expect(bashGuidelines).not.toContain('attach');
    expect(bashGuidelines).not.toContain('send-input');
  });

  it('includes enhancement safety guidance only when each action is enabled', () => {
    const defaultDescription = createTmuxToolDescription(DEFAULT_TMUX_BASH_CONFIG);
    const defaultGuidelines = createTmuxPromptGuidelines(DEFAULT_TMUX_BASH_CONFIG).join('\n');

    expect(defaultDescription).toContain('attach');
    expect(defaultDescription).toContain('cleanup-preview, cleanup');
    expect(defaultDescription).not.toContain('send-input');
    expect(defaultGuidelines).toContain('Tmux attach only presents a safe command');
    expect(defaultGuidelines).toContain('Use tmux cleanup-preview before tmux cleanup');
    expect(defaultGuidelines).not.toContain('send-input');

    const interactiveConfig: TmuxBashConfig = {
      ...DEFAULT_TMUX_BASH_CONFIG,
      interactiveInputEnabled: true,
      enabledTmuxActions: [...DEFAULT_TMUX_BASH_CONFIG.enabledTmuxActions, 'send-input'],
    };
    expect(createTmuxPromptGuidelines(interactiveConfig).join('\n')).toContain(
      'Never use tmux send-input for secrets',
    );
  });
});
