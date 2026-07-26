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
    'parent="$1"; shift; command="$1"; shift',
    '"$command" "$@" & child=$!',
    'supervisor=$$',
    '(while kill -0 "$parent" 2>/dev/null; do sleep 1; done; kill -TERM "$supervisor" 2>/dev/null || true) & watcher=$!',
    'cleanup() { trap - INT TERM HUP EXIT; kill "$watcher" 2>/dev/null || true; kill -TERM "$child" 2>/dev/null || true; (sleep 1; kill -KILL "$child" 2>/dev/null || true) & killer=$!; wait "$child" 2>/dev/null || true; kill "$killer" 2>/dev/null || true; wait "$killer" 2>/dev/null || true; }',
    'trap "cleanup; exit 0" INT TERM HUP',
    'trap "cleanup" EXIT',
    'wait "$child"; status=$?',
    'kill "$watcher" 2>/dev/null || true; trap - EXIT; wait "$watcher" 2>/dev/null || true; exit "$status"',
  ].join('; ');
  return {
    command: 'sh',
    args: ['-c', script, 'pi-caffeinate', String(process.pid), command, ...args],
  };
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
      let stopPromise: Promise<void> | undefined;
      let closed = false;

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
      const onClose = () => {
        closed = true;
        onExit();
      };
      const onError = (error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (!settled) {
          settled = true;
          earlyExit = { error: normalized };
          reportedExit = true;
          rejectReady(normalized);
        } else if (!stopped && !reportedExit) {
          reportedExit = true;
          options.onUnexpectedExit?.(candidate, stderr, normalized);
        }
      };

      child.stderr?.on('data', onData);
      child.stdout?.on('data', () => undefined);
      child.stdout?.resume?.();
      child.stderr?.resume?.();
      child.on('error', onError);
      child.on('exit', onExit);
      child.on('close', onClose);

      const stopChild = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        detach(child, 'error', onError);
        detach(child, 'exit', onExit);
        detach(child, 'close', onClose);
        if (closed) return;
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            detach(child, 'close', finish);
            if (killTimer) {
              clearTimer(killTimer);
              killTimer = undefined;
            }
            resolve();
          };
          child.on('close', finish);
          killTimer = setTimer(() => {
            killTimer = undefined;
            try {
              if (!child.kill('SIGKILL')) finish();
            } catch {
              finish();
            }
          }, options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT);
          (killTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();

          if (candidate.kind === 'powershell' && child.stdin) {
            try {
              child.stdin.end();
            } catch {
              try {
                if (!child.kill('SIGTERM')) finish();
              } catch {
                finish();
              }
            }
          } else {
            try {
              if (!child.kill('SIGTERM')) finish();
            } catch {
              finish();
            }
          }
        });
      };

      const managed: ManagedChild = {
        candidate,
        child,
        get stderr() {
          return stderr;
        },
        stop: () => (stopPromise ??= stopChild()),
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
