import { describe, expect, it, vi } from 'vitest';
import type { RunningInhibitor } from '../src/inhibitor-process.ts';
import { CaffeinateRuntime, shouldHold, type RuntimeDriver } from '../src/runtime.ts';
import { DEFAULT_CAFFEINATE_SETTINGS } from '../src/settings.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function inhibitor(): RunningInhibitor {
  return {
    candidate: {
      id: 'test',
      command: 'test',
      args: [],
      kind: 'caffeinate',
      mode: 'display',
    },
    stderr: '',
    stop: vi.fn(async () => undefined),
  };
}

describe('caffeinate runtime', () => {
  it('holds for active Pi, queued messages, or gates', () => {
    const base = {
      shuttingDown: false,
      settings: DEFAULT_CAFFEINATE_SETTINGS,
      manualStop: false,
    };

    expect(
      shouldHold({
        ...base,
        snapshot: { piIdle: false, pendingMessages: false, gatesBlocked: false },
      }),
    ).toBe(true);
    expect(
      shouldHold({
        ...base,
        snapshot: { piIdle: true, pendingMessages: true, gatesBlocked: false },
      }),
    ).toBe(true);
    expect(
      shouldHold({
        ...base,
        snapshot: { piIdle: true, pendingMessages: false, gatesBlocked: true },
      }),
    ).toBe(true);
    expect(
      shouldHold({
        ...base,
        snapshot: { piIdle: true, pendingMessages: false, gatesBlocked: false },
      }),
    ).toBe(false);
  });

  it('awaits and cleans up an inhibitor that finishes starting during shutdown', async () => {
    const pendingStart = deferred<RunningInhibitor | undefined>();
    const stop = vi.fn(async () => undefined);
    const driver: RuntimeDriver = {
      start: vi.fn(() => pendingStart.promise),
      stop,
    };
    const runtime = new CaffeinateRuntime({
      initialSettings: DEFAULT_CAFFEINATE_SETTINGS,
      driver,
    });
    runtime.updateSnapshot({ piIdle: false, pendingMessages: false, gatesBlocked: false });
    await vi.waitFor(() => expect(driver.start).toHaveBeenCalledOnce());

    let shutdownFinished = false;
    const shutdown = runtime.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    const running = inhibitor();
    pendingStart.resolve(running);
    await shutdown;

    expect(stop).toHaveBeenCalledWith(running);
    expect(shutdownFinished).toBe(true);
  });

  it('awaits an already-running stop before shutdown completes', async () => {
    const pendingStop = deferred<void>();
    const running = inhibitor();
    const driver: RuntimeDriver = {
      start: vi.fn(async () => running),
      stop: vi.fn(() => pendingStop.promise),
    };
    const runtime = new CaffeinateRuntime({
      initialSettings: DEFAULT_CAFFEINATE_SETTINGS,
      driver,
    });
    runtime.updateSnapshot({ piIdle: false, pendingMessages: false, gatesBlocked: false });
    await vi.waitFor(() => expect(runtime.state.inhibitor).toBe(running));

    const releasing = runtime.release();
    let shutdownFinished = false;
    const shutdown = runtime.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    pendingStop.resolve();
    await Promise.all([releasing, shutdown]);
    expect(shutdownFinished).toBe(true);
  });
});
