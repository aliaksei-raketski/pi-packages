import type { BashOperations } from '@earendil-works/pi-coding-agent';

import type { TmuxBashRuntime } from './runtime.js';

export function createTmuxUserBashOperations(runtime: TmuxBashRuntime): BashOperations {
  return {
    exec: (command, cwd, options) => runtime.executeUserBash(command, cwd, options),
  };
}
