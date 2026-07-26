import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerGoalRuntime } from './goal-runtime.ts';

/** Extension entrypoint; session-scoped wiring lives in goal-runtime. */
export function goal(pi: ExtensionAPI): void {
  registerGoalRuntime(pi);
}
