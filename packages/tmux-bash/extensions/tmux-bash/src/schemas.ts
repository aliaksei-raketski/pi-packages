import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type TSchema } from 'typebox';

import type { TmuxAction, TmuxBashConfig } from './types.js';

export function createBashInputSchema(config: TmuxBashConfig): TSchema {
  const configuredDefault = config.defaultWaitForBackgroundCompletion ? 'true' : 'false';

  return Type.Object(
    {
      command: Type.String({ minLength: 1, description: 'Shell command to execute.' }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      timeout: Type.Optional(Type.Number({ minimum: 1 })),
      timeoutAction: Type.Optional(StringEnum(['background', 'kill'] as const)),
      background: Type.Optional(Type.Boolean()),
      pollInterval: Type.Optional(Type.Number({ minimum: 1 })),
      pollLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
      completionDelivery: Type.Optional(
        StringEnum(['model', 'display', 'next-turn'] as const, {
          description:
            'Completion policy: model follow-up, display-only wake=none, or persistence for the next natural turn.',
        }),
      ),
      waitForCompletion: Type.Optional(
        Type.Boolean({
          description:
            `Gate autonomous continuation until this command completes. For explicit background commands, the configured default is ${configuredDefault}. ` +
            'Set true for every finite command whose result is required, including tests, builds, and subagents, regardless of duration or concurrent productive work. ' +
            'Set false only for processes intentionally expected to remain alive indefinitely, such as servers, watchers, and REPLs; never set false merely because a command is slow or long-running.',
        }),
      ),
    },
    { additionalProperties: false },
  );
}

export interface BashInput {
  command: string;
  name?: string;
  timeout?: number;
  timeoutAction?: 'background' | 'kill';
  background?: boolean;
  pollInterval?: number;
  pollLines?: number;
  completionDelivery?: 'model' | 'display' | 'next-turn';
  waitForCompletion?: boolean;
}

export function createTmuxInputSchema(config: TmuxBashConfig): TSchema {
  const actions = config.enabledTmuxActions as [TmuxAction, ...TmuxAction[]];
  return Type.Object(
    {
      action: StringEnum(actions),
      windowId: Type.Optional(
        Type.String({ pattern: '^@[0-9]+$', description: 'Stable tmux window ID, such as @123.' }),
      ),
      interval: Type.Optional(Type.Number({ minimum: 1 })),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
      text: Type.Optional(
        Type.String({ description: 'Literal UTF-8 input. Never use this field for secrets.' }),
      ),
      submit: Type.Optional(Type.Boolean({ description: 'Send Enter after literal input.' })),
      key: Type.Optional(StringEnum(['enter', 'escape', 'ctrl-c', 'ctrl-d'] as const)),
    },
    { additionalProperties: false },
  );
}

export type TmuxInput = {
  action: TmuxAction;
  windowId?: string;
  interval?: number;
  lines?: number;
  text?: string;
  submit?: boolean;
  key?: 'enter' | 'escape' | 'ctrl-c' | 'ctrl-d';
};
