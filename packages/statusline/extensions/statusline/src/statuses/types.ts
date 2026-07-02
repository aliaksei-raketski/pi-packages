import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from '@earendil-works/pi-coding-agent';
import type { GitStatusSource } from '../git-status.ts';

export interface StatuslineItem {
  key: string;
  text: string;
  state?: string;
  source?: string;
}

export interface StatuslineCollectContext {
  extensionContext: ExtensionContext;
  extensionApi: ExtensionAPI;
  footerData: ReadonlyFooterDataProvider;
  requestedKeys: Set<string>;
  gitStatusSource: GitStatusSource;
}

export interface StatuslineProvider {
  keys: readonly string[];
  collect(context: StatuslineCollectContext): Iterable<StatuslineItem>;
}

export const RESERVED_SPACER_TOKEN = 'spacer';
