import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type {
  ExtensionContext,
  ExtensionAPI,
  ReadonlyFooterDataProvider,
} from '@earendil-works/pi-coding-agent';
import {
  formatGitStatusChanges,
  formatPullRequest,
  isBranchDirty,
  type GitStatusSnapshot,
  type GitStatusSource,
} from './git-status.ts';

export interface StatusValue {
  text: string;
  state?: string;
}

export type BuiltinStatusKey =
  | 'cwd'
  | 'branch'
  | 'title'
  | 'model'
  | 'thinking'
  | 'changes'
  | 'context'
  | 'tokens'
  | 'cache'
  | 'cost'
  | 'project'
  | 'pr'
  | 'statuses';

const BUILTIN_STATUS_KEYS: Set<string> = new Set([
  'cwd',
  'branch',
  'title',
  'model',
  'thinking',
  'changes',
  'context',
  'tokens',
  'cache',
  'cost',
  'project',
  'pr',
  'statuses',
]);

function isBuiltinStatusKey(key: string): key is BuiltinStatusKey {
  return BUILTIN_STATUS_KEYS.has(key);
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface ProjectNameCacheEntry {
  name: string;
  mtimeMs?: number;
}

const PROJECT_NAME_CACHE = new Map<string, ProjectNameCacheEntry>();

function formatNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return `${Math.round(value)}`;
}

function formatContextWindow(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${Math.round(value)}`;
}

function formatContextPercent(percent: number): string {
  return `${percent.toFixed(1).replace(/\.0$/, '')}%`;
}

function shortPath(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) {
    const suffix = cwd === home ? '' : relative(home, cwd);
    return `~${suffix ? `/${suffix}` : ''}`;
  }
  return basename(cwd);
}

function collectProjectValue(cwd: string): string {
  const packagePath = join(cwd, 'package.json');
  if (!existsSync(packagePath)) {
    PROJECT_NAME_CACHE.delete(cwd);
    return basename(cwd);
  }

  let mtimeMs: number | undefined;
  try {
    mtimeMs = statSync(packagePath).mtimeMs;
  } catch {
    PROJECT_NAME_CACHE.delete(cwd);
    return basename(cwd);
  }

  const cached = PROJECT_NAME_CACHE.get(cwd);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.name;
  }

  let name = basename(cwd);
  try {
    const raw = readFileSync(packagePath, 'utf-8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed.name === 'string' && parsed.name) {
      name = parsed.name;
    }
  } catch {
    name = basename(cwd);
  }

  PROJECT_NAME_CACHE.set(cwd, { name, mtimeMs });
  return name;
}

function collectUsageTotals(ctx: ExtensionContext): UsageTotals {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'message') {
      continue;
    }

    const message = entry.message as {
      role?: string;
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: { total?: number };
      };
    };

    if (message.role !== 'assistant' || !message.usage) {
      continue;
    }

    const usage = message.usage;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.cost += usage.cost?.total ?? 0;
  }

  return totals;
}

function collectChangesText(changes: GitStatusSnapshot | undefined): string | undefined {
  return formatGitStatusChanges(changes);
}

function resolveBranchChangesState(gitStatus: GitStatusSnapshot | undefined): 'dirty' | 'clean' {
  return isBranchDirty(gitStatus) ? 'dirty' : 'clean';
}

function collectContextValue(ctx: ExtensionContext): StatusValue | undefined {
  const contextUsage = ctx.getContextUsage();
  if (!contextUsage || contextUsage.tokens === null || contextUsage.percent === null) {
    return undefined;
  }

  const percent = contextUsage.percent;
  const value = `${formatContextPercent(percent)}/${formatContextWindow(contextUsage.contextWindow)}`;

  let state: string;
  if (percent >= 90) {
    state = 'full';
  } else if (percent >= 70) {
    state = 'warning';
  } else {
    state = 'normal';
  }

  return { text: value, state };
}

function collectModelValue(ctx: ExtensionContext): StatusValue | undefined {
  const model = ctx.model;
  if (!model) {
    return { text: 'unknown' };
  }

  const modelData = model as { id?: string; modelId?: string };
  const modelId =
    typeof modelData.id === 'string'
      ? modelData.id
      : typeof modelData.modelId === 'string'
        ? modelData.modelId
        : 'unknown';

  return { text: modelId };
}

function collectThinkingValue(pi: ExtensionAPI): StatusValue {
  const level = pi.getThinkingLevel();
  return { text: level, state: level };
}

export function collectStatusItems(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  footerData: ReadonlyFooterDataProvider,
  requestedKeys: Set<string> = new Set(),
  gitStatusSource?: GitStatusSource,
): Map<string, StatusValue> {
  const items = new Map<string, StatusValue>();
  const should = (key: string): boolean => requestedKeys.size === 0 || requestedKeys.has(key);

  if (should('cwd')) {
    items.set('cwd', { text: shortPath(ctx.cwd) });
  }

  const includeChangesForBranch = should('branch') || should('changes') || should('pr');
  const changesStatus = includeChangesForBranch ? gitStatusSource?.gitStatus : undefined;
  const prValue = should('pr') ? formatPullRequest(gitStatusSource?.pullRequest) : undefined;

  if (should('branch')) {
    const branch = footerData.getGitBranch() || gitStatusSource?.gitStatus?.branch;
    if (branch) {
      items.set('branch', {
        text: branch,
        state: resolveBranchChangesState(changesStatus),
      });
    }
  }

  if (should('title')) {
    const sessionName = ctx.sessionManager.getSessionName();
    if (sessionName) {
      items.set('title', { text: sessionName });
    }
  }

  if (should('model')) {
    const model = collectModelValue(ctx);
    if (model) {
      items.set('model', model);
    }
  }

  if (should('thinking')) {
    items.set('thinking', collectThinkingValue(pi));
  }

  if (should('changes')) {
    const changesText = collectChangesText(changesStatus);
    if (changesText) {
      items.set('changes', { text: changesText });
    }
  }

  if (should('pr') && prValue) {
    items.set('pr', { text: prValue });
  }

  if (should('project')) {
    items.set('project', { text: collectProjectValue(ctx.cwd) });
  }

  if (should('context')) {
    const contextValue = collectContextValue(ctx);
    if (contextValue) {
      items.set('context', contextValue);
    }
  }

  const includeUsage = should('tokens') || should('cache') || should('cost');
  if (includeUsage) {
    const usageTotals = collectUsageTotals(ctx);

    if (should('tokens')) {
      const tokensValue = `${formatNumber(usageTotals.input)}↑ ${formatNumber(usageTotals.output)}↓`;
      items.set('tokens', { text: tokensValue });
    }

    if (should('cache')) {
      const totalCache = usageTotals.cacheRead + usageTotals.cacheWrite;
      const cacheHitPercent =
        totalCache > 0 ? Math.round((usageTotals.cacheRead / totalCache) * 100) : 0;
      items.set('cache', {
        text: `${formatNumber(usageTotals.cacheRead)}/${formatNumber(usageTotals.cacheWrite)} ${cacheHitPercent}%`,
      });
    }

    if (should('cost')) {
      items.set('cost', { text: `$${usageTotals.cost.toFixed(2)}` });
    }
  }

  const customStatusKeys = Array.from(requestedKeys).filter(
    (key) => !isBuiltinStatusKey(key) && key !== 'spacer',
  );

  if (should('statuses') || customStatusKeys.length > 0) {
    const statuses = footerData.getExtensionStatuses();
    if (should('statuses') && statuses.size > 0) {
      const entries = Array.from(statuses.entries()).map(([name, text]) => `${name}: ${text}`);
      items.set('statuses', { text: entries.join(' • ') });
    }

    for (const key of customStatusKeys) {
      const status = statuses.get(key);
      if (status !== undefined) {
        items.set(key, { text: status });
      }
    }
  }

  return items;
}
