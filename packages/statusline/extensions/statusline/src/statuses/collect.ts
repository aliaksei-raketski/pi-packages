import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from '@earendil-works/pi-coding-agent';
import type { GitStatusSource } from '../git-status.ts';
import type { StatuslineStatus } from '@aliaksei-raketski/pi-statusline-protocol';
import { STATUSLINE_PROVIDERS, collectFromProvider, isBuiltinStatusKey } from './registry.ts';
import type { StatuslineCollectContext, StatuslineItem } from './types.ts';
import { RESERVED_SPACER_TOKEN } from './types.ts';

function shouldCollect(requestedKeys: Set<string>, key: string): boolean {
  return requestedKeys.size === 0 || requestedKeys.has(key);
}

function collectBuiltinItems(context: StatuslineCollectContext): Map<string, StatuslineItem> {
  const items = new Map<string, StatuslineItem>();

  for (const provider of STATUSLINE_PROVIDERS) {
    if (!collectFromProvider(provider, context.requestedKeys)) {
      continue;
    }

    for (const item of provider.collect(context)) {
      if (shouldCollect(context.requestedKeys, item.key)) {
        items.set(item.key, item);
      }
    }
  }

  return items;
}

function collectRawStatusesIfNeeded(
  requestedKeys: Set<string>,
  footerStatuses: ReadonlyFooterDataProvider['getExtensionStatuses'],
): Map<string, string> | undefined {
  const customKeys = Array.from(requestedKeys).filter(
    (key) => key !== RESERVED_SPACER_TOKEN && key !== 'statuses' && !isBuiltinStatusKey(key),
  );

  const shouldCollectStatuses = requestedKeys.has('statuses') || customKeys.length > 0;
  if (!shouldCollectStatuses) {
    return undefined;
  }

  return new Map(footerStatuses());
}

export function collectStatusItems(
  extensionContext: ExtensionContext,
  extensionApi: ExtensionAPI,
  footerData: ReadonlyFooterDataProvider,
  requestedKeys: Set<string> = new Set(),
  gitStatusSource: GitStatusSource = {},
  protocolStatuses: Map<string, StatuslineStatus> = new Map(),
): Map<string, StatuslineItem> {
  const collectContext: StatuslineCollectContext = {
    extensionContext,
    extensionApi,
    footerData,
    requestedKeys,
    gitStatusSource,
  };

  const items = collectBuiltinItems(collectContext);

  for (const [key, status] of protocolStatuses) {
    if (!shouldCollect(requestedKeys, key)) {
      continue;
    }

    items.set(key, {
      key: status.key,
      text: status.text,
      state: status.state,
      source: 'protocol',
    });
  }

  const extensionStatuses = collectRawStatusesIfNeeded(
    requestedKeys,
    footerData.getExtensionStatuses,
  );
  if (!extensionStatuses) {
    return items;
  }

  if (shouldCollect(requestedKeys, 'statuses')) {
    const entries: string[] = [];
    for (const [key, status] of protocolStatuses) {
      entries.push(`${key}: ${status.text}`);
    }

    for (const [key, text] of extensionStatuses) {
      if (!protocolStatuses.has(key)) {
        entries.push(`${key}: ${text}`);
      }
    }

    if (entries.length > 0) {
      items.set('statuses', {
        key: 'statuses',
        text: entries.join(' • '),
      });
    }
  }

  for (const key of requestedKeys) {
    if (isBuiltinStatusKey(key) || key === 'statuses' || key === RESERVED_SPACER_TOKEN) {
      continue;
    }

    const existing = items.get(key);
    if (existing) {
      continue;
    }

    const text = extensionStatuses.get(key);
    if (text !== undefined) {
      items.set(key, {
        key,
        text,
      });
    }
  }

  return items;
}
