import { execFile } from 'node:child_process';
import {
  CONTINUATION_GATE_RELEASE_EVENT,
  createContinuationGateController,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import {
  TMUX_BASH_OWNERSHIP_MARKER,
  type ManagedWindowMetadata,
} from '@aliaksei-raketski/pi-tmux-bash-core';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverAndReconcileRuns } from '../src/adoption.js';
import { createCommandArtifacts } from '../src/command-artifacts.js';
import { CompletionDeliveryService } from '../src/completion.js';
import { DEFAULT_TMUX_BASH_CONFIG, validateTmuxBashConfig } from '../src/config.js';
import { ResourceManager } from '../src/resource-manager.js';
import { RunStore } from '../src/run-store.js';
import {
  TMUX_BASH_CONSUMED_COMPLETION,
  TMUX_BASH_DISPLAY_COMPLETION,
  TMUX_BASH_PENDING_COMPLETION,
  type CommandRun,
  type TmuxBashConfig,
} from '../src/types.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixtureConfig(overrides: Partial<TmuxBashConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tmux-enhancements-'));
  temporaryDirectories.push(root);
  return {
    root,
    config: validateTmuxBashConfig({
      ...DEFAULT_TMUX_BASH_CONFIG,
      outputDir: root,
      durableOutputDir: root,
      adoptionPolicy: 'same-pi-session',
      nonGitScope: 'cwd',
      ...overrides,
    }),
  };
}

async function createRun(
  root: string,
  config: TmuxBashConfig,
  runId: string,
  overrides: Partial<CommandRun> = {},
): Promise<CommandRun> {
  const artifacts = await createCommandArtifacts({
    runDir: root,
    runId,
    command: 'sleep 10',
    displayCommand: 'sleep 10',
    config,
  });
  return {
    ...artifacts,
    runId,
    completionId: `completion-${runId}`,
    sessionId: 'session-1',
    scope: { kind: 'cwd', root: '/workspace', hash: '12345678', displayName: 'workspace' },
    cwd: '/workspace',
    tmuxSession: 'pi-workspace',
    windowId: '@77',
    command: 'sleep 10',
    displayCommand: 'sleep 10',
    startedAt: Date.now() - 1000,
    mode: 'background',
    state: 'running',
    backgroundReady: true,
    awaited: true,
    continuationDomain: 'default',
    completionDelivery: 'model',
    deliveryState: 'pending',
    completionDelivered: false,
    completionClaimed: false,
    completionDeliveryFailures: 0,
    completionDeliveryFailed: false,
    killed: false,
    adopted: false,
    outputWasRotated: false,
    ...overrides,
  };
}

function windowMetadata(run: CommandRun): ManagedWindowMetadata {
  return {
    owner: TMUX_BASH_OWNERSHIP_MARKER,
    scope: run.scope,
    piSessionId: run.sessionId,
    runId: run.runId,
    manifestPath: run.manifestPath,
    completionId: run.completionId,
    completionDelivery: run.completionDelivery,
    startedAt: run.startedAt,
  };
}

describe('durable run store and adoption', () => {
  it('atomically persists private manifests and loads a live run without an exit sentinel', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    await store.initialize();
    const run = await createRun(root, config, 'run-live-1234');
    await store.persist(run);

    const stats = await lstat(run.manifestPath);
    expect(stats.mode & 0o077).toBe(0);
    const loaded = await store.loadAll();
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.manifests.map((item) => item.manifest.runId)).toEqual([run.runId]);
    expect(JSON.parse(await readFile(run.manifestPath, 'utf8'))).not.toHaveProperty('output');
  });

  it('bounds and aborts durable manifest scans', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    await store.initialize();
    await Promise.all(
      ['run-bound-one1', 'run-bound-two2'].map(async (runId) =>
        store.persist(await createRun(root, config, runId)),
      ),
    );
    await expect(store.loadAll({ maximumManifests: 1 })).rejects.toThrow('record limit');
    const controller = new AbortController();
    controller.abort(new Error('scan deadline'));
    await expect(store.loadAll({ signal: controller.signal })).rejects.toThrow('scan deadline');
  });

  it('rejects FIFO and oversized manifests without letting an in-progress scan block', async () => {
    const { root } = await fixtureConfig();
    const store = new RunStore(root);
    await store.initialize();
    const fifo = join(root, 'run-fifo-1234.manifest.json');
    const oversized = join(root, 'run-huge-1234.manifest.json');
    await execFileAsync('mkfifo', ['-m', '600', fifo]);
    await writeFile(oversized, 'x'.repeat(256 * 1024 + 1), { mode: 0o600 });

    const loaded = await withTimeout(store.loadAll(), 5_000, 'manifest scan blocked');

    expect(loaded.manifests).toEqual([]);
    expect(loaded.diagnostics.map((item) => item.reason).join('\n')).toMatch(
      /regular file|exceeds 262144 bytes/,
    );
  }, 10_000);

  it('rejects alternate artifact paths and canonical artifact symlinks', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    await store.initialize();
    const run = await createRun(root, config, 'run-paths-1234');
    await store.persist(run);
    const manifest = JSON.parse(await readFile(run.manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const alternate = join(root, 'alternate.out');
    await writeFile(alternate, 'safe alternate', { mode: 0o600 });
    manifest.outputFile = alternate;
    await writeFile(run.manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });

    let loaded = await store.loadAll();
    expect(loaded.manifests).toEqual([]);
    expect(loaded.diagnostics[0]?.reason).toContain('canonical run artifact path');

    manifest.outputFile = run.outputFile;
    await rm(run.outputFile);
    await symlink(alternate, run.outputFile);
    await writeFile(run.manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    loaded = await store.loadAll();
    expect(loaded.manifests).toEqual([]);
    expect(loaded.diagnostics[0]?.reason).toMatch(/symlink|ELOOP/);
  });

  it('rejects malformed, permissive, and symlinked manifests', async () => {
    const { root } = await fixtureConfig();
    const store = new RunStore(root);
    await store.initialize();
    const malformed = join(root, 'malformed-run.manifest.json');
    await writeFile(malformed, '{broken', { mode: 0o600 });
    const permissive = join(root, 'permissive-run.manifest.json');
    await writeFile(permissive, '{}', { mode: 0o644 });
    const linked = join(root, 'symlinked-run.manifest.json');
    await symlink(malformed, linked);
    const loaded = await store.loadAll();
    expect(loaded.manifests).toEqual([]);
    expect(loaded.diagnostics).toHaveLength(3);
    expect(loaded.diagnostics.map((item) => item.reason).join('\n')).toMatch(
      /JSON|permissions|symlink/,
    );
  });

  it('reconciles live, completed-offline, orphaned, changed-owner, and other-session runs', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    await store.initialize();
    const live = await createRun(root, config, 'run-live-1234');
    const complete = await createRun(root, config, 'run-done-1234', { windowId: '@78' });
    const orphan = await createRun(root, config, 'run-orphan-12', { windowId: '@79' });
    const changed = await createRun(root, config, 'run-changed-12', { windowId: '@80' });
    const invalidSentinel = await createRun(root, config, 'run-invalid-12', { windowId: '@82' });
    const other = await createRun(root, config, 'run-other-123', {
      sessionId: 'session-other',
      windowId: '@81',
    });
    const crashedAfterQueue = await createRun(root, config, 'run-queued-123', {
      state: 'completed',
      awaited: false,
      endedAt: Date.now(),
      exitCode: 0,
      deliveryState: 'queued',
    });
    await Promise.all(
      [live, complete, orphan, changed, invalidSentinel, other, crashedAfterQueue].map((run) =>
        store.persist(run),
      ),
    );
    await writeFile(complete.exitCodeFile, '7\n', { mode: 0o600 });
    await writeFile(invalidSentinel.exitCodeFile, 'invalid\n', { mode: 0o600 });

    const windows = [
      { windowId: '@77', metadata: windowMetadata(live) },
      {
        windowId: '@80',
        metadata: { ...windowMetadata(changed), completionId: 'different-completion' },
      },
      { windowId: '@81', metadata: windowMetadata(other) },
      { windowId: '@82', metadata: windowMetadata(invalidSentinel) },
    ];
    const tmux = {
      listManaged: vi.fn(async () => windows),
      isOwnedWindow: vi.fn(async () => true),
      isPaneDead: vi.fn(async () => false),
      killWindow: vi.fn(async () => undefined),
    };
    const adopted = await discoverAndReconcileRuns({
      config,
      tmux: tmux as never,
      store,
      sessionId: 'session-1',
      scope: live.scope,
    });

    expect(adopted.live.map((run) => run.runId)).toEqual([live.runId]);
    expect(adopted.completed.map((run) => [run.runId, run.exitCode])).toEqual(
      expect.arrayContaining([
        [complete.runId, 7],
        [crashedAfterQueue.runId, 0],
      ]),
    );
    expect(adopted.orphaned.map((run) => run.runId).sort()).toEqual(
      [changed.runId, invalidSentinel.runId, orphan.runId].sort(),
    );
    expect(tmux.killWindow).toHaveBeenCalledWith(invalidSentinel.windowId, expect.any(AbortSignal));
    expect(adopted.diagnostics.join('\n')).toContain('invalid exit sentinel');
    expect(adopted.live.some((run) => run.sessionId === 'session-other')).toBe(false);
  });

  it('does not adopt a persisted user-bash run into model-facing completion', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    await store.initialize();
    const userBash = await createRun(root, config, 'run-user-bash1', {
      origin: 'user-bash',
      windowId: '@82',
    });
    await store.persist(userBash);
    const killWindow = vi.fn(async () => undefined);
    const adopted = await discoverAndReconcileRuns({
      config,
      tmux: {
        listManaged: vi.fn(async () => [{ windowId: '@82', metadata: windowMetadata(userBash) }]),
        isOwnedWindow: vi.fn(async () => true),
        isPaneDead: vi.fn(async () => false),
        killWindow,
      } as never,
      store,
      sessionId: userBash.sessionId,
      scope: userBash.scope,
    });

    expect(adopted.live).toEqual([]);
    expect(adopted.completed).toEqual([]);
    expect(adopted.orphaned.map((run) => run.runId)).toEqual([userBash.runId]);
    expect(killWindow).toHaveBeenCalledWith('@82', expect.any(AbortSignal));
    expect(adopted.diagnostics.join('\n')).toContain('originated from user-bash');
  });

  it('contains a malformed sentinel created during dead-pane reconciliation', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    await store.initialize();
    const dead = await createRun(root, config, 'run-race-sentinel', { windowId: '@84' });
    await store.persist(dead);
    const killWindow = vi.fn(async () => undefined);
    const adopted = await discoverAndReconcileRuns({
      config,
      tmux: {
        listManaged: vi.fn(async () => [{ windowId: '@84', metadata: windowMetadata(dead) }]),
        isOwnedWindow: vi.fn(async () => true),
        isPaneDead: vi.fn(async () => {
          await writeFile(dead.exitCodeFile, 'not-an-exit-code');
          return true;
        }),
        killWindow,
      } as never,
      store,
      sessionId: dead.sessionId,
      scope: dead.scope,
    });

    expect(adopted.live).toEqual([]);
    expect(adopted.orphaned.map((run) => run.runId)).toEqual([dead.runId]);
    expect(killWindow).toHaveBeenCalledWith('@84', expect.any(AbortSignal));
    expect(adopted.diagnostics.join('\n')).toContain('invalid exit sentinel');
  });

  it('skips delivered user-bash history after closing a leftover owned pane', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    await store.initialize();
    const historical = await createRun(root, config, 'run-user-hist1', {
      origin: 'user-bash',
      state: 'completed',
      endedAt: Date.now(),
      exitCode: 0,
      deliveryState: 'delivered',
      completionClaimed: true,
      completionDelivered: true,
      windowId: '@85',
    });
    await store.persist(historical);
    const killWindow = vi.fn(async () => undefined);
    const adopted = await discoverAndReconcileRuns({
      config,
      tmux: {
        listManaged: vi.fn(async () => [{ windowId: '@85', metadata: windowMetadata(historical) }]),
        isOwnedWindow: vi.fn(async () => true),
        killWindow,
      } as never,
      store,
      sessionId: historical.sessionId,
      scope: historical.scope,
    });

    expect(adopted.live).toEqual([]);
    expect(adopted.completed).toEqual([]);
    expect(adopted.orphaned).toEqual([]);
    expect(killWindow).toHaveBeenCalledWith('@85', expect.any(AbortSignal));
  });

  it('closes all metadata-exact historical panes without touching changed-owner duplicates', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    await store.initialize();
    const historical = await createRun(root, config, 'run-historical-1', {
      state: 'completed',
      endedAt: Date.now(),
      exitCode: 0,
      deliveryState: 'delivered',
      completionClaimed: true,
      completionDelivered: true,
      windowId: '@90',
    });
    await store.persist(historical);
    const killWindow = vi.fn(async () => undefined);
    const exact = windowMetadata(historical);
    const changed = { ...exact, completionId: 'different-completion' };
    const adopted = await discoverAndReconcileRuns({
      config,
      tmux: {
        listManaged: vi.fn(async () => [
          { windowId: '@91', metadata: changed },
          { windowId: '@90', metadata: exact },
          { windowId: '@92', metadata: exact },
        ]),
        isOwnedWindow: vi.fn(async () => true),
        killWindow,
      } as never,
      store,
      sessionId: historical.sessionId,
      scope: historical.scope,
    });

    expect(adopted.live).toEqual([]);
    expect(adopted.completed).toEqual([]);
    expect(adopted.orphaned).toEqual([]);
    expect(killWindow).toHaveBeenCalledWith('@90', expect.any(AbortSignal));
    expect(killWindow).toHaveBeenCalledWith('@92', expect.any(AbortSignal));
    expect(killWindow).not.toHaveBeenCalledWith('@91', expect.any(AbortSignal));
  });

  it('orphans an exactly-owned dead pane when no exit sentinel was published', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    await store.initialize();
    const dead = await createRun(root, config, 'run-dead-pane1', { windowId: '@83' });
    await store.persist(dead);
    const killWindow = vi.fn(async () => undefined);
    const adopted = await discoverAndReconcileRuns({
      config,
      tmux: {
        listManaged: vi.fn(async () => [{ windowId: '@83', metadata: windowMetadata(dead) }]),
        isPaneDead: vi.fn(async () => true),
        killWindow,
      } as never,
      store,
      sessionId: dead.sessionId,
      scope: dead.scope,
    });

    expect(adopted.live).toEqual([]);
    expect(adopted.orphaned.map((run) => run.runId)).toEqual([dead.runId]);
    expect(killWindow).not.toHaveBeenCalled();
    expect(adopted.diagnostics.join('\n')).toContain('pane died without an exit sentinel');
  });

  it('reconciles terminal artifacts but preserves live runs when tmux discovery is unavailable', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    await store.initialize();
    const run = await createRun(root, config, 'run-unavail-12');
    const completed = await createRun(root, config, 'run-unavail-done');
    await Promise.all([store.persist(run), store.persist(completed)]);
    await writeFile(completed.exitCodeFile, '0\n', { mode: 0o600 });
    await writeFile(
      completed.manifestPath.replace(/\.manifest\.json$/, '.completion.claim'),
      `${process.pid} ${Date.now()}\n`,
      { mode: 0o600 },
    );

    const adopted = await discoverAndReconcileRuns({
      config,
      tmux: { listManaged: vi.fn(async () => Promise.reject(new Error('no server'))) } as never,
      store,
      sessionId: run.sessionId,
      scope: run.scope,
    });

    expect(adopted.live).toEqual([]);
    expect(adopted.completed.map((candidate) => candidate.runId)).toEqual([completed.runId]);
    expect(adopted.orphaned).toEqual([]);
    expect(adopted.diagnostics.join('\n')).toMatch(/discovery unavailable/);
    const persisted = JSON.parse(await readFile(run.manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(persisted).toMatchObject({ state: 'running' });
    expect(persisted).not.toHaveProperty('endedAt');
  });
});

describe('completion delivery policies', () => {
  it('persists display-only completion before wake=none without model context', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    const run = await createRun(root, config, 'run-display-12', {
      completionDelivery: 'display',
      state: 'completed',
      endedAt: Date.now(),
      exitCode: 0,
    });
    await store.persist(run);
    const entries: unknown[] = [];
    const pi = {
      events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
      appendEntry: vi.fn((customType, data) => entries.push({ type: 'custom', customType, data })),
      sendMessage: vi.fn(),
    };
    const controller = createContinuationGateController(pi as never, { source: 'test' });
    const service = new CompletionDeliveryService(pi as never, store, controller);
    const ctx = context(entries, false);
    const outcome = await service.deliverCompletion(
      run,
      { text: 'finished', details: details(run) },
      ctx as never,
    );
    expect(outcome.wake).toBe('none');
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      TMUX_BASH_DISPLAY_COMPLETION,
      expect.objectContaining({ completionId: run.completionId, displayed: false }),
    );
    expect(run.deliveryState).toBe('persisted');
  });

  it('persists next-turn completions, batches them once, and appends consumed markers', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    const run = await createRun(root, config, 'run-nextturn-1', {
      completionDelivery: 'next-turn',
      state: 'completed',
      endedAt: Date.now(),
      exitCode: 0,
    });
    await store.persist(run);
    const entries: Array<Record<string, unknown>> = [];
    const pi = {
      events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
      appendEntry: vi.fn((customType: string, data: unknown) =>
        entries.push({ type: 'custom', customType, data }),
      ),
      sendMessage: vi.fn(),
    };
    const controller = createContinuationGateController(pi as never, { source: 'test' });
    const service = new CompletionDeliveryService(pi as never, store, controller);
    const ctx = context(entries, true);
    const outcome = await service.deliverCompletion(
      run,
      { text: 'next natural turn', details: details(run) },
      ctx as never,
    );
    expect(outcome.wake).toBe('none');
    expect(entries.some((entry) => entry.customType === TMUX_BASH_PENDING_COMPLETION)).toBe(true);
    expect(service.isCompletionRecorded(ctx as never, run.completionId)).toBe(true);
    expect(service.consumePending(ctx as never)).toMatch(/next natural turn/);
    expect(entries.some((entry) => entry.customType === TMUX_BASH_CONSUMED_COMPLETION)).toBe(true);
    expect(service.consumePending(ctx as never)).toBeUndefined();
  });

  it('bounds next-turn batching and retains overflow for later natural turns', async () => {
    const { root } = await fixtureConfig();
    const store = new RunStore(root);
    const entries: Array<Record<string, unknown>> = Array.from({ length: 25 }, (_, index) => ({
      type: 'custom',
      customType: TMUX_BASH_PENDING_COMPLETION,
      data: {
        completionId: `completion-batch-${index}`,
        runId: `run-batch-${index}`,
        summary: `summary ${index}`,
        outputFile: `/tmp/output-${index}`,
      },
    }));
    const pi = {
      events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
      appendEntry: vi.fn((customType: string, data: unknown) =>
        entries.push({ type: 'custom', customType, data }),
      ),
      sendMessage: vi.fn(),
    };
    const controller = createContinuationGateController(pi as never, { source: 'test' });
    const service = new CompletionDeliveryService(pi as never, store, controller);
    const first = service.consumePending(context(entries, true) as never);
    expect(first).toMatch(/5 additional tmux completion\(s\) remain pending/);
    expect(
      entries.filter((entry) => entry.customType === TMUX_BASH_CONSUMED_COMPLETION),
    ).toHaveLength(20);
    expect(service.consumePending(context(entries, true) as never)).toMatch(/summary 24/);
  });

  it('bounds the complete next-turn payload and rejects oversized branch references', async () => {
    const { root } = await fixtureConfig();
    const store = new RunStore(root);
    const entries: Array<Record<string, unknown>> = [
      {
        type: 'custom',
        customType: TMUX_BASH_PENDING_COMPLETION,
        data: {
          completionId: 'completion-large-1',
          runId: 'run-large-1234',
          summary: 'λ'.repeat(40_000),
          outputFile: '/tmp/output-large',
        },
      },
      {
        type: 'custom',
        customType: TMUX_BASH_PENDING_COMPLETION,
        data: {
          completionId: 'completion-invalid-1',
          runId: 'run-invalid-1234',
          summary: 'ignored',
          outputFile: '/'.repeat(5_000),
        },
      },
    ];
    const pi = {
      events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
      appendEntry: vi.fn((customType: string, data: unknown) =>
        entries.push({ type: 'custom', customType, data }),
      ),
      sendMessage: vi.fn(),
    };
    const service = new CompletionDeliveryService(
      pi as never,
      store,
      createContinuationGateController(pi as never, { source: 'test' }),
    );
    const payload = service.consumePending(context(entries, true) as never);
    expect(payload).toContain('[bounded]');
    expect(Buffer.byteLength(payload ?? '')).toBeLessThanOrEqual(50 * 1_024);
    expect(
      entries.filter((entry) => entry.customType === TMUX_BASH_CONSUMED_COMPLETION),
    ).toHaveLength(1);
  });

  it('deduplicates an already-recorded model completion ID', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    const run = await createRun(root, config, 'run-dedupe-123', {
      state: 'completed',
      endedAt: Date.now(),
      exitCode: 0,
    });
    await store.persist(run);
    const entries = [
      {
        type: 'custom_message',
        customType: 'tmux-bash-completion',
        details: { completionId: run.completionId },
      },
    ];
    const pi = {
      events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    };
    const controller = createContinuationGateController(pi as never, { source: 'test' });
    const service = new CompletionDeliveryService(pi as never, store, controller);
    const outcome = await service.deliverCompletion(
      run,
      { text: 'duplicate', details: details(run) },
      context(entries, true) as never,
    );
    expect(outcome.alreadyDelivered).toBe(true);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it('orders model queue before committed gate release', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    const run = await createRun(root, config, 'run-model-1234', {
      state: 'completed',
      endedAt: Date.now(),
      exitCode: 0,
      gateId: 'gate-model',
    });
    await store.persist(run);
    const order: string[] = [];
    const events = {
      on: vi.fn(() => vi.fn()),
      emit: vi.fn((name: string) => {
        if (name === CONTINUATION_GATE_RELEASE_EVENT) order.push('release');
      }),
    };
    const pi = {
      events,
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => order.push('message')),
    };
    const controller = createContinuationGateController(pi as never, { source: 'test' });
    const gateId = run.gateId;
    if (!gateId) throw new Error('Expected model completion gate.');
    controller.acquire({
      sessionId: run.sessionId,
      gateId,
      reason: 'test',
    });
    const service = new CompletionDeliveryService(pi as never, store, controller);
    const outcome = await service.deliverCompletion(
      run,
      { text: 'model', details: details(run) },
      context([], true) as never,
    );
    controller.release({
      sessionId: run.sessionId,
      gateId,
      outcome: 'completed',
      wake: outcome.wake,
      handoffId: outcome.handoff?.handoffId,
    });
    expect(order).toEqual(['message', 'release']);
  });
});

describe('resource reservations and cleanup', () => {
  it('enforces cross-instance reservations and rolls back released slots', async () => {
    const { root, config } = await fixtureConfig({ maxConcurrentRuns: 1 });
    const left = new ResourceManager(root, config);
    const right = new ResourceManager(root, config);
    const raced = await Promise.allSettled([
      left.reserve('reserve-left-1'),
      right.reserve('reserve-right1'),
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = raced.findIndex((result) => result.status === 'fulfilled');
    const reservation = raced[winner];
    if (reservation?.status !== 'fulfilled') throw new Error('Expected one reservation winner.');
    await (winner === 0 ? left : right).releaseReservation(reservation.value);
    const after = await right.reserve('reserve-after1');
    expect(after).toContain('reserve-after1.reserve');
    await right.releaseReservation(after);
  });

  it('protects a starting run from concurrent cleanup by reservation and discovered ownership', async () => {
    const { root, config } = await fixtureConfig({ adoptionPolicy: 'off' });
    const store = new RunStore(root);
    await store.initialize();
    const run = await createRun(root, config, 'run-launch-1234', {
      state: 'starting',
      windowId: undefined,
    });
    await store.persist(run);
    const resources = new ResourceManager(root, config);
    const reservation = await resources.reserve(run.runId, {
      isActiveRun: vi.fn(async () => false),
      isCleanupProtectedWindow: vi.fn(async () => false),
    });

    await expect(
      resources.cleanup({
        includeYoung: true,
        isActiveRun: vi.fn(async () => false),
        isLiveOwnedWindow: vi.fn(async () => false),
      }),
    ).resolves.toEqual([]);
    await expect(readFile(run.manifestPath, 'utf8')).resolves.toContain('"state":"starting"');

    await resources.releaseReservation(reservation);
    const discoveredOwner = vi.fn(async () => true);
    await expect(
      resources.cleanup({
        includeYoung: true,
        isActiveRun: vi.fn(async () => false),
        isLiveOwnedWindow: discoveredOwner,
      }),
    ).resolves.toEqual([]);
    expect(discoveredOwner).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }));
  });

  it('does not steal a stale-looking lock while its owner process is still alive', async () => {
    const { root, config } = await fixtureConfig({ maxConcurrentRuns: 4 });
    const store = new RunStore(root);
    await store.initialize();
    const active = await createRun(root, config, 'run-lock-live1');
    await store.persist(active);
    let clock = Date.now();
    let entered!: () => void;
    const operationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const blocker = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const left = new ResourceManager(root, config, () => clock);
    const right = new ResourceManager(root, config, () => clock);
    const first = left.reserve('run-lock-left1', {
      isActiveRun: async () => {
        entered();
        await blocker;
        return true;
      },
    });
    await operationEntered;
    clock += 120_000;

    await expect(right.reserve('run-lock-right')).rejects.toThrow('Timed out acquiring');
    resume();
    const reservation = await first;
    await expect(readFile(reservation, 'utf8')).resolves.toMatch(/^\d+ /);
    await left.releaseReservation(reservation);
  });

  it('counts only externally revalidated active manifests when a tmux host is available', async () => {
    const { root, config } = await fixtureConfig();
    const store = new RunStore(root);
    await store.initialize();
    const live = await createRun(root, config, 'run-resource-live');
    const stale = await createRun(root, config, 'run-resource-stale', { windowId: '@88' });
    await Promise.all([store.persist(live), store.persist(stale)]);
    const resources = new ResourceManager(root, config);
    const usage = await resources.usage({
      isActiveRun: vi.fn(async (manifest) => manifest.runId === live.runId),
    });
    expect(usage.activeRuns).toBe(1);
  });

  it('makes inactive crash leftovers cleanable when restart adoption is disabled', async () => {
    const { root, config } = await fixtureConfig({ adoptionPolicy: 'off' });
    const store = new RunStore(root);
    await store.initialize();
    const stale = await createRun(root, config, 'run-crash-stale', {
      startedAt: Date.now() - 20_000,
    });
    await store.persist(stale);
    const resources = new ResourceManager(root, config);

    const preview = await resources.preview({
      includeYoung: true,
      isActiveRun: vi.fn(async () => false),
    });
    expect(preview.map((candidate) => candidate.runId)).toEqual([stale.runId]);

    const removed = await resources.cleanup({
      includeYoung: true,
      isActiveRun: vi.fn(async () => false),
      isLiveOwnedWindow: vi.fn(async () => false),
    });
    expect(removed.map((candidate) => candidate.runId)).toEqual([stale.runId]);
    await expect(readFile(stale.manifestPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reserves total artifact headroom across concurrent processes', async () => {
    const { root, config } = await fixtureConfig({
      maxConcurrentRuns: 10,
      maxArtifactBytesPerRun: 1_024,
      maxArtifactBytesTotal: 80_000,
    });
    const left = new ResourceManager(root, config);
    const right = new ResourceManager(root, config);
    const first = await left.reserve('artifact-left-1');
    const second = await right.reserve('artifact-right1');
    await expect(left.reserve('artifact-third1')).rejects.toThrow(/artifact quota/);
    await Promise.all([left.releaseReservation(first), right.releaseReservation(second)]);
  });

  it('rejects launches that would exceed the completed-run limit', async () => {
    const { root, config } = await fixtureConfig({ maxCompletedRuns: 1 });
    const store = new RunStore(root);
    await store.initialize();
    const completed = await createRun(root, config, 'run-complete-1', {
      state: 'completed',
      awaited: false,
      endedAt: Date.now(),
      exitCode: 0,
    });
    await store.persist(completed);

    const resources = new ResourceManager(root, config);
    await expect(resources.reserve('run-overflow-1')).rejects.toThrow(/completed run limit/);
  });

  it('rolls back launch capacity when structural artifacts exceed total headroom', async () => {
    const { root, config } = await fixtureConfig({
      maxArtifactBytesPerRun: 1_024,
      maxArtifactBytesTotal: 34_000,
    });
    const resources = new ResourceManager(root, config);
    const reservation = await resources.reserve('run-overhead-1');
    await writeFile(join(root, 'run-overhead-1.command'), Buffer.alloc(600));

    await expect(resources.validateReservationCapacity(reservation)).rejects.toThrow(
      /after creating launch artifacts/,
    );
    await resources.releaseReservation(reservation);
  });

  it('previews oldest eligible runs, protects live windows, and skips symlinks', async () => {
    const { root, config } = await fixtureConfig({
      completedArtifactRetentionSeconds: 0,
      maxCompletedRuns: 1,
    });
    const store = new RunStore(root);
    await store.initialize();
    const old = await createRun(root, config, 'run-oldest-12', {
      state: 'completed',
      awaited: false,
      startedAt: Date.now() - 20_000,
      endedAt: Date.now() - 10_000,
      exitCode: 0,
      deliveryState: 'delivered',
    });
    const newer = await createRun(root, config, 'run-newer-123', {
      state: 'failed',
      awaited: false,
      startedAt: Date.now() - 2_000,
      endedAt: Date.now() - 1000,
      exitCode: 2,
      deliveryState: 'failed',
      completionDeliveryExhausted: true,
    });
    await store.persist(old);
    await store.persist(newer);
    const fifo = join(root, `${old.runId}.stream`);
    await execFileAsync('mkfifo', ['-m', '600', fifo]);
    const external = join(root, 'outside');
    await writeFile(external, 'do not delete');
    const prefixedNotes = join(root, `${old.runId}.notes`);
    await writeFile(prefixedNotes, 'keep notes');
    const linked = join(root, `${old.runId}.unsafe`);
    await symlink(external, linked);

    const resources = new ResourceManager(root, config);
    const preview = await resources.preview();
    expect(preview.map((item) => item.runId)).toEqual([old.runId, newer.runId]);
    const removed = await resources.cleanup({
      includeYoung: true,
      runIds: new Set([old.runId]),
      isLiveOwnedWindow: async (manifest) => manifest.runId === newer.runId,
    });
    expect(removed.map((item) => item.runId)).toEqual([old.runId]);
    await expect(readFile(external, 'utf8')).resolves.toBe('do not delete');
    await expect(readFile(prefixedNotes, 'utf8')).resolves.toBe('keep notes');
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    await expect(lstat(fifo)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('protects terminal runs until delivery is settled and while in-memory work is active', async () => {
    const { root, config } = await fixtureConfig({ completedArtifactRetentionSeconds: 0 });
    const store = new RunStore(root);
    await store.initialize();
    const run = await createRun(root, config, 'run-pending-123', {
      state: 'completed',
      endedAt: Date.now(),
      exitCode: 0,
      deliveryState: 'pending',
      completionDelivered: false,
      completionClaimed: false,
    });
    await store.persist(run);
    const resources = new ResourceManager(root, config);

    await expect(resources.preview({ includeYoung: true })).resolves.toEqual([]);
    run.deliveryState = 'failed';
    run.completionDeliveryExhausted = false;
    await store.persist(run);
    await expect(resources.preview({ includeYoung: true })).resolves.toEqual([]);
    run.completionDeliveryExhausted = true;
    await store.persist(run);
    await expect(resources.preview({ includeYoung: true })).resolves.toHaveLength(1);
    run.deliveryState = 'delivered';
    run.completionDelivered = true;
    run.completionClaimed = true;
    await store.persist(run);
    await expect(
      resources.cleanup({
        includeYoung: true,
        isCleanupProtectedRun: async (manifest) => manifest.runId === run.runId,
      }),
    ).resolves.toEqual([]);
    await expect(readFile(run.manifestPath, 'utf8')).resolves.toContain(
      '"deliveryState":"delivered"',
    );

    const removed = await resources.cleanup({
      includeYoung: true,
      isLiveOwnedWindow: async () => false,
    });
    expect(removed.map((candidate) => candidate.runId)).toEqual([run.runId]);
  });

  it('counts bounded artifacts and rejects quota pressure with cleanup guidance', async () => {
    const { root, config } = await fixtureConfig({
      maxArtifactBytesPerRun: 1024,
      maxArtifactBytesTotal: 1024,
    });
    await writeFile(join(root, 'quota.bin'), Buffer.alloc(1024));
    const resources = new ResourceManager(root, config);
    const usage = await resources.usage();
    expect(usage.artifactBytes).toBe(1024);
    await expect(resources.reserve('quota-run-123')).rejects.toThrow(/cleanup-preview/);
  });
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function details(run: CommandRun) {
  return {
    runId: run.runId,
    completionId: run.completionId,
    windowId: run.windowId,
    tmuxSession: run.tmuxSession,
    command: run.command,
    outputFile: run.outputFile,
    exitCode: run.exitCode,
    state: 'completed' as const,
    background: true,
    awaited: run.awaited,
    durationMs: 1,
    completionDelivery: run.completionDelivery,
    adopted: run.adopted,
    outputWasRotated: run.outputWasRotated,
  };
}

function context(entries: unknown[], hasUI: boolean) {
  return {
    hasUI,
    cwd: '/workspace',
    sessionManager: {
      getSessionId: () => 'session-1',
      getBranch: () => entries,
    },
    ui: { notify: vi.fn() },
  };
}
