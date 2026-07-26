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
      expect(guidelines).toContain('set waitForCompletion explicitly');
      expect(guidelines).toContain('false for persistent servers, watchers, and REPLs');
      expect(description).toContain(`configured default is ${String(configuredDefault)}`);
      expect(description).toContain('set false for persistent servers, watchers, and REPLs');
    },
  );
});
