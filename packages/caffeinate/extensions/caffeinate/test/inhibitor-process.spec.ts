import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startInhibitor,
  type InhibitorChild,
  type ProcessRunner,
} from '../src/inhibitor-process.ts';
import type { InhibitorCandidate } from '../src/inhibitors.ts';

const candidate: InhibitorCandidate = {
  id: 'powershell-0',
  command: 'powershell.exe',
  args: [],
  kind: 'powershell',
  mode: 'display',
};

class FakeStream extends EventEmitter {
  resume = vi.fn();
}

class FakeChild extends EventEmitter implements InhibitorChild {
  stdin = { end: vi.fn(() => undefined) };
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = vi.fn(() => true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('inhibitor process cleanup', () => {
  it('waits for PowerShell to close instead of treating stdin flush as process exit', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const runner: ProcessRunner = { spawn: () => child };
    const started = startInhibitor([candidate], { runner, readinessDelayMs: 1 });
    await vi.advanceTimersByTimeAsync(1);
    const inhibitor = await started;
    expect(inhibitor).toBeDefined();

    let stopped = false;
    const stopping = inhibitor?.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(child.stdin.end).toHaveBeenCalledWith();
    expect(stopped).toBe(false);
    child.emit('close');
    await stopping;
    expect(stopped).toBe(true);
  });

  it('keeps the kill fallback armed until the child closes', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const runner: ProcessRunner = { spawn: () => child };
    const started = startInhibitor([candidate], {
      runner,
      readinessDelayMs: 1,
      killTimeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(1);
    const inhibitor = await started;
    expect(inhibitor).toBeDefined();

    let stopped = false;
    const stopping = inhibitor?.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(stopped).toBe(false);
    child.emit('close');
    await stopping;
    expect(stopped).toBe(true);
  });
});
