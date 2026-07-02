import type { StatuslineProvider } from './types.ts';
import { branchProvider } from './builtins/branch.ts';
import { changesProvider } from './builtins/changes.ts';
import { contextProvider } from './builtins/context.ts';
import { cwdProvider } from './builtins/cwd.ts';
import { modelProvider } from './builtins/model.ts';
import { prProvider } from './builtins/pr.ts';
import { projectProvider } from './builtins/project.ts';
import { thinkingProvider } from './builtins/thinking.ts';
import { titleProvider } from './builtins/title.ts';
import { usageProvider } from './builtins/usage.ts';

export type BuiltinStatusKey =
  | 'cwd'
  | 'branch'
  | 'title'
  | 'model'
  | 'thinking'
  | 'changes'
  | 'pr'
  | 'project'
  | 'context'
  | 'tokens'
  | 'cache'
  | 'cost'
  | 'statuses';

export const BUILTIN_STATUS_KEYS: Set<string> = new Set<BuiltinStatusKey>([
  'cwd',
  'branch',
  'title',
  'model',
  'thinking',
  'changes',
  'pr',
  'project',
  'context',
  'tokens',
  'cache',
  'cost',
  'statuses',
]);

export const STATUSLINE_PROVIDERS: readonly StatuslineProvider[] = [
  cwdProvider,
  branchProvider,
  titleProvider,
  modelProvider,
  thinkingProvider,
  changesProvider,
  prProvider,
  projectProvider,
  contextProvider,
  usageProvider,
];

export function isBuiltinStatusKey(value: string): value is BuiltinStatusKey {
  return BUILTIN_STATUS_KEYS.has(value);
}

export function collectFromProvider(
  provider: StatuslineProvider,
  requestedKeys: Set<string>,
): boolean {
  return provider.keys.some((key) => requestedKeys.size === 0 || requestedKeys.has(key));
}
