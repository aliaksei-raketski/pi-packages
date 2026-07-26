import { win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CAFFEINATE_SETTINGS,
  parseSettings,
  resolveTemporaryPath,
  SettingsStore,
  type SettingsFileSystem,
} from '../src/settings.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('caffeinate settings', () => {
  it('does not duplicate an absolute Windows temporary path', () => {
    const path = 'C:\\Users\\me\\.pi\\pi-caffeinate.json';
    const temporaryPath = `${path}.123.tmp`;

    expect(resolveTemporaryPath(path, temporaryPath, win32)).toBe(temporaryPath);
  });

  it('marks malformed and invalid settings as protected from saves', () => {
    expect(parseSettings(null).canSave).toBe(false);
    expect(parseSettings({ mode: 'invalid' }).canSave).toBe(false);
    expect(parseSettings({ mode: 'sleep', future: 1 })).toMatchObject({
      canSave: true,
      settings: { mode: 'sleep' },
      unknownFields: { future: 1 },
    });
  });

  it('serializes a load behind an in-flight save', async () => {
    const pendingWrite = deferred<void>();
    const calls: string[] = [];
    const fileSystem: SettingsFileSystem = {
      readFile: vi.fn(async () => {
        calls.push('read');
        return JSON.stringify(DEFAULT_CAFFEINATE_SETTINGS);
      }),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => {
        calls.push('write');
        await pendingWrite.promise;
      }),
      rename: vi.fn(async () => {
        calls.push('rename');
      }),
      unlink: vi.fn(async () => undefined),
    };
    const store = new SettingsStore('/tmp/pi-caffeinate.json', fileSystem);

    const saving = store.save(DEFAULT_CAFFEINATE_SETTINGS, {});
    const loading = store.load();
    await vi.waitFor(() => expect(calls).toEqual(['write']));
    expect(fileSystem.readFile).not.toHaveBeenCalled();

    pendingWrite.resolve();
    await saving;
    await loading;
    expect(calls).toEqual(['write', 'rename', 'read']);
  });
});
