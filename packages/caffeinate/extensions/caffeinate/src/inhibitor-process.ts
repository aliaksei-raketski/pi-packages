import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { InhibitorCandidate } from './inhibitors.ts';

const STDERR_TAIL_LIMIT = 1_024;
const DEFAULT_KILL_TIMEOUT = 500;

type Listener = (...args: unknown[]) => void;

export interface InhibitorChild {
  pid?: number;
  stdin?: { end(callback?: () => void): void; once?(event: string, listener: Listener): void };
  stdout?: { on(event: string, listener: Listener): void; resume?(): void };
  stderr?: { on(event: string, listener: Listener): void; resume?(): void };
  on(event: string, listener: Listener): void;
  removeListener?(event: string, listener: Listener): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ProcessRunner {
  spawn(command: string, args: string[], candidate?: InhibitorCandidate): InhibitorChild;
}

export interface RunningInhibitor {
  readonly candidate: InhibitorCandidate;
  readonly stderr: string;
  stop(): Promise<void>;
}

export interface InhibitorStartOptions {
  runner?: ProcessRunner;
  killTimeoutMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  onUnexpectedExit?: (candidate: InhibitorCandidate, stderr: string, error?: Error) => void;
  readinessDelayMs?: number;
}

interface ManagedChild extends RunningInhibitor {
  readonly child: InhibitorChild;
}

function unixSupervisor(command: string, args: string[]): { command: string; args: string[] } {
  const script = [
    'command="$1"; shift',
    '"$command" "$@" & child=$!',
    '(while [ "$PPID" -gt 1 ] && kill -0 "$PPID" 2>/dev/null; do sleep 1; done; kill "$child" 2>/dev/null || true) & watcher=$!',
    'trap "kill $child $watcher 2>/dev/null || true; exit 0" INT TERM HUP EXIT',
    'wait "$child"; status=$?; kill "$watcher" 2>/dev/null || true; trap - INT TERM HUP EXIT; exit "$status"',
  ].join('; ');
  return { command: 'sh', args: ['-c', script, 'pi-caffeinate', command, ...args] };
}

const defaultRunner: ProcessRunner = {
  spawn(command, args, candidate) {
    const invocation =
      process.platform === 'win32' || candidate?.kind === 'powershell'
        ? { command, args }
        : unixSupervisor(command, args);
    return spawn(invocation.command, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  },
};

function appendTail(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk)}`;
  return next.length <= STDERR_TAIL_LIMIT ? next : next.slice(-STDERR_TAIL_LIMIT);
}

function detach(child: InhibitorChild, event: string, listener: Listener): void {
  child.removeListener?.(event, listener);
}

/** Start the first usable candidate. Candidate failures are bounded to one pass. */
export async function startInhibitor(
  candidates: readonly InhibitorCandidate[],
  options: InhibitorStartOptions = {},
): Promise<RunningInhibitor | undefined> {
  const runner = options.runner ?? defaultRunner;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;

  for (const candidate of candidates) {
    try {
      const child = runner.spawn(candidate.command, candidate.args, candidate);
      let stderr = '';
      let stopped = false;
      let settled = false;
      let earlyExit: { error?: Error } | undefined;
      let reportedExit = false;
      let resolveReady: (value: ManagedChild | undefined) => void = () => undefined;
      let rejectReady: (error: unknown) => void = () => undefined;
      const ready = new Promise<ManagedChild | undefined>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const onData = (chunk: unknown) => {
        stderr = appendTail(stderr, chunk);
      };
      const onExit = () => {
        if (!settled) {
          settled = true;
          earlyExit = {};
          resolveReady(undefined);
          return;
        }
        if (!stopped && !reportedExit) {
          reportedExit = true;
          options.onUnexpectedExit?.(candidate, stderr, earlyExit?.error);
        }
      };
      const onError = (error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (!settled) {
          settled = true;
          earlyExit = { error: normalized };
          rejectReady(normalized);
        } else if (!stopped) {
          options.onUnexpectedExit?.(candidate, stderr, normalized);
        }
      };

      child.stderr?.on('data', onData);
      child.stdout?.on('data', () => undefined);
      child.stdout?.resume?.();
      child.stderr?.resume?.();
      child.on('error', onError);
      child.on('exit', onExit);
      child.on('close', onExit);

      const managed: ManagedChild = {
        candidate,
        child,
        get stderr() {
          return stderr;
        },
        stop: async () => {
          if (stopped) return;
          stopped = true;
          if (killTimer) {
            clearTimer(killTimer);
            killTimer = undefined;
          }
          detach(child, 'error', onError);
          detach(child, 'exit', onExit);
          detach(child, 'close', onExit);
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              if (killTimer) {
                clearTimer(killTimer);
                killTimer = undefined;
              }
              resolve();
            };
            child.on('close', finish);
            if (candidate.kind === 'powershell') {
              try {
                child.stdin?.end(finish);
              } catch {
                finish();
              }
            } else {
              try {
                child.kill('SIGTERM');
              } catch {
                finish();
              }
            }
            killTimer = setTimer(() => {
              try {
                child.kill('SIGKILL');
              } catch {
                // The process may have exited between the signal and fallback.
              }
              finish();
            }, options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT);
            (killTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
          });
        },
      };

      // A synchronous spawn error is reported through error; a child that exits immediately is
      // rejected on the next task, allowing normal long-lived inhibitors to become ready.
      const readinessTimer = setTimer(() => {
        if (!settled) {
          settled = true;
          resolveReady(managed);
        }
      }, options.readinessDelayMs ?? 25);
      (readinessTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();

      const result = await ready;
      clearTimer(readinessTimer);
      if (result) return result;
      if (!reportedExit) {
        reportedExit = true;
        options.onUnexpectedExit?.(candidate, stderr, earlyExit?.error);
      }
    } catch (error) {
      options.onUnexpectedExit?.(
        candidate,
        '',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  return undefined;
}

export function createNodeProcessRunner(): ProcessRunner {
  return defaultRunner;
}
