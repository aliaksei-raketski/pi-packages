import {
  CONTINUATION_GATE_ACQUIRE_EVENT,
  CONTINUATION_GATE_RELEASE_EVENT,
  CONTINUATION_GATE_SNAPSHOT_EVENT,
  createContinuationGateController,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent';
import { shortHash, TMUX_BASH_OWNERSHIP_MARKER } from '@aliaksei-raketski/pi-tmux-bash-core';
import { execFile, execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCommandArtifacts, shellQuote } from '../src/command-artifacts.js';
import { DEFAULT_TMUX_BASH_CONFIG } from '../src/config.js';
import { readExitCode } from '../src/output.js';
import { TmuxBashRuntime } from '../src/runtime.js';
import { TmuxClient, type TmuxExecutor } from '../src/tmux-client.js';
import { resolveWorkspaceScope } from '../src/tmux-scope.js';

const execFileAsync = promisify(execFile);
const tmuxAvailable = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
if (process.env.CI && !tmuxAvailable) {
  throw new Error('The CI integration suite requires tmux, but the binary is unavailable.');
}
const suite = tmuxAvailable ? describe : describe.skip;
let environment: RealTmuxEnvironment | undefined;

interface RealTmuxEnvironment {
  root: string;
  sessionName: string;
  client: TmuxClient;
  execute: TmuxExecutor;
}

suite('real tmux integration', () => {
  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-tmux-test-'));
    const execute = isolatedTmuxExecutor(join(root, 'tmux.sock'));
    environment = {
      root,
      sessionName: 'pi-test',
      client: new TmuxClient('tmux', execute),
      execute,
    };
  });

  afterEach(async () => {
    const current = environment;
    environment = undefined;
    if (!current) return;
    await current.execute('tmux', ['kill-server']).catch(() => undefined);
    await rm(current.root, { recursive: true, force: true });
  });
  it('captures output, exact exit code, stable ID, and owned window metadata', async () => {
    const current = requireEnvironment();
    const runDir = await mkdtemp(join(current.root, 'artifacts-'));
    const artifacts = await createCommandArtifacts({
      runDir,
      runId: 'integration',
      command: "printf 'hello from tmux\\n'; exit 9",
      displayCommand: 'integration command',
      config: DEFAULT_TMUX_BASH_CONFIG,
    });
    const client = current.client;
    const windowId = await client.createWindow({
      sessionName: current.sessionName,
      windowName: 'integration',
      cwd: process.cwd(),
      scriptFile: artifacts.scriptFile,
      metadata: {
        owner: TMUX_BASH_OWNERSHIP_MARKER,
        scope: {
          kind: 'git-root',
          root: process.cwd(),
          hash: shortHash(process.cwd()),
        },
        piSessionId: 'test-session',
        runId: 'integration',
        manifestPath: artifacts.manifestPath,
        completionId: 'completion-integration',
        completionDelivery: 'model',
        startedAt: Date.now(),
        displayCommand: 'integration command',
      },
    });

    expect(windowId).toMatch(/^@\d+$/);
    await waitFor(async () => (await readExitCode(artifacts.exitCodeFile)) === 9);
    expect(await readFile(artifacts.outputFile, 'utf8')).toContain('hello from tmux');
    const metadata = await current.execute('tmux', [
      'show-options',
      '-w',
      '-v',
      '-t',
      windowId,
      '@pi_tmux_bash_run_id',
    ]);
    expect(metadata.code).toBe(0);
    expect(metadata.stdout.trim()).toBe('integration');
    await client.killWindow(windowId);
  });

  it('streams exact bytes from a real tmux window through the user-bash FIFO', async () => {
    const current = requireEnvironment();
    const runDir = await mkdtemp(join(current.root, 'stream-artifacts-'));
    const artifacts = await createCommandArtifacts({
      runDir,
      runId: 'stream-integration',
      command: "printf 'one\\n'; printf 'two\\n' >&2; exit 7",
      displayCommand: 'stream integration',
      config: DEFAULT_TMUX_BASH_CONFIG,
      streamOutput: true,
    });
    const streamFile = artifacts.streamFile;
    if (!streamFile) throw new Error('Expected stream FIFO.');
    const received = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of createReadStream(streamFile)) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    })();
    const client = current.client;
    const windowId = await client.createWindow({
      sessionName: current.sessionName,
      windowName: 'stream-integration',
      cwd: process.cwd(),
      scriptFile: artifacts.scriptFile,
      metadata: {
        owner: TMUX_BASH_OWNERSHIP_MARKER,
        scope: { kind: 'git-root', root: process.cwd(), hash: shortHash(process.cwd()) },
        piSessionId: 'stream-session',
        runId: 'stream-integration',
        manifestPath: artifacts.manifestPath,
        completionId: 'stream-completion',
        completionDelivery: 'model',
        startedAt: Date.now(),
        displayCommand: 'stream integration',
      },
    });
    await waitFor(async () => (await readExitCode(artifacts.exitCodeFile)) === 7);
    expect(await received).toEqual(Buffer.from('one\ntwo\n'));
    await client.killWindow(windowId).catch(() => undefined);
  });

  it('lists, peeks, kills, and reports completion through the real runtime', async () => {
    const current = requireEnvironment();
    const runDir = await mkdtemp(join(current.root, 'runtime-'));
    const completeBackgroundFile = join(runDir, 'complete-background');
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const events = {
      on(name: string, handler: (payload: unknown) => void) {
        const listeners = handlers.get(name) ?? new Set();
        listeners.add(handler);
        handlers.set(name, listeners);
        return () => listeners.delete(handler);
      },
      emit(name: string, payload: unknown) {
        for (const handler of handlers.get(name) ?? []) handler(payload);
      },
    };
    const pi = { events, sendMessage: vi.fn() };
    const controller = createContinuationGateController(pi, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: runDir,
        durableOutputDir: runDir,
        preserveOutputFiles: true,
        tmuxSessionScope: 'global',
        globalTmuxSessionName: current.sessionName,
        autoCloseWindowsOnCompletion: false,
        statusbarEnabled: false,
      },
      controller,
      current.client,
    );
    const context = {
      cwd: process.cwd(),
      sessionManager: {
        getSessionId: () => 'real-runtime-session',
        getSessionFile: () => join(runDir, 'real-runtime-session.jsonl'),
      },
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        theme: { fg: (_color: string, text: string) => text },
      },
    };

    try {
      await runtime.startSession(context as never);
      const longRunning = await runtime.executeBash(
        { command: "printf 'peek-ready\\n'; while :; do sleep 1; done", background: true },
        undefined,
        undefined,
        context as never,
      );
      const windowId = longRunning.details?.windowId;
      if (!windowId) throw new Error('Expected a stable tmux window ID.');
      await waitFor(async () =>
        (await readFile(longRunning.details?.outputFile ?? '', 'utf8')).includes('peek-ready'),
      );

      const listed = await runtime.listResult(context as never);
      expect(listed.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining(windowId),
      });
      const peeked = await runtime.peek(windowId, context as never);
      expect(peeked.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('peek-ready'),
      });
      await runtime.kill(windowId, context as never);
      await expect(current.client.hasWindow(windowId)).resolves.toBe(false);

      const backgroundResult = await runtime.executeBash(
        {
          command: `while [ ! -e ${shellQuote(completeBackgroundFile)} ]; do sleep 0.05; done; printf 'background-complete\\n'`,
          background: true,
          waitForCompletion: true,
        },
        undefined,
        undefined,
        context as never,
      );
      expect(backgroundResult.details?.state).toBe('running');
      await writeFile(completeBackgroundFile, '');
      await waitFor(async () => pi.sendMessage.mock.calls.length === 1, 10_000);
      expect(pi.sendMessage.mock.calls[0]?.[0]).toMatchObject({
        content: expect.stringContaining('background-complete'),
      });
      await waitFor(async () => controller.list('real-runtime-session').length === 0, 5_000);
    } finally {
      await runtime.shutdown(context as never);
      controller.dispose();
    }
  }, 20_000);

  it('adopts same-session live and completed-offline awaited runs before publishing gates', async () => {
    const current = requireEnvironment();
    const directory = await mkdtemp(join(current.root, 'adoption-'));
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const emittedEvents: string[] = [];
    const entries: unknown[] = [];
    const pi = {
      events: {
        on(name: string, handler: (payload: unknown) => void) {
          const listeners = handlers.get(name) ?? new Set();
          listeners.add(handler);
          handlers.set(name, listeners);
          return () => listeners.delete(handler);
        },
        emit(name: string, payload: unknown) {
          emittedEvents.push(name);
          for (const handler of handlers.get(name) ?? []) handler(payload);
        },
      },
      sendMessage: vi.fn(),
      appendEntry: vi.fn((customType: string, data: unknown) =>
        entries.push({ type: 'custom', customType, data }),
      ),
    };
    const config = {
      ...DEFAULT_TMUX_BASH_CONFIG,
      outputDir: directory,
      durableOutputDir: directory,
      adoptionPolicy: 'same-pi-session' as const,
      preserveOutputFiles: true,
      tmuxSessionScope: 'global' as const,
      globalTmuxSessionName: current.sessionName,
      autoCloseWindowsOnCompletion: false,
      statusbarEnabled: false,
    };
    const context = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: {
        getSessionId: () => 'restart-session',
        getSessionFile: () => join(directory, 'restart-session.jsonl'),
        getBranch: () => [...entries],
      },
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_: string, text: string) => text } },
    };
    const firstController = createContinuationGateController(pi as never, {
      source: 'pi-tmux-bash',
    });
    const first = new TmuxBashRuntime(pi as never, config, firstController, current.client);
    const completeOfflineFile = join(directory, 'complete-offline');
    const completeLiveFile = join(directory, 'complete-live');
    let second: TmuxBashRuntime | undefined;
    let secondController: ReturnType<typeof createContinuationGateController> | undefined;
    try {
      await first.startSession(context as never);
      const completedOffline = await first.executeBash(
        {
          command: `while [ ! -e ${shellQuote(completeOfflineFile)} ]; do sleep 0.05; done; printf 'offline\\n'`,
          background: true,
          waitForCompletion: true,
        },
        undefined,
        undefined,
        context as never,
      );
      const stillLive = await first.executeBash(
        {
          command: `while [ ! -e ${shellQuote(completeLiveFile)} ]; do sleep 0.05; done; printf 'live\\n'`,
          background: true,
          waitForCompletion: true,
        },
        undefined,
        undefined,
        context as never,
      );
      const completedOfflineExitFile = first.state.commands.get(
        completedOffline.details?.runId ?? '',
      )?.exitCodeFile;
      if (!completedOfflineExitFile) throw new Error('Expected the offline run exit file.');
      await first.shutdown(context as never);
      firstController.dispose();
      await writeFile(completeOfflineFile, '');
      await waitFor(async () => (await readExitCode(completedOfflineExitFile)) === 0);

      emittedEvents.length = 0;
      secondController = createContinuationGateController(pi as never, {
        source: 'pi-tmux-bash',
      });
      second = new TmuxBashRuntime(pi as never, config, secondController, current.client);
      await second.startSession(context as never);
      expect(
        [...second.state.commands.values()].some(
          (run) => run.runId === stillLive.details?.runId && run.adopted && run.state === 'running',
        ),
      ).toBe(true);
      expect(secondController.list('restart-session')).toHaveLength(1);
      expect(emittedEvents.indexOf(CONTINUATION_GATE_ACQUIRE_EVENT)).toBeLessThan(
        emittedEvents.indexOf(CONTINUATION_GATE_SNAPSHOT_EVENT),
      );
      await writeFile(completeLiveFile, '');
      await waitFor(async () => pi.sendMessage.mock.calls.length === 2, 10_000);
      await waitFor(async () => secondController?.list('restart-session').length === 0, 5_000);
      const completionIds = pi.sendMessage.mock.calls.map(
        (call) => (call[0] as { details?: { completionId?: string } }).details?.completionId,
      );
      expect(new Set(completionIds).size).toBe(2);
    } finally {
      await first.shutdown(context as never).catch(() => undefined);
      firstController.dispose();
      await second?.shutdown(context as never).catch(() => undefined);
      secondController?.dispose();
    }
  }, 30_000);

  it('round-trips literal interactive input through a real prompt without persisting it', async () => {
    const current = requireEnvironment();
    const directory = await mkdtemp(join(current.root, 'input-'));
    const events = { on: vi.fn(() => vi.fn()), emit: vi.fn() };
    const pi = { events, sendMessage: vi.fn(), appendEntry: vi.fn() };
    const controller = createContinuationGateController(pi as never, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: directory,
        durableOutputDir: directory,
        tmuxSessionScope: 'global',
        globalTmuxSessionName: current.sessionName,
        autoCloseWindowsOnCompletion: false,
        interactiveInputEnabled: true,
        enabledTmuxActions: [
          ...DEFAULT_TMUX_BASH_CONFIG.enabledTmuxActions,
          'send-input',
          'send-key',
        ],
        statusbarEnabled: false,
      },
      controller,
      current.client,
    );
    const context = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: {
        getSessionId: () => 'interactive-session',
        getSessionFile: () => join(directory, 'interactive-session.jsonl'),
      },
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_: string, text: string) => text } },
    };
    const neverCreated = join(directory, 'never-created');
    const literal = `literal $(touch ${shellQuote(neverCreated)}) ; λ`;
    try {
      await runtime.startSession(context as never);
      const started = await runtime.executeBash(
        {
          command:
            'for iteration in 1 2; do IFS= read -r answer; printf \'answer-%s=<%s>\\n\' "$iteration" "$answer"; done',
          background: true,
        },
        undefined,
        undefined,
        context as never,
      );
      const windowId = started.details?.windowId;
      if (!windowId) throw new Error('Expected interactive window.');
      await runtime.sendInput(windowId, literal, false, context as never);
      const run = runtime.state.commands.get(started.details?.runId ?? '');
      if (!run) throw new Error('Expected interactive run.');
      expect(await readExitCode(run.exitCodeFile)).toBeUndefined();
      await runtime.sendKey(windowId, 'enter', context as never);
      await waitFor(async () => (await readFile(run.outputFile, 'utf8')).includes('answer-1='));
      await runtime.sendInput(windowId, 'second λ', true, context as never);
      await waitFor(async () => (await readExitCode(run.exitCodeFile)) === 0);
      expect(await readFile(run.outputFile, 'utf8')).toContain(`answer-1=<${literal}>`);
      expect(await readFile(run.outputFile, 'utf8')).toContain('answer-2=<second λ>');
      const manifest = await readFile(run.manifestPath, 'utf8');
      expect(manifest).not.toContain(literal);
      expect(manifest).not.toContain('second λ');
      await expect(readFile(neverCreated)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await runtime.shutdown(context as never);
      controller.dispose();
    }
  }, 20_000);

  it('routes user bash through tmux with ordered bytes, actual non-zero status, cwd, and no gates', async () => {
    const current = requireEnvironment();
    const directory = await mkdtemp(join(current.root, 'user-bash-'));
    const gateEvents: string[] = [];
    const events = {
      on: vi.fn(() => vi.fn()),
      emit: vi.fn((name: string) => {
        if (name === CONTINUATION_GATE_ACQUIRE_EVENT || name === CONTINUATION_GATE_RELEASE_EVENT) {
          gateEvents.push(name);
        }
      }),
    };
    const pi = { events, sendMessage: vi.fn(), appendEntry: vi.fn() };
    const controller = createContinuationGateController(pi as never, { source: 'pi-tmux-bash' });
    const runtime = new TmuxBashRuntime(
      pi as never,
      {
        ...DEFAULT_TMUX_BASH_CONFIG,
        outputDir: directory,
        durableOutputDir: directory,
        tmuxSessionScope: 'global',
        globalTmuxSessionName: current.sessionName,
        autoCloseWindowsOnCompletion: true,
        nonGitScope: 'cwd',
        preserveOutputFiles: true,
        statusbarEnabled: false,
      },
      controller,
      current.client,
    );
    const context = {
      cwd: directory,
      sessionManager: {
        getSessionId: () => 'user-bash-session',
        getSessionFile: () => join(directory, 'user-bash-session.jsonl'),
      },
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_: string, text: string) => text } },
    };
    const output: Buffer[] = [];
    try {
      await runtime.startSession(context as never);
      const command =
        "printf 'one\\n'; printf 'two\\n' >&2; printf '%s\\n' \"$PWD\"; printf '%s\\n' \"${PI_SESSION_ID-unset}\"; exit 7";
      const builtInOutput: Buffer[] = [];
      const builtInResult = await createLocalBashOperations().exec(command, directory, {
        onData: (data) => builtInOutput.push(Buffer.from(data)),
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith('PI_SESSION_')),
        ),
      });
      const result = await runtime.executeUserBash(command, directory, {
        onData: (data) => output.push(Buffer.from(data)),
      });
      expect(result).toEqual(builtInResult);
      // Pi's local backend reads stdout/stderr as separate streams, so their cross-stream
      // callback order is scheduler-dependent. Compare the same records, then assert that
      // the tmux pipeline preserves the shell's actual merged byte order below.
      expect(Buffer.concat(output).toString().trim().split('\n').sort()).toEqual(
        Buffer.concat(builtInOutput).toString().trim().split('\n').sort(),
      );
      expect(Buffer.concat(output).toString()).toBe(`one\ntwo\n${directory}\nunset\n`);
      expect(gateEvents).toEqual([]);
      expect(pi.sendMessage).not.toHaveBeenCalled();
      const emptyOutput: Buffer[] = [];
      await expect(
        runtime.executeUserBash('true', directory, {
          onData: (data) => emptyOutput.push(Buffer.from(data)),
        }),
      ).resolves.toEqual({ exitCode: 0 });
      expect(emptyOutput).toEqual([]);

      const routedDirectory = await mkdtemp(join(current.root, 'user-bash-cwd-'));
      await expect(
        runtime.executeUserBash('true', routedDirectory, { onData: () => undefined }),
      ).resolves.toEqual({ exitCode: 0 });
      const routedScope = await resolveWorkspaceScope(runtime.config, routedDirectory);
      expect(
        (await readdir(join(directory, routedScope.hash))).some((name) =>
          name.endsWith('.manifest.json'),
        ),
      ).toBe(true);

      await expect(
        runtime.executeUserBash('sleep 5', directory, {
          onData: () => undefined,
          timeout: 0.05,
        }),
      ).rejects.toThrow('timeout:0.05');
      expect(runtime.state.commands.size).toBe(0);
      const abort = new AbortController();
      const cancelled = runtime.executeUserBash('sleep 5', directory, {
        onData: () => undefined,
        signal: abort.signal,
      });
      await waitFor(async () => runtime.state.commands.size === 1, 5_000);
      abort.abort();
      await expect(cancelled).rejects.toThrow('aborted');
      expect(runtime.state.commands.size).toBe(0);
      expect(gateEvents).toEqual([]);
      expect(runtime.state.pollers.size).toBe(0);
      expect(pi.sendMessage).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown(context as never);
      controller.dispose();
    }
  }, 20_000);
});

function requireEnvironment(): RealTmuxEnvironment {
  if (!environment) throw new Error('The disposable tmux environment is unavailable.');
  return environment;
}

function isolatedTmuxExecutor(socketPath: string): TmuxExecutor {
  return async (binary, args, signal) => {
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
    delete childEnvironment.TMUX;
    delete childEnvironment.TMUX_PANE;
    try {
      const result = await execFileAsync(binary, ['-S', socketPath, ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        signal,
        env: childEnvironment,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      if (signal?.aborted) throw error;
      const failed = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      if (failed.code === 'ENOENT') throw new Error(`tmux binary not found: ${binary}`);
      return {
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? failed.message,
        code: typeof failed.code === 'number' ? failed.code : 1,
      };
    }
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for tmux command completion.');
}
