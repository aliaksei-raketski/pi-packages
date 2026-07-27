import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildAttachCommand,
  deriveTmuxSession,
  listManagedTmuxWindows,
  managedWindowMetadataEntries,
  parseManagedRunManifest,
  parseManagedWindowMetadata,
  resolveTmuxWorkspaceScope,
  sameManagedWindowOwner,
  sameTmuxWorkspaceScope,
  shortHash,
  TMUX_BASH_METADATA_KEYS,
  TMUX_BASH_OWNERSHIP_MARKER,
  validateManagedRunManifestPaths,
  type ManagedRunManifest,
  type ManagedWindowMetadata,
  type TmuxCommandResult,
} from '../index.js';

const root = '/tmp/pi-tmux-artifacts';
const metadata: ManagedWindowMetadata = {
  owner: TMUX_BASH_OWNERSHIP_MARKER,
  scope: { kind: 'git-root', root: '/workspace/repo', hash: shortHash('/workspace/repo') },
  piSessionId: 'session-123',
  runId: 'run-12345678',
  manifestPath: `${root}/run-12345678.manifest.json`,
  completionId: 'completion-12345678',
  completionDelivery: 'model',
  startedAt: 100,
  displayCommand: 'printf hello',
};

function manifest(overrides: Partial<ManagedRunManifest> = {}): ManagedRunManifest {
  return {
    runId: 'run-12345678',
    completionId: 'completion-12345678',
    piSessionId: 'session-123',
    scope: metadata.scope,
    cwd: '/workspace/repo',
    tmuxSession: 'pi-repo',
    windowId: '@7',
    commandFile: `${root}/run-12345678.command`,
    scriptFile: `${root}/run-12345678.sh`,
    outputFile: `${root}/run-12345678.out`,
    exitCodeFile: `${root}/run-12345678.exit`,
    displayCommand: 'printf hello',
    startedAt: 100,
    mode: 'background',
    state: 'running',
    awaited: true,
    continuationDomain: 'autonomous-continuation',
    completionDelivery: 'model',
    deliveryState: 'pending',
    outputWasRotated: false,
    updatedAt: 100,
    ...overrides,
  };
}

describe('workspace scopes and names', () => {
  it('prefers and canonicalizes a Git root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tmux-core-'));
    try {
      const nested = join(directory, 'nested');
      await mkdir(nested);
      const scope = await resolveTmuxWorkspaceScope(nested, {
        resolveGitRoot: async () => directory,
        realpath,
      });
      expect(scope).toEqual({
        kind: 'git-root',
        root: directory,
        hash: shortHash(directory),
        displayName: directory.split('/').at(-1),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires opt-in before using a canonical cwd scope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tmux-core-'));
    try {
      const host = { resolveGitRoot: async () => undefined, realpath };
      await expect(resolveTmuxWorkspaceScope(directory, host)).rejects.toThrow('Git worktree');
      const scope = await resolveTmuxWorkspaceScope(directory, host, { nonGitScope: 'cwd' });
      expect(scope.kind).toBe('cwd');
      expect(scope.root).toBe(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('canonicalizes symlinked cwd scopes and rejects deleted or inaccessible paths', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tmux-core-symlink-'));
    try {
      const actual = join(parent, 'actual');
      const linked = join(parent, 'linked');
      await mkdir(actual);
      await symlink(actual, linked);
      const host = { resolveGitRoot: async () => undefined, realpath };
      const scope = await resolveTmuxWorkspaceScope(linked, host, { nonGitScope: 'cwd' });
      expect(scope.root).toBe(actual);
      const renamed = join(parent, 'renamed');
      await rename(actual, renamed);
      await expect(
        resolveTmuxWorkspaceScope(actual, host, { nonGitScope: 'cwd' }),
      ).rejects.toThrow();
      const renamedScope = await resolveTmuxWorkspaceScope(renamed, host, { nonGitScope: 'cwd' });
      expect(renamedScope.root).toBe(renamed);
      expect(renamedScope.hash).not.toBe(scope.hash);
      await expect(
        resolveTmuxWorkspaceScope(join(parent, 'missing'), host, { nonGitScope: 'cwd' }),
      ).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('isolates same-basename cwd scopes and derives hash-based sessions', async () => {
    const left = '/a/project';
    const right = '/b/project';
    expect(shortHash(left)).not.toBe(shortHash(right));
    expect(
      sameTmuxWorkspaceScope(
        { kind: 'cwd', root: left, hash: shortHash(left) },
        { kind: 'cwd', root: right, hash: shortHash(right) },
      ),
    ).toBe(false);
    const config = {
      tmuxSessionScope: 'workspace' as const,
      globalTmuxSessionName: 'global',
      gitRootTmuxSessionNameTemplate: 'git-{scopeHash}',
      cwdTmuxSessionNameTemplate: 'cwd-{scopeName}-{scopeHash}',
      tmuxWindowNameTemplate: '{name}-{runId}',
      maxTmuxWindowNameLength: 64,
    };
    expect(
      deriveTmuxSession(config, {
        kind: 'cwd',
        root: left,
        hash: shortHash(left),
        displayName: 'project',
      }),
    ).not.toBe(
      deriveTmuxSession(config, {
        kind: 'cwd',
        root: right,
        hash: shortHash(right),
        displayName: 'project',
      }),
    );
  });
});

describe('manifest parser', () => {
  it('accepts only the current strict structural shape', () => {
    expect(parseManagedRunManifest(manifest(), { artifactRoot: root })).toEqual(manifest());
    expect(() =>
      parseManagedRunManifest({ ...manifest(), protocolVersion: 1 }, { artifactRoot: root }),
    ).toThrow('unexpected field');
    const { continuationDomain: missing, ...incomplete } = manifest();
    expect(missing).toBe('autonomous-continuation');
    expect(() => parseManagedRunManifest(incomplete, { artifactRoot: root })).toThrow(
      'continuationDomain',
    );
  });

  it('uses one leading-alphanumeric identifier grammar across manifests and metadata', () => {
    expect(() =>
      parseManagedRunManifest(manifest({ runId: '________' }), { artifactRoot: root }),
    ).toThrow();
    expect(() =>
      parseManagedWindowMetadata(
        Object.fromEntries(managedWindowMetadataEntries({ ...metadata, runId: '________' })),
      ),
    ).toThrow();
  });

  it('rejects traversal, mismatched IDs, NULs, and inconsistent timestamps', () => {
    expect(() =>
      parseManagedRunManifest(manifest({ outputFile: '/tmp/escape.out' }), {
        artifactRoot: root,
      }),
    ).toThrow('escapes');
    expect(() =>
      parseManagedRunManifest(manifest(), { artifactRoot: root, expectedRunId: 'another-run' }),
    ).toThrow('does not match');
    expect(() =>
      parseManagedRunManifest(manifest({ cwd: '/tmp/bad\0path' }), { artifactRoot: root }),
    ).toThrow('invalid');
    expect(() =>
      parseManagedRunManifest(manifest({ state: 'completed', endedAt: 99 }), {
        artifactRoot: root,
      }),
    ).toThrow('precede');
  });

  it('requires private, regular, owned artifact paths inside the canonical root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tmux-core-manifest-paths-'));
    const paths = {
      commandFile: join(directory, 'run-12345678.command'),
      scriptFile: join(directory, 'run-12345678.sh'),
      outputFile: join(directory, 'run-12345678.out'),
      exitCodeFile: join(directory, 'run-12345678.exit'),
    };
    try {
      await Promise.all(
        [paths.commandFile, paths.scriptFile, paths.outputFile].map((path) =>
          writeFile(path, '', { mode: 0o600 }),
        ),
      );
      const value = manifest(paths);
      await expect(
        validateManagedRunManifestPaths(value, directory, { realpath, lstat }),
      ).resolves.toBeUndefined();
      await chmod(paths.outputFile, 0o644);
      await expect(
        validateManagedRunManifestPaths(value, directory, { realpath, lstat }),
      ).rejects.toThrow('permissions are not private');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects parser fuzz values without coercion or crashes', () => {
    const fuzz = [null, [], '', 1, true, { ...manifest(), runId: '../escape' }];
    for (const value of fuzz) {
      expect(() => parseManagedRunManifest(value, { artifactRoot: root })).toThrow();
    }
    for (const field of ['scope', 'completionDelivery', 'deliveryState', 'updatedAt'] as const) {
      expect(() =>
        parseManagedRunManifest(
          { ...manifest(), [field]: { unexpected: true } },
          { artifactRoot: root },
        ),
      ).toThrow();
    }
  });
});

describe('metadata and discovery', () => {
  it('round-trips complete metadata and compares ownership', () => {
    const options = Object.fromEntries(managedWindowMetadataEntries(metadata));
    const parsed = parseManagedWindowMetadata(options);
    expect(parsed).toEqual(metadata);
    expect(sameManagedWindowOwner(parsed, metadata)).toBe(true);
    expect(sameManagedWindowOwner({ ...parsed, runId: 'other-run-123' }, metadata)).toBe(false);
  });

  it('queries options independently and omits command text by default', async () => {
    const options = Object.fromEntries(managedWindowMetadataEntries(metadata));
    const calls: string[][] = [];
    const execute = async (args: readonly string[]): Promise<TmuxCommandResult> => {
      calls.push([...args]);
      if (args[0] === 'list-windows') return { stdout: '@7\n', stderr: '', code: 0 };
      const key = args.at(-1) ?? '';
      const value = options[key];
      return value === undefined
        ? { stdout: '', stderr: 'missing', code: 1 }
        : { stdout: `${value}\n`, stderr: '', code: 0 };
    };
    const listed = await listManagedTmuxWindows(execute, {
      scope: metadata.scope,
      piSessionId: metadata.piSessionId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.metadata.displayCommand).toBeUndefined();
    expect(calls.filter((args) => args[0] === 'show-options')).toHaveLength(10);
    expect(calls.some((args) => args.at(-1) === TMUX_BASH_METADATA_KEYS.displayCommand)).toBe(
      false,
    );
  });

  it('bounds executor output before parsing records', async () => {
    const execute = async (): Promise<TmuxCommandResult> => ({
      stdout: '@7'.repeat(2000),
      stderr: '',
      code: 0,
    });
    await expect(listManagedTmuxWindows(execute, { maximumOutputBytes: 1024 })).rejects.toThrow(
      'exceeded',
    );
  });

  it('ignores structurally incomplete pre-enhancement windows', async () => {
    const execute = async (args: readonly string[]): Promise<TmuxCommandResult> =>
      args[0] === 'list-windows'
        ? { stdout: '@8\n', stderr: '', code: 0 }
        : { stdout: '', stderr: 'missing', code: 1 };
    await expect(listManagedTmuxWindows(execute)).resolves.toEqual([]);
  });
});

describe('structured attach commands', () => {
  it('builds safe argv inside and outside tmux', () => {
    expect(
      buildAttachCommand({
        binary: '/usr/bin/tmux',
        sessionName: "odd session's name",
        windowId: '@12',
        insideTmux: false,
      }),
    ).toEqual({
      binary: '/usr/bin/tmux',
      args: ['attach-session', '-t', "odd session's name", ';', 'select-window', '-t', '@12'],
      display:
        "/usr/bin/tmux attach-session -t 'odd session'\"'\"'s name' ';' select-window -t @12",
    });
    expect(
      buildAttachCommand({
        binary: 'tmux',
        sessionName: 'target-session',
        windowId: '@12',
        insideTmux: true,
      }).args,
    ).toEqual(['switch-client', '-t', 'target-session', ';', 'select-window', '-t', '@12']);
  });

  it('accepts absolute binary paths containing spaces as argv data', () => {
    expect(
      buildAttachCommand({
        binary: '/opt/tmux builds/tmux',
        sessionName: 'target-session',
        windowId: '@12',
      }).binary,
    ).toBe('/opt/tmux builds/tmux');
  });

  it('does not need filesystem state for parsing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tmux-core-artifacts-'));
    try {
      const output = join(directory, 'run-12345678.out');
      await writeFile(output, 'output');
      expect(output).toContain(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
