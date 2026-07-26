import type { CaffeinateSettings } from './settings.ts';
import type { RunningInhibitor } from './inhibitor-process.ts';

export interface RuntimeSnapshot {
  piIdle: boolean;
  pendingMessages: boolean;
  gatesBlocked: boolean;
}

export interface CaffeinateRuntimeState {
  generation: number;
  settings: CaffeinateSettings;
  manualStop: boolean;
  shuttingDown: boolean;
  snapshot: RuntimeSnapshot;
  inhibitor?: RunningInhibitor;
  unavailable: boolean;
  lastError?: string;
}

export interface RuntimeDriver {
  start(settings: CaffeinateSettings, generation: number): Promise<RunningInhibitor | undefined>;
  stop(inhibitor: RunningInhibitor): Promise<void>;
  onChange?(): void;
}

export interface RuntimeOptions {
  initialSettings: CaffeinateSettings;
  driver: RuntimeDriver;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export function shouldHold(
  runtime: Pick<CaffeinateRuntimeState, 'shuttingDown' | 'settings' | 'manualStop' | 'snapshot'>,
): boolean {
  return (
    !runtime.shuttingDown &&
    runtime.settings.enabled &&
    !runtime.manualStop &&
    (!runtime.snapshot.piIdle || runtime.snapshot.pendingMessages || runtime.snapshot.gatesBlocked)
  );
}

export class CaffeinateRuntime {
  readonly state: CaffeinateRuntimeState;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private stopPromise: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;

  constructor(private readonly options: RuntimeOptions) {
    this.state = {
      generation: 0,
      settings: { ...options.initialSettings },
      manualStop: false,
      shuttingDown: false,
      snapshot: { piIdle: true, pendingMessages: false, gatesBlocked: false },
      unavailable: false,
    };
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
  }

  updateSnapshot(snapshot: RuntimeSnapshot): void {
    this.state.snapshot = { ...snapshot };
    this.reconcile();
  }

  setSettings(settings: CaffeinateSettings): void {
    const modeChanged = settings.mode !== this.state.settings.mode;
    this.state.settings = { ...settings };
    if (modeChanged) {
      this.state.unavailable = false;
      ++this.state.generation;
    }
    if (modeChanged && this.state.inhibitor) {
      void this.restart();
      return;
    }
    this.reconcile();
  }

  clearManualStop(): void {
    this.state.manualStop = false;
    this.state.unavailable = false;
    this.reconcile();
  }

  setManualStop(): void {
    this.state.manualStop = true;
    this.state.unavailable = false;
    this.cancelRelease();
    void this.release();
    this.options.driver.onChange?.();
  }

  markUnavailable(error?: string): void {
    this.state.unavailable = true;
    this.state.lastError = error;
    this.state.inhibitor = undefined;
    this.options.driver.onChange?.();
  }

  reconcile(): void {
    if (shouldHold(this.state)) {
      this.cancelRelease();
      if (!this.state.inhibitor && !this.state.unavailable) {
        this.startPromise ??= this.start().finally(() => {
          this.startPromise = undefined;
          this.reconcile();
        });
      }
      return;
    }
    this.scheduleRelease();
  }

  async start(): Promise<void> {
    const generation = ++this.state.generation;
    const settings = { ...this.state.settings };
    if (this.stopPromise) await this.stopPromise;
    if (generation !== this.state.generation || !shouldHold(this.state)) return;
    const inhibitor = await this.options.driver.start(settings, generation);
    if (
      generation !== this.state.generation ||
      this.state.shuttingDown ||
      !shouldHold(this.state)
    ) {
      if (inhibitor) await this.options.driver.stop(inhibitor);
      return;
    }
    if (!inhibitor) {
      this.markUnavailable(this.state.lastError);
      return;
    }
    this.state.inhibitor = inhibitor;
    this.state.unavailable = false;
    this.state.lastError = undefined;
    this.options.driver.onChange?.();
  }

  async restart(): Promise<void> {
    this.cancelRelease();
    ++this.state.generation;
    await this.release();
    if (shouldHold(this.state)) {
      this.state.unavailable = false;
      await this.start();
    }
  }

  async release(): Promise<void> {
    const inhibitor = this.state.inhibitor;
    this.state.inhibitor = undefined;
    if (!inhibitor) return;
    this.stopPromise ??= this.options.driver.stop(inhibitor).finally(() => {
      this.stopPromise = undefined;
      this.options.driver.onChange?.();
    });
    await this.stopPromise;
  }

  async shutdown(): Promise<void> {
    this.state.shuttingDown = true;
    ++this.state.generation;
    this.cancelRelease();
    await this.release();
  }

  private scheduleRelease(): void {
    if (this.releaseTimer) return;
    const generation = this.state.generation;
    this.releaseTimer = this.setTimer(() => {
      this.releaseTimer = undefined;
      if (generation !== this.state.generation || shouldHold(this.state)) return;
      void this.release();
    }, 0);
    (this.releaseTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }

  private cancelRelease(): void {
    if (!this.releaseTimer) return;
    this.clearTimer(this.releaseTimer);
    this.releaseTimer = undefined;
  }
}
