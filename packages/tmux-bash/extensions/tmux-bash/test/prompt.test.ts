import { describe, expect, it } from 'vitest';

import { DEFAULT_TMUX_BASH_CONFIG } from '../src/config.js';
import { createBashPromptGuidelines } from '../src/prompt.js';
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
      expect(guidelines).toContain('use tmux action await');
      expect(guidelines).toContain('do not repeatedly call goal tools or emit waiting updates');
      expect(description).toContain(`configured default is ${String(configuredDefault)}`);
      expect(description).toContain('true for every finite command whose result is required');
      expect(description).toContain('false only for processes intentionally expected');
      expect(description).toContain('never set false merely because a command is slow');
    },
  );
});
