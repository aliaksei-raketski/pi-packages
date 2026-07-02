import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { StatuslineCollectContext, StatuslineItem, StatuslineProvider } from '../types.ts';

interface ProjectNameCacheEntry {
  name: string;
  mtimeMs?: number;
}

const PROJECT_NAME_CACHE = new Map<string, ProjectNameCacheEntry>();

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

function shouldCollect(requestedKeys: Set<string>): boolean {
  return requestedKeys.size === 0 || requestedKeys.has('project');
}

export const projectProvider: StatuslineProvider = {
  keys: ['project'],
  collect(context: StatuslineCollectContext): StatuslineItem[] {
    if (!shouldCollect(context.requestedKeys)) {
      return [];
    }

    return [{ key: 'project', text: collectProjectValue(context.extensionContext.cwd) }];
  },
};
