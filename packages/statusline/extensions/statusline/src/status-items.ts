import type { StatuslineStatus } from '@aliaksei-raketski/pi-statusline-protocol';
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from '@earendil-works/pi-coding-agent';
import type { GitStatusSource } from './git-status.ts';
import { collectStatusItems as collectStatuslineItems } from './statuses/collect.ts';
import type { StatuslineItem } from './statuses/types.ts';

export type { StatuslineItem } from './statuses/types.ts';

export function collectStatusItems(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  footerData: ReadonlyFooterDataProvider,
  requestedKeys: Set<string> = new Set(),
  gitStatusSource: GitStatusSource = {},
  protocolStatuses: Map<string, StatuslineStatus> = new Map(),
): Map<string, StatuslineItem> {
  return collectStatuslineItems(
    ctx,
    pi,
    footerData,
    requestedKeys,
    gitStatusSource,
    protocolStatuses,
  );
}
