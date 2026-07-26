import {
  createContinuationGateRegistry,
  type ContinuationGateRegistry,
  type ContinuationGateRegistryChange,
} from '@aliaksei-raketski/pi-continuation-gate-protocol';
import {
  clearStatus,
  publishStatus,
  registerStatusProvider,
  type StatuslineProtocolHost,
  type StatuslineUICtx,
} from '@aliaksei-raketski/pi-statusline-protocol';
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { buildInhibitorCandidates, type CaffeinateMode } from './inhibitors.ts';
import { startInhibitor, type RunningInhibitor } from './inhibitor-process.ts';
import {
  parseCaffeinateCommand,
  getCaffeinateCompletions,
  caffeinateHelp,
  type CaffeinateCommand,
} from './commands.ts';
import { CaffeinateRuntime, shouldHold } from './runtime.ts';
import {
  DEFAULT_CAFFEINATE_SETTINGS,
  getSettingsPath,
  SettingsStore,
  type CaffeinateSettings,
} from './settings.ts';
import {
  CAFFEINATE_STATUS_KEY,
  CAFFEINATE_STATUS_SOURCE,
  collectCaffeinateStatus,
} from './status.ts';

const SETTINGS_PATH = getSettingsPath(getAgentDir());

type SessionRuntime = {
  generation: number;
  sessionId: string;
  ctx: ExtensionContext;
  settings: CaffeinateSettings;
  unknownFields: Record<string, unknown>;
  controller: CaffeinateRuntime;
  clearProvider?: () => void;
  statusPublished?: boolean;
};

function statusContext(ctx: ExtensionContext) {
  return {
    setStatus: (key: string, text: string | undefined) => ctx.ui.setStatus(key, text),
    theme: ctx.ui.theme,
  };
}

function clearOwnedStatus(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const clear = clearStatus as unknown as (
    host: StatuslineProtocolHost,
    ui: StatuslineUICtx,
    key: string,
    source: string,
  ) => void;
  clear(pi, statusContext(ctx), CAFFEINATE_STATUS_KEY, CAFFEINATE_STATUS_SOURCE);
}

function isCurrent(current: SessionRuntime | undefined, session: SessionRuntime): boolean {
  return current === session && !session.controller.state.shuttingDown;
}

function notify(ctx: ExtensionContext, message: string, level: 'info' | 'warning' = 'info'): void {
  ctx.ui.notify(message, level);
}

export function caffeinate(pi: ExtensionAPI): void {
  let current: SessionRuntime | undefined;
  let startupGeneration = 0;
  const createGateRegistry = (): ContinuationGateRegistry =>
    createContinuationGateRegistry(pi, {
      onChange: (change: ContinuationGateRegistryChange) => {
        const session = current;
        if (!session || change.sessionId !== session.sessionId) return;
        if (change.kind === 'acquired') session.controller.clearManualStop();
        refresh(session);
      },
    });
  let gateRegistry = createGateRegistry();
  const settingsStore = new SettingsStore(SETTINGS_PATH);

  const getStatus = (session: SessionRuntime) => {
    const state = session.controller.state;
    return collectCaffeinateStatus({
      enabled: state.settings.enabled,
      manualStop: state.manualStop,
      holding: shouldHold(state),
      inhibitorRunning: Boolean(state.inhibitor),
      unavailable: state.unavailable,
      gateCount: gateRegistry.list(session.sessionId).length,
      piIdle: state.snapshot.piIdle,
      pendingMessages: state.snapshot.pendingMessages,
    });
  };

  const updateStatus = (session: SessionRuntime): void => {
    if (!isCurrent(current, session)) return;
    const status = getStatus(session);
    if (!status) {
      session.statusPublished = false;
      if (session.ctx.hasUI) {
        clearOwnedStatus(pi, session.ctx);
      }
      return;
    }
    session.statusPublished = true;
    if (session.ctx.hasUI) {
      publishStatus(pi, statusContext(session.ctx), status, CAFFEINATE_STATUS_SOURCE);
    }
  };

  const refresh = (session: SessionRuntime): void => {
    if (!isCurrent(current, session)) return;
    session.controller.updateSnapshot({
      piIdle: session.ctx.isIdle(),
      pendingMessages: session.ctx.hasPendingMessages(),
      gatesBlocked: gateRegistry.isBlocked(session.sessionId),
    });
    updateStatus(session);
  };

  const stopCurrent = async (): Promise<void> => {
    const session = current;
    if (!session) return;
    ++session.generation;
    await session.controller.shutdown();
    session.clearProvider?.();
    session.clearProvider = undefined;
    gateRegistry.dispose();
    if (session.ctx.hasUI) {
      clearOwnedStatus(pi, session.ctx);
    }
    if (current === session) current = undefined;
  };

  const persistSettings = async (
    session: SessionRuntime,
    next: CaffeinateSettings,
    feedback: string,
  ): Promise<void> => {
    const previous = { ...session.settings };
    const previousUnknown = { ...session.unknownFields };
    session.settings = { ...next };
    session.controller.setSettings(next);
    try {
      await settingsStore.save(next, session.unknownFields);
      if (isCurrent(current, session)) {
        refresh(session);
        notify(session.ctx, feedback);
      }
    } catch (error) {
      session.settings = previous;
      session.unknownFields = previousUnknown;
      session.controller.setSettings(previous);
      if (isCurrent(current, session))
        notify(
          session.ctx,
          `Could not save ${SETTINGS_PATH}: ${error instanceof Error ? error.message : String(error)}`,
          'warning',
        );
    }
  };

  const showStatus = (session: SessionRuntime): void => {
    const state = session.controller.state;
    const gates = gateRegistry.list(session.sessionId);
    const candidate = state.inhibitor?.candidate;
    notify(
      session.ctx,
      [
        `Caffeinate: ${state.settings.enabled ? 'enabled' : 'disabled'} (${state.settings.mode})`,
        `Inhibitor: ${candidate ? `active (${candidate.id})` : state.unavailable ? 'unavailable' : 'idle'}`,
        `Pi: ${state.snapshot.piIdle ? 'idle' : 'active'}${state.snapshot.pendingMessages ? ', queued messages' : ''}`,
        `Continuation gates: ${gates.length}`,
        `Quiet: ${state.settings.quiet ? 'on' : 'off'}`,
        `Settings: ${SETTINGS_PATH}`,
        state.lastError ? `Last error: ${state.lastError}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  };

  const runCommand = async (command: CaffeinateCommand, ctx: ExtensionContext): Promise<void> => {
    const session = current;
    if (!session || session.ctx !== ctx) {
      notify(ctx, 'Caffeinate is not ready for this session.', 'warning');
      return;
    }
    switch (command.kind) {
      case 'menu': {
        if (!ctx.hasUI) {
          notify(
            ctx,
            'Use /caffeinate status|start|stop|enable|disable|display|sleep|quiet on|quiet off.',
            'warning',
          );
          return;
        }
        const choice = await ctx.ui.select('Caffeinate', [
          'status',
          'start',
          'stop',
          'enable',
          'disable',
          'display',
          'sleep',
          'quiet on',
          'quiet off',
          'help',
        ]);
        if (choice) await runCommand(parseCaffeinateCommand(choice) ?? { kind: 'help' }, ctx);
        return;
      }
      case 'status':
        showStatus(session);
        return;
      case 'help':
        notify(ctx, caffeinateHelp(SETTINGS_PATH));
        return;
      case 'start':
        session.controller.clearManualStop();
        refresh(session);
        notify(ctx, 'Caffeinate started.');
        return;
      case 'stop':
        session.controller.setManualStop();
        updateStatus(session);
        notify(ctx, 'Caffeinate stopped until the next Pi activity or gate acquisition.');
        return;
      case 'enable':
        await persistSettings(
          session,
          { ...session.settings, enabled: true },
          'Caffeinate enabled.',
        );
        return;
      case 'disable':
        await persistSettings(
          session,
          { ...session.settings, enabled: false },
          'Caffeinate disabled.',
        );
        return;
      case 'mode':
        await persistSettings(
          session,
          { ...session.settings, mode: command.mode },
          `Caffeinate mode is now ${command.mode}.`,
        );
        return;
      case 'quiet':
        await persistSettings(
          session,
          { ...session.settings, quiet: command.enabled },
          `Caffeinate quiet mode is now ${command.enabled ? 'on' : 'off'}.`,
        );
        return;
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    const startupToken = ++startupGeneration;
    await stopCurrent();
    gateRegistry.dispose();
    gateRegistry = createGateRegistry();
    const generation = (current?.generation ?? 0) + 1;
    const loaded = await settingsStore.load();
    if (startupToken !== startupGeneration) return;
    const session: SessionRuntime = {
      generation,
      sessionId: ctx.sessionManager.getSessionId(),
      ctx,
      settings: loaded.settings,
      unknownFields: loaded.unknownFields,
      controller: undefined as unknown as CaffeinateRuntime,
    };
    const driver = {
      start: async (settings: CaffeinateSettings): Promise<RunningInhibitor | undefined> => {
        let errorText = '';
        const result = await startInhibitor(
          buildInhibitorCandidates({ platform: process.platform, env: process.env }, settings.mode),
          {
            onUnexpectedExit: (_candidate, stderr, error) => {
              errorText = stderr || error?.message || 'inhibitor exited unexpectedly';
              if (session.controller.state.inhibitor) {
                session.controller.markUnavailable(errorText);
              }
            },
          },
        );
        if (!result)
          session.controller.state.lastError = errorText || 'No supported inhibitor was available.';
        return result;
      },
      stop: (inhibitor: RunningInhibitor) => inhibitor.stop(),
      onChange: () => updateStatus(session),
    };
    session.controller = new CaffeinateRuntime({ initialSettings: loaded.settings, driver });
    current = session;
    if (loaded.warning) notify(ctx, loaded.warning, 'warning');

    session.clearProvider = registerStatusProvider(
      pi,
      () => {
        const status = current === session ? getStatus(session) : undefined;
        return status ? [status] : [];
      },
      CAFFEINATE_STATUS_SOURCE,
    ).dispose;
    gateRegistry.requestSnapshot(session.sessionId);
    refresh(session);
  });

  pi.on('agent_start', (_event, ctx) => {
    if (!current || current.ctx !== ctx) return;
    current.controller.clearManualStop();
    refresh(current);
  });
  pi.on('agent_settled', (_event, ctx) => {
    if (!current || current.ctx !== ctx) return;
    refresh(current);
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    ++startupGeneration;
    if (current?.ctx === ctx) await stopCurrent();
  });

  pi.registerCommand('caffeinate', {
    description: 'Keep the computer awake while Pi is active or continuation gates are pending',
    getArgumentCompletions: getCaffeinateCompletions,
    handler: async (args, ctx) => {
      const command = parseCaffeinateCommand(args);
      if (!command) {
        notify(ctx, 'Unknown caffeinate command. Use /caffeinate help.', 'warning');
        return;
      }
      await runCommand(command, ctx);
    },
  });
}

export {
  DEFAULT_CAFFEINATE_SETTINGS,
  CAFFEINATE_STATUS_KEY,
  CAFFEINATE_STATUS_SOURCE,
  getSettingsPath,
  type CaffeinateMode,
};
