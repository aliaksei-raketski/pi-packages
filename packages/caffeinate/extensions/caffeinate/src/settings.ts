import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { CaffeinateMode } from './inhibitors.ts';

export interface CaffeinateSettings {
  enabled: boolean;
  mode: CaffeinateMode;
  quiet: boolean;
}

export interface LoadedSettings {
  settings: CaffeinateSettings;
  unknownFields: Record<string, unknown>;
  warning?: string;
}

export interface SettingsFileSystem {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export const DEFAULT_CAFFEINATE_SETTINGS: CaffeinateSettings = {
  enabled: true,
  mode: 'display',
  quiet: false,
};

const nodeFileSystem: SettingsFileSystem = {
  readFile: (path, encoding) => fs.readFile(path, encoding),
  mkdir: async (path, options) => {
    await fs.mkdir(path, options);
  },
  writeFile: (path, data, encoding) => fs.writeFile(path, data, encoding),
  rename: (from, to) => fs.rename(from, to),
  unlink: (path) => fs.unlink(path),
};

export function getSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, 'pi-caffeinate.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseSettings(raw: unknown): LoadedSettings {
  if (!isRecord(raw)) {
    return {
      settings: { ...DEFAULT_CAFFEINATE_SETTINGS },
      unknownFields: {},
      warning: 'pi-caffeinate settings must be a JSON object; using defaults.',
    };
  }

  const invalid: string[] = [];
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') invalid.push('enabled');
  if (raw.mode !== undefined && raw.mode !== 'display' && raw.mode !== 'sleep')
    invalid.push('mode');
  if (raw.quiet !== undefined && typeof raw.quiet !== 'boolean') invalid.push('quiet');
  if (invalid.length > 0) {
    return {
      settings: { ...DEFAULT_CAFFEINATE_SETTINGS },
      unknownFields: {},
      warning: `Invalid pi-caffeinate setting(s): ${invalid.join(', ')}; using defaults.`,
    };
  }

  const unknownFields = Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== 'enabled' && key !== 'mode' && key !== 'quiet'),
  );
  const enabled =
    typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CAFFEINATE_SETTINGS.enabled;
  const mode =
    raw.mode === 'sleep' || raw.mode === 'display' ? raw.mode : DEFAULT_CAFFEINATE_SETTINGS.mode;
  const quiet = typeof raw.quiet === 'boolean' ? raw.quiet : DEFAULT_CAFFEINATE_SETTINGS.quiet;
  return {
    settings: { enabled, mode, quiet },
    unknownFields,
  };
}

export async function loadSettings(
  path = getSettingsPath(),
  fileSystem: SettingsFileSystem = nodeFileSystem,
): Promise<LoadedSettings> {
  try {
    const text = await fileSystem.readFile(path, 'utf8');
    try {
      return parseSettings(JSON.parse(text));
    } catch (error) {
      return {
        settings: { ...DEFAULT_CAFFEINATE_SETTINGS },
        unknownFields: {},
        warning: `Could not parse ${path}; using defaults (${error instanceof Error ? error.message : String(error)}).`,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { settings: { ...DEFAULT_CAFFEINATE_SETTINGS }, unknownFields: {} };
    }
    return {
      settings: { ...DEFAULT_CAFFEINATE_SETTINGS },
      unknownFields: {},
      warning: `Could not read ${path}; using defaults (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

export async function saveSettings(
  settings: CaffeinateSettings,
  unknownFields: Record<string, unknown> = {},
  path = getSettingsPath(),
  fileSystem: SettingsFileSystem = nodeFileSystem,
  tempName = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`,
): Promise<void> {
  const temporaryPath = tempName.includes('/') ? tempName : join(dirname(path), tempName);
  await fileSystem.mkdir(dirname(path), { recursive: true });
  try {
    await fileSystem.writeFile(
      temporaryPath,
      `${JSON.stringify({ ...unknownFields, ...settings }, null, 2)}\n`,
      'utf8',
    );
    await fileSystem.rename(temporaryPath, path);
  } catch (error) {
    try {
      await fileSystem.unlink(temporaryPath);
    } catch {
      // Best effort cleanup must not mask the original persistence error.
    }
    throw error;
  }
}

export class SettingsStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly path = getSettingsPath(),
    readonly fileSystem: SettingsFileSystem = nodeFileSystem,
  ) {}

  load(): Promise<LoadedSettings> {
    return loadSettings(this.path, this.fileSystem);
  }

  save(settings: CaffeinateSettings, unknownFields: Record<string, unknown>): Promise<void> {
    const operation = this.queue.then(() =>
      saveSettings(settings, unknownFields, this.path, this.fileSystem),
    );
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
