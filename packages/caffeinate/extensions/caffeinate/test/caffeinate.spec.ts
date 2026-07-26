import { describe, expect, it, vi } from 'vitest';
import { createContinuationGateController } from '@aliaksei-raketski/pi-continuation-gate-protocol';
import { caffeinate } from '../src/caffeinate.ts';
import { parseCaffeinateCommand } from '../src/commands.ts';
import type { RunningInhibitor } from '../src/inhibitor-process.ts';
import { DEFAULT_CAFFEINATE_SETTINGS, type CaffeinateSettings } from '../src/settings.ts';
import { collectCaffeinateStatus } from '../src/status.ts';

type Handler = (event: unknown, ctx: ReturnType<typeof createContext>) => unknown;

function createPi() {
  const lifecycle = new Map<string, Handler>();
  const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
  let command:
    | {
        handler(args: string, ctx: ReturnType<typeof createContext>): Promise<void>;
      }
    | undefined;
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      lifecycle.set(event, handler);
    }),
    registerCommand: vi.fn(
      (
        _name: string,
        registered: {
          handler(args: string, ctx: ReturnType<typeof createContext>): Promise<void>;
        },
      ) => {
        command = registered;
      },
    ),
    events: {
      on: vi.fn((event: string, listener: (payload: unknown) => void) => {
        const listeners = eventListeners.get(event) ?? new Set();
        listeners.add(listener);
        eventListeners.set(event, listeners);
        return () => listeners.delete(listener);
      }),
      emit: vi.fn((event: string, payload: unknown) => {
        for (const listener of eventListeners.get(event) ?? []) listener(payload);
      }),
    },
  };
  return {
    pi,
    lifecycle,
    get command() {
      return command;
    },
  };
}

function createContext(sessionId: string, activity = { idle: true, pending: false }) {
  return {
    hasUI: true,
    mode: 'tui',
    sessionManager: { getSessionId: vi.fn(() => sessionId) },
    isIdle: vi.fn(() => activity.idle),
    hasPendingMessages: vi.fn(() => activity.pending),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      select: vi.fn(async () => undefined),
      theme: { fg: vi.fn((_color: string, text: string) => text) },
    },
  };
}

function createSettingsStore(settings: CaffeinateSettings, canSave = true) {
  return {
    load: vi.fn(async () => ({ settings, unknownFields: {}, canSave })),
    save: vi.fn(async () => undefined),
  };
}

function fakeInhibitor(): RunningInhibitor {
  return {
    candidate: {
      id: 'test-inhibitor',
      command: 'test',
      args: [],
      kind: 'caffeinate',
      mode: 'display',
    },
    stderr: '',
    stop: vi.fn(async () => undefined),
  };
}

async function startSession(
  harness: ReturnType<typeof createPi>,
  ctx: ReturnType<typeof createContext>,
): Promise<void> {
  const handler = harness.lifecycle.get('session_start');
  expect(handler).toBeDefined();
  await handler?.({}, ctx);
}

describe('caffeinate extension', () => {
  it('registers lifecycle hooks, continuation observation, and commands without starting work', () => {
    const harness = createPi();
    caffeinate(harness.pi as never, {
      settingsPath: '/tmp/pi-caffeinate.json',
      settingsStore: createSettingsStore(DEFAULT_CAFFEINATE_SETTINGS),
    });

    expect(harness.lifecycle.has('session_start')).toBe(true);
    expect(harness.lifecycle.has('agent_settled')).toBe(true);
    expect(harness.lifecycle.has('session_shutdown')).toBe(true);
    expect(harness.command).toBeDefined();
  });

  it('accepts a distinct command context for the current session', async () => {
    const harness = createPi();
    const settingsStore = createSettingsStore(DEFAULT_CAFFEINATE_SETTINGS);
    caffeinate(harness.pi as never, {
      settingsPath: '/tmp/pi-caffeinate.json',
      settingsStore,
    });
    const sessionContext = createContext('session-1');
    await startSession(harness, sessionContext);
    expect(sessionContext.ui.setStatus).not.toHaveBeenCalled();

    const commandContext = createContext('session-1');
    await harness.command?.handler('status', commandContext);

    expect(commandContext.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Caffeinate: enabled'),
      'info',
    );
    expect(commandContext.ui.notify).not.toHaveBeenCalledWith(
      'Caffeinate is not ready for this session.',
      'warning',
    );
  });

  it('protects an invalid settings file from command writes', async () => {
    const harness = createPi();
    const settingsStore = createSettingsStore(DEFAULT_CAFFEINATE_SETTINGS, false);
    caffeinate(harness.pi as never, {
      settingsPath: '/tmp/pi-caffeinate.json',
      settingsStore,
    });
    const ctx = createContext('session-1');
    await startSession(harness, ctx);

    await harness.command?.handler('quiet on', createContext('session-1'));

    expect(settingsStore.save).not.toHaveBeenCalled();
  });

  it('applies queued setting commands in order after an earlier save fails', async () => {
    let rejectFirst!: (reason?: unknown) => void;
    const firstSave = new Promise<undefined>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const harness = createPi();
    const settingsStore = createSettingsStore({
      enabled: false,
      mode: 'display',
      quiet: false,
    });
    settingsStore.save
      .mockImplementationOnce(() => firstSave)
      .mockImplementationOnce(async () => undefined);
    caffeinate(harness.pi as never, {
      settingsPath: '/tmp/pi-caffeinate.json',
      settingsStore,
    });
    const ctx = createContext('session-1');
    await startSession(harness, ctx);

    const enabling = harness.command?.handler('enable', createContext('session-1'));
    await vi.waitFor(() => expect(settingsStore.save).toHaveBeenCalledTimes(1));
    const changingMode = harness.command?.handler('sleep', createContext('session-1'));
    rejectFirst(new Error('disk full'));
    await Promise.all([enabling, changingMode]);

    expect(settingsStore.save).toHaveBeenNthCalledWith(
      2,
      { enabled: false, mode: 'sleep', quiet: false },
      {},
    );
  });

  it.each([
    { quiet: false, expectedNotifications: 1 },
    { quiet: true, expectedNotifications: 0 },
  ])(
    'uses quiet=$quiet for routine inhibitor notifications',
    async ({ quiet, expectedNotifications }) => {
      const harness = createPi();
      const settingsStore = createSettingsStore({ ...DEFAULT_CAFFEINATE_SETTINGS, quiet });
      const running = fakeInhibitor();
      const launch = vi.fn(async () => running);
      caffeinate(harness.pi as never, {
        settingsPath: '/tmp/pi-caffeinate.json',
        settingsStore,
        startInhibitor: launch as never,
      });
      const ctx = createContext('session-1', { idle: false, pending: false });
      await startSession(harness, ctx);
      await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenCalled());

      const routineNotifications = ctx.ui.notify.mock.calls.filter(([message]) =>
        String(message).startsWith('Caffeinate started ('),
      );
      expect(routineNotifications).toHaveLength(expectedNotifications);
    },
  );

  it('recovers an existing gate and releases only after the final gate unblocks', async () => {
    const harness = createPi();
    const controller = createContinuationGateController(harness.pi as never, {
      source: 'test-producer',
    });
    controller.acquire({
      sessionId: 'session-1',
      gateId: 'gate-1',
      domain: 'non-default-domain',
      reason: 'finite work',
    });
    const running = fakeInhibitor();
    const launch = vi.fn(async () => running);
    caffeinate(harness.pi as never, {
      settingsPath: '/tmp/pi-caffeinate.json',
      settingsStore: createSettingsStore(DEFAULT_CAFFEINATE_SETTINGS),
      startInhibitor: launch as never,
    });
    const ctx = createContext('session-1');
    await startSession(harness, ctx);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());

    controller.release({
      sessionId: 'session-1',
      gateId: 'gate-1',
      domain: 'non-default-domain',
      outcome: 'completed',
      wake: 'none',
    });

    await vi.waitFor(() => expect(running.stop).toHaveBeenCalledOnce());
    controller.dispose();
  });

  it('shuts down an active inhibitor with a distinct current-session context', async () => {
    const harness = createPi();
    const running = fakeInhibitor();
    caffeinate(harness.pi as never, {
      settingsPath: '/tmp/pi-caffeinate.json',
      settingsStore: createSettingsStore(DEFAULT_CAFFEINATE_SETTINGS),
      startInhibitor: vi.fn(async () => running) as never,
    });
    const activity = { idle: false, pending: false };
    await startSession(harness, createContext('session-1', activity));
    await vi.waitFor(() => expect(running.stop).not.toHaveBeenCalled());

    const shutdown = harness.lifecycle.get('session_shutdown');
    await shutdown?.({}, createContext('session-1', activity));

    expect(running.stop).toHaveBeenCalledOnce();
  });
});

describe('caffeinate pure contracts', () => {
  it('keeps gates alive after Pi settles', () => {
    expect(
      collectCaffeinateStatus({
        enabled: true,
        manualStop: false,
        holding: true,
        inhibitorRunning: true,
        unavailable: false,
        gateCount: 2,
        piIdle: true,
      }),
    ).toMatchObject({ text: 'awake · 2 waiting', state: 'waiting' });
  });

  it('rejects trailing or unknown command input', () => {
    expect(parseCaffeinateCommand('quiet on')).toEqual({ kind: 'quiet', enabled: true });
    expect(parseCaffeinateCommand('status extra')).toBeUndefined();
  });
});
